#!/usr/bin/env node
// Production-mode API smoke against one owned, disposable reliability database.
// Never points at the dedicated laptop alpha database or public origin ports.
import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createConnection } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const backendRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const container = 'jdq-reliability-pg-20260910';
const host = '127.0.0.1';
const port = 4102;
const databaseName = `jdq_alpha_smoke_${randomUUID().replaceAll('-', '')}`;
const base = `http://${host}:${port}/api/v1`;
let apiChild;
let databaseCreated = false;
let databaseWasCreated = false;
let databaseUser;
let smokePassed = false;

function docker(args) {
  return execFileSync('docker', args, {
    encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function exactContainerPreflight() {
  assert(process.platform === 'linux' && Boolean(process.env.WSL_DISTRO_NAME), 'WSL Linux is required.');
  assert(existsSync(resolve(backendRoot, 'dist/server.js')), 'Build backend/dist/server.js first.');
  assert(docker(['inspect', '--format', '{{.State.Running}}', container]) === 'true', 'Reliability container is not running.');
  assert(docker(['port', container, '5432']) === '127.0.0.1:55432', 'Reliability container must expose only loopback port 55432.');
  assert(docker(['exec', container, 'printenv', 'POSTGRES_DB']) === 'jdq_reliability_test', 'Unexpected reliability database identity.');
  databaseUser = docker(['exec', container, 'printenv', 'POSTGRES_USER']);
  const password = docker(['exec', container, 'printenv', 'POSTGRES_PASSWORD']);
  assert(databaseUser.length > 0 && password.length > 0, 'Reliability database credentials are missing.');
  const url = new URL('postgresql://127.0.0.1:55432/');
  url.username = databaseUser;
  url.password = password;
  url.pathname = `/${databaseName}`;
  return url.toString();
}

async function portOpen() {
  return await new Promise(resolvePort => {
    const socket = createConnection({ host, port });
    socket.setTimeout(1000);
    socket.once('connect', () => { socket.destroy(); resolvePort(true); });
    socket.once('error', () => { socket.destroy(); resolvePort(false); });
    socket.once('timeout', () => { socket.destroy(); resolvePort(false); });
  });
}

function queryDatabase(sql) {
  return docker(['exec', container, 'psql', '-U', databaseUser, '-d', databaseName, '-tAc', sql]);
}

async function jsonRequest(path, options = {}) {
  const response = await fetch(`${base}${path}`, { ...options, signal: AbortSignal.timeout(5000) });
  const body = await response.json();
  return { response, body };
}

async function waitForReady() {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    assert(apiChild.exitCode === null && !apiChild.killed, 'Owned API exited before readiness.');
    try {
      const { response, body } = await jsonRequest('/health/ready');
      if (response.ok && body?.ready === true && body?.dependencies?.postgres?.status === 'up') return;
    } catch { /* Still starting migrations or server. */ }
    await new Promise(resolveWait => setTimeout(resolveWait, 1000));
  }
  throw new Error('Production-mode API did not become ready within 120 seconds.');
}

async function stopOwnedApi() {
  if (!apiChild || apiChild.exitCode !== null || apiChild.signalCode !== null) return;
  const child = apiChild;
  child.kill('SIGTERM');
  const waitForExit = async timeoutMs => {
    const deadline = Date.now() + timeoutMs;
    while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) {
      await new Promise(resolveWait => setTimeout(resolveWait, 50));
    }
    return child.exitCode !== null || child.signalCode !== null;
  };
  if (!(await waitForExit(5000))) {
    child.kill('SIGKILL');
    assert(await waitForExit(5000), 'Owned API did not exit after SIGKILL; refusing to drop its database.');
  }
}

try {
  assert(!(await portOpen()), 'Loopback smoke port 4102 is already occupied.');
  const databaseUrl = exactContainerPreflight();
  // createdb rejects any collision. Only a successful create grants cleanup ownership.
  docker(['exec', container, 'createdb', '-U', databaseUser, databaseName]);
  databaseCreated = true;
  databaseWasCreated = true;

  const childEnv = {
    ...process.env,
    NODE_ENV: 'production', HOST: host, PORT: String(port), DATABASE_URL: databaseUrl,
    JWT_SECRET: randomBytes(48).toString('hex'),
    CORS_ORIGIN: 'https://juanderquest.app',
    ALLOW_IN_MEMORY_FALLBACK: 'false', SEED_DEVELOPMENT_DATA: 'false',
    WALLET_AUTH_MODE: 'signature', ALLOW_INSECURE_LOCAL_WALLET_AUTH: 'false',
    ALLOW_DEMO_LOGIN: 'false', GUEST_LOGIN_ENABLED: 'true',
    ALPHA_WALLET_SIMULATION_ENABLED: 'true', MARKETPLACE_ENABLED: 'false',
    JUANCHOICE_ENABLED: 'true', JUANCHOICE_WRITES_ENABLED: 'false',
    JUANCHOICE_BATCH_WRITES_ENABLED: 'false', JUANCHOICE_PROMOTION_ENABLED: 'false',
    JUANCHOICE_ECONOMY_ENABLED: 'false', JUANCHOICE_FINALIZER_WORKER_ENABLED: 'false',
    JUANCHOICE_SCHEDULER_ENABLED: 'false',
    PROGRESSION_OUTBOX_WORKER_ENABLED: 'false',
  };
  apiChild = spawn(process.execPath, [resolve(backendRoot, 'dist/server.js')], {
    cwd: backendRoot, env: childEnv, stdio: ['ignore', 'ignore', 'ignore'],
  });
  await waitForReady();
  assert(queryDatabase('SELECT COUNT(*) FROM schema_migrations') === '23', 'Migration ledger is not at 23.');

  const config = await jsonRequest('/auth/wallet/config');
  assert(config.response.status === 200 && config.body?.data?.mode === 'signature' && config.body?.data?.guest_login_enabled === true,
    'Production wallet/guest configuration is incorrect.');

  const guest = await jsonRequest('/auth/guest-login', {
    method: 'POST', headers: { Origin: 'https://juanderquest.app', 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert(guest.response.status === 200 && guest.body?.success === true && guest.body?.data?.user?.seed_id?.startsWith('guest:'),
    'Durable guest sign-in failed.');
  assert(!('token' in guest.body.data), 'Guest sign-in leaked a bearer token.');
  const setCookie = guest.response.headers.get('set-cookie') || '';
  assert(setCookie.startsWith('__Host-jdq_session=') && /;\s*secure\b/i.test(setCookie)
    && /;\s*httponly\b/i.test(setCookie) && /;\s*samesite=lax\b/i.test(setCookie),
  'Production session cookie attributes are incorrect.');
  const cookie = setCookie.split(';', 1)[0];
  const ownSession = await jsonRequest('/auth/me', { headers: { Cookie: cookie } });
  assert(ownSession.response.status === 200 && ownSession.body?.data?.id === guest.body.data.user.id,
    'Durable guest session restoration failed.');

  const overview = await jsonRequest('/juanchoice/overview', { headers: { Cookie: cookie } });
  assert(overview.response.status === 200 && overview.body?.success === true,
    'Read-only JuanChoice overview failed.');

  const ballot = await jsonRequest(`/juanchoice/campaigns/${randomUUID()}/ballot`, {
    method: 'PUT',
    headers: {
      Origin: 'https://juanderquest.app', Cookie: cookie, 'Content-Type': 'application/json',
      'Idempotency-Key': randomUUID(),
    },
    body: JSON.stringify({ candidate_id: randomUUID(), expected_version: 0 }),
  });
  assert(ballot.response.status === 503 && ballot.body?.error?.code === 'WRITES_DISABLED',
    'JuanChoice ballot was not fail-closed.');
  assert(queryDatabase("SELECT (SELECT COUNT(*) FROM juanchoice_ballots)::text || ',' || (SELECT COUNT(*) FROM progression_events WHERE source_type='juanchoice_participation')::text") === '0,0',
    'Disabled ballot changed JuanChoice accounting.');

  const demo = await jsonRequest('/auth/demo-login', {
    method: 'POST', headers: { Origin: 'https://juanderquest.app', 'Content-Type': 'application/json' },
    body: JSON.stringify({ seed_id: 'user-1' }),
  });
  assert(demo.response.status === 403 && demo.body?.error?.code === 'DEMO_LOGIN_DISABLED',
    'Production demo-login guard failed.');
  smokePassed = true;
} catch (error) {
  process.stderr.write(`SMOKE_RESULT production_api=fail reason=${error instanceof Error ? error.message : 'unknown'}\n`);
  process.exitCode = 1;
} finally {
  try {
    await stopOwnedApi();
    if (databaseCreated) {
      assert(/^jdq_alpha_smoke_[a-f0-9]{32}$/.test(databaseName), 'Refusing unsafe cleanup target.');
      docker(['exec', container, 'dropdb', '-U', databaseUser, databaseName]);
      databaseCreated = false;
    }
    process.stdout.write(`SMOKE_CLEANUP completed disposable_database_removed=${databaseWasCreated ? 'true' : 'not_created'}\n`);
    if (smokePassed) process.stdout.write('SMOKE_RESULT production_api=pass migrations=23 guest_cookie=pass choice_read=pass ballot_disabled=pass demo_disabled=pass\n');
  } catch {
    process.stderr.write('SMOKE_CLEANUP failed; inspect the owned disposable database and child process manually.\n');
    process.stderr.write('SMOKE_RESULT production_api=fail reason=cleanup_failed\n');
    process.exitCode = 1;
  }
}
