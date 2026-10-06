/**
 * Isolated child load client for JuanChoice capacity rehearsal.
 *
 * MUST NOT import the application, database, test harness, or PostgreSQL client.
 * Receives only minimal parameters via Node IPC:
 * - base: loopback HTTP origin
 * - roundId: campaign ID
 * - candidateIds: string[]
 * - tokens: pre-signed JWT user tokens (never printed)
 * - durationMs: total workload duration
 * - pollIntervalMs: read polling interval (default 15_000)
 * - voterCount: number of voters (default 50)
 * - readerCount: number of readers (default 100)
 *
 * Never prints tokens, auth headers, or request payloads.
 * Sends sanitized samples and progress events to parent over IPC.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { ReaderAuthMode } from './juanchoice-capacity-mode.js';
import { buildReaderAuthHeaders } from './juanchoice-capacity-reader-headers.js';

export interface ChildStartConfig {
  readonly baseUrl: string;
  readonly campaignId: string;
  readonly candidateIds: readonly string[];
  readonly tokens: readonly string[];
  readonly durationMs: number;
  readonly pollIntervalMs: number;
  readonly voterCount: number;
  readonly readerCount: number;
  readonly readerAuthMode?: ReaderAuthMode;
  readonly readerTokens?: readonly string[];
}

export interface SanitizedSample {
  readonly reqId: string;
  readonly kind: string;
  readonly status: number;
  readonly totalClientMs: number;
}

export type ParentToChildMessage =
  | { readonly type: 'START'; readonly config: ChildStartConfig }
  | { readonly type: 'ACK_DONE' }
  | { readonly type: 'ABORT' };

export type ChildToParentMessage =
  | { readonly type: 'READY' }
  | { readonly type: 'PROGRESS'; readonly elapsed_s: number; readonly reads: number; readonly ballots: number; readonly errors: number }
  | { readonly type: 'DONE'; readonly reads: readonly SanitizedSample[]; readonly ballots: readonly SanitizedSample[]; readonly errors: readonly string[] }
  | { readonly type: 'ERROR'; readonly error: string };

export function validateChildStartConfig(raw: unknown): ChildStartConfig {
  assert(raw && typeof raw === 'object', 'Child config must be an object');
  const cfg = raw as Record<string, unknown>;

  assert(typeof cfg.baseUrl === 'string', 'baseUrl must be a string');
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(cfg.baseUrl);
  } catch {
    throw new Error('baseUrl must be a valid URL');
  }

  assert(parsedUrl.protocol === 'http:', 'baseUrl protocol must be http:');
  assert(parsedUrl.hostname === '127.0.0.1', 'baseUrl hostname must be 127.0.0.1');
  assert(parsedUrl.username === '' && parsedUrl.password === '', 'baseUrl credentials are forbidden');
  assert(parsedUrl.pathname === '/api/v1/juanchoice' || parsedUrl.pathname === '' || parsedUrl.pathname === '/',
    'baseUrl path must be exactly /api/v1/juanchoice or /');
  assert(parsedUrl.search === '', 'baseUrl search params are forbidden');
  assert(parsedUrl.hash === '', 'baseUrl hash is forbidden');

  assert(parsedUrl.port !== '', 'baseUrl must include an explicit numeric port');
  const portNum = Number(parsedUrl.port);
  assert(Number.isSafeInteger(portNum) && portNum >= 1 && portNum <= 65535, 'baseUrl port must be 1-65535');

  const normalizedPath = parsedUrl.pathname === '/api/v1/juanchoice' ? '/api/v1/juanchoice' : '';
  const normalizedBaseUrl = `http://127.0.0.1:${portNum}${normalizedPath}`;

  assert(typeof cfg.campaignId === 'string' && cfg.campaignId.length > 0 && cfg.campaignId.length <= 256, 'campaignId is required');
  assert(Array.isArray(cfg.candidateIds) && cfg.candidateIds.length >= 2 && cfg.candidateIds.length <= 100, 'candidateIds must have 2-100 items');
  for (const cid of cfg.candidateIds) {
    assert(typeof cid === 'string' && cid.length > 0 && cid.length <= 256, 'Each candidateId must be a valid string');
  }

  assert(Array.isArray(cfg.tokens) && cfg.tokens.length > 0 && cfg.tokens.length <= 50_000, 'tokens must be non-empty and bounded');
  for (const tok of cfg.tokens) {
    assert(typeof tok === 'string' && tok.length > 0, 'Each token must be a non-empty string');
  }

  assert(typeof cfg.durationMs === 'number' && Number.isSafeInteger(cfg.durationMs) && cfg.durationMs >= 1000 && cfg.durationMs <= 3_600_000, 'durationMs must be safe int 1000-3600000');
  assert(typeof cfg.pollIntervalMs === 'number' && Number.isSafeInteger(cfg.pollIntervalMs) && cfg.pollIntervalMs >= 100 && cfg.pollIntervalMs <= 600_000, 'pollIntervalMs must be safe int 100-600000');
  assert(typeof cfg.voterCount === 'number' && Number.isSafeInteger(cfg.voterCount) && cfg.voterCount > 0 && cfg.voterCount <= cfg.tokens.length, 'voterCount must be safe int <= tokens.length');
  assert(typeof cfg.readerCount === 'number' && Number.isSafeInteger(cfg.readerCount) && cfg.readerCount > 0 && cfg.readerCount <= 10_000, 'readerCount must be safe int 1-10000');

  const rawReaderAuthMode = cfg.readerAuthMode ?? 'guest';
  assert(
    rawReaderAuthMode === 'guest' || rawReaderAuthMode === 'wallet_alpha',
    'readerAuthMode must be guest or wallet_alpha'
  );
  const readerAuthMode: ReaderAuthMode = rawReaderAuthMode;

  let validatedReaderTokens: readonly string[] | undefined = undefined;

  if (readerAuthMode === 'guest') {
    if (cfg.readerTokens !== undefined) {
      assert(
        Array.isArray(cfg.readerTokens) && cfg.readerTokens.length === 0,
        'readerTokens must not be non-empty in guest readerAuthMode'
      );
      validatedReaderTokens = Object.freeze([]);
    }
  } else if (readerAuthMode === 'wallet_alpha') {
    assert(cfg.readerCount === 100, 'readerCount must be exactly 100 in wallet_alpha readerAuthMode');
    assert(
      Array.isArray(cfg.readerTokens) && cfg.readerTokens.length === 100,
      'readerTokens must be an array of exactly 100 tokens in wallet_alpha readerAuthMode'
    );
    for (const tok of cfg.readerTokens) {
      assert(
        typeof tok === 'string' && tok.trim().length > 0,
        'Each readerToken must be a non-empty string'
      );
    }
    validatedReaderTokens = Object.freeze([...(cfg.readerTokens as string[])]);
  }

  return {
    baseUrl: normalizedBaseUrl,
    campaignId: cfg.campaignId,
    candidateIds: cfg.candidateIds as string[],
    tokens: cfg.tokens as string[],
    durationMs: cfg.durationMs,
    pollIntervalMs: cfg.pollIntervalMs,
    voterCount: cfg.voterCount,
    readerCount: cfg.readerCount,
    readerAuthMode,
    ...(validatedReaderTokens !== undefined ? { readerTokens: validatedReaderTokens } : {}),
  };
}

let aborted = false;

async function runClientWorkload(config: ChildStartConfig): Promise<void> {
  const { baseUrl, campaignId, candidateIds, tokens, durationMs, pollIntervalMs, voterCount, readerCount, readerAuthMode = 'guest', readerTokens = [] } = config;
  const reads: SanitizedSample[] = [];
  const ballots: SanitizedSample[] = [];
  const errors: string[] = [];

  aborted = false;

  async function timedFetch(url: string, options: RequestInit, target: SanitizedSample[], label: string, phase?: string) {
    if (aborted) return;
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
    const kind = label.startsWith('vote')
      ? label.split(' ')[1].split(':')[0]
      : url.endsWith('/overview') ? 'overview' : 'standings';

    try {
      const response = await fetch(url, requestOptions);
      await response.arrayBuffer();
      const totalClientMs = performance.now() - clientStart;
      target.push({
        reqId,
        kind,
        status: response.status,
        totalClientMs,
      });
      if (response.status !== 200) {
        errors.push(`${label}: HTTP ${response.status}`);
      }
    } catch (error) {
      const totalClientMs = performance.now() - clientStart;
      target.push({
        reqId,
        kind,
        status: 0,
        totalClientMs,
      });
      errors.push(`${label}: ${String(error)}`);
    }
  }

  const vote = (version: number) => Promise.all(
    Array.from({ length: voterCount }, (_, i) => timedFetch(
      `${baseUrl}/campaigns/${campaignId}/ballot`,
      {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokens[i]}`,
          'Idempotency-Key': randomUUID(),
          'X-Forwarded-For': `10.40.2.${i + 1}`,
        },
        body: JSON.stringify({
          candidate_id: candidateIds[(i + version) % candidateIds.length],
          expected_version: version,
        }),
      },
      ballots,
      `vote ${version}:${i}`,
      'mixed_ballot_burst'
    ))
  );

  const readRound = (roundIndex: number, phase: string) => Promise.all(
    Array.from({ length: readerCount }, (_, i) => timedFetch(
      i % 2 === 0 ? `${baseUrl}/overview` : `${baseUrl}/campaigns/${campaignId}/standings`,
      {
        headers: {
          'X-Forwarded-For': `10.40.1.${i + 1}`,
          ...buildReaderAuthHeaders(readerAuthMode, i, readerTokens, readerCount),
        },
      },
      reads,
      `read ${roundIndex}:${i}`,
      phase
    ))
  );

  const startedAt = Date.now();
  let readRoundCount = 0;
  let changed = false;

  // Wave 0
  await Promise.all([vote(0), readRound(readRoundCount++, 'mixed_ballot_burst')]);

  while (Date.now() - startedAt < durationMs && !aborted) {
    const nextAt = startedAt + readRoundCount * pollIntervalMs;
    if (Date.now() < nextAt) {
      await new Promise(resolve => setTimeout(resolve, Math.max(0, nextAt - Date.now())));
    }
    if (aborted) break;

    if (!changed && Date.now() - startedAt >= durationMs / 2) {
      await Promise.all([vote(1), readRound(readRoundCount++, 'mixed_ballot_burst')]);
      changed = true;
    } else {
      await readRound(readRoundCount++, 'idle_read');
    }

    if (process.send && process.connected) {
      const msg: ChildToParentMessage = {
        type: 'PROGRESS',
        elapsed_s: Math.round((Date.now() - startedAt) / 1000),
        reads: reads.length,
        ballots: ballots.length,
        errors: errors.length,
      };
      process.send(msg);
    }
  }

  assert(changed, 'Second concurrent vote wave did not run in child client');

  if (process.send && process.connected) {
    const doneMsg: ChildToParentMessage = {
      type: 'DONE',
      reads,
      ballots,
      errors,
    };
    process.send(doneMsg);
    doneSent = true;
  }
}

let doneSent = false;
let startReceived = false;

function terminateNonzero(): void {
  try {
    if (process.connected && process.disconnect) {
      process.disconnect();
    }
  } catch {
    // ignore
  }
  process.exit(1);
}

// IPC listener
if (process.send) {
  process.on('disconnect', () => {
    aborted = true;
    // Parent disconnected during active run or waiting. Settle promptly with nonzero exit.
    setTimeout(() => {
      process.exit(1);
    }, 200).unref();
  });

  process.on('message', async (msg: ParentToChildMessage) => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'ABORT') {
      aborted = true;
      return;
    }
    if (msg.type === 'ACK_DONE') {
      if (doneSent) {
        if (process.connected && process.disconnect) {
          process.disconnect();
        }
        process.exit(0);
      }
      return;
    }
    if (msg.type === 'START') {
      if (startReceived) return;
      startReceived = true;
      let config: ChildStartConfig;
      try {
        config = validateChildStartConfig(msg.config);
      } catch {
        if (process.connected && process.send) {
          try {
            process.send({ type: 'ERROR', error: 'INVALID_START_CONFIG' } as ChildToParentMessage);
          } catch {
            // ignore
          }
        }
        terminateNonzero();
        return;
      }

      try {
        await runClientWorkload(config);
      } catch {
        if (process.connected && process.send) {
          try {
            process.send({ type: 'ERROR', error: 'WORKLOAD_FAILED' } as ChildToParentMessage);
          } catch {
            // ignore
          }
        }
        terminateNonzero();
      }
    }
  });

  const readyMsg: ChildToParentMessage = { type: 'READY' };
  process.send(readyMsg);
}
