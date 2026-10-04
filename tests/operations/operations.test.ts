import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BillingService, type Grant, type Subscription, type UsageReservation } from '../../packages/billing/src/index.js';
import { nowISO, plusMs, stableId, type Delivery, type Destination, type Entity, type Route, type Session, type SourceBinding, type Workspace } from '../../packages/core/src/index.js';
import type { Config } from '../../apps/server/src/config.js';
import { MemoryStore } from '../../apps/server/src/infrastructure/store.js';
import { TelegramClient, TelegramError } from '../../apps/server/src/infrastructure/telegram.js';
import { AuthService } from '../../apps/server/src/services/auth.js';
import { FeedService } from '../../apps/server/src/services/feed-service.js';
import { Processor } from '../../apps/server/src/services/processor.js';

const START = new Date('2026-01-01T00:00:00.000Z');
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(START); });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

async function fixture() {
  const store = new MemoryStore();
  const config: Config = { MODE: 'demo', ROLE: 'all', NODE_ENV: 'test', PORT: 4100, HOST: '127.0.0.1', TRUSTED_PROXY_CIDRS: '', PUBLIC_URL: 'http://localhost:3000', BOT_ID: 'operations-bot', BOT_USERNAME: 'OperationsTestBot', BILLING_ENABLED: 'false', STARTER_STARS: 300, SUPPORT_EMAIL: 'support@example.test', TERMS_URL: 'https://example.test/terms', DEMO_DATA_PATH: 'work/unused-operations.json', LOG_LEVEL: 'error', FETCH_CONCURRENCY: 4 };
  // Billing is exercised locally using authenticated receipt fixtures; transport remains demo-only.
  const billing = new BillingService(store, { botId: config.BOT_ID, priceStars: 300, billingEnabled: true, termsUrl: config.TERMS_URL, supportContact: config.SUPPORT_EMAIL });
  const telegram = new TelegramClient(undefined, true);
  const auth = new AuthService(store, config);
  const feeds = new FeedService(store, billing, telegram, config);
  const processor = new Processor(feeds, auth);
  const account = await auth.login('67890', 'Operations owner');
  await auth.identity(account.actor.telegramId, 'Operations owner', true);
  const binding = await feeds.addSource(account.actor, 'https://demo.feedrelay.invalid/rss');
  const destination = await feeds.privateDestination(account.actor);
  const route = await feeds.saveRoute(account.actor, { name: 'Operations feed', sourceBindingId: binding.id, destinationId: destination.id, requestedIntervalMinutes: 60 });
  await processor.fetchSource(binding.sourceId); await processor.releaseRoute(route.id);
  return { store, billing, telegram, auth, feeds, processor, actor: account.actor, binding, destination, route };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function publish(f: Fixture): Promise<Delivery> {
  await f.processor.publishDemo(); await f.processor.fetchSource(f.binding.sourceId); await f.processor.releaseRoute(f.route.id);
  return (await f.store.read(tx => tx.list<Delivery>('deliveries', { kind: 'article' }))).at(-1)!;
}
async function paid(f: Fixture, first = true) {
  const checkout = await f.billing.checkout(f.actor, true);
  const receipt = { chargeId: 'operations-charge', payload: checkout.payload, payerId: f.actor.telegramId, currency: 'XTR', totalAmount: 300, paidAt: START.getTime() / 1000, expirationDate: START.getTime() / 1000 + 30 * 86_400, isRecurring: true, isFirstRecurring: first };
  await f.billing.recordPayment(receipt);
  return receipt;
}
async function deleting(f: Fixture) {
  await f.store.transaction(['workspace:' + f.actor.workspaceId], async tx => {
    const workspace = (await tx.get<Workspace>('workspaces', f.actor.workspaceId))!;
    workspace.state = 'deleting'; workspace.version++;
    await tx.put('workspaces', workspace);
  });
}

describe('restored database recovery', () => {
  it('freezes active and initializing routes, records cursor gaps and prevents automatic replay', async () => {
    const f = await fixture(); const pending = await publish(f);
    const routeBefore = (await f.store.read(tx => tx.get<Route>('routes', f.route.id)))!;
    const initializing: Route = { ...routeBefore, id: 'initializing-route', state: 'initializing', cursor: 0 };
    const paused: Route = { ...routeBefore, id: 'paused-route', state: 'paused', pauseReason: 'manual' };
    const sent: Delivery = { ...pending, id: 'already-sent', state: 'sent', messageId: 'saved-message', sentAt: nowISO() };
    await f.store.transaction([], async tx => { await tx.put('routes', initializing); await tx.put('routes', paused); await tx.put('deliveries', sent); });
    const send = vi.spyOn(f.telegram, 'call');
    const epoch = await f.processor.freezeRecovery();
    const gaps = await f.store.read(tx => tx.list<Entity & { epoch: string; routeId?: string; oldCursor?: number; state?: string }>('recovery', { epoch }));
    expect(gaps).toHaveLength(2);
    expect(gaps).toEqual(expect.arrayContaining([
      expect.objectContaining({ routeId: f.route.id, oldCursor: routeBefore.cursor, state: 'needs_review', workspaceId: f.actor.workspaceId }),
      expect.objectContaining({ routeId: initializing.id, oldCursor: 0, state: 'needs_review' }),
    ]));
    expect(await f.store.read(tx => tx.get('recovery', epoch))).toMatchObject({ kind: 'recovery_epoch' });
    expect(await f.store.read(tx => tx.get('routes', f.route.id))).toMatchObject({ state: 'recovery', pauseReason: 'database_restored', version: routeBefore.version + 1, cursor: routeBefore.cursor });
    expect(await f.store.read(tx => tx.get('routes', f.route.id))).toMatchObject({ baselineAfter: nowISO() });
    expect(await f.store.read(tx => tx.get('sources', f.binding.sourceId))).toMatchObject({ nextPollAt: nowISO() });
    expect(await f.store.read(tx => tx.get('routes', paused.id))).toMatchObject({ state: 'paused', pauseReason: 'manual', version: paused.version });
    expect(await f.store.read(tx => tx.get('deliveries', pending.id))).toMatchObject({ state: 'needs_review', error: 'database_restored' });
    expect(await f.store.read(tx => tx.get('deliveries', sent.id))).toMatchObject({ state: 'sent', messageId: 'saved-message' });
    await f.processor.releaseRoute(f.route.id); await f.processor.deliver(pending.id);
    expect(send).not.toHaveBeenCalled();
    const secondEpoch = await f.processor.freezeRecovery();
    expect(await f.store.read(tx => tx.list('recovery', { epoch: secondEpoch }))).toHaveLength(0);
  });
  it('allows explicit skip review to establish a fresh cursor instead of replaying the recovery window', async () => {
    const f = await fixture(); const pending = await publish(f);
    await f.processor.freezeRecovery();
    await f.processor.publishDemo(); await f.processor.fetchSource(f.binding.sourceId);
    const source = await f.store.read(tx => tx.get<Entity & { seq: number }>('sources', f.binding.sourceId));
    expect(await f.feeds.resumeRoute(f.actor, f.route.id, 'skip')).toMatchObject({ state: 'active', cursor: source!.seq });
    await f.processor.releaseRoute(f.route.id);
    expect(await f.store.read(tx => tx.get('deliveries', pending.id))).toMatchObject({ state: 'needs_review' });
    expect(await f.store.read(tx => tx.list('deliveries', { kind: 'article' }))).toHaveLength(1);
  });
  it('preserves quota for an in-flight restored send after its reservation deadline', async () => {
    const f = await fixture(); const delivery = await publish(f);
    await f.store.transaction(['workspace:' + f.actor.workspaceId], async tx => {
      await f.billing.reserveUsage(tx, f.actor.workspaceId, delivery.id, nowISO(), plusMs(nowISO(), 3_600_000));
      await tx.put('deliveries', { ...delivery, state: 'sending' as const, leaseUntil: plusMs(nowISO(), 90_000), attemptCount: 1 });
    });
    await f.processor.freezeRecovery();
    vi.setSystemTime(new Date(START.getTime() + 2 * 86_400_000));
    await f.processor.maintain();
    expect(await f.billing.entitlements(f.actor.workspaceId)).toMatchObject({ used: 0, reserved: 1, remaining: 199 });
    expect(await f.store.read(tx => tx.list<UsageReservation>('reservations', { deliveryId: delivery.id }))).toMatchObject([{ state: 'unknown' }]);
  });
});

describe('subscription cancellation and account deletion', () => {
  it('retries deletion until recurring cancellation is confirmed before disabling resources', async () => {
    const f = await fixture(); await paid(f); await deleting(f);
    const cancel = vi.spyOn(f.telegram, 'editUserStarSubscription').mockRejectedValueOnce(new TelegramError('retry', 'network_error')).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    for (let attempt = 0; attempt < 2; attempt++) {
      await f.processor.cancelDeleting();
      expect(await f.store.read(tx => tx.get<Workspace>('workspaces', f.actor.workspaceId))).toMatchObject({ state: 'deleting' });
      expect(await f.store.read(tx => tx.get<SourceBinding>('sourceBindings', f.binding.id))).toMatchObject({ state: 'active' });
      expect(await f.store.read(tx => tx.get<Destination>('destinations', f.destination.id))).toMatchObject({ state: 'active' });
      expect(await f.store.read(tx => tx.list<Subscription>('subscriptions', { workspaceId: f.actor.workspaceId }))).toMatchObject([{ renewalCanceled: false }]);
    }
    await f.processor.cancelDeleting();
    expect(cancel).toHaveBeenCalledTimes(3);
    expect(cancel).toHaveBeenLastCalledWith({ user_id: f.actor.telegramId, telegram_payment_charge_id: 'operations-charge', is_canceled: true });
    expect(await f.store.read(tx => tx.get<Workspace>('workspaces', f.actor.workspaceId))).toMatchObject({ state: 'deleted' });
    expect(await f.store.read(tx => tx.get<SourceBinding>('sourceBindings', f.binding.id))).toMatchObject({ state: 'disabled' });
    expect(await f.store.read(tx => tx.get<Destination>('destinations', f.destination.id))).toMatchObject({ state: 'disabled' });
    expect(await f.store.read(tx => tx.get<Route>('routes', f.route.id))).toMatchObject({ state: 'paused', pauseReason: 'workspace_deleted' });
    expect(await f.store.read(tx => tx.list<Session>('sessions', { workspaceId: f.actor.workspaceId }))).toHaveLength(0);
    expect(await f.store.read(tx => tx.list<Grant>('grants', { workspaceId: f.actor.workspaceId }))).toMatchObject([{ state: 'active' }]);
    await expect(f.auth.identity(f.actor.telegramId, 'Owner', true)).rejects.toMatchObject({ code: 'workspace_deleted' });
    await f.processor.cancelDeleting(); expect(cancel).toHaveBeenCalledTimes(3);
  });
  it('defers deletion when the initial recurring charge is missing', async () => {
    const f = await fixture(); await paid(f, false); await deleting(f);
    const cancel = vi.spyOn(f.telegram, 'editUserStarSubscription');
    await f.processor.cancelDeleting();
    expect(cancel).not.toHaveBeenCalled();
    expect(await f.store.read(tx => tx.get<Workspace>('workspaces', f.actor.workspaceId))).toMatchObject({ state: 'deleting' });
    expect(await f.store.read(tx => tx.get<SourceBinding>('sourceBindings', f.binding.id))).toMatchObject({ state: 'active' });
  });
  it('keeps the purchased interval after a confirmed user cancellation and downgrades at expiration', async () => {
    const f = await fixture(); await paid(f);
    const cancel = vi.spyOn(f.telegram, 'editUserStarSubscription').mockResolvedValue(true);
    const before = await f.billing.status(f.actor);
    expect(await f.billing.cancelRenewal(f.actor, f.telegram)).toMatchObject({ plan: 'starter', renewalCanceled: true, paidUntil: before.paidUntil });
    expect(cancel).toHaveBeenCalledTimes(1);
    vi.setSystemTime(new Date(START.getTime() + 29 * 86_400_000));
    expect((await f.billing.entitlements(f.actor.workspaceId)).plan).toBe('starter');
    vi.setSystemTime(new Date(START.getTime() + 30 * 86_400_000));
    expect(await f.billing.entitlements(f.actor.workspaceId)).toMatchObject({ plan: 'free', periodStart: nowISO(), remaining: 200, renewalCanceled: true });
  });
  it('processes Telegram cancellation through the persisted inbox once and retains paid access', async () => {
    const f = await fixture(); const receipt = await paid(f);
    const update = { update_id: 100, subscription: { user: { id: Number(f.actor.telegramId) }, invoice_payload: receipt.payload, state: 'canceled' } };
    await f.processor.receive(update);
    const id = stableId(f.feeds.config.BOT_ID, String(update.update_id));
    await f.processor.processInbox(id);
    expect(await f.billing.status(f.actor)).toMatchObject({ plan: 'starter', renewalCanceled: true });
    expect(await f.store.read(tx => tx.get('inbox', id))).toMatchObject({ state: 'processed' });
    await f.processor.receive(update); await f.processor.processInbox(id);
    expect(await f.store.read(tx => tx.list('billingEvents', { kind: 'subscription_update' }))).toHaveLength(1);
  });
  it('retries late subscription reactivation cancellation without resurrecting a deleted workspace', async () => {
    const f = await fixture(); const receipt = await paid(f); await deleting(f);
    const cancel = vi.spyOn(f.telegram, 'editUserStarSubscription').mockResolvedValue(true);
    await f.processor.cancelDeleting();
    const deleted = await f.store.read(tx => tx.get<Workspace>('workspaces', f.actor.workspaceId));
    const destination = await f.store.read(tx => tx.get<Destination>('destinations', f.destination.id));
    await f.billing.recordSubscriptionUpdate({ payload: receipt.payload, payerId: f.actor.telegramId, state: 'active', updateId: '999' });
    cancel.mockRejectedValueOnce(new TelegramError('retry', 'connection_failed')).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    for (let attempt = 0; attempt < 2; attempt++) {
      await f.processor.maintain();
      expect(await f.store.read(tx => tx.get<Workspace>('workspaces', f.actor.workspaceId))).toEqual(deleted);
      expect(await f.store.read(tx => tx.list<Subscription>('subscriptions', { workspaceId: f.actor.workspaceId }))).toMatchObject([{ renewalCanceled: false }]);
    }
    await f.processor.maintain();
    expect(cancel).toHaveBeenCalledTimes(4);
    expect(cancel).toHaveBeenLastCalledWith({ user_id: f.actor.telegramId, telegram_payment_charge_id: receipt.chargeId, is_canceled: true });
    expect(await f.store.read(tx => tx.get<Workspace>('workspaces', f.actor.workspaceId))).toEqual(deleted);
    expect(await f.store.read(tx => tx.get<Destination>('destinations', f.destination.id))).toEqual(destination);
    expect(await f.store.read(tx => tx.list<Subscription>('subscriptions', { workspaceId: f.actor.workspaceId }))).toMatchObject([{ renewalCanceled: true, renewalState: 'canceled' }]);
    await expect(f.auth.identity(f.actor.telegramId, 'Owner', true)).rejects.toMatchObject({ code: 'workspace_deleted' });
    await expect(f.billing.entitlements(f.actor.workspaceId)).rejects.toMatchObject({ code: 'workspace_forbidden' });
    await f.processor.maintain(); expect(cancel).toHaveBeenCalledTimes(4);
  });
  it('does not cancel a subscription whose recorded payer disagrees with its checkout owner', async () => {
    const f = await fixture(); await paid(f); await deleting(f);
    await f.store.transaction([], async tx => {
      const sub = (await tx.list<Subscription>('subscriptions', { workspaceId: f.actor.workspaceId }))[0]!;
      await tx.put('subscriptions', { ...sub, payerId: 'someone-else' });
    });
    const cancel = vi.spyOn(f.telegram, 'editUserStarSubscription');
    await f.processor.cancelDeleting();
    expect(cancel).not.toHaveBeenCalled();
    expect(await f.store.read(tx => tx.get<Workspace>('workspaces', f.actor.workspaceId))).toMatchObject({ state: 'deleting' });
  });
});

describe('uncertain send retention', () => {
  it('holds the original logical delivery quota after retries stop and maintenance runs days later', async () => {
    const f = await fixture(); const delivery = await publish(f);
    const send = vi.spyOn(f.telegram, 'call').mockRejectedValue(new TelegramError('unknown', 'connection_lost'));
    await f.processor.deliver(delivery.id);
    vi.setSystemTime(new Date(START.getTime() + 61_000)); await f.processor.deliver(delivery.id);
    expect(await f.store.read(tx => tx.get('deliveries', delivery.id))).toMatchObject({ state: 'needs_review', unknownRetries: 1, attemptCount: 2 });
    vi.setSystemTime(new Date(START.getTime() + 2 * 86_400_000)); await f.processor.maintain();
    expect(await f.billing.entitlements(f.actor.workspaceId)).toMatchObject({ used: 0, reserved: 1, remaining: 199 });
    expect(await f.store.read(tx => tx.list<UsageReservation>('reservations', { deliveryId: delivery.id }))).toHaveLength(1);
    await f.processor.deliver(delivery.id); expect(send).toHaveBeenCalledTimes(2);
  });
});
