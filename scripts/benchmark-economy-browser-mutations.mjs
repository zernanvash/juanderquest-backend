#!/usr/bin/env node
// Direct HTTP mutation load on a fresh, marked, fictional benchmark fixture.
// Bearer tokens are locally signed from the same dev profile to avoid adding
// auth-login rate limit noise; browser cookie/CSRF behavior is tested elsewhere.
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { cpus, totalmem, platform, release } from 'node:os';
import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';
import { Pool } from 'pg';
import { reconcileEconomy } from '../dist/economy/reconcile.js';

const [database, marker] = process.argv.slice(2);
if (!/^jdq_economy_lab_[a-f0-9]{12}_dev$/.test(database || '') ||
    !/^[0-9a-f-]{36}$/i.test(marker || '')) throw new Error('Exact marked disposable lab database and UUID marker required');
const fixtureCheck = spawnSync('node', ['scripts/economy-browser-fixture.mjs', '--check', database, marker],
  { cwd: new URL('..', import.meta.url), encoding: 'utf8' });
if (fixtureCheck.status !== 0) throw new Error('Marked fixture preflight failed');
const fixture = JSON.parse(fixtureCheck.stdout.trim().split('\n').at(-1));
if (fixture.fixture_version !== 'browser-lab-bench-v2') throw new Error('Fresh 150-actor benchmark fixture required');
const profile = dotenv.parse(readFileSync(new URL('../.env.dev', import.meta.url)));
const signingSecret = process.env.JWT_SECRET || profile.JWT_SECRET || 'dev_only_jwt_secret_do_not_use_in_production';
const base = 'http://127.0.0.1:4300/api/v1';
const reviewerTokens = Array.from({ length: 5 }, (_, index) => jwt.sign({
  id: `lab-bench-reviewer-${index + 1}`, seed_id: `admin:lab-bench-${index + 1}`, role: 'admin',
}, signingSecret, { expiresIn: '1h' }));
const travelerToken = index => jwt.sign({ id: `lab-bench-traveler-${index}`,
  seed_id: `wallet:lab-bench-${index}`, role: 'user' }, signingSecret, { expiresIn: '1h' });
const authCheck = await fetch(`${base}/auth/me`, { headers: { Authorization: `Bearer ${travelerToken(1)}` } });
if (!authCheck.ok) throw new Error(`Locally signed benchmark identity rejected: HTTP ${authCheck.status}`);
async function benchmarkTelemetry() {
  const response = await fetch(`${base}/admin/economy/telemetry`, {
    headers: { Authorization: `Bearer ${reviewerTokens[0]}` }, signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`SQL telemetry unavailable: HTTP ${response.status}`);
  const body = await response.json();
  if (!body?.success || body.data?.enabled !== true) throw new Error('SQL telemetry is not enabled for this fixture');
  return body.data;
}

const dockerValue = key => {
  const result = spawnSync('docker', ['exec', 'jdq-reliability-pg-20260910', 'printenv', key], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error('Reliability container identity unavailable');
  return result.stdout.trim();
};
if (dockerValue('POSTGRES_DB') !== 'jdq_reliability_test') throw new Error('Reliability container mismatch');
const ownerUrl = new URL(`postgresql://127.0.0.1:55432/${database}`);
ownerUrl.username = dockerValue('POSTGRES_USER');
ownerUrl.password = dockerValue('POSTGRES_PASSWORD');
const pool = new Pool({ connectionString: ownerUrl.toString(), max: 2 });
const appRole = `jdq_econ_lab_${database.match(/jdq_economy_lab_([a-f0-9]{12})_dev/)[1]}_app`;
const lsof = spawnSync('lsof', ['-t', '-nP', '-iTCP:4300', '-sTCP:LISTEN'], { encoding: 'utf8' });
const apiPid = Number(lsof.stdout.trim().split('\n')[0]);
if (lsof.status !== 0 || !Number.isInteger(apiPid) || apiPid <= 1) throw new Error('Loopback API process unavailable for resource sampling');
const clockTicks = Number(spawnSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).stdout.trim());
const pageBytes = Number(spawnSync('getconf', ['PAGESIZE'], { encoding: 'utf8' }).stdout.trim());
function processSnapshot() {
  const stat = readFileSync(`/proc/${apiPid}/stat`, 'utf8').split(') ').at(-1).trim().split(' ');
  const statm = readFileSync(`/proc/${apiPid}/statm`, 'utf8').trim().split(' ');
  return { ticks: Number(stat[11]) + Number(stat[12]), rss_bytes: Number(statm[1]) * pageBytes };
}
function sampleResources() {
  const initial = processSnapshot();
  const began = performance.now();
  const points = [];
  let pending = false;
  let samplingErrors = 0;
  const timer = setInterval(() => {
    const process = processSnapshot();
    points.push({ rss_bytes: process.rss_bytes, ticks: process.ticks, active_connections: null,
      lock_waiters: null, max_active_query_age_ms: null });
    const point = points.at(-1);
    if (!pending) {
      pending = true;
      void pool.query(`SELECT count(*) FILTER (WHERE state = 'active')::int AS active_connections,
        count(*) FILTER (WHERE wait_event_type = 'Lock')::int AS lock_waiters,
        max(extract(epoch FROM (clock_timestamp() - query_start)) * 1000) FILTER (WHERE state = 'active')::numeric AS max_active_query_age_ms
        FROM pg_stat_activity WHERE usename = $1`, [appRole])
        .then(result => Object.assign(point, result.rows[0]))
        .catch(() => { samplingErrors++; })
        .finally(() => { pending = false; });
    }
  }, 100);
  return () => {
    clearInterval(timer);
    const last = processSnapshot();
    const seconds = (performance.now() - began) / 1000;
    return { api_peak_rss_bytes: Math.max(initial.rss_bytes, last.rss_bytes,
      ...points.map(point => point.rss_bytes)),
      api_cpu_core_percent: Math.round(((last.ticks - initial.ticks) / clockTicks / seconds) * 10000) / 100,
      postgres_peak_active_connections: Math.max(0, ...points.map(point => Number(point.active_connections) || 0)),
      postgres_peak_lock_waiters: Math.max(0, ...points.map(point => Number(point.lock_waiters) || 0)),
      postgres_max_sampled_active_query_age_ms: Math.max(0, ...points.map(point => Number(point.max_active_query_age_ms) || 0)),
      samples: points.length, sampling_errors: samplingErrors,
      note: '100ms sampled process/pg_stat_activity telemetry; not exact SQL per-query latency or pg.Pool internals' };
  };
}

async function api(method, path, token, body, key) {
  const began = performance.now();
  let response;
  try {
    response = await fetch(`${base}${path}`, { method, headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(key ? { 'x-idempotency-key': key } : {}),
    }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20000) });
  } catch (error) { throw new Error(`Network failure on ${method} ${path}: ${error instanceof Error ? error.name : 'unknown'}`); }
  const data = await response.json();
  const ms = Math.round((performance.now() - began) * 100) / 100;
  if (!response.ok || !data?.success) throw new Error(`${method} ${path} returned HTTP ${response.status} ${data?.error?.code || ''}`);
  return { data: data.data, ms };
}

const durations = [];
const correctness = { starts_replayed: 0, proof_pending_zero: 0, awards_exact: 0,
  purchases_replayed: 0, balances_exact: 0 };
async function journey(index, reviewerIndex, repeat, tier) {
  const user = travelerToken(index);
  const reviewer = reviewerTokens[reviewerIndex % reviewerTokens.length];
  const record = (operation, value) => durations.push({ repeat, tier, operation, ms: value });
  const preview = await api('GET', '/economy/quests/lab-economy-reviewed-quest/reward', user);
  record('reward_preview', preview.ms);
  if (preview.data?.reward_minor !== '100' || !preview.data?.funded_slots_available) throw new Error('Incorrect funded reward preview');
  const start = await api('POST', '/quests/lab-economy-reviewed-quest/attempts', user);
  record('start', start.ms);
  const replayStart = await api('POST', '/quests/lab-economy-reviewed-quest/attempts', user);
  if (replayStart.data?.id !== start.data?.id) throw new Error('Repeated start created another attempt');
  correctness.starts_replayed++;
  const challenge = await api('POST', '/quests/lab-economy-reviewed-quest/challenge', user);
  const proof = await api('POST', '/submissions', user, { quest_id: 'lab-economy-reviewed-quest',
    challenge_token: challenge.data?.challenge_token, idempotency_key: randomUUID(),
    captured_lat: 16.0, captured_lng: 120.0, captured_accuracy: 8 });
  record('proof_submit', proof.ms);
  const pending = await api('GET', '/economy/me', user);
  if (pending.data?.balance_minor !== '0') throw new Error('Pending synthetic proof issued coins');
  correctness.proof_pending_zero++;
  const reviewed = await api('PATCH', `/admin/submissions/${encodeURIComponent(proof.data.id)}`, reviewer,
    { action: 'approve' });
  record('review_settle', reviewed.ms);
  if (String(reviewed.data?.awarded_explorer_coins) !== '100') throw new Error('Reviewer award mismatch');
  correctness.awards_exact++;
  const wallet = await api('GET', '/economy/me', user);
  record('wallet_read', wallet.ms);
  if (wallet.data?.balance_minor !== '100') throw new Error('Approved wallet not 100');
  const key = randomUUID();
  const purchase = await api('POST', '/wallet/cosmetics/lab-compass-skin/purchase', user, {}, key);
  record('cosmetic_purchase', purchase.ms);
  const purchaseReplay = await api('POST', '/wallet/cosmetics/lab-compass-skin/purchase', user, {}, key);
  if (purchaseReplay.data?.transactionId !== purchase.data?.transactionId) throw new Error('Purchase replay changed receipt');
  correctness.purchases_replayed++;
  const balance = await api('GET', '/economy/me', user);
  if (balance.data?.balance_minor !== '60') throw new Error('Purchased wallet not 60');
  correctness.balances_exact++;
}

function percentile(values, fraction) {
  const sorted = values.toSorted((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] * 100) / 100;
}
async function invariantSnapshot() {
  const legacy = await pool.query(`SELECT COALESCE(sum(demo_points),0)::text AS points,
    COALESCE(sum(scout_reputation),0)::text AS scout FROM users`);
  const civic = await pool.query(`SELECT COALESCE(sum(civic_xp),0)::text AS civic_xp,
    COALESCE(sum(civic_stamps),0)::text AS stamps FROM progression_totals`);
  const chain = await pool.query('SELECT count(*)::int AS count FROM chain_events');
  return { ...legacy.rows[0], ...civic.rows[0], chain_events: chain.rows[0].count };
}
async function verifyAfterRun(before) {
  const poolRow = await pool.query(`SELECT allocated_minor::text, available_minor::text,
    reserved_minor::text, paid_minor::text, returned_minor::text FROM reward_pools WHERE id = 'lab-economy-pool'`);
  const p = poolRow.rows[0];
  const conserved = BigInt(p.allocated_minor) === BigInt(p.available_minor) + BigInt(p.reserved_minor) +
    BigInt(p.paid_minor) + BigInt(p.returned_minor);
  const duplicates = await pool.query(`SELECT
    (SELECT count(*)::int FROM (SELECT user_id, scope_key FROM reward_awards GROUP BY user_id, scope_key HAVING count(*) > 1) q) AS award,
    (SELECT count(*)::int FROM (SELECT user_id, cosmetic_id FROM economic_entitlements GROUP BY user_id, cosmetic_id HAVING count(*) > 1) q) AS entitlement`);
  const rec = await reconcileEconomy(pool);
  const unchanged = JSON.stringify(before) === JSON.stringify(await invariantSnapshot());
  const audit = { pool_conservation: conserved, account_drift: rec.pilotAccountDrift.length,
    duplicate_awards: duplicates.rows[0].award, duplicate_entitlements: duplicates.rows[0].entitlement,
    legacy_progression_chain_unchanged: unchanged };
  if (!conserved || audit.account_drift || audit.duplicate_awards || audit.duplicate_entitlements || !unchanged) {
    throw new Error('Post-run accounting invariant failed');
  }
  return audit;
}

try {
  const before = await invariantSnapshot();
  const warmup = await api('GET', '/economy/me', travelerToken(1));
  if (warmup.data?.balance_minor !== '0') throw new Error('Warmup fixture not pristine');
  let nextIndex = 1;
  const runs = [];
  for (let repeat = 1; repeat <= 3; repeat++) {
    for (const [tier, sampleCount] of [[1, 10], [5, 20], [20, 20]]) {
      const firstIndex = nextIndex;
      const sqlBefore = await benchmarkTelemetry();
      const began = performance.now();
      const stopSampling = sampleResources();
      let next = 0;
      await Promise.all(Array.from({ length: tier }, async (_, worker) => {
        while (next < sampleCount) {
          const offset = next++;
          await journey(firstIndex + offset, worker, repeat, tier);
        }
      }));
      nextIndex += sampleCount;
      const seconds = (performance.now() - began) / 1000;
      const resources = stopSampling();
      const sqlAfter = await benchmarkTelemetry();
      const operations = ['reward_preview', 'start', 'proof_submit', 'review_settle', 'wallet_read', 'cosmetic_purchase'];
      runs.push({ repeat, concurrency: tier, journeys: sampleCount,
        duration_seconds: Math.round(seconds * 1000) / 1000,
        journey_throughput_rps: Math.round(sampleCount / seconds * 100) / 100, resources,
        sql_telemetry: { query_count_delta: sqlAfter.query_count - sqlBefore.query_count,
          query_errors_delta: sqlAfter.query_errors - sqlBefore.query_errors,
          cumulative_roundtrip_ms: sqlAfter.sql_roundtrip_ms, pool_after_run: sqlAfter.pool },
        invariant: await verifyAfterRun(before),
        operations: Object.fromEntries(operations.map(operation => {
          const values = durations.filter(row => row.repeat === repeat && row.tier === tier && row.operation === operation).map(row => row.ms);
          return [operation, { samples: values.length, p50_ms: percentile(values, 0.5),
            p95_ms: percentile(values, 0.95), p99_ms: percentile(values, 0.99), raw_ms: values }];
        })) });
    }
  }
  const after = await invariantSnapshot();
  const poolRows = await pool.query(`SELECT allocated_minor::text, available_minor::text,
    reserved_minor::text, paid_minor::text, returned_minor::text FROM reward_pools WHERE id = 'lab-economy-pool'`);
  const p = poolRows.rows[0];
  const conservation = BigInt(p.allocated_minor) === BigInt(p.available_minor) + BigInt(p.reserved_minor) +
    BigInt(p.paid_minor) + BigInt(p.returned_minor);
  const duplicates = await pool.query(`SELECT
    (SELECT count(*)::int FROM (SELECT user_id, scope_key FROM reward_awards GROUP BY user_id, scope_key HAVING count(*) > 1) q) AS award,
    (SELECT count(*)::int FROM (SELECT user_id, cosmetic_id FROM economic_entitlements GROUP BY user_id, cosmetic_id HAVING count(*) > 1) q) AS entitlement`);
  const rec = await reconcileEconomy(pool);
  const invariant = { pool_conservation: conservation,
    transfer_derived_account_drift: rec.pilotAccountDrift.length,
    duplicate_awards: duplicates.rows[0].award, duplicate_entitlements: duplicates.rows[0].entitlement,
    legacy_progression_chain_unchanged: JSON.stringify(before) === JSON.stringify(after),
    before, after, pool: p, correctness };
  if (!conservation || rec.pilotAccountDrift.length || duplicates.rows[0].award ||
      duplicates.rows[0].entitlement || !invariant.legacy_progression_chain_unchanged ||
      Object.values(correctness).some(value => value !== 150)) throw new Error('Post-load accounting invariant failed');
  const sourceSha256 = createHash('sha256').update(readFileSync(new URL('../src/economy/service.ts', import.meta.url))).digest('hex');
  const fixtureSha256 = createHash('sha256').update(readFileSync(new URL('economy-browser-fixture.mjs', import.meta.url))).digest('hex');
  console.log(JSON.stringify({ evidence_class: 'local bearer-auth HTTP mutation load on fictional marked PostgreSQL fixture',
    fixture_profile: fixture.fixture_version, migration_count: fixture.migration_count,
    source_sha256: sourceSha256, fixture_sha256: fixtureSha256,
    http_source_sha256: createHash('sha256').update(['../src/routes/economyReads.ts', '../src/economy/profile.ts', '../src/db/pool.ts', '../src/services/submissions.ts'].map(path => readFileSync(new URL(path, import.meta.url), 'utf8')).join('\n')).digest('hex'),
    host: { platform: platform(), release: release(), cpus: cpus().length, memory_bytes: totalmem(), node: process.version },
    warmup: true, runs, invariant }));
} finally { await pool.end(); }
