// Executed through `docker compose exec -T ... node --input-type=module - ROLE`.
// The parent starts no Telegram control/delivery worker and blocks egress.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile, unlink } from 'node:fs/promises';

const role = process.argv[2];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const request = (url, options = {}) => fetch(url, { ...options, signal: AbortSignal.timeout(5000) });

assert.equal(process.getuid(), 1000, `${role} must run as the node user`);
const writeProbe = `/app/.feedrelay-smoke-${randomUUID()}`;
let writeError;
try { await writeFile(writeProbe, 'read-only filesystem probe'); }
catch (error) { writeError = error; }
if (!writeError) await unlink(writeProbe);
assert.equal(writeError?.code, 'EROFS', `${role} must have a read-only root filesystem`);

if (role === 'api') {
  assert.equal(process.env.MODE, 'production');
  assert.equal(process.env.TRUSTED_PROXY_CIDRS, '');
  for (const path of ['/health/live', '/health/ready', '/healthz']) {
    const response = await request(`http://127.0.0.1:4100${path}`);
    assert.equal(response.status, 200, path);
    assert.equal((await response.json()).ok, true, path);
  }
  const configResponse = await request('http://127.0.0.1:4100/api/config');
  assert.equal(configResponse.status, 200);
  const config = await configResponse.json();
  assert.equal(config.mode, 'production');
  assert.equal(config.billingEnabled, false);
  assert.equal(config.botUsername, 'FeedRelaySmokeFakeBot');
  for (const path of ['/api/me', '/api/sources', '/api/overview']) {
    assert.equal((await request(`http://127.0.0.1:4100${path}`)).status, 401, path);
  }
  const post = path => request(`http://127.0.0.1:4100${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}'
  });
  assert.equal((await post('/api/sources')).status, 401, 'anonymous mutation rejected');
  assert.equal((await post('/api/auth/demo')).status, 404, 'demo login disabled in production');
  assert.equal((await post('/api/telegram/webhook')).status, 403, 'unsigned webhook rejected');
  console.log('PASS API/database readiness, anonymous access rejection, production configuration, nonroot/read-only runtime.');
} else if (role === 'web') {
  let lastError;
  for (let attempt = 0; attempt < 45; attempt++) {
    try {
      const home = await request('http://127.0.0.1:3000/');
      assert.equal(home.status, 200);
      assert.match(await home.text(), /FeedRelay/);
      const proxy = await request('http://127.0.0.1:3000/api/config');
      assert.equal(proxy.status, 200);
      const config = await proxy.json();
      assert.equal(config.mode, 'production');
      assert.equal(config.billingEnabled, false);
      assert.equal((await request('http://127.0.0.1:3000/api/me')).status, 401);
      const sitemap = await request('http://127.0.0.1:3000/sitemap.xml');
      assert.equal(sitemap.status, 200);
      assert.match(await sitemap.text(), /https:\/\/smoke\.feedrelay\.invalid/);
      console.log('PASS web homepage, same-origin API rewrite, metadata, anonymous access rejection, nonroot/read-only runtime.');
      process.exit(0);
    } catch (error) { lastError = error; await delay(2000); }
  }
  throw lastError;
} else if (role === 'fetch-worker') {
  assert.equal(process.env.ROLE, 'fetch-worker');
  assert.equal(process.env.MODE, 'production');
  for (const key of ['BOT_TOKEN', 'WEBHOOK_SECRET', 'TELEGRAM_CLIENT_SECRET', 'TELEGRAM_CLIENT_ID']) {
    assert.equal(process.env[key], undefined, `${key} must be absent from the fetch worker`);
  }
  // An absent source returns before feed fetching. Completion demonstrates that
  // the real worker consumed this PostgreSQL-backed queue job without a send.
  const { PgBoss } = await import('pg-boss');
  const boss = new PgBoss({ connectionString: process.env.DATABASE_URL, schema: 'pgboss', max: 2, application_name: 'feedrelay-smoke-probe' });
  boss.on('error', error => console.error('Queue probe error:', error.message));
  try {
    await boss.start();
    const sourceId = `smoke-absent-source-${randomUUID()}`;
    const jobId = await boss.send('fetch', { id: sourceId }, { singletonKey: sourceId, retryLimit: 0 });
    assert.ok(jobId, 'queue must accept the harmless fetch job');
    let completed = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      const job = await boss.getJobById('fetch', jobId);
      if (job?.state === 'completed') { completed = true; break; }
      assert.notEqual(job?.state, 'failed', 'fetch worker must complete the queue probe');
      await delay(1000);
    }
    assert.ok(completed, 'real fetch worker must consume the pg-boss job within 60 seconds');
    console.log('PASS pg-boss dispatch/completion, fetch credential isolation, nonroot/read-only runtime.');
  } finally { await boss.stop({ graceful: true, timeout: 5000 }); }
} else {
  throw new Error(`Unknown smoke probe role: ${role}`);
}
