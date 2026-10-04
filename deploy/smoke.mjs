#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workRoot = path.join(repoRoot, 'work', 'deploy-smoke');
const projectPattern = /^feedrelay-smoke-\d{14}-[a-f0-9]{16}$/;
const ownershipLabel = 'org.feedrelay.smoke.project';
const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('Usage: node deploy/smoke.mjs [--prepare-only]\n       node deploy/smoke.mjs --cleanup-record work/deploy-smoke/PROJECT/results.json\n\nBuilds production images and tests an isolated local Linux Docker project. Uses fake credentials, no published ports, no runtime egress, and no Telegram messages/payments. Results and logs remain under work/deploy-smoke/PROJECT; only this run\'s resources are removed. --prepare-only validates inputs without building images or starting containers.');
  process.exit(0);
}
const cleanupMode = args[0] === '--cleanup-record';
assert.ok(cleanupMode ? args.length === 2 : args.length === 0 || args.length === 1 && args[0] === '--prepare-only', 'Unknown smoke arguments; use --help');
const prepareOnly = args.includes('--prepare-only');
let currentChild;
let interrupted = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  interrupted = true;
  currentChild?.kill('SIGTERM');
});
let record, outputDir, recordPath, composeArgs, commandEnvironment;

function fakeEnvironment(project) {
  return {
    FEEDRELAY_TAG: project, DOMAIN: 'smoke.feedrelay.invalid', ACME_EMAIL: 'smoke@example.invalid',
    POSTGRES_DB: 'feedrelay', POSTGRES_USER: 'feedrelay', POSTGRES_PASSWORD: 'throwaway-smoke-password-not-production',
    DATABASE_URL: 'postgresql://feedrelay:throwaway-smoke-password-not-production@postgres:5432/feedrelay',
    PUBLIC_URL: 'https://smoke.feedrelay.invalid', BOT_ID: '123456789', BOT_USERNAME: 'FeedRelaySmokeFakeBot',
    BOT_TOKEN: '123456789:FAKE_ONLY_DO_NOT_USE', WEBHOOK_SECRET: 'smoke-only-webhook-secret-00000000000000000000',
    TELEGRAM_CLIENT_ID: 'fake-smoke-client', TELEGRAM_CLIENT_SECRET: 'fake-smoke-secret',
    BILLING_ENABLED: 'false', STARTER_STARS: '300', SUPPORT_EMAIL: '', TERMS_URL: '',
    TRUSTED_PROXY_CIDRS: '', LOG_LEVEL: 'info', FETCH_CONCURRENCY: '2', COMPOSE_PROJECT_NAME: project,
    COMPOSE_PROFILES: '', COMPOSE_BAKE: 'false'
  };
}
function setCommands() {
  // Shell variables win over --env-file. Override every interpolation so a
  // developer's production credentials cannot enter this throwaway project.
  commandEnvironment = { ...process.env, ...fakeEnvironment(record.project) };
  delete commandEnvironment.COMPOSE_FILE;
  composeArgs = ['compose', '--project-name', record.project, '--env-file', path.join(outputDir, 'smoke.env'),
    '-f', path.join(repoRoot, 'deploy', 'compose.production.yml'), '-f', path.join(outputDir, 'override.json')];
}
async function saveRecord() {
  await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
}
async function docker(commandArgs, { timeoutMs = 120000, quiet = false, allowFailure = false, input, cleanup = false } = {}) {
  if (interrupted && !cleanup) throw new Error('Smoke interrupted; cleaning this project.');
  const description = `docker ${commandArgs.join(' ')}`;
  appendFileSync(path.join(outputDir, 'commands.log'), `\n$ ${description}\n`);
  if (!quiet) console.log(`\n$ ${description}`);
  return await new Promise((resolve, reject) => {
    const child = spawn('docker', commandArgs, { cwd: repoRoot, env: commandEnvironment, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    currentChild = child;
    let stdout = '', stderr = '', timedOut = false;
    const collect = (stream, chunk) => {
      const text = chunk.toString();
      appendFileSync(path.join(outputDir, 'commands.log'), text);
      if (stream === 'stdout') { stdout = (stdout + text).slice(-2_000_000); if (!quiet) process.stdout.write(text); }
      else { stderr = (stderr + text).slice(-2_000_000); if (!quiet) process.stderr.write(text); }
    };
    child.stdout.on('data', chunk => collect('stdout', chunk));
    child.stderr.on('data', chunk => collect('stderr', chunk));
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.on('error', error => { clearTimeout(timer); if (currentChild === child) currentChild = undefined; reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (currentChild === child) currentChild = undefined;
      if ((code !== 0 || timedOut) && !allowFailure) reject(new Error(`${description} ${timedOut ? 'timed out' : `exited ${code}`}\n${stderr.slice(-4000)}`));
      else resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}
const compose = (commandArgs, options) => docker([...composeArgs, ...commandArgs], options);
const dockerJSON = async commandArgs => JSON.parse((await docker(commandArgs, { quiet: true })).stdout);

async function localEngine() {
  const context = (await docker(['context', 'show'], { quiet: true })).stdout;
  const contexts = await dockerJSON(['context', 'inspect', context]);
  const endpoint = process.env.DOCKER_CONTEXT ? contexts[0]?.Endpoints?.docker?.Host
    : process.env.DOCKER_HOST || contexts[0]?.Endpoints?.docker?.Host;
  const loopback = endpoint?.startsWith('tcp://') && ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(endpoint).hostname);
  assert.ok(endpoint?.startsWith('npipe://') || endpoint?.startsWith('unix://') || loopback,
    `Smoke requires a local Docker engine; refusing endpoint ${endpoint}`);
  const info = await dockerJSON(['info', '--format', '{{json .}}']);
  assert.equal(info.OSType, 'linux', 'Production images require Docker Linux containers');
  record.engine = { context, endpoint, version: info.ServerVersion, operatingSystem: info.OperatingSystem };
  console.log(`Local Linux Docker ready: ${info.ServerVersion} (${context})`);
}
async function projectResources() {
  const filter = `label=com.docker.compose.project=${record.project}`;
  const values = await Promise.all([
    docker(['ps', '-a', '-q', '--filter', filter], { quiet: true, cleanup: true }),
    docker(['network', 'ls', '-q', '--filter', filter], { quiet: true, cleanup: true }),
    docker(['volume', 'ls', '-q', '--filter', filter], { quiet: true, cleanup: true })
  ]);
  return values.map(value => value.stdout.split(/\r?\n/).filter(Boolean));
}
async function validateConfig() {
  const config = JSON.parse((await compose(['config', '--format', 'json'], { quiet: true })).stdout);
  for (const network of ['backend', 'egress']) assert.equal(config.networks[network].internal, true, `${network} must block runtime egress`);
  for (const service of ['postgres', 'migrate', 'api', 'web', 'fetch-worker']) {
    assert.equal(config.services[service].ports?.length ?? 0, 0, `${service} must not publish ports`);
    assert.equal(config.services[service].labels[ownershipLabel], record.project);
  }
  assert.equal(config.services.api.environment.TRUSTED_PROXY_CIDRS, '');
  assert.equal(String(config.services.api.environment.BILLING_ENABLED), 'false');
  for (const key of ['BOT_TOKEN', 'WEBHOOK_SECRET', 'TELEGRAM_CLIENT_ID', 'TELEGRAM_CLIENT_SECRET']) {
    assert.equal(config.services['fetch-worker'].environment[key], undefined, `fetch worker must not receive ${key}`);
  }
}
async function verifyRuntime() {
  for (const service of ['caddy', 'control-worker', 'delivery-worker']) {
    assert.equal((await compose(['ps', '-a', '-q', service], { quiet: true })).stdout, '', `${service} must remain absent`);
  }
  for (const network of ['backend', 'egress']) {
    const [value] = await dockerJSON(['network', 'inspect', `${record.project}_${network}`]);
    assert.equal(value.Internal, true);
    assert.equal(value.Labels[ownershipLabel], record.project);
  }
  for (const service of ['postgres', 'migrate', 'api', 'web', 'fetch-worker']) {
    const id = (await compose(['ps', '-a', '-q', service], { quiet: true })).stdout;
    assert.ok(id, `${service} container must exist`);
    const [container] = await dockerJSON(['inspect', id]);
    assert.equal(container.Config.Labels[ownershipLabel], record.project);
    assert.equal(Object.keys(container.HostConfig.PortBindings ?? {}).length, 0, `${service} must have no host ports`);
    if (service === 'migrate') {
      assert.equal(container.State.Status, 'exited');
      assert.equal(container.State.ExitCode, 0, 'one-shot migration must succeed');
    } else {
      assert.equal(container.State.Status, 'running', `${service} must be running`);
      if (service !== 'postgres') assert.equal(container.HostConfig.ReadonlyRootfs, true);
    }
  }
  const probes = await readFile(path.join(repoRoot, 'deploy', 'smoke-probes.mjs'), 'utf8');
  for (const service of ['api', 'web', 'fetch-worker']) {
    await compose(['exec', '-T', '--workdir', '/app/apps/server', service, 'node', '--input-type=module', '-', service], { input: probes, timeoutMs: 120000 });
  }
  const sql = `SELECT max(version) >= 3 FROM fr_migrations;
SELECT count(*) FROM pg_namespace WHERE nspname='pgboss';
SELECT count(*) FROM pgboss.queue WHERE name IN ('fetch','release','deliver','inbox','billing');
SELECT count(*) FROM fr_deliveries;
SELECT count(*) FROM fr_payments;
SELECT count(*) FROM fr_inbox;
SELECT count(*) FROM fr_users;`;
  const result = await compose(['exec', '-T', 'postgres', 'psql', '-v', 'ON_ERROR_STOP=1', '-U', 'feedrelay', '-d', 'feedrelay', '-Atqc', sql], { quiet: true });
  assert.deepEqual(result.stdout.split(/\r?\n/), ['t', '1', '5', '0', '0', '0', '0'], 'migrations, queues, and absence of deliveries/payments/users/webhook facts');
  console.log('PASS migration versions, five pg-boss queues, internal networks, no host ports, no delivery/payment/login records.');
}
async function cleanupProject() {
  // A changed manifest or an unrelated resource reusing the name must not turn
  // cleanup into a broad delete. Every resource must carry this run's label.
  const resources = await projectResources();
  for (let i = 0; i < resources.length; i++) {
    if (!resources[i].length) continue;
    const inspectArgs = i === 0 ? ['inspect', ...resources[i]] : [i === 1 ? 'network' : 'volume', 'inspect', ...resources[i]];
    const values = JSON.parse((await docker(inspectArgs, { quiet: true, cleanup: true })).stdout);
    for (const value of values) assert.equal((i === 0 ? value.Config.Labels : value.Labels)?.[ownershipLabel], record.project,
      'Refusing cleanup of a resource without this smoke run ownership label');
  }
  await compose(['down', '--volumes', '--remove-orphans', '--timeout', '10'], { timeoutMs: 120000, cleanup: true });
  for (const image of [`feedrelay-server:${record.project}`, `feedrelay-web:${record.project}`]) {
    const inspected = await docker(['image', 'inspect', image], { quiet: true, allowFailure: true, cleanup: true });
    if (inspected.code !== 0) continue;
    const [value] = JSON.parse(inspected.stdout);
    assert.equal(value.Config.Labels?.[ownershipLabel], record.project, 'Refusing removal of an image without this run ownership label');
    await docker(['image', 'rm', image], { cleanup: true });
  }
  assert.ok((await projectResources()).every(values => values.length === 0), 'This smoke project must leave no containers, networks, or volumes');
  record.cleanup = 'passed';
}
async function diagnostics() {
  await compose(['ps', '-a'], { allowFailure: true, cleanup: true });
  const logs = await compose(['logs', '--no-color', '--tail', '150', 'migrate', 'api', 'web', 'fetch-worker'], { allowFailure: true, quiet: true, cleanup: true });
  await writeFile(path.join(outputDir, 'runtime.log'), `${logs.stdout}\n${logs.stderr}\n`, { mode: 0o600 });
}
async function step(name, operation) {
  const entry = { name, startedAt: new Date().toISOString(), outcome: 'running' };
  record.steps.push(entry);
  await saveRecord();
  console.log(`\n[smoke] ${name}`);
  try { await operation(); entry.outcome = 'passed'; }
  catch (error) { entry.outcome = 'failed'; entry.error = error.message; throw error; }
  finally { entry.finishedAt = new Date().toISOString(); await saveRecord(); }
}

if (cleanupMode) {
  recordPath = path.resolve(repoRoot, args[1]);
  outputDir = path.dirname(recordPath);
  assert.equal(path.dirname(outputDir), workRoot, 'Cleanup record must be directly within this repository work/deploy-smoke/PROJECT directory');
  assert.equal(path.basename(recordPath), 'results.json');
  record = JSON.parse(await readFile(recordPath, 'utf8'));
  assert.ok(projectPattern.test(record.project));
  assert.equal(path.basename(outputDir), record.project);
  assert.equal(record.repoRoot, repoRoot);
  setCommands();
  await localEngine();
  await cleanupProject();
  await saveRecord();
  console.log(`Cleanup verified: ${record.project}`);
  process.exit(0);
}

const project = `feedrelay-smoke-${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}-${randomBytes(8).toString('hex')}`;
outputDir = path.join(workRoot, project);
recordPath = path.join(outputDir, 'results.json');
await mkdir(workRoot, { recursive: true });
await mkdir(outputDir, { mode: 0o700 });
record = { project, repoRoot, startedAt: new Date().toISOString(), outcome: 'running', prepareOnly, cleanup: 'not-needed', steps: [] };
setCommands();
await writeFile(path.join(outputDir, 'smoke.env'), Object.entries(fakeEnvironment(project)).map(([key, value]) => `${key}=${value}`).join('\n') + '\n', { mode: 0o600 });
const label = { [ownershipLabel]: project };
const override = {
  networks: { backend: { internal: true, labels: label }, egress: { internal: true, labels: label } },
  volumes: { postgres_data: { labels: label }, caddy_data: { labels: label }, caddy_config: { labels: label } },
  services: Object.fromEntries(['postgres', 'migrate', 'api', 'web', 'fetch-worker', 'control-worker', 'delivery-worker', 'caddy'].map(service => [service, {
    labels: label,
    ...(service === 'api' ? { environment: { TRUSTED_PROXY_CIDRS: '' }, build: { labels: label } } : {}),
    ...(service === 'web' ? { build: { labels: label } } : {})
  }]))
};
await writeFile(path.join(outputDir, 'override.json'), JSON.stringify(override, null, 2) + '\n', { mode: 0o600 });
await saveRecord();
if (process.env.GITHUB_ENV) appendFileSync(process.env.GITHUB_ENV, `FEEDRELAY_SMOKE_RECORD=${recordPath}\n`);
console.log(`Smoke project: ${project}\nResults: ${recordPath}`);
let resourcesMayExist = false;
try {
  await step('Local engine and unique project', async () => {
    await localEngine();
    assert.ok((await projectResources()).every(values => values.length === 0), 'Random smoke project already exists; refusing to reuse it');
  });
  await step('Validate isolated Compose inputs', validateConfig);
  if (prepareOnly) record.outcome = 'prepared';
  else {
    // An interrupted build can leave this tagged image before any container.
    resourcesMayExist = true;
    await step('Build production server and web images', async () => {
      await compose(['build', 'api', 'web'], { timeoutMs: 1200000 });
      const images = await dockerJSON(['image', 'inspect', `feedrelay-server:${project}`, `feedrelay-web:${project}`]);
      record.images = images.map(value => ({ tags: value.RepoTags, id: value.Id, createdAt: value.Created, os: value.Os, architecture: value.Architecture, digests: value.RepoDigests }));
    });
    await step('Pull PostgreSQL', () => compose(['pull', 'postgres'], { timeoutMs: 300000 }));
    await step('Start isolated database/migration/API/web/fetch worker', () => compose(['up', '-d', 'postgres', 'api', 'web', 'fetch-worker'], { timeoutMs: 360000 }));
    await step('Verify production runtime and pg-boss completion', verifyRuntime);
    record.outcome = 'passed';
  }
} catch (error) {
  record.outcome = 'failed';
  record.error = error.stack ?? error.message;
  console.error(`\nSmoke failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  if (resourcesMayExist) {
    try { await diagnostics(); } catch (error) { record.diagnosticsError = error.message; }
    try { await cleanupProject(); }
    catch (error) { record.cleanup = 'failed'; record.cleanupError = error.message; record.outcome = 'failed'; process.exitCode = 1; console.error(`Cleanup failed: ${error.message}\nRetry only this run: node deploy/smoke.mjs --cleanup-record "${recordPath}"`); }
  }
  record.finishedAt = new Date().toISOString();
  await saveRecord();
  console.log(`\nSmoke ${record.outcome}: ${project}\nCleanup: ${record.cleanup}\nResults: ${recordPath}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    `### Isolated Docker smoke\n\n- Result: ${record.outcome}\n- Cleanup: ${record.cleanup}\n- Project: \`${project}\`\n- Actual production image builds, migrations, database readiness, pg-boss job completion, web/API routing, anonymous rejection, nonroot/read-only runtime, and fetch credential isolation.\n- Fake credentials; internal runtime networks; no published ports. No Telegram sign-in, message delivery, payment, webhook setup, or public deployment.\n`);
}
