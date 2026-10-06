/** Isolated local capacity preflight. Never point this at an alpha or production database. */
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import jwt from 'jsonwebtoken';
import { Pool } from 'pg';
import { app } from '../src/app.js';
import { env } from '../src/config/env.js';
import { db } from '../src/db/index.js';
import { createTestDb } from '../src/db/testHarness.js';
import { setPool } from '../src/db/pool.js';
import { createMonthlySchedule, reconcileMonthlySchedulesAt } from '../src/juanchoice/monthly-service.js';
import { execSync, fork, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { localMonth, monthlyWindow, nextMonth } from '../src/juanchoice/monthly-policy.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { installAcquisitionProbe, type AcquisitionProbe, type AcquisitionPhase } from './juanchoice-pool-acquisition-probe.js';
import {
  resolveBallotMode,
  resolveClientMode,
  resolveReaderAuthMode,
  type BallotMode,
  type ClientMode,
  type ReaderAuthMode,
} from './juanchoice-capacity-mode.js';
import type { ChildToParentMessage, ParentToChildMessage, SanitizedSample } from './juanchoice-capacity-child-client.js';
import {
  calculateExpectedCapacityBounds,
  validateChildDonePayload,
  type ValidatedChildResult,
} from './juanchoice-capacity-ipc-validator.js';
import {
  assembleWalletReaderFixtureForHarness,
  type WalletReaderAssemblyResult,
} from './juanchoice-capacity-reader-assembly.js';
import { buildReaderAuthHeaders } from './juanchoice-capacity-reader-headers.js';
import { countDisposableWalletReaderBatchChecks, isDisposableWalletReaderLookup } from './juanchoice-capacity-reader-matcher.js';
import {
  buildReadQueryFocusReport,
  installPoolQueryProfile,
  instrumentCallbackClientQuery,
  sqlShape,
  type SqlProfilePath,
} from './juanchoice-capacity-sql-profile.js';
import {
  BallotAdmissionController,
  isBallotRequest,
  resolveBallotAdmission,
} from './juanchoice-capacity-ballot-admission.js';
import { retainLongestIntervals, stallOverlapReport, stallTimelineReport, type MonotonicInterval } from './juanchoice-capacity-stall-overlap.js';
import { CapacityCpuProfiler, formatCpuProfileSummaryLine } from './juanchoice-capacity-cpu-profile.js';

export {
  resolveBallotAdmission,
  resolveBallotMode,
  resolveClientMode,
  resolveReaderAuthMode,
  type BallotMode,
  type ClientMode,
  type ReaderAuthMode,
};
export const ballotMode: BallotMode = resolveBallotMode(process.env.JDQ_CAPACITY_BALLOT_MODE);
export const clientMode: ClientMode = resolveClientMode(process.env.JDQ_CAPACITY_CLIENT_MODE);
export const readerAuthMode: ReaderAuthMode = resolveReaderAuthMode(process.env.JDQ_CAPACITY_READER_AUTH);

const durationMs = Number(process.env.JDQ_CAPACITY_DURATION_MS ?? 600_000);
const poolMax = Number(process.env.JDQ_CAPACITY_POOL_MAX ?? 5);
export const ballotAdmissionLimit: number = resolveBallotAdmission(process.env.JDQ_CAPACITY_BALLOT_ADMISSION, poolMax);
const readerCount = 100;
const voterCount = 50;
const pollIntervalMs = 15_000;
assert(Number.isInteger(durationMs) && durationMs >= 30_000 && durationMs <= 600_000,
  'JDQ_CAPACITY_DURATION_MS must be 30000–600000');
assert(Number.isInteger(poolMax) && poolMax >= 1 && poolMax <= 50,
  'JDQ_CAPACITY_POOL_MAX must be 1–50');
assert(process.env.JDQ_REAL_PG_URL, 'JDQ_REAL_PG_URL is required');
assert(env.NODE_ENV !== 'production', 'Capacity rehearsal cannot run in production mode');

function getSourceIdentity(): { commit: string | null; isDirty: boolean | null } {
  try {
    const commit = execSync('git rev-parse HEAD', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const status = execSync('git status --porcelain', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return { commit: commit || null, isDirty: status.length > 0 };
  } catch {
    return { commit: null, isDirty: null };
  }
}

import {
  assertResponseLifecycleDiagnosticIntegrity,
  assertCapacityPopulationIntegrity,
  computeCorrelatedSegmentSummary,
  summarizeNegativeDurationGaps,
  summarizeResponseLifecycleDiagnostics,
  type CorrelatedSegmentSummary,
  type RequestTimingSample,
  type ServerTimingRecord,
} from './juanchoice-capacity-segments.js';
import {
  summarizeArrivals,
  type RawArrivalRecord,
  type ArrivalKind,
} from './juanchoice-capacity-arrivals.js';

type Sample = RequestTimingSample;
const reads: Sample[] = [];
const ballots: Sample[] = [];
const errors: string[] = [];
const percentile = (samples: Sample[], p: number) => {
  const values = samples.map(s => s.totalClientMs).sort((a, b) => a - b);
  return values[Math.min(values.length - 1, Math.ceil(values.length * p) - 1)] ?? 0;
};

type GroupSummary = CorrelatedSegmentSummary;

function computeGroupSummary(samples: Sample[], serverTimings: Map<string, ServerTimingRecord>): GroupSummary {
  return computeCorrelatedSegmentSummary(samples, serverTimings);
}

async function main() {
  const cpuProfiler = new CapacityCpuProfiler(process.env.JDQ_CAPACITY_CPU_PROFILE);
  const fixture = await createTestDb({ poolMax });
  setPool(fixture.pool);
  db.usersRepo.setPool(fixture.pool);
  const flags = {
    JUANCHOICE_ENABLED: env.JUANCHOICE_ENABLED,
    JUANCHOICE_SCHEDULER_ENABLED: env.JUANCHOICE_SCHEDULER_ENABLED,
    JUANCHOICE_WRITES_ENABLED: env.JUANCHOICE_WRITES_ENABLED,
    JUANCHOICE_BATCH_WRITES_ENABLED: env.JUANCHOICE_BATCH_WRITES_ENABLED,
    PROGRESSION_ENABLED: env.PROGRESSION_ENABLED,
    ALPHA_WALLET_SIMULATION_ENABLED: env.ALPHA_WALLET_SIMULATION_ENABLED,
  };
  Object.assign(env, {
    JUANCHOICE_ENABLED: true, JUANCHOICE_SCHEDULER_ENABLED: true,
    JUANCHOICE_WRITES_ENABLED: true,
    JUANCHOICE_BATCH_WRITES_ENABLED: ballotMode === 'batch',
    PROGRESSION_ENABLED: true,
    ...(readerAuthMode === 'wallet_alpha' ? { ALPHA_WALLET_SIMULATION_ENABLED: true } : {}),
  });
  let server: http.Server | undefined;
  let childProcess: ChildProcess | undefined;
  let childExitStatus: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  let childExitPromise: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | undefined;

  async function terminateAndReapChild(
    child: ChildProcess,
    exitPromise: Promise<{ code: number | null; signal: NodeJS.Signals | null }>,
    reason: string
  ): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    if (child.exitCode !== null || child.signalCode !== null || childExitStatus !== null) {
      return (await exitPromise);
    }

    if (child.connected) {
      try {
        child.send({ type: 'ABORT' } as ParentToChildMessage);
      } catch {
        // Channel may have closed concurrently
      }
    }

    try {
      child.kill('SIGTERM');
    } catch {
      // Process may already have terminated
    }

    const waitForExitWithDeadline = (ms: number) => {
      let handle: NodeJS.Timeout | undefined;
      const timer = new Promise<'timeout'>(resolve => {
        handle = setTimeout(() => resolve('timeout'), ms);
      });
      return Promise.race([exitPromise, timer]).finally(() => {
        if (handle) clearTimeout(handle);
      });
    };

    let outcome = await waitForExitWithDeadline(2000);
    if (outcome !== 'timeout') {
      return outcome;
    }

    try {
      child.kill('SIGKILL');
    } catch {
      // Process may already have terminated
    }

    outcome = await waitForExitWithDeadline(2000);
    if (outcome !== 'timeout') {
      return outcome;
    }

    throw new Error(`Child process failed to exit within bounded reap deadlines (${reason}); retaining fixture to prevent unsafe cleanup`);
  }

  const monitor = new Pool({ connectionString: process.env.JDQ_REAL_PG_URL, max: 1 });
  let maxLockWaiters = 0;
  let lockSamples = 0;
  let maxPoolWaiting = 0;
  let maxPoolTotal = 0;
  let queryProfileActive = false;
  let walletDurableLookupCount = 0;
  let walletIdentityQueryCount = 0;
  const disposableReaderIds = new Set<string>();
  const instrumentedClients = new WeakSet<object>();
  const sqlTimings = new Map<string, number[]>();
  const sqlErrors = new Map<string, number>();
  let slowWalletBatchIntervals: MonotonicInterval[] = [];
  let timerGapIntervals: MonotonicInterval[] = [];
  const recordSql = (path: SqlProfilePath, query: unknown, elapsedMs: number, success: boolean,
    startMs?: number, endMs?: number) => {
    const shape = sqlShape(query);
    const key = `${path}|${shape}`;
    const samples = sqlTimings.get(key) ?? [];
    samples.push(elapsedMs);
    sqlTimings.set(key, samples);
    if (!success) sqlErrors.set(key, (sqlErrors.get(key) ?? 0) + 1);
    if (path === 'client_callback_query'
      && shape === 'SELECT id, seed_id, is_test FROM users WHERE id = ANY($1::text[])'
      && startMs !== undefined && endMs !== undefined) {
      slowWalletBatchIntervals = retainLongestIntervals(slowWalletBatchIntervals, { start: startMs, end: endMs });
    }
  };
  const restorePoolQuery = installPoolQueryProfile(fixture.pool, {
    isActive: () => queryProfileActive,
    record: (query, elapsedMs, success) => recordSql('pool_query', query, elapsedMs, success),
    isWalletLookup: (query, values) => isDisposableWalletReaderLookup(query, values, disposableReaderIds) ||
      countDisposableWalletReaderBatchChecks(query, values, disposableReaderIds) > 0,
    onWalletLookup: (query, values) => {
      walletDurableLookupCount += isDisposableWalletReaderLookup(query, values, disposableReaderIds) ? 1 :
        countDisposableWalletReaderBatchChecks(query, values, disposableReaderIds);
      walletIdentityQueryCount++;
    },
  });

  fixture.pool.on('acquire', client => {
    if (instrumentedClients.has(client)) return;
    instrumentedClients.add(client);
    instrumentCallbackClientQuery(client, {
      isActive: () => queryProfileActive,
      record: (query, elapsedMs, success, startMs, endMs) =>
        recordSql('client_callback_query', query, elapsedMs, success, startMs, endMs),
    });
    const originalQuery = client.query;
    client.query = ((...args: unknown[]) => {
      const result = Reflect.apply(originalQuery, client, args);
      if (!queryProfileActive || !result || typeof result.then !== 'function') return result;
      const query = args[0];
      const started = performance.now();
      return result.then((value: unknown) => {
        recordSql('transaction_client_query', query, performance.now() - started, true);
        return value;
      }, (error: unknown) => {
        recordSql('transaction_client_query', query, performance.now() - started, false);
        throw error;
      });
    }) as typeof client.query;
  });
  let poolSampler: NodeJS.Timeout | undefined;
  let stallHeartbeat: NodeJS.Timeout | undefined;
  let acquisitionProbe: AcquisitionProbe | undefined;
  const eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });
  let cpuStart: NodeJS.CpuUsage | undefined;
  const serverTimings = new Map<string, ServerTimingRecord>();
  let duplicateReqIdDetected = false;

  try {
    const now = new Date();
    const voters = Array.from({ length: voterCount }, (_, i) => ({
      id: randomUUID(), seed: `cv-${i}-${randomUUID()}`,
    }));
    for (const voter of voters) {
      await fixture.pool.query(`INSERT INTO users(id,seed_id,display_name,email,created_at,is_test)
        VALUES($1,$2,'Capacity voter',$3,$4,false)`, [voter.id, voter.seed,
        `${voter.id}@example.test`, new Date(now.getTime() - 4 * 86_400_000)]);
    }

    // Assemble disposable wallet reader fixture if wallet_alpha is selected.
    // Kept in memory, ordered by reader index. Never logged or exposed in IPC/stdout.
    // Reader identities are scoped to this disposable fixture in either client mode.
    const readerAssembly = await assembleWalletReaderFixtureForHarness(
      readerAuthMode,
      fixture.pool,
      env.JWT_SECRET,
      readerCount
    );
    const seededReaderCount = readerAssembly.seededCount;
    // Retained in-memory for exact reader ID lookup instrumentation.
    // Never printed or included in a report, thrown error, child environment, or process command line.
    for (const readerId of readerAssembly.readerUserIds) {
      disposableReaderIds.add(readerId);
    }
    const readerTokens = readerAssembly.tokens;
    for (let i = 0; i < 4; i++) {
      const id = `capacity-spot-${i}`;
      const municipality = ['Bolinao', 'Anda', 'Sual', 'Lingayen'][i];
      await fixture.pool.query(`INSERT INTO spots(id,slug,name,description,category,subcategory,municipality,address,
        gps_lat,gps_lng,source_type,source_name,is_test)
        VALUES($1,$2,$3,'Disposable load fixture','nature_outdoors','coast',$4,$5,16,120,'lgu','Fixture',false)`,
      [id, id, `Capacity destination ${i}`, municipality, municipality]);
    }
    const period = nextMonth(localMonth(now, 'Asia/Manila'));
    await createMonthlySchedule({
      schedule_key: 'capacity-rehearsal', region_key: 'pangasinan', display_region: 'Pangasinan',
      timezone: 'Asia/Manila', enabled: true, effective_period: period, preparation_lead_days: 7,
      minimum_candidates: 2, target_candidates: 4, maximum_candidates: 6,
      themes: [{ name: 'Coastal discovery', categories: ['nature_outdoors'] }],
      policy_version: 'juanchoice-monthly-v1', is_test: false,
    });
    const opening = monthlyWindow(period, 'Asia/Manila').opensAt;
    assert.equal((await reconcileMonthlySchedulesAt(new Date(opening.getTime() - 3 * 86_400_000))).prepared, 1);
    const round = (await fixture.pool.query('SELECT id,campaign_id FROM juanchoice_schedule_periods WHERE period_start=$1',
      [period])).rows[0];
    assert(round?.campaign_id, 'No prepared campaign');
    const opensAt = new Date(now.getTime() - 60_000);
    const closesAt = new Date(now.getTime() + durationMs + 120_000);
    await fixture.pool.query('UPDATE juanchoice_schedule_periods SET opens_at=$2,closes_at=$3 WHERE id=$1',
      [round.id, opensAt, closesAt]);
    await fixture.pool.query('UPDATE juanchoice_campaigns SET opens_at=$2,closes_at=$3 WHERE id=$1',
      [round.campaign_id, opensAt, closesAt]);
    const candidateIds = (await fixture.pool.query('SELECT id FROM juanchoice_candidates WHERE campaign_id=$1 ORDER BY id',
      [round.campaign_id])).rows.map(row => row.id as string);
    assert.equal(candidateIds.length, 4);

    const phaseContext = new AsyncLocalStorage<AcquisitionPhase>();
    const ballotAdmission = new BallotAdmissionController({ limit: ballotAdmissionLimit, maxQueueDepth: 100 });

    // Test-only node:http server wrapper recording ingress-to-finish duration
    server = http.createServer((req, res) => {
      const rawPhaseHeader = req.headers['x-benchmark-phase'];
      if (rawPhaseHeader !== 'mixed_ballot_burst' && rawPhaseHeader !== 'idle_read') {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.end('Bad Request: Invalid or missing benchmark phase');
        return;
      }
      const validatedPhase: AcquisitionPhase = rawPhaseHeader;

      const ingressAt = performance.now();
      const rawHeader = req.headers['x-benchmark-request-id'];
      const reqId = typeof rawHeader === 'string' ? rawHeader : Array.isArray(rawHeader) ? rawHeader[0] : undefined;

      let prefinishAt: number | undefined;
      res.once('prefinish', () => {
        prefinishAt = performance.now();
      });

      const recordServerTiming = () => {
        if (reqId) {
          if (serverTimings.has(reqId)) {
            duplicateReqIdDetected = true;
          }
          const finishAt = performance.now();
          const duration = finishAt - ingressAt;
          serverTimings.set(reqId, {
            serverIngress: ingressAt,
            ...(prefinishAt !== undefined ? { serverPrefinish: prefinishAt } : {}),
            serverFinish: finishAt,
            durationMs: duration >= 0 ? duration : 0,
            statusCode: res.statusCode,
          });
        }
      };

      res.on('finish', recordServerTiming);

      if (ballotAdmissionLimit > 0 && isBallotRequest(req.method, req.url)) {
        const abortCtrl = new AbortController();
        const onPrematureClose = () => {
          abortCtrl.abort();
        };

        if (req.aborted || res.destroyed || res.writableEnded) {
          abortCtrl.abort();
        } else {
          req.on('aborted', onPrematureClose);
          res.on('close', onPrematureClose);
        }

        ballotAdmission.acquire(abortCtrl.signal).then(release => {
          req.removeListener('aborted', onPrematureClose);
          res.removeListener('close', onPrematureClose);

          let permitReleased = false;
          const safeRelease = () => {
            if (!permitReleased) {
              permitReleased = true;
              release();
            }
          };

          // If the client/connection closed before permit was granted or listeners were attached
          if (req.aborted || res.destroyed || res.writableEnded) {
            safeRelease();
            return;
          }

          res.on('finish', safeRelease);
          res.on('close', safeRelease);

          phaseContext.run(validatedPhase, () => {
            app(req, res);
          });
        }).catch(err => {
          req.removeListener('aborted', onPrematureClose);
          res.removeListener('close', onPrematureClose);

          if (!res.writableEnded && !res.destroyed) {
            res.statusCode = 503;
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            res.end(`Service Unavailable: ${err instanceof Error ? err.message : String(err)}`);
          }
        });
      } else {
        phaseContext.run(validatedPhase, () => {
          app(req, res);
        });
      }
    });

    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}/api/v1/juanchoice`;
    const tokens = voters.map(voter => jwt.sign({ id: voter.id, seed_id: voter.seed, role: 'user' }, env.JWT_SECRET));

    async function timed(url: string, options: RequestInit, target: Sample[], label: string, phase?: AcquisitionPhase) {
      const reqId = randomUUID();
      const existingHeaders = (options.headers as Record<string, string>) || {};
      const benchmarkHeaders: Record<string, string> = {
        'x-benchmark-request-id': reqId,
      };
      if (phase) {
        benchmarkHeaders['x-benchmark-phase'] = phase;
      }
      const requestOptions: RequestInit = {
        ...options,
        headers: {
          ...existingHeaders,
          ...benchmarkHeaders,
        },
        signal: AbortSignal.timeout(10_000),
      };

      const clientStart = performance.now();
      const kind = label.startsWith('vote') ? label.split(' ')[1].split(':')[0]
        : url.endsWith('/overview') ? 'overview' : 'standings';
      try {
        const response = await fetch(url, requestOptions);
        const headersResolved = performance.now();
        await response.arrayBuffer();
        const clientBodyConsumed = performance.now();
        const totalClientMs = clientBodyConsumed - clientStart;
        target.push({
          reqId,
          kind,
          status: response.status,
          clientStart,
          headersResolved,
          clientBodyConsumed,
          totalClientMs,
        });
        if (response.status !== 200) errors.push(`${label}: HTTP ${response.status}`);
      } catch (error) {
        const end = performance.now();
        target.push({
          reqId,
          kind,
          status: 0,
          clientStart,
          totalClientMs: end - clientStart,
        });
        errors.push(`${label}: ${String(error)}`);
      }
    }

    async function monitoredVote(version: number) {
      let active = true;
      const sampler = (async () => {
        while (active) {
          try {
            const row = (await monitor.query(`SELECT COUNT(*)::int AS count FROM pg_stat_activity
              WHERE datname='jdq_reliability_test' AND wait_event_type='Lock' AND pid<>pg_backend_pid()`)).rows[0];
            maxLockWaiters = Math.max(maxLockWaiters, Number(row.count));
            lockSamples++;
          } catch (error) {
            errors.push(`lock sampler: ${String(error)}`);
          }
          if (active) await new Promise(resolve => setTimeout(resolve, 100));
        }
      })();
      try { await vote(version); }
      finally { active = false; await sampler; }
    }
    const vote = (version: number) => Promise.all(voters.map((_, i) => timed(
      `${base}/campaigns/${round.campaign_id}/ballot`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json',
          Authorization: `Bearer ${tokens[i]}`, 'Idempotency-Key': randomUUID(),
          'X-Forwarded-For': `10.40.2.${i + 1}` },
        body: JSON.stringify({ candidate_id: candidateIds[(i + version) % candidateIds.length], expected_version: version }),
      }, ballots, `vote ${version}:${i}`, 'mixed_ballot_burst')));
    const readRound = (roundIndex: number, phase: AcquisitionPhase) => Promise.all(Array.from({ length: readerCount }, (_, i) => timed(
      i % 2 === 0 ? `${base}/overview` : `${base}/campaigns/${round.campaign_id}/standings`,
      {
        headers: {
          'X-Forwarded-For': `10.40.1.${i + 1}`,
          ...buildReaderAuthHeaders(readerAuthMode, i, readerTokens, readerCount),
        },
      }, reads, `read ${roundIndex}:${i}`, phase)));

    await cpuProfiler.start();
    const startedAt = Date.now();
    cpuStart = process.cpuUsage();
    eventLoopDelay.enable();
    queryProfileActive = true;
    let nextExpectedTick = performance.now() + 20;
    stallHeartbeat = setInterval(() => {
      const actualTick = performance.now();
      if (actualTick - nextExpectedTick > 50) {
        timerGapIntervals = retainLongestIntervals(timerGapIntervals,
          { start: nextExpectedTick, end: actualTick });
      }
      nextExpectedTick = actualTick + 20;
    }, 20);
    acquisitionProbe = installAcquisitionProbe(fixture.pool, () => phaseContext.getStore() ?? 'unscoped');
    poolSampler = setInterval(() => {
      maxPoolWaiting = Math.max(maxPoolWaiting, fixture.pool.waitingCount);
      maxPoolTotal = Math.max(maxPoolTotal, fixture.pool.totalCount);
    }, 20);

    if (clientMode === 'child_process') {
      const childScriptTs = path.resolve(process.cwd(), 'scripts', 'juanchoice-capacity-child-client.ts');
      const childScriptJs = path.resolve(process.cwd(), '.local', 'capacity-build', 'scripts', 'juanchoice-capacity-child-client.js');
      const isTsMode = fs.existsSync(childScriptTs) && (Boolean(process.env.TSX) || !fs.existsSync(childScriptJs));
      const childScript = isTsMode ? childScriptTs : childScriptJs;
      const childExecArgv = isTsMode ? ['-r', 'tsx'] : [];

      // Minimal explicit environment: do NOT pass PG credentials, URL, or JWT secrets
      const childEnv: NodeJS.ProcessEnv = {
        PATH: process.env.PATH,
        NODE_ENV: 'test',
        NODE_PATH: process.env.NODE_PATH,
        HOME: process.env.HOME,
        LANG: process.env.LANG,
        LC_ALL: process.env.LC_ALL,
      };

      childProcess = fork(childScript, [], {
        cwd: process.cwd(),
        env: childEnv,
        execArgv: childExecArgv,
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      });

      const child = childProcess;
      childExitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        child.on('exit', (code, signal) => {
          childExitStatus = { code, signal };
          resolve({ code, signal });
        });
      });

      const bounds = calculateExpectedCapacityBounds(durationMs, pollIntervalMs, readerCount, voterCount);
      let childReady = false;
      let childDoneReceived = false;
      let childFailureReason: string | null = null;
      let failEarlyPrompt: (() => void) | null = null;
      const failEarlyPromise = new Promise<void>((resolve) => {
        failEarlyPrompt = resolve;
      });

      child.on('error', (_err) => {
        if (!childFailureReason) {
          childFailureReason = 'CHILD_PROCESS_ERROR_EVENT';
          errors.push('CHILD_PROCESS_ERROR_EVENT');
        }
        if (failEarlyPrompt) failEarlyPrompt();
      });

      child.on('disconnect', () => {
        if (!childDoneReceived && !childFailureReason) {
          childFailureReason = 'CHILD_DISCONNECT_BEFORE_VALID_DONE';
          errors.push('CHILD_DISCONNECT_BEFORE_VALID_DONE');
        }
        if (failEarlyPrompt) failEarlyPrompt();
      });

      child.on('message', (msg: unknown) => {
        if (!msg || typeof msg !== 'object') return;
        const typedMsg = msg as Partial<ChildToParentMessage>;

        if (typedMsg.type === 'READY') {
          childReady = true;
        } else if (typedMsg.type === 'PROGRESS') {
          if (
            typeof typedMsg.elapsed_s === 'number' &&
            typeof typedMsg.reads === 'number' &&
            typeof typedMsg.ballots === 'number' &&
            typeof typedMsg.errors === 'number'
          ) {
            process.stdout.write(`CAPACITY_PROGRESS elapsed_s=${typedMsg.elapsed_s} reads=${typedMsg.reads} ballots=${typedMsg.ballots} errors=${typedMsg.errors}\n`);
          }
        } else if (typedMsg.type === 'DONE') {
          if (childDoneReceived) {
            // Duplicate DONE message rejected - do not mutate or acknowledge
            if (!childFailureReason) {
              childFailureReason = 'CHILD_DUPLICATE_DONE_RECEIVED';
              errors.push('CHILD_DUPLICATE_DONE_RECEIVED');
            }
            if (failEarlyPrompt) failEarlyPrompt();
            return;
          }

          let validation: ValidatedChildResult;
          try {
            validation = validateChildDonePayload(msg, bounds);
          } catch {
            if (!childFailureReason) {
              childFailureReason = 'CHILD_MALFORMED_DONE_PAYLOAD';
              errors.push('CHILD_MALFORMED_DONE_PAYLOAD');
            }
            if (failEarlyPrompt) failEarlyPrompt();
            return;
          }

          childDoneReceived = true;
          for (const s of validation.reads) reads.push(s);
          for (const s of validation.ballots) ballots.push(s);
          for (const err of validation.errors) errors.push(err);

          try {
            child.send({ type: 'ACK_DONE' } as ParentToChildMessage);
          } catch {
            // IPC channel may already be closed
          }
        } else if (typedMsg.type === 'ERROR') {
          if (!childFailureReason) {
            childFailureReason = 'CHILD_REPORTED_ERROR';
            errors.push('CHILD_REPORTED_ERROR');
          }
          if (failEarlyPrompt) failEarlyPrompt();
        }
      });

      // Wait up to 10s for child to be READY
      const readyDeadline = Date.now() + 10_000;
      while (!childReady && Date.now() < readyDeadline) {
        if (childExitStatus !== null || childFailureReason) break;
        await new Promise(r => setTimeout(r, 50));
      }
      assert(childReady && !childFailureReason, 'Child load client failed to report READY within 10s');

      // Start lock sampling monitor in parent
      let activeLockSampling = true;
      const lockSampler = (async () => {
        while (activeLockSampling) {
          try {
            const row = (await monitor.query(`SELECT COUNT(*)::int AS count FROM pg_stat_activity
              WHERE datname='jdq_reliability_test' AND wait_event_type='Lock' AND pid<>pg_backend_pid()`)).rows[0];
            maxLockWaiters = Math.max(maxLockWaiters, Number(row.count));
            lockSamples++;
          } catch {
            errors.push('LOCK_SAMPLER_FAILURE');
          }
          if (activeLockSampling) await new Promise(r => setTimeout(r, 100));
        }
      })();

      process.stdout.write(`CAPACITY_START voters=${voterCount} readers=${readerCount} duration_ms=${durationMs} client_mode=child_process\n`);
      const startMsg: ParentToChildMessage = {
        type: 'START',
        config: {
          baseUrl: base,
          campaignId: round.campaign_id,
          candidateIds,
          tokens,
          durationMs,
          pollIntervalMs,
          voterCount,
          readerCount,
          readerAuthMode,
          ...(readerAuthMode === 'wallet_alpha' ? { readerTokens } : {}),
        },
      };
      child.send(startMsg);

      // Bounded wait for child completion (durationMs + 20s allowance), or prompt early failure
      const timeoutMs = durationMs + 20_000;
      let timeoutHandle: NodeJS.Timeout | undefined;
      const timeoutPromise = new Promise<'timeout'>(r => {
        timeoutHandle = setTimeout(() => r('timeout'), timeoutMs);
      });
      let finishedOrTimeout: { code: number | null; signal: NodeJS.Signals | null } | 'timeout' | 'fail_early';
      try {
        finishedOrTimeout = await Promise.race([
          childExitPromise,
          timeoutPromise,
          failEarlyPromise.then(() => 'fail_early' as const),
        ]);
      } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle);
      }

      activeLockSampling = false;
      await lockSampler;

      let finalExitStatus: { code: number | null; signal: NodeJS.Signals | null };
      if (finishedOrTimeout === 'timeout') {
        errors.push(`CHILD_WORKLOAD_TIMEOUT_${timeoutMs}MS`);
        finalExitStatus = await terminateAndReapChild(child, childExitPromise, `timeout after ${timeoutMs}ms`);
      } else if (finishedOrTimeout === 'fail_early') {
        finalExitStatus = await terminateAndReapChild(child, childExitPromise, childFailureReason ?? 'early failure');
      } else {
        finalExitStatus = finishedOrTimeout;
      }

      assert(childDoneReceived, `Child process completed without sending valid single DONE message (${childFailureReason ?? 'unknown failure'})`);
      assert(finalExitStatus.code === 0, `Child process exited with non-zero code (${finalExitStatus.code}, signal=${finalExitStatus.signal})`);
    } else {
      let readRoundCount = 0;
      let changed = false;
      await Promise.all([monitoredVote(0), readRound(readRoundCount++, 'mixed_ballot_burst')]);
      process.stdout.write(`CAPACITY_START voters=${voterCount} readers=${readerCount} duration_ms=${durationMs} client_mode=inprocess\n`);
      while (Date.now() - startedAt < durationMs) {
        const nextAt = startedAt + readRoundCount * pollIntervalMs;
        if (Date.now() < nextAt) await new Promise(resolve => setTimeout(resolve, nextAt - Date.now()));
        if (!changed && Date.now() - startedAt >= durationMs / 2) {
          await Promise.all([monitoredVote(1), readRound(readRoundCount++, 'mixed_ballot_burst')]);
          changed = true;
        } else {
          await readRound(readRoundCount++, 'idle_read');
        }
        if (readRoundCount % 4 === 0) process.stdout.write(`CAPACITY_PROGRESS elapsed_s=${Math.round((Date.now() - startedAt) / 1000)} reads=${reads.length} ballots=${ballots.length} errors=${errors.length}\n`);
      }
      assert(changed, 'Second concurrent vote wave did not run');
    }

    // Keep post-workload accounting and synchronous Git source identification
    // outside the request-window event-loop measurement.
    if (stallHeartbeat) { clearInterval(stallHeartbeat); stallHeartbeat = undefined; }
    eventLoopDelay.disable();
    const cpuProfileResult = await cpuProfiler.stop();
    const requestWindowEventLoopDelay = {
      p95Ms: Math.round(eventLoopDelay.percentile(95) / 1e6),
      maxMs: Math.round(eventLoopDelay.max / 1e6),
    };
    queryProfileActive = false;
    const counts = (await fixture.pool.query(`SELECT
      (SELECT COUNT(*)::int FROM juanchoice_ballots WHERE campaign_id=$1) AS ballots,
      (SELECT COUNT(*)::int FROM juanchoice_participations WHERE campaign_id=$1) AS participations,
      (SELECT COALESCE(SUM(delta),0)::int FROM progression_events WHERE source_type='juanchoice_participation' AND award_kind='xp') AS civic_xp,
      (SELECT COALESCE(SUM(delta),0)::int FROM progression_events WHERE source_type='juanchoice_participation' AND award_kind='stamp') AS stamps,
      (SELECT COUNT(*)::int FROM juanchoice_ballots b JOIN juanchoice_candidates c ON c.id=b.candidate_id
        WHERE c.campaign_id=$1) AS candidate_votes`,
      [round.campaign_id])).rows[0];
    const pendingOutbox = (await fixture.pool.query(`SELECT COUNT(*)::int AS count,
      EXTRACT(EPOCH FROM clock_timestamp()-MIN(created_at)) AS oldest_seconds
      FROM outbox_events WHERE status IN ('pending','processing','failed')`)).rows[0];
    const cpu = cpuStart ? process.cpuUsage(cpuStart) : null;
    const sourceIdentity = getSourceIdentity();

    // Group-level server and client latency split calculations
    const overviewSamples = reads.filter(s => s.kind === 'overview');
    const standingsSamples = reads.filter(s => s.kind === 'standings');
    const firstBallotSamples = ballots.filter(s => s.kind === '0');
    const changedBallotSamples = ballots.filter(s => s.kind === '1');

    const overviewSummary = computeGroupSummary(overviewSamples, serverTimings);
    const standingsSummary = computeGroupSummary(standingsSamples, serverTimings);
    const firstBallotSummary = computeGroupSummary(firstBallotSamples, serverTimings);
    const changedBallotSummary = computeGroupSummary(changedBallotSamples, serverTimings);
    const readsSummary = computeGroupSummary(reads, serverTimings);
    const ballotsSummary = computeGroupSummary(ballots, serverTimings);

    // Check that every successful response had a matching server timing entry
    const successfulReads = reads.filter(s => s.status === 200);
    const successfulBallots = ballots.filter(s => s.status === 200);
    const unmatchedSuccessfulReads = successfulReads.filter(s => !serverTimings.has(s.reqId));
    const unmatchedSuccessfulBallots = successfulBallots.filter(s => !serverTimings.has(s.reqId));

    // Match each read/ballot sample to serverTimings by opaque request ID for arrival summary.
    // Fail closed if timing matching is incomplete or missing timing records.
    const allSamples = [...reads, ...ballots];
    const missingTimingSamples = allSamples.filter(s => !serverTimings.has(s.reqId));
    if (missingTimingSamples.length > 0) {
      throw new Error(`Incomplete server timing records: ${missingTimingSamples.length} samples lacked server timing matches`);
    }

    const arrivalRecords: RawArrivalRecord[] = allSamples.map(sample => {
      const timing = serverTimings.get(sample.reqId)!;
      return {
        kind: sample.kind as ArrivalKind,
        ingressMs: timing.serverIngress,
        finishMs: timing.serverFinish,
      };
    });

    const serverArrivals = summarizeArrivals(arrivalRecords);

    const timingScope = clientMode === 'child_process'
      ? 'separate_process_client_duration_and_server_ingress_to_finish'
      : 'same_process_correlated_segments';

    const ballotAdmissionStats = ballotAdmission.getStats();
    const ballotAdmissionWaitPercentiles = ballotAdmission.getWaitPercentiles();

    const report = {
      mode: ballotMode,
      client_mode: clientMode,
      reader_auth_mode: readerAuthMode,
      timing_scope: timingScope,
      ballot_admission_limit: ballotAdmissionStats.limit,
      ballot_admission_peak_queue: ballotAdmissionStats.peakQueue,
      ballot_admission_queue_wait_p50_ms: ballotAdmissionWaitPercentiles.p50_ms,
      ballot_admission_queue_wait_p95_ms: ballotAdmissionWaitPercentiles.p95_ms,
      child_exit_status: clientMode === 'child_process' ? childExitStatus : null,
      gate_metric: 'server_p95_ms (backend-only local gate; client_p95_ms retained for historical comparability)',
      git_commit: sourceIdentity.commit,
      git_dirty: sourceIdentity.isDirty,
      duration_ms: Date.now() - startedAt, voter_count: voterCount, reader_count: readerCount,
      // Sanitized fixture count metadata (0 for guest, 100 for wallet_alpha).
      // Both client modes verify the durable reader lookup count before capacity clearance.
      seeded_reader_count: seededReaderCount,
      wallet_durable_lookup_count: walletDurableLookupCount,
      wallet_identity_query_count: walletIdentityQueryCount,
      read_requests: reads.length, ballot_requests: ballots.length,

      // Historical client p95 fields (fetch wall clock, includes client dispatch queue)
      read_p95_ms: readsSummary.client_p95_ms,
      ballot_p95_ms: ballotsSummary.client_p95_ms,
      overview_p95_ms: overviewSummary.client_p95_ms,
      standings_p95_ms: standingsSummary.client_p95_ms,
      first_ballot_p95_ms: firstBallotSummary.client_p95_ms,
      changed_ballot_p95_ms: changedBallotSummary.client_p95_ms,

      // Explicitly named server p95 fields (ingress to response finish)
      server_read_p95_ms: readsSummary.matched_server_p95_ms,
      server_ballot_p95_ms: ballotsSummary.matched_server_p95_ms,
      server_overview_p95_ms: overviewSummary.matched_server_p95_ms,
      server_standings_p95_ms: standingsSummary.matched_server_p95_ms,
      server_first_ballot_p95_ms: firstBallotSummary.matched_server_p95_ms,
      server_changed_ballot_p95_ms: changedBallotSummary.matched_server_p95_ms,

      groups: {
        first_ballot: firstBallotSummary,
        changed_ballot: changedBallotSummary,
        overview: overviewSummary,
        standings: standingsSummary,
        all_reads: readsSummary,
        all_ballots: ballotsSummary,
      },

      // Diagnostic only; strict invalid-sample and latency gates below are unchanged.
      negative_duration_gap_ms: {
        all_reads: summarizeNegativeDurationGaps(reads, serverTimings),
        all_ballots: summarizeNegativeDurationGaps(ballots, serverTimings),
      },
      response_lifecycle_diagnostics: {
        all_reads: summarizeResponseLifecycleDiagnostics(reads, serverTimings),
        all_ballots: summarizeResponseLifecycleDiagnostics(ballots, serverTimings),
      },

      server_arrivals: serverArrivals,

      unmatched_successful_requests: unmatchedSuccessfulReads.length + unmatchedSuccessfulBallots.length,
      duplicate_req_id_detected: duplicateReqIdDetected,

      read_errors: reads.filter(item => item.status !== 200).length,
      ballot_errors: ballots.filter(item => item.status !== 200).length,
      counts, pending_outbox: pendingOutbox, max_lock_waiters_observed: maxLockWaiters,
      lock_samples: lockSamples,
      max_pool_waiting_observed: maxPoolWaiting, max_pool_connections_observed: maxPoolTotal,
      sql_profile_completed_attempts: {
        pool_query: [...sqlTimings.entries()].filter(([key]) => key.startsWith('pool_query|'))
          .reduce((total, [, samples]) => total + samples.length, 0),
        transaction_client_query: [...sqlTimings.entries()].filter(([key]) => key.startsWith('transaction_client_query|'))
          .reduce((total, [, samples]) => total + samples.length, 0),
      },
      event_loop_delay_p95_ms: requestWindowEventLoopDelay.p95Ms,
      event_loop_delay_max_ms: requestWindowEventLoopDelay.maxMs,
      process_cpu_ms: cpu ? Math.round((cpu.user + cpu.system) / 1000) : null,
      host_cpus: os.cpus().length, host_memory_gib: Math.round(os.totalmem() / 2 ** 30),
      pool_max: fixture.pool.options.max,
    };
    process.stdout.write(`CAPACITY_RESULT ${JSON.stringify(report)}\n`);
    if (cpuProfileResult.artifact) {
      process.stdout.write(formatCpuProfileSummaryLine(cpuProfileResult.artifact));
      process.stdout.write('CAPACITY_CPU_PROFILE_CLASSIFICATION profiled_diagnostic\n');
    }
    process.stdout.write(`CAPACITY_STALL_OVERLAP ${JSON.stringify(stallOverlapReport(timerGapIntervals, slowWalletBatchIntervals))}\n`);
    if (cpuProfileResult.artifact) {
      process.stdout.write(`CAPACITY_STALL_TIMELINE ${JSON.stringify(stallTimelineReport(timerGapIntervals, slowWalletBatchIntervals))}\n`);
    }
    if (acquisitionProbe) {
      const probeSummary = acquisitionProbe.getSummary();
      process.stdout.write(`CAPACITY_ACQUISITION_PROFILE ${JSON.stringify(probeSummary)}\n`);
    }
    const queryProfile = [...sqlTimings.entries()].map(([key, samples]) => {
      const sorted = samples.sort((a, b) => a - b);
      const [path, sql] = [key.slice(0, key.indexOf('|')), key.slice(key.indexOf('|') + 1)];
      return { path, sql, count: sorted.length, error_count: sqlErrors.get(key) ?? 0,
        total_ms: Math.round(sorted.reduce((sum, value) => sum + value, 0)),
        p95_ms: Math.round(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] ?? 0),
        max_ms: Math.round(sorted[sorted.length - 1] ?? 0) };
    }).sort((a, b) => b.total_ms - a.total_ms).slice(0, 12);
    process.stdout.write(`CAPACITY_SQL_PROFILE ${JSON.stringify(queryProfile)}\n`);
    const readQueryFocus = buildReadQueryFocusReport(sqlTimings, sqlErrors);
    process.stdout.write(`CAPACITY_READ_QUERY_FOCUS ${JSON.stringify(readQueryFocus)}\n`);

    // Strict acceptance checks
    assertResponseLifecycleDiagnosticIntegrity('all_reads', report.response_lifecycle_diagnostics.all_reads);
    assertResponseLifecycleDiagnosticIntegrity('all_ballots', report.response_lifecycle_diagnostics.all_ballots);
    assert(!duplicateReqIdDetected, 'A duplicate benchmark request ID was detected');
    assert.equal(unmatchedSuccessfulReads.length, 0, 'Some successful read responses lacked server timing matches');
    assert.equal(unmatchedSuccessfulBallots.length, 0, 'Some successful ballot responses lacked server timing matches');
    assertCapacityPopulationIntegrity([
      { name: 'all_reads', unmatched_count: readsSummary.unmatched_count, invalid_count: readsSummary.invalid_count },
      { name: 'all_ballots', unmatched_count: ballotsSummary.unmatched_count, invalid_count: ballotsSummary.invalid_count },
    ]);
    assert.equal(errors.length, 0, errors.slice(0, 5).join('; '));
    assert.deepEqual(counts, { ballots: 50, participations: 50, civic_xp: 1250, stamps: 50, candidate_votes: 50 });

    if (readerAuthMode === 'guest') {
      assert.equal(walletDurableLookupCount, 0, 'wallet_durable_lookup_count must be 0 in guest reader mode');
      assert.equal(walletIdentityQueryCount, 0, 'wallet_identity_query_count must be 0 in guest reader mode');
    } else if (readerAuthMode === 'wallet_alpha') {
      assert(
        walletDurableLookupCount >= successfulReads.length,
        `wallet_durable_lookup_count (${walletDurableLookupCount}) must be at least successfulReads.length (${successfulReads.length}) in wallet_alpha mode`
      );
      assert(walletIdentityQueryCount > 0 && walletIdentityQueryCount <= walletDurableLookupCount,
        'wallet_identity_query_count must reconcile with completed durable identity checks');
    }

    // Both metrics are reported. The local backend capacity gate evaluates server_ballot_p95_ms (<1000) and server_read_p95_ms (<500).
    assert(report.server_ballot_p95_ms < 1000 && report.server_read_p95_ms < 500,
      `Proposed server latency targets were missed in the local rehearsal (server_ballot_p95=${report.server_ballot_p95_ms}ms, server_read_p95=${report.server_read_p95_ms}ms, client_ballot_p95=${report.ballot_p95_ms}ms); do not claim capacity clearance`);
  } finally {
    await cpuProfiler.cleanup();
    if (acquisitionProbe) acquisitionProbe.restore();
    if (poolSampler) clearInterval(poolSampler);
    if (stallHeartbeat) clearInterval(stallHeartbeat);
    eventLoopDelay.disable();
    if (childProcess && childExitPromise) {
      await terminateAndReapChild(childProcess, childExitPromise, 'cleanup');
    }
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
    }
    setPool(null);
    db.usersRepo.setPool(null);
    restorePoolQuery();
    Object.assign(env, flags);
    await monitor.end();
    await fixture.close();
    process.stdout.write('CAPACITY_FIXTURE_CLOSED disposable schema dropped\n');
  }
}

void main().catch(error => { process.stderr.write(`CAPACITY_ERROR ${String(error)}\n`); process.exitCode = 1; });
