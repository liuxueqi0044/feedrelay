import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BillingService } from '../../packages/billing/src/index.js';
import { nowISO, plusMs, stableId, type Delivery, type Entity, type Item, type Route, type Source } from '../../packages/core/src/index.js';
import { parseFeed, type FeedSnapshot } from '../../packages/sources/src/index.js';
import * as sourcePackage from '../../packages/sources/src/index.js';
import type { Config } from '../../apps/server/src/config.js';
import { MemoryStore } from '../../apps/server/src/infrastructure/store.js';
import { TelegramClient, TelegramError } from '../../apps/server/src/infrastructure/telegram.js';
import { AuthService } from '../../apps/server/src/services/auth.js';
import { FeedService } from '../../apps/server/src/services/feed-service.js';
import { Processor } from '../../apps/server/src/services/processor.js';

const START = new Date('2026-01-01T00:00:00.000Z');
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(START); });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

async function fixture(initialize = true) {
  const store = new MemoryStore();
  const testConfig: Config = { MODE: 'demo', ROLE: 'all', NODE_ENV: 'test', PORT: 4100, HOST: '127.0.0.1', PUBLIC_URL: 'http://localhost:3000', BOT_ID: 'test-bot', BOT_USERNAME: 'TestBot', BILLING_ENABLED: 'false', STARTER_STARS: 300, SUPPORT_EMAIL: '', TERMS_URL: '', DEMO_DATA_PATH: 'work/test-unused.json', LOG_LEVEL: 'error', FETCH_CONCURRENCY: 4 };
  const billing = new BillingService(store, { botId: testConfig.BOT_ID, billingEnabled: false });
  const telegram = new TelegramClient(undefined, true);
  const auth = new AuthService(store, testConfig);
  const feeds = new FeedService(store, billing, telegram, testConfig);
  const processor = new Processor(feeds, auth);
  const { actor } = await auth.identity('123456', 'Alice', true);
  const binding = await feeds.addSource(actor, 'https://demo.feedrelay.invalid/rss');
  const destination = await feeds.privateDestination(actor);
  const route = await feeds.saveRoute(actor, { name: 'News', sourceBindingId: binding.id, destinationId: destination.id, requestedIntervalMinutes: 60 });
  if (initialize) { await processor.fetchSource(binding.sourceId); await processor.releaseRoute(route.id); }
  return { store, billing, telegram, auth, feeds, processor, actor, binding, destination, route };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function deliveries(f: Fixture) { return f.store.read(tx => tx.list<Delivery>('deliveries', { kind: 'article' })); }
async function readRoute(f: Fixture) { return (await f.store.read(tx => tx.get<Route>('routes', f.route.id)))!; }
async function readSource(f: Fixture) { return (await f.store.read(tx => tx.get<Source>('sources', f.binding.sourceId)))!; }
async function publish(f: Fixture): Promise<Delivery> {
  await f.processor.publishDemo(); await f.processor.fetchSource(f.binding.sourceId); await f.processor.releaseRoute(f.route.id);
  return (await deliveries(f)).at(-1)!;
}
async function updateDelivery(f: Fixture, id: string, change: Partial<Delivery>) {
  await f.store.transaction([], async tx => { const row = await tx.get<Delivery>('deliveries', id); await tx.put('deliveries', { ...row!, ...change }); });
}
async function ingest(f: Fixture, input: string) {
  await f.store.transaction([], async tx => {
    const source = (await tx.get<Source>('sources', f.binding.sourceId))!;
    await f.feeds.ingest(tx, source, parseFeed(input, 'https://feed.example.com/rss'));
    source.lastSuccessAt = nowISO(); source.nextPollAt = plusMs(nowISO(), 60_000);
    await tx.put('sources', source);
  });
}
const article = (guid: string, url: string, title = 'Article') => `<rss><channel><title>Feed</title><item><guid isPermaLink="false">${guid}</guid><link>${url}</link><title>${title}</title><description>Summary</description></item></channel></rss>`;

describe('route lifecycle boundaries', () => {
  it('does not resurrect a deleted route through edit, pause, or resume', async () => {
    const f = await fixture();
    await f.feeds.removeRoute(f.actor, f.route.id);
    await expect(f.feeds.pauseRoute(f.actor, f.route.id)).rejects.toMatchObject({ code: 'not_found' });
    await expect(f.feeds.resumeRoute(f.actor, f.route.id, 'skip')).rejects.toMatchObject({ code: 'not_found' });
    await expect(f.feeds.saveRoute(f.actor, { name: 'Resurrected', sourceBindingId: f.binding.id, destinationId: f.destination.id, requestedIntervalMinutes: 60 }, f.route.id)).rejects.toMatchObject({ code: 'not_found' });
    expect((await readRoute(f)).state).toBe('deleted');
  });
  it('requires a fresh recovery snapshot and explicit skip before resuming', async () => {
    const f = await fixture();
    vi.setSystemTime(new Date(START.getTime() + 60_000));
    await f.processor.freezeRecovery();
    await expect(f.feeds.resumeRoute(f.actor, f.route.id, 'skip')).rejects.toMatchObject({ code: 'source_not_ready' });
    await f.feeds.pauseRoute(f.actor, f.route.id);
    await f.processor.fetchSource(f.binding.sourceId);
    await expect(f.feeds.resumeRoute(f.actor, f.route.id, 'recent')).rejects.toMatchObject({ code: 'recovery_backlog' });
    await expect(f.feeds.resumeRoute(f.actor, f.route.id, 'skip')).resolves.toMatchObject({ state: 'active', cursor: (await readSource(f)).seq });
    expect(await deliveries(f)).toHaveLength(0);
  });
});

describe('source polling and route baselines', () => {
  it('takes an initialization baseline and sends only subsequently observed articles', async () => {
    const f = await fixture();
    expect((await readRoute(f))).toMatchObject({ state: 'active', baselineSeq: 2, cursor: 2 });
    expect(await deliveries(f)).toHaveLength(0);
    const next = await publish(f);
    expect(next).toMatchObject({ state: 'pending', kind: 'article', workspaceId: f.actor.workspaceId });
    expect(await deliveries(f)).toHaveLength(1); expect((await readRoute(f)).cursor).toBe(3);
  });
  it('repeated fetches and route releases do not create duplicate items or deliveries', async () => {
    const f = await fixture(); await publish(f);
    await f.processor.fetchSource(f.binding.sourceId); await f.processor.fetchSource(f.binding.sourceId);
    await f.processor.releaseRoute(f.route.id); await f.processor.releaseRoute(f.route.id);
    expect((await readSource(f)).seq).toBe(3);
    expect(await f.store.read(tx => tx.list('items'))).toHaveLength(3);
    expect(await deliveries(f)).toHaveLength(1);
  });
  it('waits for the first successful snapshot before initializing the cursor', async () => {
    const f = await fixture(false); await f.processor.releaseRoute(f.route.id);
    expect((await readRoute(f)).state).toBe('initializing'); expect(await deliveries(f)).toHaveLength(0);
    await f.processor.fetchSource(f.binding.sourceId); await f.processor.releaseRoute(f.route.id);
    expect((await readRoute(f))).toMatchObject({ state: 'active', cursor: 2 });
  });
  it('keeps one item when a GUID changes for the same permalink and tracks revisions', async () => {
    const f = await fixture(false);
    await ingest(f, article('guid-old', 'https://example.com/post'));
    await ingest(f, article('guid-new', 'https://example.com/post', 'Updated title'));
    await ingest(f, article('guid-new', 'https://example.com/post', 'Updated title'));
    const rows = await f.store.read(tx => tx.list<Item>('items'));
    expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ seq: 1, revision: 2, title: 'Updated title' });
    const aliases = await f.store.read(tx => tx.list<Entity & { key: string }>('itemAliases'));
    expect(aliases.map(row => row.key)).toContain('external:guid-new'); expect((await readSource(f)).seq).toBe(1);
  });
  it('does not merge a reused GUID when it refers to a different permalink', async () => {
    const f = await fixture(false);
    await ingest(f, article('same-guid', 'https://example.com/one'));
    await ingest(f, article('same-guid', 'https://example.com/two'));
    expect(await f.store.read(tx => tx.list('items'))).toHaveLength(2); expect((await readSource(f)).seq).toBe(2);
  });
  it('discards a stale source worker snapshot after a newer lease succeeds', async () => {
    const f = await fixture(false); f.feeds.config.MODE = 'production';
    let completeFirst!: (value: FeedSnapshot) => void;
    let announceFirst!: () => void;
    const firstStarted = new Promise<void>(resolve => { announceFirst = resolve; });
    const firstResult = new Promise<FeedSnapshot>(resolve => { completeFirst = resolve; });
    const latest = parseFeed(article('new', 'https://example.com/new', 'New snapshot'), 'https://feed.example.com/rss');
    vi.spyOn(sourcePackage, 'discoverFeed').mockImplementationOnce(async () => { announceFirst(); return firstResult; }).mockResolvedValueOnce(latest);
    const first = f.processor.fetchSource(f.binding.sourceId); await firstStarted;
    await f.store.transaction([], async tx => { const source = (await tx.get<Source>('sources', f.binding.sourceId))!; source.leaseUntil = plusMs(nowISO(), -1); await tx.put('sources', source); });
    await f.processor.fetchSource(f.binding.sourceId);
    completeFirst(parseFeed(article('old', 'https://example.com/old', 'Old snapshot'), 'https://feed.example.com/rss')); await first;
    expect(await f.store.read(tx => tx.list<Item>('items'))).toEqual([expect.objectContaining({ title: 'New snapshot' })]);
    expect((await readSource(f)).leaseVersion).toBe(2);
  });
  it('does not advance past omitted lower sequence numbers when release is paginated', async () => {
    const f = await fixture();
    await f.store.transaction([], async tx => {
      const source = (await tx.get<Source>('sources', f.binding.sourceId))!;
      source.seq = 403; source.nextPollAt = plusMs(nowISO(), 60_000); await tx.put('sources', source);
      const route = (await tx.get<Route>('routes', f.route.id))!; route.nextReleaseAt = nowISO(); await tx.put('routes', route);
      // Insert high sequence values first to model PostgreSQL UUID ordering before LIMIT.
      for (let seq = 403; seq >= 3; seq--) {
        const item: Item = { id: stableId('scrambled-item', String(seq)), createdAt: nowISO(), sourceId: source.id, seq, title: `Post ${seq}`, summary: '', contentHash: String(seq), revision: 1, updatedAt: nowISO() };
        await tx.put('items', item);
      }
    });
    await f.processor.releaseRoute(f.route.id); await f.processor.releaseRoute(f.route.id); await f.processor.releaseRoute(f.route.id);
    expect(await deliveries(f)).toHaveLength(401); expect((await readRoute(f)).cursor).toBe(403);
  });
});

describe('authorization, pause and delivery attempts', () => {
  it('isolates route, source and delivery mutation by workspace', async () => {
    const f = await fixture(); const d = await publish(f);
    const other = (await f.auth.identity('987654', 'Bob', true)).actor;
    await expect(f.feeds.pauseRoute(other, f.route.id)).rejects.toMatchObject({ code: 'not_found' });
    await expect(f.feeds.sourceItems(other, f.binding.id)).rejects.toMatchObject({ code: 'not_found' });
    await expect(f.feeds.retry(other, d.id, true)).rejects.toMatchObject({ code: 'not_found' });
    expect(await f.feeds.listRoutes(other)).toHaveLength(0); expect(await f.feeds.listDeliveries(other)).toHaveLength(0);
  });
  it('blocks queued deliveries when paused and skips them on explicit resume with skip', async () => {
    const f = await fixture(); const d = await publish(f);
    const send = vi.spyOn(f.telegram, 'call');
    await f.feeds.pauseRoute(f.actor, f.route.id); await f.processor.deliver(d.id);
    expect(send).not.toHaveBeenCalled(); expect((await deliveries(f))[0]).toMatchObject({ state: 'blocked', error: 'route_paused' });
    await f.feeds.resumeRoute(f.actor, f.route.id, 'skip');
    expect((await deliveries(f))[0]).toMatchObject({ state: 'expired', error: 'backlog_skipped' });
    expect((await readRoute(f)).cursor).toBe((await readSource(f)).seq);
  });
  it('deduplicates successful sends and charges usage once', async () => {
    const f = await fixture(); const d = await publish(f); const send = vi.spyOn(f.telegram, 'call');
    await Promise.all([f.processor.deliver(d.id), f.processor.deliver(d.id)]); await f.processor.deliver(d.id);
    expect(send).toHaveBeenCalledTimes(1); expect((await deliveries(f))[0]).toMatchObject({ state: 'sent', attemptCount: 1 });
    expect((await f.billing.entitlements(f.actor.workspaceId)).used).toBe(1);
  });
  it('preserves chat FIFO when several articles have identical creation timestamps', async () => {
    const f = await fixture();
    await publish(f); await publish(f); await publish(f);
    const rows = (await deliveries(f)).sort((a, b) => a.enqueueSeq! - b.enqueueSeq!);
    expect(new Set(rows.map(row => row.createdAt)).size).toBe(1);
    expect(rows.map(row => row.enqueueSeq)).toEqual([1, 2, 3]);
    const send = vi.spyOn(f.telegram, 'call');
    await f.processor.deliver(rows[2]!.id); expect(send).not.toHaveBeenCalled();
    await f.processor.deliver(rows[0]!.id);
    vi.setSystemTime(new Date(START.getTime() + 1300));
    await f.processor.deliver(rows[2]!.id); await f.processor.deliver(rows[1]!.id);
    vi.setSystemTime(new Date(START.getTime() + 2600)); await f.processor.deliver(rows[2]!.id);
    expect(send.mock.calls.map(call => call[1].text)).toEqual(rows.map(row => row.text));
    expect((await deliveries(f)).map(row => row.state)).toEqual(['sent', 'sent', 'sent']);
  });
  it('retries a known transient failure after retry_after without double charging', async () => {
    const f = await fixture(); const d = await publish(f);
    const send = vi.spyOn(f.telegram, 'call').mockRejectedValueOnce(new TelegramError('retry', 'rate_limited', 2));
    await f.processor.deliver(d.id); expect((await deliveries(f))[0]).toMatchObject({ state: 'retry_wait', attemptCount: 1 });
    await f.processor.deliver(d.id); expect(send).toHaveBeenCalledTimes(1);
    vi.setSystemTime(new Date(START.getTime() + 3000)); await f.processor.deliver(d.id);
    expect(send).toHaveBeenCalledTimes(2); expect((await deliveries(f))[0]).toMatchObject({ state: 'sent', attemptCount: 2 });
    expect((await f.billing.entitlements(f.actor.workspaceId)).used).toBe(1);
  });
  it('moves a stale sending lease to unknown and holds its reservation', async () => {
    const f = await fixture(); const d = await publish(f);
    await f.store.transaction([], async tx => { await f.billing.reserveUsage(tx, d.workspaceId, d.id); const current = (await tx.get<Delivery>('deliveries', d.id))!; await tx.put('deliveries', { ...current, state: 'sending', leaseUntil: plusMs(nowISO(), -1), attemptId: 'stale-attempt' }); });
    await f.processor.maintain();
    expect((await deliveries(f))[0]).toMatchObject({ state: 'unknown', error: 'worker_interrupted', unknownRetries: 0 });
    expect(await f.store.read(tx => tx.list('reservations', { workspaceId: f.actor.workspaceId }))).toEqual(expect.arrayContaining([expect.objectContaining({ state: 'unknown' })]));
  });
  it('keeps the unknown retry available when rate limiting delays the claim', async () => {
    const f = await fixture(); const d = await publish(f); const send = vi.spyOn(f.telegram, 'call');
    await updateDelivery(f, d.id, { state: 'unknown' });
    await f.store.transaction([], tx => tx.put('rateLimits', { id: 'bot', createdAt: nowISO(), nextAt: plusMs(nowISO(), 2000) }));
    await f.processor.deliver(d.id);
    expect(send).not.toHaveBeenCalled(); expect((await deliveries(f))[0]).toMatchObject({ state: 'unknown', unknownRetries: 0 });
    vi.setSystemTime(new Date(START.getTime() + 3000)); await f.processor.deliver(d.id);
    expect(send).toHaveBeenCalledTimes(1); expect((await deliveries(f))[0]).toMatchObject({ state: 'sent', unknownRetries: 1 });
  });
  it('keeps a successful retry when the stale attempt later returns an error', async () => {
    const f = await fixture(); const d = await publish(f);
    let failFirst!: (error: Error) => void, announceFirst!: () => void;
    const firstStarted = new Promise<void>(resolve => { announceFirst = resolve; });
    const firstResult = new Promise<never>((_resolve, reject) => { failFirst = reject; });
    const send = vi.spyOn(f.telegram, 'call').mockImplementationOnce(async () => { announceFirst(); return firstResult; });
    const first = f.processor.deliver(d.id); await firstStarted;
    await updateDelivery(f, d.id, { leaseUntil: plusMs(nowISO(), -1) }); await f.processor.maintain();
    vi.setSystemTime(new Date(START.getTime() + 61_000)); await f.processor.deliver(d.id);
    failFirst(new TelegramError('unknown', 'stale_connection_failed')); await first;
    expect(send).toHaveBeenCalledTimes(2); expect((await deliveries(f))[0]).toMatchObject({ state: 'sent', attemptCount: 2 });
    expect((await f.billing.entitlements(f.actor.workspaceId)).used).toBe(1);
  });
  it('allows one automatic unknown retry and then requires review', async () => {
    const f = await fixture(); const d = await publish(f);
    const send = vi.spyOn(f.telegram, 'call').mockRejectedValue(new TelegramError('unknown', 'connection_lost'));
    await f.processor.deliver(d.id); expect((await deliveries(f))[0]).toMatchObject({ state: 'unknown', unknownRetries: 0 });
    vi.setSystemTime(new Date(START.getTime() + 61_000)); await f.processor.deliver(d.id);
    expect((await deliveries(f))[0]).toMatchObject({ state: 'needs_review', unknownRetries: 1 });
    vi.setSystemTime(new Date(START.getTime() + 122_000)); await f.processor.deliver(d.id); expect(send).toHaveBeenCalledTimes(2);
  });
  it('refreshes verified destination versions for an explicit retry after permissions recover', async () => {
    const f = await fixture(); const d = await publish(f);
    vi.spyOn(f.telegram, 'call').mockRejectedValueOnce(new TelegramError('blocked', 'permission_lost'));
    await f.processor.deliver(d.id); expect((await deliveries(f))[0]).toMatchObject({ state: 'blocked' });
    await f.feeds.verifyDestination(f.actor, f.destination.id); await f.feeds.retry(f.actor, d.id, false);
    vi.setSystemTime(new Date(START.getTime() + 3000)); await f.processor.deliver(d.id);
    expect((await deliveries(f))[0]).toMatchObject({ state: 'sent', attemptCount: 2 });
  });
  it('requires duplicate-risk acknowledgement for an uncertain manual retry', async () => {
    const f = await fixture(); const d = await publish(f); await updateDelivery(f, d.id, { state: 'needs_review' });
    await expect(f.feeds.retry(f.actor, d.id, false)).rejects.toMatchObject({ code: 'duplicate_risk' });
    await expect(f.feeds.retry(f.actor, d.id, true)).resolves.toMatchObject({ state: 'pending' });
  });
});
