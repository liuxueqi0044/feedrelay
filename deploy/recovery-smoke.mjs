#!/usr/bin/env node
// Synthetic, port-free PostgreSQL logical recovery drill. Never reads production config.
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}
const serverImage = option('--server-image', process.env.FEEDRELAY_SERVER_IMAGE ?? 'feedrelay-server:local');
const postgresImage = option('--postgres-image', 'postgres:16-bookworm');
const prefix = `feedrelay-recovery-${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}-${randomBytes(8).toString('hex')}`;
const label = 'com.feedrelay.recovery-smoke';
const network = `${prefix}-internal`;
const names = { source: `${prefix}-source`, target: `${prefix}-target`, helper: `${prefix}-helper` };
const volumes = { source: `${prefix}-source-data`, target: `${prefix}-target-data` };
const alias = `feedrelay-recovery:${prefix}`;
const database = 'feedrelay_recovery';
const username = 'recovery';
const password = randomBytes(24).toString('hex');
const created = { containers: new Set(), volumes: new Set(), network: false, alias: false };
const phases = {};
const started = performance.now();
const children = new Map();
let interrupted;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  if (!interrupted) console.error(`[${prefix}] ${signal} received; cleaning owned resources`);
  interrupted ??= signal;
  // Cleanup commands must finish even if another interrupt arrives.
  for (const [child, isCleanup] of children) if (!isCleanup) child.kill('SIGTERM');
});
// SIGKILL, a host shutdown or an unavailable daemon cannot guarantee cleanup.
const interruptionError = () => new Error(`Recovery drill interrupted by ${interrupted}; cleaning owned resources`);

async function docker(args, { input, timeout = 180_000, allowFailure = false, cleanup = false } = {}) {
  if (interrupted && !cleanup) throw interruptionError();
  return await new Promise((resolve, reject) => {
    const child = spawn('docker', args, { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    children.set(child, cleanup);
    const stdout = [], stderr = [];
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeout);
    child.stdout.on('data', part => stdout.push(part));
    child.stderr.on('data', part => stderr.push(part));
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') reject(error); });
    child.on('error', error => { clearTimeout(timer); children.delete(child); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      children.delete(child);
      const result = { code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) };
      if (interrupted && !cleanup) reject(interruptionError());
      else if (timedOut || (code !== 0 && !allowFailure)) {
        // Args may contain the throwaway DB password; do not print them.
        reject(new Error(`Docker ${args[0]} ${timedOut ? 'timed out' : `failed (${code})`}: ${result.stderr.toString().trim()}`));
      } else resolve(result);
    });
    child.stdin.end(input);
  });
}
async function phase(name, run, { cleanup = false } = {}) {
  if (interrupted && !cleanup) throw interruptionError();
  console.log(`[${prefix}] ${name}`);
  const begin = performance.now();
  const result = await run();
  phases[name] = Number(((performance.now() - begin) / 1000).toFixed(3));
  return result;
}
async function inspect(kind, name, options = {}) {
  const result = await docker([kind, 'inspect', name], options);
  if (result.code !== 0 && options.allowFailure) return undefined;
  return JSON.parse(result.stdout.toString())[0];
}
async function localEngine() {
  // Context commands read local metadata; reject remote endpoints before daemon requests.
  const context = (await docker(['context', 'show'])).stdout.toString().trim();
  const contexts = JSON.parse((await docker(['context', 'inspect', context])).stdout.toString());
  const endpoint = process.env.DOCKER_CONTEXT ? contexts[0]?.Endpoints?.docker?.Host
    : process.env.DOCKER_HOST || contexts[0]?.Endpoints?.docker?.Host;
  let local = false;
  try {
    const url = new URL(endpoint);
    const hostname = url.hostname.toLowerCase();
    local = url.protocol === 'unix:' && ['', 'localhost'].includes(hostname)
      || url.protocol === 'npipe:' && /^npipe:\/{2,4}(?:\.|localhost)\/pipe\//i.test(endpoint.replaceAll('\\', '/'))
      || url.protocol === 'tcp:' && ['127.0.0.1', 'localhost', '[::1]'].includes(hostname);
  } catch { /* Missing or malformed endpoints are refused. */ }
  if (!local) throw new Error(`Recovery drill requires a local Docker engine; refusing endpoint ${endpoint}`);
  const info = JSON.parse((await docker(['info', '--format', '{{json .}}'])).stdout.toString());
  if (info.OSType !== 'linux') throw new Error('Recovery drill requires Docker Linux containers');
  return { context, endpoint, version: info.ServerVersion, operatingSystem: info.OperatingSystem };
}
async function waitPostgres(name) {
  const deadline = performance.now() + 120_000;
  while (performance.now() < deadline) {
    const result = await docker(['exec', name, 'pg_isready', '-U', username, '-d', database], { allowFailure: true, timeout: 10_000 });
    if (result.code === 0) return;
    const state = await inspect('container', name);
    if (!state.State.Running) {
      const logs = await docker(['logs', '--tail', '35', name]);
      throw new Error(`Isolated PostgreSQL exited: ${logs.stderr.toString()} ${logs.stdout.toString()}`);
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(`Isolated PostgreSQL readiness timed out: ${name}`);
}

// This helper is piped into the existing server runtime, with no Telegram token or app config.
// BillingService below only writes synthetic receipts; no Telegram client is constructed.
const fixture = String.raw`
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { tables, DEFAULT_RULES } from '@feedrelay/core';
import { BillingService, SUBSCRIPTION_PERIOD_SECONDS } from '@feedrelay/billing';
import { PostgresStore, sqlNames } from './src/infrastructure/store.ts';
import { migrate } from './src/infrastructure/migrations.ts';

const store = new PostgresStore(process.env.DATABASE_URL);
const at = '2026-10-04T00:00:00.000Z';
const start = '2026-10-03T00:00:00.000Z';
const end = new Date(Date.parse(start) + SUBSCRIPTION_PERIOD_SECONDS * 1000).toISOString();
const renewalEnd = new Date(Date.parse(end) + SUBSCRIPTION_PERIOD_SECONDS * 1000).toISOString();
const actor = { userId: 'recovery-user', workspaceId: 'recovery-workspace', telegramId: '999999991' };
const billing = new BillingService(store, { botId: 'synthetic-recovery-bot', priceStars: 300, billingEnabled: true, termsUrl: 'https://recovery.invalid/terms', supportContact: 'recovery@example.invalid', clock: () => at });
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
async function snapshot() {
  return store.read(async tx => Object.fromEntries(await Promise.all(tables.map(async table => [table, (await tx.list(table)).sort((a,b) => a.id.localeCompare(b.id))]))));
}
async function seed() {
  await migrate(store.pool);
  await store.transaction(['workspace:' + actor.workspaceId], async tx => {
    await tx.put('users', { id: actor.userId, createdAt: start, telegramId: actor.telegramId, name: 'Synthetic recovery owner', privateChatStarted: true });
    await tx.put('workspaces', { id: actor.workspaceId, createdAt: start, ownerId: actor.userId, name: 'Synthetic recovery workspace', state: 'active', freeAnchor: start, version: 3 });
    await tx.put('sources', { id: 'recovery-source', createdAt: start, url: 'https://recovery.invalid/feed.xml', urlHash: 'synthetic-unique-url-hash', resolvedUrl: 'https://recovery.invalid/feed.xml', title: 'Synthetic engineering feed', state: 'healthy', seq: 2, etag: 'recovery-etag-v2', checkedAt: at, lastSuccessAt: at, nextPollAt: end, leaseVersion: 7, failures: 0 });
    await tx.put('sourceBindings', { id: 'recovery-binding', createdAt: start, workspaceId: actor.workspaceId, sourceId: 'recovery-source', title: 'Owner feed binding', state: 'active', version: 2 });
    await tx.put('destinations', { id: 'recovery-destination', createdAt: start, workspaceId: actor.workspaceId, chatId: '-1009999999991', title: 'Synthetic channel', kind: 'channel', authorizedBy: actor.userId, state: 'active', version: 2, verifiedAt: at });
    for (const seq of [1, 2]) {
      await tx.put('items', { id: 'recovery-item-' + seq, createdAt: start, sourceId: 'recovery-source', seq, title: 'Recovery article ' + seq, summary: 'Synthetic retained body with Unicode: 恢复验证 & <markup>', url: 'https://recovery.invalid/article/' + seq, externalId: 'external-' + seq, contentHash: 'synthetic-content-' + seq, revision: seq, publishedAt: start, updatedAt: at });
      await tx.put('itemAliases', { id: 'recovery-alias-' + seq, createdAt: start, sourceId: 'recovery-source', itemId: 'recovery-item-' + seq, key: 'external:external-' + seq });
    }
    await tx.put('routes', { id: 'recovery-route', createdAt: start, workspaceId: actor.workspaceId, sourceBindingId: 'recovery-binding', sourceId: 'recovery-source', destinationId: 'recovery-destination', name: 'Synthetic filtered route', state: 'active', cursor: 2, baselineSeq: 1, requestedIntervalMinutes: 60, nextReleaseAt: end, baselineAfter: start, rules: { ...DEFAULT_RULES, include: ['Recovery'], exclude: ['skip'], summaryLength: 350 }, version: 4 });
    for (const [seq, state] of [[1, 'sent'], [2, 'unknown']]) {
      await tx.put('deliveries', { id: 'recovery-delivery-' + seq, createdAt: start, workspaceId: actor.workspaceId, routeId: 'recovery-route', itemId: 'recovery-item-' + seq, destinationId: 'recovery-destination', chatId: '-1009999999991', enqueueSeq: seq, kind: 'article', text: 'Retained recovery message ' + seq, state, nextAttemptAt: end, eligibleAt: at, attemptCount: seq, unknownRetries: seq === 2 ? 1 : 0, version: 6, attemptId: 'recovery-attempt-' + seq, ruleVersion: 4, destinationVersion: 2, routeVersion: 4, ...(state === 'sent' ? { messageId: '9001', sentAt: at } : { error: 'worker_interrupted_after_send' }) });
      await tx.put('attempts', { id: 'recovery-attempt-' + seq, createdAt: at, workspaceId: actor.workspaceId, deliveryId: 'recovery-delivery-' + seq, number: seq, state, finishedAt: at, ...(state === 'sent' ? { messageId: '9001' } : { error: 'worker_interrupted_after_send' }) });
    }
    await tx.put('outbox', { id: 'recovery-outbox-fetch', createdAt: at, type: 'fetch', aggregateId: 'recovery-source', state: 'pending' });
    await tx.put('outbox', { id: 'recovery-outbox-deliver', createdAt: at, workspaceId: actor.workspaceId, type: 'deliver', aggregateId: 'recovery-delivery-2', state: 'pending' });
    await tx.put('audit', { id: 'recovery-audit', createdAt: at, workspaceId: actor.workspaceId, actorId: actor.userId, action: 'synthetic_recovery_drill', targetId: 'recovery-route', details: { synthetic: true } });
  });
  const checkout = await billing.checkout(actor, true, 'synthetic-recovery-checkout');
  const precheck = await billing.validatePreCheckout(checkout.payload, actor.telegramId, 'XTR', 300, 'synthetic-precheckout');
  assert.equal(precheck.ok, true);
  assert.equal((await billing.recordPayment({ chargeId: 'synthetic-charge-first', payload: checkout.payload, payerId: actor.telegramId, currency: 'XTR', totalAmount: 300, expirationDate: end, paidAt: start, isRecurring: true, isFirstRecurring: true })).state, 'applied');
  assert.equal((await billing.recordPayment({ chargeId: 'synthetic-charge-renewal', payload: checkout.payload, payerId: actor.telegramId, currency: 'XTR', totalAmount: 300, expirationDate: renewalEnd, paidAt: at, isRecurring: true, isFirstRecurring: false })).state, 'applied');
  assert.equal((await billing.recordRefund({ chargeId: 'synthetic-charge-renewal', payload: checkout.payload, payerId: actor.telegramId, currency: 'XTR', totalAmount: 300, refundedAt: at })).state, 'applied');
  await store.transaction(['workspace:' + actor.workspaceId], async tx => {
    for (const seq of [1, 2]) {
      const id = 'recovery-delivery-' + seq;
      const reserved = await billing.reserveUsage(tx, actor.workspaceId, id);
      assert.equal(reserved.ok, true);
      const delivery = await tx.get('deliveries', id);
      await tx.put('deliveries', { ...delivery, reservationId: reserved.reservationId });
      if (seq === 1) await billing.commitUsage(tx, actor.workspaceId, id);
      else await billing.releaseUsage(tx, actor.workspaceId, id, { preserveUnknown: true });
    }
  });
}
async function verify(snapshot) {
  const one = (table, id) => { const row = snapshot[table].find(row => row.id === id); assert.ok(row, table + ':' + id); return row; };
  const workspace = one('workspaces', actor.workspaceId);
  assert.equal(workspace.ownerId, one('users', actor.userId).id);
  const binding = one('sourceBindings', 'recovery-binding');
  const source = one('sources', binding.sourceId);
  const route = one('routes', 'recovery-route');
  assert.equal(route.workspaceId, binding.workspaceId);
  assert.equal(route.sourceId, source.id);
  assert.equal(route.sourceBindingId, binding.id);
  assert.equal(route.destinationId, one('destinations', 'recovery-destination').id);
  assert.equal(route.cursor, 2); assert.equal(route.baselineSeq, 1); assert.equal(source.seq, 2);
  assert.deepEqual(route.rules.include, ['Recovery']);
  assert.equal(one('items', 'recovery-item-2').summary, 'Synthetic retained body with Unicode: 恢复验证 & <markup>');
  const sent = one('deliveries', 'recovery-delivery-1');
  const unknown = one('deliveries', 'recovery-delivery-2');
  assert.equal(sent.state, 'sent'); assert.equal(sent.messageId, '9001'); assert.equal(sent.sentAt, at);
  assert.equal(unknown.state, 'unknown'); assert.equal(unknown.unknownRetries, 1); assert.equal(unknown.attemptCount, 2); assert.equal(unknown.messageId, undefined);
  assert.equal(one('attempts', unknown.attemptId).state, 'unknown');
  assert.equal(one('reservations', sent.reservationId).state, 'committed');
  assert.equal(one('reservations', unknown.reservationId).state, 'unknown');
  assert.equal(snapshot.ledger.length, 1); assert.equal(snapshot.ledger[0].deliveryId, sent.id); assert.equal(snapshot.ledger[0].reservationId, sent.reservationId);
  assert.equal(snapshot.payments.length, 2); assert.equal(snapshot.grants.length, 2); assert.equal(snapshot.refunds.length, 1);
  for (const grant of snapshot.grants) {
    const payment = snapshot.payments.find(row => row.chargeId === grant.chargeId && row.botId === grant.botId);
    assert.ok(payment); assert.equal(grant.workspaceId, payment.workspaceId);
    assert.equal(grant.endsAt, payment.expirationDate);
    assert.equal(Date.parse(grant.endsAt) - Date.parse(grant.startsAt), SUBSCRIPTION_PERIOD_SECONDS * 1000);
    assert.ok(snapshot.checkouts.some(row => row.id === grant.checkoutId && row.payload === payment.payload));
    assert.equal(grant.state === 'active', payment.state === 'applied');
  }
  assert.equal(snapshot.grants.find(row => row.chargeId === 'synthetic-charge-renewal').state, 'revoked');
  assert.equal(snapshot.refunds[0].chargeId, 'synthetic-charge-renewal');
  assert.equal(snapshot.subscriptions[0].firstChargeId, 'synthetic-charge-first');
  assert.equal(snapshot.outbox.length, 2); assert.ok(snapshot.outbox.every(row => row.state === 'pending'));
  const entitlement = await billing.entitlements(actor.workspaceId);
  assert.equal(entitlement.plan, 'starter'); assert.equal(entitlement.used, 1); assert.equal(entitlement.reserved, 1); assert.equal(entitlement.paidUntil, end);
  const period = one('usagePeriods', entitlement.periodId);
  assert.equal(period.used, 1); assert.equal(period.reserved, 1); assert.equal(period.limit, 5000);
  return { plan: entitlement.plan, used: entitlement.used, reserved: entitlement.reserved, paidUntil: entitlement.paidUntil };
}
async function constraints(snapshot) {
  const checked = [];
  async function rejects(label, table, row, code, columnId = row.id, columnWorkspace = row.workspaceId ?? null) {
    const client = await store.pool.connect();
    try {
      await client.query('BEGIN');
      let error;
      try { await client.query('INSERT INTO ' + sqlNames[table] + '(id,workspace_id,created_at,data) VALUES($1,$2,$3,$4::jsonb)', [columnId, columnWorkspace, row.createdAt, JSON.stringify(row)]); }
      catch (caught) { error = caught; }
      assert.equal(error?.code, code, label + ' must reject with SQLSTATE ' + code);
      checked.push(label);
    } finally { await client.query('ROLLBACK'); client.release(); }
  }
  for (const [table, label] of [['users','telegram_identity_unique'],['sources','source_url_unique'],['sourceBindings','active_binding_unique'],['destinations','active_chat_unique'],['items','source_sequence_unique'],['routes','active_route_unique'],['deliveries','logical_delivery_unique'],['ledger','logical_usage_unique'],['payments','charge_unique'],['grants','paid_grant_charge_unique'],['reservations','delivery_period_unique']]) {
    const row = { ...snapshot[table][0], id: 'constraint-probe-' + table };
    await rejects(label, table, row, '23505');
  }
  await rejects('id_envelope_check', 'audit', { id: 'different-data-id', createdAt: at }, '23514', 'constraint-envelope-id');
  await rejects('workspace_envelope_check', 'audit', { id: 'constraint-envelope-workspace', createdAt: at, workspaceId: actor.workspaceId }, '23514', 'constraint-envelope-workspace', 'wrong-workspace');
  return checked;
}
try {
  if (process.env.RECOVERY_PHASE === 'seed') await seed();
  const rows = await snapshot();
  const entitlement = await verify(rows);
  const checked = await constraints(rows);
  const migrationVersions = (await store.pool.query('SELECT version FROM fr_migrations ORDER BY version')).rows.map(row => row.version);
  const digest = createHash('sha256').update(JSON.stringify(canonical(rows))).digest('hex');
  if (process.env.RECOVERY_EXPECTED_DIGEST) assert.equal(digest, process.env.RECOVERY_EXPECTED_DIGEST, 'every retained business envelope must match the source');
  console.log('RECOVERY_SMOKE_RESULT=' + JSON.stringify({ digest, rowCounts: Object.fromEntries(tables.map(table => [table, rows[table].length])), totalRows: tables.reduce((sum, table) => sum + rows[table].length, 0), migrationVersions, constraints: checked, entitlement }));
} finally { await store.close(); }
`;

async function runFixture(phaseName, host, digest) {
  created.containers.add(names.helper);
  const args = ['run', '--rm', '-i', '--name', names.helper, '--label', `${label}=${prefix}`, '--network', network, '--read-only', '--tmpfs', '/tmp:mode=1777', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--workdir', '/app/apps/server', '-e', `DATABASE_URL=postgres://${username}:${password}@${host}:5432/${database}`, '-e', `RECOVERY_PHASE=${phaseName}`];
  if (digest) args.push('-e', `RECOVERY_EXPECTED_DIGEST=${digest}`);
  args.push('--entrypoint', 'node', alias, '--import', 'tsx', '--input-type=module');
  const result = await docker(args, { input: fixture });
  const line = result.stdout.toString().split(/\r?\n/).find(line => line.startsWith('RECOVERY_SMOKE_RESULT='));
  if (!line) throw new Error(`Fixture produced no result: ${result.stdout.toString()}`);
  return JSON.parse(line.slice('RECOVERY_SMOKE_RESULT='.length));
}

async function cleanup() {
  const failures = [];
  for (const name of created.containers) {
    const found = await docker(['container', 'inspect', name], { allowFailure: true, cleanup: true });
    if (found.code !== 0) continue;
    const details = JSON.parse(found.stdout.toString())[0];
    if (details.Config.Labels?.[label] !== prefix) { failures.push(`Container label mismatch: ${name}`); continue; }
    const result = await docker(['container', 'rm', '--force', name], { allowFailure: true, cleanup: true });
    if (result.code !== 0) failures.push(result.stderr.toString().trim());
  }
  for (const name of created.volumes) {
    const details = await inspect('volume', name, { allowFailure: true, cleanup: true });
    if (!details) continue;
    if (details.Labels?.[label] !== prefix) { failures.push(`Volume label mismatch: ${name}`); continue; }
    const result = await docker(['volume', 'rm', name], { allowFailure: true, cleanup: true });
    if (result.code !== 0) failures.push(result.stderr.toString().trim());
  }
  if (created.network) {
    const details = await inspect('network', network, { allowFailure: true, cleanup: true });
    if (details && details.Labels?.[label] !== prefix) failures.push(`Network label mismatch: ${network}`);
    else if (details) {
      const result = await docker(['network', 'rm', network], { allowFailure: true, cleanup: true });
      if (result.code !== 0) failures.push(result.stderr.toString().trim());
    }
  }
  if (created.alias) {
    if (await inspect('image', alias, { allowFailure: true, cleanup: true })) {
      const result = await docker(['image', 'rm', alias], { allowFailure: true, cleanup: true });
      if (result.code !== 0) failures.push(result.stderr.toString().trim());
    }
  }
  if (failures.length) throw new Error(`Own-resource cleanup failed: ${failures.join('; ')}`);
}

let report;
let failure;
try {
  const engine = await phase('check_local_engine', localEngine);
  const images = await phase('inspect_images', async () => {
    await docker(['image', 'inspect', serverImage]);
    const present = await docker(['image', 'inspect', postgresImage], { allowFailure: true });
    if (present.code !== 0) await docker(['pull', postgresImage], { timeout: 300_000 });
    created.alias = true;
    await docker(['image', 'tag', serverImage, alias]);
    return { server: { requested: serverImage, alias, ...pickImage(await inspect('image', alias)) }, postgres: { requested: postgresImage, ...pickImage(await inspect('image', postgresImage)) } };
  });
  await phase('start_isolated_databases', async () => {
    // Register names before mutation: an interrupted CLI can lose a successful reply.
    created.network = true;
    await docker(['network', 'create', '--internal', '--label', `${label}=${prefix}`, network]);
    const net = await inspect('network', network);
    if (!net.Internal) throw new Error('Recovery network must be internal');
    for (const role of ['source', 'target']) {
      created.volumes.add(volumes[role]);
      await docker(['volume', 'create', '--label', `${label}=${prefix}`, volumes[role]]);
      created.containers.add(names[role]);
      await docker(['run', '-d', '--name', names[role], '--label', `${label}=${prefix}`, '--network', network, '--user', 'postgres', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--tmpfs', '/tmp:mode=1777', '--tmpfs', '/var/run/postgresql:uid=999,gid=999,mode=0755', '-v', `${volumes[role]}:/var/lib/postgresql/data`, '-e', `POSTGRES_DB=${database}`, '-e', `POSTGRES_USER=${username}`, '-e', `POSTGRES_PASSWORD=${password}`, '-e', 'POSTGRES_INITDB_ARGS=--auth-host=scram-sha-256', postgresImage]);
      const details = await inspect('container', names[role]);
      if (Object.keys(details.HostConfig.PortBindings ?? {}).length || Object.keys(details.NetworkSettings.Networks).join() !== network) throw new Error('Recovery database isolation check failed');
    }
    await Promise.all(Object.values(names).filter(name => name !== names.helper).map(waitPostgres));
  });
  const source = await phase('migrate_seed_and_verify_source', () => runFixture('seed', names.source));
  const dump = await phase('pg_dump_custom', async () => (await docker(['exec', names.source, 'pg_dump', '-U', username, '-d', database, '--format=custom', '--no-acl'])).stdout);
  if (dump.subarray(0, 5).toString() !== 'PGDMP') throw new Error('Expected a PostgreSQL custom archive');
  const catalog = await phase('check_archive_catalog', async () => (await docker(['exec', '-i', names.target, 'pg_restore', '--list'], { input: dump })).stdout.toString());
  if (!catalog.includes('fr_deliveries') || !catalog.includes('fr_payments')) throw new Error('Custom archive is missing business tables');
  await phase('pg_restore_single_transaction', () => docker(['exec', '-i', names.target, 'pg_restore', '-U', username, '-d', database, '--no-owner', '--no-privileges', '--exit-on-error', '--single-transaction'], { input: dump }));
  const target = await phase('verify_restored_business_state', () => runFixture('verify', names.target, source.digest));
  if (JSON.stringify(source.migrationVersions) !== JSON.stringify(target.migrationVersions)) throw new Error('Migration versions changed during restore');
  report = { success: true, project: prefix, completedAt: new Date().toISOString(), engine, images, archive: { format: 'custom', bytes: dump.length, sha256: createHash('sha256').update(dump).digest('hex'), retained: false }, source, restored: target, isolation: { networkInternal: true, publishedPorts: 0, realDatabaseAccess: false, telegramClients: 0 }, unverified: ['age encryption/decryption', 'off-host transfer and retention', 'production-scale RTO/RPO', 'pg-boss queue recovery', 'Telegram reconciliation and production worker recovery'] };
} catch (error) {
  failure = error;
} finally {
  try { await phase('cleanup_owned_resources', cleanup, { cleanup: true }); }
  catch (error) { failure = failure ? new AggregateError([failure, error], 'Recovery drill and cleanup failed') : error; }
}
if (failure) {
  console.error(failure);
  console.error(JSON.stringify({ success: false, project: prefix, phasesSeconds: phases, totalSeconds: Number(((performance.now() - started) / 1000).toFixed(3)) }));
  process.exitCode = interrupted === 'SIGINT' ? 130 : interrupted === 'SIGTERM' ? 143 : 1;
} else {
  report.phasesSeconds = phases;
  report.totalSeconds = Number(((performance.now() - started) / 1000).toFixed(3));
  report.cleanup = 'owned containers, volumes, network and image alias removed';
  console.log('RECOVERY_SMOKE_REPORT=' + JSON.stringify(report, null, 2));
}

function pickImage(image) { return { id: image.Id, repoDigests: image.RepoDigests ?? [] }; }
