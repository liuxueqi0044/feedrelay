import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { BillingService } from '../../packages/billing/src/index.js';
import type { Delivery, Route, Workspace } from '../../packages/core/src/index.js';
import type { Config } from '../../apps/server/src/config.js';
import { MemoryStore } from '../../apps/server/src/infrastructure/store.js';
import { TelegramClient } from '../../apps/server/src/infrastructure/telegram.js';
import { AuthService } from '../../apps/server/src/services/auth.js';
import { FeedService } from '../../apps/server/src/services/feed-service.js';
import { Processor, type Inbox } from '../../apps/server/src/services/processor.js';
import { createApi } from '../../apps/server/src/api.js';

const START = new Date('2026-01-01T00:00:00.000Z');
const apps: Array<Awaited<ReturnType<typeof createApi>>> = [];
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(START); });
afterEach(async () => { for (const app of apps.splice(0)) await app.close(); vi.restoreAllMocks(); vi.useRealTimers(); });

async function fixture(mode: Config['MODE'] = 'demo', trustedProxies = '') {
  const config: Config = { MODE: mode, ROLE: 'all', NODE_ENV: 'test', PORT: 4100, HOST: '127.0.0.1', TRUSTED_PROXY_CIDRS: trustedProxies, PUBLIC_URL: mode === 'demo' ? 'http://localhost:3000' : 'https://feedrelay.example.com', BOT_ID: 'api-test-bot', BOT_USERNAME: 'ApiTestBot', BOT_TOKEN: 'test-only-token', WEBHOOK_SECRET: 'test-webhook-secret-with-at-least-32-characters', BILLING_ENABLED: 'false', STARTER_STARS: 300, SUPPORT_EMAIL: 'support@example.com', TERMS_URL: 'https://example.com/terms', DEMO_DATA_PATH: 'work/test-unused.json', LOG_LEVEL: 'silent', FETCH_CONCURRENCY: 4 };
  const store = new MemoryStore();
  const billing = new BillingService(store, { botId: config.BOT_ID, billingEnabled: false });
  const telegram = new TelegramClient(undefined, true);
  let messageId = 0;
  const platform = vi.spyOn(telegram, 'call').mockImplementation(async (method, body) => {
    const value = method === 'sendMessage' ? { message_id: ++messageId, date: Math.floor(Date.now() / 1000) }
      : method === 'getChat' ? { id: body.chat_id, type: 'channel', title: 'Test channel' }
      : method === 'getChatMember' ? { status: 'administrator', can_post_messages: true }
      : method === 'getStarTransactions' ? { transactions: [] }
      : method === 'getMe' ? { id: 123, username: config.BOT_USERNAME }
      : method === 'createInvoiceLink' ? 'https://t.me/invoice/mock'
      : true;
    return value as never;
  });
  const auth = new AuthService(store, config);
  const feeds = new FeedService(store, billing, telegram, config);
  const processor = new Processor(feeds, auth);
  const app = await createApi(config, auth, feeds, processor); apps.push(app);
  await app.ready();
  async function login(telegramId = '123456', name = 'Alice') {
    const account = await auth.login(telegramId, name);
    return { ...account, headers: { cookie: `fr_session=${account.token}`, 'x-csrf-token': account.csrf, origin: new URL(config.PUBLIC_URL).origin } };
  }
  return { app, config, store, billing, auth, feeds, processor, telegram, platform, login };
}

describe('API session and workspace boundaries', () => {
  it('round trips the built-in sandbox feed through OPML without allowing private or invalid production sources', async () => {
    const demo=await fixture(),account=await demo.login();
    await demo.feeds.addSource(account.actor,'https://demo.feedrelay.invalid/engineering.xml');
    const exported=await demo.app.inject({method:'GET',url:'/api/exports/opml',headers:account.headers});
    expect(exported.statusCode).toBe(200);expect(exported.headers['content-type']).toContain('application/xml');
    const preview=await demo.app.inject({method:'POST',url:'/api/imports/preview',headers:account.headers,payload:{opml:exported.body}});
    expect(preview.statusCode).toBe(200);expect(preview.json().feeds).toHaveLength(1);
    const imported=await demo.app.inject({method:'POST',url:'/api/imports',headers:account.headers,payload:{feeds:preview.json().feeds}});
    expect(imported.statusCode).toBe(200);expect(imported.json().results[0].error).toBeUndefined();expect(await demo.feeds.listSources(account.actor)).toHaveLength(1);
    const privateUrl='<opml version="2.0"><body><outline xmlUrl="http://127.0.0.1/feed"/></body></opml>';
    expect((await demo.app.inject({method:'POST',url:'/api/imports/preview',headers:account.headers,payload:{opml:privateUrl}})).statusCode).toBe(400);
    const prod=await fixture('production'),owner=await prod.login();
    expect((await prod.app.inject({method:'POST',url:'/api/imports/preview',headers:owner.headers,payload:{opml:exported.body}})).statusCode).toBe(400);
  });
  it('limits clients independently through a configured private proxy and ignores spoofed forwarded addresses from direct clients', async () => {
    const proxied = await fixture('production', '172.20.0.0/16');
    for (let i = 0; i < 120; i++) {
      const response = await proxied.app.inject({ method: 'GET', url: '/api/config', remoteAddress: '172.20.0.2', headers: { 'x-forwarded-for': '198.51.100.10' } });
      expect(response.statusCode).toBe(200);
    }
    expect((await proxied.app.inject({ method: 'GET', url: '/api/config', remoteAddress: '172.20.0.2', headers: { 'x-forwarded-for': '198.51.100.10' } })).statusCode).toBe(429);
    expect((await proxied.app.inject({ method: 'GET', url: '/api/config', remoteAddress: '172.20.0.2', headers: { 'x-forwarded-for': '198.51.100.11' } })).statusCode).toBe(200);
    for (let i = 0; i < 120; i++) {
      expect((await proxied.app.inject({ method: 'GET', url: '/api/config', remoteAddress: '203.0.113.10', headers: { 'x-forwarded-for': `198.51.100.${i + 1}` } })).statusCode).toBe(200);
    }
    expect((await proxied.app.inject({ method: 'GET', url: '/api/config', remoteAddress: '203.0.113.10', headers: { 'x-forwarded-for': '198.51.100.200' } })).statusCode).toBe(429);
    const direct = await fixture();
    for (let i = 0; i < 120; i++) {
      expect((await direct.app.inject({ method: 'GET', url: '/api/config', remoteAddress: '172.20.0.2', headers: { 'x-forwarded-for': `198.51.100.${i + 1}` } })).statusCode).toBe(200);
    }
    expect((await direct.app.inject({ method: 'GET', url: '/api/config', remoteAddress: '172.20.0.2', headers: { 'x-forwarded-for': '198.51.100.200' } })).statusCode).toBe(429);
  });
  it('requires a valid session and CSRF for writes and rejects foreign browser origins', async () => {
    const f = await fixture(); const account = await f.login();
    expect((await f.app.inject({ method: 'GET', url: '/api/me' })).statusCode).toBe(401);
    expect((await f.app.inject({ method: 'GET', url: '/api/me', headers: account.headers })).json().user.telegramId).toBe('123456');
    const write = { method: 'POST' as const, url: '/api/destination-bindings' };
    const noCsrf = await f.app.inject({ ...write, headers: { cookie: account.headers.cookie, origin: account.headers.origin } });
    expect(noCsrf.statusCode).toBe(403); expect(noCsrf.json().code).toBe('csrf_invalid');
    const invalid = await f.app.inject({ ...write, headers: { ...account.headers, 'x-csrf-token': 'wrong' } });
    expect(invalid.statusCode).toBe(403); expect(invalid.json().code).toBe('csrf_invalid');
    const unicode = await f.app.inject({ ...write, headers: { ...account.headers, 'x-csrf-token': 'é'.repeat(account.csrf.length) } });
    expect(unicode.statusCode).toBe(403); expect(unicode.json().code).toBe('csrf_invalid');
    const foreign = await f.app.inject({ ...write, headers: { ...account.headers, origin: 'https://attacker.example.com' } });
    expect(foreign.statusCode).toBe(403); expect(foreign.json().code).toBe('origin_forbidden');
    expect((await f.app.inject({ ...write, headers: account.headers })).statusCode).toBe(200);
    expect((await f.app.inject({ method: 'POST', url: '/api/auth/logout', headers: account.headers })).statusCode).toBe(200);
    expect((await f.app.inject({ method: 'GET', url: '/api/me', headers: account.headers })).statusCode).toBe(401);
  });
  it('sets a protected session cookie for demo login and hides demo operations in production', async () => {
    const demo = await fixture();
    const login = await demo.app.inject({ method: 'POST', url: '/api/auth/demo' });
    expect(login.statusCode).toBe(200); expect(login.headers['set-cookie']).toContain('HttpOnly'); expect(login.headers['set-cookie']).toContain('SameSite=Lax');
    expect(login.json().csrf).toHaveLength(43);
    const prod = await fixture('production'); const account = await prod.login();
    expect((await prod.app.inject({ method: 'POST', url: '/api/auth/demo' })).statusCode).toBe(404);
    expect((await prod.app.inject({ method: 'POST', url: '/api/demo/publish', headers: account.headers })).statusCode).toBe(404);
    const publicConfig = (await prod.app.inject({ method: 'GET', url: '/api/config' })).json();
    expect(publicConfig).toMatchObject({ mode: 'production', billingEnabled: false }); expect(publicConfig.botToken).toBeUndefined();
  });
  it('accepts signed Mini App login, uses a Secure cookie, and keeps Bot Start permission separate', async () => {
    const f = await fixture('production');
    const params = new URLSearchParams({ auth_date: String(Math.floor(START.getTime() / 1000)), query_id: 'test-query', user: JSON.stringify({ id: 123456, first_name: 'Alice' }) });
    const signed = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join('\n');
    const key = createHmac('sha256', 'WebAppData').update(f.config.BOT_TOKEN!).digest();
    params.set('hash', createHmac('sha256', key).update(signed).digest('hex'));
    const login = await f.app.inject({ method: 'POST', url: '/api/auth/miniapp', payload: { initData: params.toString(), telegramId: '987654' } });
    expect(login.statusCode).toBe(200); expect(login.headers['set-cookie']).toContain('Secure');
    expect(login.json().user).toMatchObject({ telegramId: '123456', privateChatStarted: false });
    const cookie = String(login.headers['set-cookie']).split(';')[0]!;
    expect((await f.app.inject({ method: 'POST', url: '/api/destinations/private', headers: { cookie, 'x-csrf-token': login.json().csrf, origin: new URL(f.config.PUBLIC_URL).origin } })).json().code).toBe('bot_not_started');
    params.set('user', JSON.stringify({ id: 987654, first_name: 'Mallory' }));
    expect((await f.app.inject({ method: 'POST', url: '/api/auth/miniapp', payload: { initData: params.toString() } })).statusCode).toBe(401);
  });
  it('does not let another tenant inspect or mutate source, route, destination or delivery IDs', async () => {
    const f = await fixture(); const alice = await f.login(); const bob = await f.login('987654', 'Bob');
    const source = await f.feeds.addSource(alice.actor, 'https://demo.feedrelay.invalid/rss');
    const destination = await f.feeds.privateDestination(alice.actor);
    const route = await f.feeds.saveRoute(alice.actor, { name: 'Alice news', sourceBindingId: source.id, destinationId: destination.id, requestedIntervalMinutes: 60 });
    const delivery = (await f.feeds.testDestination(alice.actor, destination.id))!;
    const foreign = [
      { method: 'GET' as const, url: `/api/sources/${source.id}/items` },
      { method: 'DELETE' as const, url: `/api/sources/${source.id}` },
      { method: 'POST' as const, url: `/api/routes/${route.id}/pause` },
      { method: 'POST' as const, url: `/api/destinations/${destination.id}/test` },
      { method: 'POST' as const, url: `/api/deliveries/${delivery.id}/retry`, payload: { acknowledgeDuplicateRisk: true } },
    ];
    for (const request of foreign) {
      const result = await f.app.inject({ ...request, headers: bob.headers });
      expect(result.statusCode).toBe(404); expect(result.json().code).toBe('not_found');
    }
    for (const url of ['/api/sources', '/api/routes', '/api/destinations', '/api/deliveries']) expect((await f.app.inject({ method: 'GET', url, headers: bob.headers })).json()).toEqual([]);
    expect((await f.app.inject({ method: 'POST', url: '/api/routes', headers: bob.headers, payload: { name: 'Borrowed', sourceBindingId: source.id, destinationId: destination.id, requestedIntervalMinutes: 60 } })).statusCode).toBe(404);
  });
});

describe('durable Telegram webhook ingestion', () => {
  it('authenticates the webhook secret and persists unique update IDs before processing, including out-of-order updates', async () => {
    const f = await fixture('production');
    const request = { method: 'POST' as const, url: '/api/telegram/webhook', payload: { update_id: 100 } };
    expect((await f.app.inject(request)).statusCode).toBe(403);
    expect((await f.app.inject({ ...request, headers: { 'x-telegram-bot-api-secret-token': 'wrong' } })).statusCode).toBe(403);
    expect(await f.store.read(tx => tx.list('inbox'))).toHaveLength(0);
    const headers = { 'x-telegram-bot-api-secret-token': f.config.WEBHOOK_SECRET! };
    for (const updateId of [100, 50, 100]) expect((await f.app.inject({ ...request, headers, payload: { update_id: updateId } })).statusCode).toBe(200);
    const inbox = await f.store.read(tx => tx.list<Inbox>('inbox'));
    expect(inbox.map(row => row.updateId).sort()).toEqual(['100', '50']); expect(inbox.every(row => row.state === 'pending')).toBe(true);
    expect(await f.store.read(tx => tx.list('outbox', { type: 'inbox' }))).toHaveLength(2);
    expect(f.platform).not.toHaveBeenCalled();
    for (const row of inbox) await f.processor.processInbox(row.id);
    expect((await f.store.read(tx => tx.list<Inbox>('inbox'))).every(row => row.state === 'processed')).toBe(true);
    expect((await f.app.inject({ ...request, headers, payload: { update_id: -1 } })).statusCode).toBe(400);
  });
  it('rejects webhook ingress in demo mode even if its secret matches', async () => {
    const f = await fixture();
    expect((await f.app.inject({ method: 'POST', url: '/api/telegram/webhook', headers: { 'x-telegram-bot-api-secret-token': f.config.WEBHOOK_SECRET! }, payload: { update_id: 1 } })).statusCode).toBe(403);
    expect(await f.store.read(tx => tx.list('inbox'))).toHaveLength(0);
  });
  it('does not acknowledge a webhook until its inbox and outbox write commits', async () => {
    const f = await fixture('production');
    vi.spyOn(f.store, 'transaction').mockRejectedValueOnce(new Error('database_unavailable'));
    const request = { method: 'POST' as const, url: '/api/telegram/webhook', headers: { 'x-telegram-bot-api-secret-token': f.config.WEBHOOK_SECRET! }, payload: { update_id: 200 } };
    expect((await f.app.inject(request)).statusCode).toBe(500);
    expect(await f.store.read(tx => tx.list('inbox'))).toHaveLength(0);
    expect((await f.app.inject(request)).statusCode).toBe(200);
    expect(await f.store.read(tx => tx.list('inbox'))).toHaveLength(1);
    expect(await f.store.read(tx => tx.list('outbox', { type: 'inbox' }))).toHaveLength(1);
  });
});

describe('complete dashboard setup and controls', () => {
  it('sets up a route, skips historical baseline, sends a test and update, exposes logs, and safely deletes the workspace', async () => {
    const f = await fixture(); const account = await f.login(); const headers = account.headers;
    const sourceResponse = await f.app.inject({ method: 'POST', url: '/api/sources', headers, payload: { url: 'https://demo.feedrelay.invalid/rss' } });
    expect(sourceResponse.statusCode).toBe(201); const source = sourceResponse.json();
    const destinationResponse = await f.app.inject({ method: 'POST', url: '/api/destinations/private', headers });
    expect(destinationResponse.statusCode).toBe(200); const destination = destinationResponse.json();
    const routeResponse = await f.app.inject({ method: 'POST', url: '/api/routes', headers, payload: { name: 'Demo news', sourceBindingId: source.id, destinationId: destination.id, requestedIntervalMinutes: 60 } });
    expect(routeResponse.statusCode).toBe(201); const route = routeResponse.json(); expect(route.state).toBe('initializing');
    await f.processor.fetchSource(source.sourceId); await f.processor.releaseRoute(route.id);
    expect(await f.store.read(tx => tx.list('deliveries', { kind: 'article' }))).toHaveLength(0);
    expect((await f.app.inject({ method: 'GET', url: `/api/sources/${source.id}/items`, headers })).json()).toHaveLength(2);
    expect((await f.app.inject({ method: 'POST', url: `/api/routes/${route.id}/preview`, headers })).json().matches).toBe(true);
    const test = await f.app.inject({ method: 'POST', url: `/api/destinations/${destination.id}/test`, headers });
    expect(test.statusCode).toBe(200); await f.processor.deliver(test.json().id);
    expect((await f.app.inject({ method: 'POST', url: '/api/demo/publish', headers })).json()).toEqual({ queued: true });
    await f.processor.fetchSource(source.sourceId); await f.processor.releaseRoute(route.id);
    const article = (await f.store.read(tx => tx.list<Delivery>('deliveries', { kind: 'article' })))[0]!;
    vi.setSystemTime(new Date(START.getTime() + 1300)); await f.processor.deliver(article.id);
    const logs = (await f.app.inject({ method: 'GET', url: '/api/deliveries', headers })).json();
    expect(logs).toHaveLength(2); expect(logs.every((row: Delivery) => row.state === 'sent')).toBe(true);
    expect((await f.app.inject({ method: 'GET', url: '/api/overview', headers })).json()).toMatchObject({ sources: 1, destinations: 1, routes: 1, sent: 2, usage: { used: 2 } });
    expect((await f.app.inject({ method: 'POST', url: `/api/routes/${route.id}/pause`, headers })).json().state).toBe('paused');
    expect((await f.app.inject({ method: 'POST', url: `/api/routes/${route.id}/backfill`, headers, payload: { limit: 1 } })).statusCode).toBe(409);
    expect((await f.app.inject({ method: 'POST', url: `/api/routes/${route.id}/resume`, headers, payload: { backlog: 'skip' } })).json().state).toBe('active');
    expect((await f.app.inject({ method: 'POST', url: `/api/routes/${route.id}/backfill`, headers, payload: { limit: 21 } })).statusCode).toBe(400);
    expect((await f.app.inject({ method: 'POST', url: `/api/routes/${route.id}/backfill`, headers, payload: { limit: 2 } })).json().queued).toBe(1);
    expect((await f.app.inject({ method: 'DELETE', url: '/api/workspace', headers, payload: { confirmation: 'wrong' } })).statusCode).toBe(400);
    expect((await f.app.inject({ method: 'DELETE', url: '/api/workspace', headers, payload: { confirmation: 'DELETE' } })).json()).toEqual({ state: 'deleting' });
    expect((await f.app.inject({ method: 'GET', url: '/api/me', headers })).statusCode).toBe(401);
    const before = f.platform.mock.calls.length; await f.processor.cancelDeleting();
    for (const row of await f.store.read(tx => tx.list<Delivery>('deliveries', { state: 'pending' }))) await f.processor.deliver(row.id);
    expect(f.platform.mock.calls).toHaveLength(before);
    expect(await f.store.read(tx => tx.get<Workspace>('workspaces', account.actor.workspaceId))).toMatchObject({ state: 'deleted' });
    expect(await f.store.read(tx => tx.get<Route>('routes', route.id))).toMatchObject({ state: 'paused', pauseReason: 'workspace_deleted' });
  });
  it('validates public feed input and exports/import-previews safe OPML in production', async () => {
    const f = await fixture('production'); const account = await f.login();
    for (const url of ['http://127.0.0.1/rss', 'https://example.com/rss?token=secret', 'https://example.com:8080/rss']) expect((await f.app.inject({ method: 'POST', url: '/api/sources', headers: account.headers, payload: { url } })).statusCode).toBe(400);
    expect((await f.app.inject({ method: 'POST', url: '/api/sources', headers: account.headers, payload: { url: 'https://feed.example.com/rss?a=1&b=2' } })).statusCode).toBe(201);
    expect(f.platform).not.toHaveBeenCalled();
    const exported = await f.app.inject({ method: 'GET', url: '/api/exports/opml', headers: account.headers });
    expect(exported.statusCode).toBe(200); expect(exported.headers['content-type']).toContain('application/xml'); expect(exported.body).toContain('&amp;');
    const preview = await f.app.inject({ method: 'POST', url: '/api/imports/preview', headers: account.headers, payload: { opml: exported.body } });
    expect(preview.statusCode).toBe(200); expect(preview.json().feeds).toHaveLength(1);
    expect((await f.app.inject({ method: 'POST', url: '/api/imports/preview', headers: account.headers, payload: { opml: '<!DOCTYPE opml><opml><body/></opml>' } })).statusCode).toBe(400);
    const dest = await f.app.inject({ method: 'POST', url: '/api/destinations/private', headers: account.headers });
    expect(dest.statusCode).toBe(409); expect(dest.json().code).toBe('bot_not_started');
  });
});
