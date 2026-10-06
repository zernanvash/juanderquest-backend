import assert from 'node:assert/strict';
import type { RequestTimingSample } from './juanchoice-capacity-segments.js';

export interface ValidatedChildResult {
  readonly reads: RequestTimingSample[];
  readonly ballots: RequestTimingSample[];
  readonly errors: string[];
}

export interface CapacityBounds {
  readonly maxReads: number;
  readonly maxBallots: number;
}

export const VALID_READ_KINDS = new Set(['overview', 'standings']);
export const VALID_BALLOT_KINDS = new Set(['0', '1']);

/**
 * Validates a single sample from untrusted child IPC.
 * Required:
 * - reqId: nonempty string (opaque UUID / token)
 * - kind: 'overview' | 'standings' for reads; '0' | '1' for ballots
 * - status: integer HTTP status (0 or >= 100)
 * - totalClientMs: finite nonnegative number (>= 0)
 */
export function validateSanitizedSample(
  raw: unknown,
  allowedKinds: Set<string>,
  seenReqIds: Set<string>,
  sampleType: 'read' | 'ballot'
): RequestTimingSample {
  assert(raw && typeof raw === 'object', `Invalid ${sampleType} sample: must be an object`);
  const s = raw as Record<string, unknown>;

  assert(
    typeof s.reqId === 'string' && s.reqId.length > 0 && s.reqId.length <= 128,
    `Invalid ${sampleType} sample: reqId must be nonempty string <= 128 chars`
  );
  assert(!seenReqIds.has(s.reqId), `Invalid ${sampleType} sample: duplicate reqId detected across samples`);
  seenReqIds.add(s.reqId);

  assert(
    typeof s.kind === 'string' && allowedKinds.has(s.kind),
    `Invalid ${sampleType} sample: unexpected kind`
  );

  assert(
    typeof s.status === 'number' && Number.isInteger(s.status) && s.status >= 0 && s.status <= 599,
    `Invalid ${sampleType} sample: status must be integer 0-599`
  );

  assert(
    typeof s.totalClientMs === 'number' && Number.isFinite(s.totalClientMs) && s.totalClientMs >= 0,
    `Invalid ${sampleType} sample: totalClientMs must be finite nonnegative number`
  );

  const sample: RequestTimingSample = {
    reqId: s.reqId,
    kind: s.kind,
    status: s.status,
    totalClientMs: s.totalClientMs,
  };

  // Optional timing markers if present
  if (s.clientStart !== undefined) {
    assert(typeof s.clientStart === 'number' && Number.isFinite(s.clientStart), 'clientStart must be finite number');
  }
  if (s.headersResolved !== undefined) {
    assert(typeof s.headersResolved === 'number' && Number.isFinite(s.headersResolved), 'headersResolved must be finite number');
  }
  if (s.clientBodyConsumed !== undefined) {
    assert(typeof s.clientBodyConsumed === 'number' && Number.isFinite(s.clientBodyConsumed), 'clientBodyConsumed must be finite number');
  }

  return sample;
}

/**
 * Calculates upper bounds for expected reads and ballots given duration and config.
 */
export function calculateExpectedCapacityBounds(
  durationMs: number,
  pollIntervalMs: number,
  readerCount: number,
  voterCount: number
): CapacityBounds {
  // Read rounds: initial wave + 1 per pollInterval + 1 per ballot burst (max 2) + generous margin
  const intervals = Math.ceil(durationMs / Math.max(1, pollIntervalMs));
  const maxReadRounds = Math.max(10, intervals * 3 + 10);
  const maxReads = maxReadRounds * readerCount;

  // Ballots: exactly 2 waves planned; allow bounded multiplier for potential retries/bursts
  const maxBallots = Math.max(voterCount * 4, 100);

  return { maxReads, maxBallots };
}

/**
 * Validates untrusted child DONE message payload before mutating parent state.
 * Enforces:
 * - message shape and array types
 * - bounded cardinality
 * - sample field integrity
 * - globally unique reqId across both reads and ballots
 * - errors array converted to static diagnostic without logging child text
 */
export function validateChildDonePayload(
  raw: unknown,
  bounds?: CapacityBounds
): ValidatedChildResult {
  assert(raw && typeof raw === 'object', 'Child DONE payload must be an object');
  const payload = raw as Record<string, unknown>;

  assert(Array.isArray(payload.reads), 'Child DONE reads must be an array');
  assert(Array.isArray(payload.ballots), 'Child DONE ballots must be an array');
  assert(Array.isArray(payload.errors), 'Child DONE errors must be an array');

  if (bounds) {
    assert(
      payload.reads.length <= bounds.maxReads,
      `Child DONE reads count (${payload.reads.length}) exceeded upper bound (${bounds.maxReads})`
    );
    assert(
      payload.ballots.length <= bounds.maxBallots,
      `Child DONE ballots count (${payload.ballots.length}) exceeded upper bound (${bounds.maxBallots})`
    );
  }

  const seenReqIds = new Set<string>();
  const validatedReads: RequestTimingSample[] = [];
  const validatedBallots: RequestTimingSample[] = [];

  for (const rawSample of payload.reads) {
    validatedReads.push(validateSanitizedSample(rawSample, VALID_READ_KINDS, seenReqIds, 'read'));
  }

  for (const rawSample of payload.ballots) {
    validatedBallots.push(validateSanitizedSample(rawSample, VALID_BALLOT_KINDS, seenReqIds, 'ballot'));
  }

  // Child errors are mapped to static parent diagnostic errors without echoing raw child text
  const staticErrors: string[] = [];
  if (payload.errors.length > 0) {
    staticErrors.push(`CHILD_REPORTED_FAILURES count=${payload.errors.length}`);
  }

  return {
    reads: validatedReads,
    ballots: validatedBallots,
    errors: staticErrors,
  };
}
