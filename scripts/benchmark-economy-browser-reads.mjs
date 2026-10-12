#!/usr/bin/env node
// Local-only HTTP read benchmark. It never mutates economic state after the
// fixture has been created, and it prints no cookie, token, email or actor ID.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { cpus, totalmem, platform, release } from 'node:os';

const [database, marker] = process.argv.slice(2);
if (!/^jdq_economy_lab_[a-f0-9]{12}_dev$/.test(database || '') ||
    !/^[0-9a-f-]{36}$/i.test(marker || '')) {
  throw new Error('Supply exact marked disposable lab database and UUID marker');
}
const base = 'http://127.0.0.1:4300/api/v1';
const check = spawnSync('node', ['scripts/economy-browser-fixture.mjs', '--check', database, marker],
  { cwd: new URL('..', import.meta.url), encoding: 'utf8' });
if (check.status !== 0) throw new Error('Marked fixture check failed');
const fixture = JSON.parse(check.stdout.trim().split('\n').at(-1));
if (!['browser-lab-bench-v1', 'browser-lab-bench-v2'].includes(fixture.fixture_version)) {
  throw new Error('A fresh benchmark-profile fixture is required');
}

async function login(seed) {
  const response = await fetch(`${base}/auth/demo-login`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:3300' },
    body: JSON.stringify({ seed_id: seed }), signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`Benchmark login failed: HTTP ${response.status}`);
  const cookie = response.headers.get('set-cookie')?.split(';')[0];
  if (!cookie) throw new Error('Benchmark login did not issue a session cookie');
  return cookie;
}

function percentile(sorted, fraction) {
  return Math.round(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] * 100) / 100;
}

async function timed(path, cookie) {
  const began = performance.now();
  let status = 0;
  try {
    const response = await fetch(`${base}${path}`, {
      headers: { Cookie: cookie }, cache: 'no-store', signal: AbortSignal.timeout(15000),
    });
    status = response.status;
    await response.arrayBuffer();
  } catch { status = 0; }
  return { ms: Math.round((performance.now() - began) * 100) / 100, status };
}

async function run(path, concurrency, cookies) {
  const sampleCount = 40;
  const samples = new Array(sampleCount);
  let next = 0;
  const began = performance.now();
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (next < sampleCount) {
      const index = next++;
      samples[index] = await timed(path, cookies[index % cookies.length]);
    }
  }));
  const seconds = (performance.now() - began) / 1000;
  const sorted = samples.map(sample => sample.ms).sort((a, b) => a - b);
  return { concurrency, sample_count: sampleCount, duration_seconds: Math.round(seconds * 1000) / 1000,
    throughput_rps: Math.round(sampleCount / seconds * 100) / 100,
    p50_ms: percentile(sorted, 0.5), p95_ms: percentile(sorted, 0.95), p99_ms: percentile(sorted, 0.99),
    statuses: Object.fromEntries([...new Set(samples.map(item => item.status))]
      .map(status => [status, samples.filter(item => item.status === status).length])),
    raw_ms: samples.map(item => item.ms) };
}

const sourceSha256 = createHash('sha256').update(readFileSync(new URL('../src/economy/readModel.ts', import.meta.url))).digest('hex');
const fixtureSha256 = createHash('sha256').update(readFileSync(new URL('economy-browser-fixture.mjs', import.meta.url))).digest('hex');
const cookies = [];
for (let index = 1; index <= 18; index++) cookies.push(await login(`wallet:lab-bench-${index}`));
cookies.push(await login('wallet:lab-traveler'));
cookies.push(await login('wallet:lab-appeal'));
const operations = {
  reward_preview: '/economy/quests/lab-economy-reviewed-quest/reward',
  wallet: '/economy/me', activity: '/economy/me/activity?limit=20',
};
for (const [name, path] of Object.entries(operations)) {
  const warmup = await timed(path, cookies[0]);
  if (warmup.status !== 200) throw new Error(`Warmup failed for ${name}: HTTP ${warmup.status}`);
}
const runs = [];
for (let repeat = 1; repeat <= 3; repeat++) {
  for (const [name, path] of Object.entries(operations)) {
    for (const concurrency of [1, 5, 20]) {
      runs.push({ repeat, operation: name, ...await run(path, concurrency, cookies) });
    }
  }
}
console.log(JSON.stringify({ evidence_class: 'local HTTP read load on fictional marked PostgreSQL fixture',
  fixture_profile: fixture.fixture_version, migration_count: fixture.migration_count,
  source_sha256: sourceSha256, fixture_sha256: fixtureSha256,
  http_source_sha256: createHash('sha256').update(['../src/routes/economyReads.ts', '../src/economy/profile.ts', '../src/db/pool.ts'].map(path => readFileSync(new URL(path, import.meta.url), 'utf8')).join('\n')).digest('hex'),
  host: { platform: platform(), release: release(), cpus: cpus().length, memory_bytes: totalmem(), node: process.version },
  warmup: true, repeats: 3, runs }));
