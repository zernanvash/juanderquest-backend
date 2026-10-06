import assert from 'node:assert/strict';

export interface RequestTimingSample {
  readonly reqId: string;
  readonly kind: string;
  readonly status: number;
  readonly clientStart?: number;
  readonly headersResolved?: number;
  readonly clientBodyConsumed?: number;
  readonly totalClientMs: number;
}

export interface ServerTimingRecord {
  readonly serverIngress: number;
  readonly serverPrefinish?: number;
  readonly serverFinish: number;
  readonly durationMs: number;
  readonly statusCode: number;
}

export interface LifecycleTimingMagnitudeSummary {
  readonly count: number;
  readonly min_ms: number;
  readonly p50_ms: number;
  readonly p95_ms: number;
  readonly max_ms: number;
}

export interface ResponseLifecycleTimingDiagnostic {
  readonly total_samples: number;
  readonly matched_samples: number;
  readonly invalid_server_clock_count: number;
  readonly missing_prefinish_count: number;
  readonly invalid_prefinish_count: number;
  readonly prefinish_after_finish_count: number;
  readonly client_below_prefinish_count: number;
  readonly client_below_prefinish_magnitude: LifecycleTimingMagnitudeSummary;
  readonly client_below_finish_count: number;
  readonly client_below_finish_magnitude: LifecycleTimingMagnitudeSummary;
  readonly client_below_finish_but_at_or_above_prefinish_count: number;
  readonly client_below_finish_but_at_or_above_prefinish_magnitude: LifecycleTimingMagnitudeSummary;
}

export type KnownInvalidTimingReason =
  | 'unmatched_server_timing'
  | 'status_code_mismatch'
  | 'non_finite_timing_value'
  | 'negative_duration'
  | 'client_shorter_than_server'
  | 'inconsistent_client_duration'
  | 'inconsistent_server_duration'
  | 'invalid_timing_order'
  | 'invalid_header_timing_order';

export type InvalidTimingReason = KnownInvalidTimingReason | 'unknown_invalid_reason';

export const KNOWN_INVALID_TIMING_REASONS: readonly KnownInvalidTimingReason[] = [
  'unmatched_server_timing',
  'status_code_mismatch',
  'non_finite_timing_value',
  'negative_duration',
  'client_shorter_than_server',
  'inconsistent_client_duration',
  'inconsistent_server_duration',
  'invalid_timing_order',
  'invalid_header_timing_order',
] as const;

export function normalizeInvalidTimingReason(reason: string | undefined): InvalidTimingReason {
  if (reason && (KNOWN_INVALID_TIMING_REASONS as readonly string[]).includes(reason)) {
    return reason as KnownInvalidTimingReason;
  }
  return 'unknown_invalid_reason';
}

export interface PercentileSummary {
  readonly p50_ms: number;
  readonly p95_ms: number;
  readonly max_ms: number;
}

export interface NegativeDurationGapSummary {
  readonly count: number;
  readonly min_ms: number;
  readonly p50_ms: number;
  readonly p95_ms: number;
  readonly max_ms: number;
}

/** Diagnostic only: magnitude of matched child durations shorter than server durations. */
export function summarizeNegativeDurationGaps(
  clientSamples: readonly RequestTimingSample[],
  serverTimings: ReadonlyMap<string, ServerTimingRecord>
): NegativeDurationGapSummary {
  const gaps: number[] = [];
  for (const sample of clientSamples) {
    const server = serverTimings.get(sample.reqId);
    if (!server || sample.clientStart !== undefined || sample.status !== server.statusCode) continue;
    if (!Number.isFinite(sample.totalClientMs) || !Number.isFinite(server.durationMs)) continue;
    if (sample.totalClientMs < 0 || server.durationMs < 0) continue;
    const gap = server.durationMs - sample.totalClientMs;
    if (gap > 0 && Number.isFinite(gap)) gaps.push(gap);
  }
  if (gaps.length === 0) return { count: 0, min_ms: 0, p50_ms: 0, p95_ms: 0, max_ms: 0 };
  gaps.sort((a, b) => a - b);
  const roundMs = (value: number) => Math.round(value * 1000) / 1000;
  const rank = (percentile: number) => gaps[Math.min(gaps.length - 1, Math.ceil(gaps.length * percentile) - 1)];
  return {
    count: gaps.length,
    min_ms: roundMs(gaps[0]),
    p50_ms: roundMs(rank(0.50)),
    p95_ms: roundMs(rank(0.95)),
    max_ms: roundMs(gaps[gaps.length - 1]),
  };
}

export function computeLifecycleMagnitudeSummary(
  values: readonly number[]
): LifecycleTimingMagnitudeSummary {
  if (values.length === 0) {
    return { count: 0, min_ms: 0, p50_ms: 0, p95_ms: 0, max_ms: 0 };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const roundMs = (val: number) => Math.round(val * 1000) / 1000;
  const rank = (p: number) => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)];
  return {
    count: sorted.length,
    min_ms: roundMs(sorted[0]),
    p50_ms: roundMs(rank(0.50)),
    p95_ms: roundMs(rank(0.95)),
    max_ms: roundMs(sorted[sorted.length - 1]),
  };
}

/**
 * Diagnostic only: analyzes server response lifecycle (ingress -> prefinish -> finish)
 * against client total duration.
 *
 * Checks finite/nonnegative times and order. Does not clamp or discard anomalies.
 * Reports aggregate counts and magnitudes without sensitive identifiers.
 */
export function summarizeResponseLifecycleDiagnostics(
  clientSamples: readonly RequestTimingSample[],
  serverTimings: ReadonlyMap<string, ServerTimingRecord>
): ResponseLifecycleTimingDiagnostic {
  let matchedSamples = 0;
  let invalidServerClockCount = 0;
  let missingPrefinishCount = 0;
  let invalidPrefinishCount = 0;
  let prefinishAfterFinishCount = 0;

  const clientBelowPrefinishMagnitudes: number[] = [];
  const clientBelowFinishMagnitudes: number[] = [];
  const clientBelowFinishButAtOrAbovePrefinishMagnitudes: number[] = [];

  for (const sample of clientSamples) {
    const server = serverTimings.get(sample.reqId);
    if (!server) continue;
    matchedSamples++;

    const ingress = server.serverIngress;
    const prefinish = server.serverPrefinish;
    const finish = server.serverFinish;
    const validServerClock = Number.isFinite(ingress) && Number.isFinite(finish) && ingress >= 0 && finish >= ingress;
    if (!validServerClock) invalidServerClockCount++;

    // Check prefinish presence and validity
    if (prefinish === undefined) {
      missingPrefinishCount++;
    } else if (!Number.isFinite(prefinish) || prefinish < 0 || !Number.isFinite(ingress) || prefinish < ingress) {
      invalidPrefinishCount++;
    } else if (validServerClock && prefinish > finish) {
      prefinishAfterFinishCount++;
    }

    if (sample.status !== server.statusCode) continue;

    // Examine client duration comparison
    const clientMs = sample.totalClientMs;
    if (!Number.isFinite(clientMs) || clientMs < 0) continue;

    // Check client vs ingress-to-finish
    let ingressToFinish: number | undefined;
    if (validServerClock) {
      ingressToFinish = finish - ingress;
      if (clientMs < ingressToFinish) {
        clientBelowFinishMagnitudes.push(ingressToFinish - clientMs);
      }
    }

    // Check client vs ingress-to-prefinish
    let ingressToPrefinish: number | undefined;
    if (
      prefinish !== undefined &&
      Number.isFinite(prefinish) &&
      validServerClock &&
      prefinish >= ingress &&
      prefinish <= finish
    ) {
      ingressToPrefinish = prefinish - ingress;
      if (clientMs < ingressToPrefinish) {
        clientBelowPrefinishMagnitudes.push(ingressToPrefinish - clientMs);
      }
    }

    // Check subset: client < finish but client >= prefinish
    if (ingressToFinish !== undefined && ingressToPrefinish !== undefined) {
      if (clientMs < ingressToFinish && clientMs >= ingressToPrefinish) {
        clientBelowFinishButAtOrAbovePrefinishMagnitudes.push(ingressToFinish - clientMs);
      }
    }
  }

  return {
    total_samples: clientSamples.length,
    matched_samples: matchedSamples,
    invalid_server_clock_count: invalidServerClockCount,
    missing_prefinish_count: missingPrefinishCount,
    invalid_prefinish_count: invalidPrefinishCount,
    prefinish_after_finish_count: prefinishAfterFinishCount,
    client_below_prefinish_count: clientBelowPrefinishMagnitudes.length,
    client_below_prefinish_magnitude: computeLifecycleMagnitudeSummary(clientBelowPrefinishMagnitudes),
    client_below_finish_count: clientBelowFinishMagnitudes.length,
    client_below_finish_magnitude: computeLifecycleMagnitudeSummary(clientBelowFinishMagnitudes),
    client_below_finish_but_at_or_above_prefinish_count: clientBelowFinishButAtOrAbovePrefinishMagnitudes.length,
    client_below_finish_but_at_or_above_prefinish_magnitude: computeLifecycleMagnitudeSummary(
      clientBelowFinishButAtOrAbovePrefinishMagnitudes
    ),
  };
}

/** Missing or malformed lifecycle instrumentation invalidates a diagnostic run. */
export function assertResponseLifecycleDiagnosticIntegrity(
  groupName: string,
  diagnostic: ResponseLifecycleTimingDiagnostic
): void {
  assert.equal(diagnostic.invalid_server_clock_count, 0, `${groupName} has invalid server clocks`);
  assert.equal(diagnostic.missing_prefinish_count, 0, `${groupName} is missing prefinish timings`);
  assert.equal(diagnostic.invalid_prefinish_count, 0, `${groupName} has invalid prefinish timings`);
  assert.equal(diagnostic.prefinish_after_finish_count, 0, `${groupName} has prefinish after finish`);
}

export interface CorrelatedSegmentSummary {
  readonly client_count: number;
  readonly matched_count: number;
  readonly unmatched_count: number;
  readonly invalid_count: number;
  readonly invalid_reason_counts: Readonly<Record<InvalidTimingReason, number>>;
  // Historical / overall metrics
  readonly client_p95_ms: number;
  readonly server_p95_ms: number;
  readonly server_max_ms: number;
  // Backward compatibility aliases for existing report consumers
  readonly matched_server_count: number;
  readonly matched_server_p95_ms: number;
  readonly matched_server_max_ms: number;
  readonly gap_p50_ms: number;
  readonly gap_p95_ms: number;
  readonly gap_max_ms: number;
  // Decomposition segments (percentiled over valid matched population; null in child_process mode)
  readonly pre_ingress: PercentileSummary | null;
  readonly server_processing: PercentileSummary | null;
  readonly post_finish: PercentileSummary | null;
  readonly headers_resolved: PercentileSummary | null;
  readonly body_transfer: PercentileSummary | null;
}

export interface CorrelatedSegmentSample {
  readonly reqId: string;
  readonly kind: string;
  readonly status: number;
  readonly isValid: boolean;
  readonly invalidReason?: string;
  readonly preIngressMs?: number;
  readonly serverProcessingMs?: number;
  readonly postFinishMs?: number;
  readonly headersResolvedMs?: number;
  readonly bodyTransferMs?: number;
  readonly gapMs?: number;
  readonly totalClientMs?: number;
  readonly serverDurationMs?: number;
}

export function computePercentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1);
  return Math.round(sorted[index] ?? 0);
}

export function computePercentileSummary(values: readonly number[]): PercentileSummary {
  if (values.length === 0) {
    return { p50_ms: 0, p95_ms: 0, max_ms: 0 };
  }
  const sorted = [...values].sort((a, b) => a - b);
  return {
    p50_ms: computePercentile(sorted, 0.50),
    p95_ms: computePercentile(sorted, 0.95),
    max_ms: Math.round(sorted[sorted.length - 1] ?? 0),
  };
}

export const TIMING_TOLERANCE_MS = 0.5;

/**
 * Computes correlated timing decomposition for a single request sample against server timing records.
 *
 * Rules:
 * - Timestamps and durations must be finite numbers.
 * - HTTP status must match between client and server.
 * - Durations totalClientMs and serverDurationMs must be non-negative.
 * - Elapsed intervals must be consistent with timestamps within floating-point tolerance (TIMING_TOLERANCE_MS):
 *     |totalClientMs - (bodyEnd - clientStart)| <= TIMING_TOLERANCE_MS
 *     |serverDurationMs - (serverFinish - serverIngress)| <= TIMING_TOLERANCE_MS
 * - Monotonic ordering constraint:
 *     clientStart <= serverIngress <= serverFinish <= bodyEnd
 *     and if headersResolved is present: clientStart <= headersResolved <= bodyEnd.
 * - Any unmatched, non-finite, negative, or internally inconsistent sample is flagged as invalid without clamping.
 * - Invalid reason codes are static and non-sensitive (no raw timings or credentials).
 */
export function correlateRequestSample(
  clientSample: RequestTimingSample,
  serverRecord: ServerTimingRecord | undefined
): CorrelatedSegmentSample {
  if (!serverRecord) {
    return {
      reqId: clientSample.reqId,
      kind: clientSample.kind,
      status: clientSample.status,
      isValid: false,
      invalidReason: 'unmatched_server_timing',
    };
  }

  const { clientStart, headersResolved, clientBodyConsumed, totalClientMs } = clientSample;
  const { serverIngress, serverFinish, durationMs: serverDurationMs, statusCode: serverStatusCode } = serverRecord;

  // Status code agreement check
  if (clientSample.status !== serverStatusCode) {
    return {
      reqId: clientSample.reqId,
      kind: clientSample.kind,
      status: clientSample.status,
      isValid: false,
      invalidReason: 'status_code_mismatch',
    };
  }

  // Duration finite check
  if (!Number.isFinite(totalClientMs) || !Number.isFinite(serverDurationMs)) {
    return {
      reqId: clientSample.reqId,
      kind: clientSample.kind,
      status: clientSample.status,
      isValid: false,
      invalidReason: 'non_finite_timing_value',
    };
  }

  // Non-negative duration check
  if (totalClientMs < 0 || serverDurationMs < 0) {
    return {
      reqId: clientSample.reqId,
      kind: clientSample.kind,
      status: clientSample.status,
      isValid: false,
      invalidReason: 'negative_duration',
    };
  }

  const gapMs = totalClientMs - serverDurationMs;

  // If clientStart is not provided, this is a duration-only sample (e.g. child_process mode)
  // Cross-process performance.now() comparison is intentionally forbidden.
  if (clientStart === undefined) {
    const { serverIngress, serverPrefinish, serverFinish } = serverRecord;

    // Must have finite server timestamps and ingress <= prefinish <= finish
    if (
      !Number.isFinite(serverIngress) ||
      serverPrefinish === undefined ||
      !Number.isFinite(serverPrefinish) ||
      !Number.isFinite(serverFinish)
    ) {
      return {
        reqId: clientSample.reqId,
        kind: clientSample.kind,
        status: clientSample.status,
        isValid: false,
        invalidReason: 'non_finite_timing_value',
      };
    }

    if (serverIngress < 0 || serverPrefinish < serverIngress || serverFinish < serverPrefinish) {
      return {
        reqId: clientSample.reqId,
        kind: clientSample.kind,
        status: clientSample.status,
        isValid: false,
        invalidReason: 'invalid_timing_order',
      };
    }

    const expectedServerDuration = serverFinish - serverIngress;
    if (Math.abs(serverDurationMs - expectedServerDuration) > TIMING_TOLERANCE_MS) {
      return {
        reqId: clientSample.reqId,
        kind: clientSample.kind,
        status: clientSample.status,
        isValid: false,
        invalidReason: 'inconsistent_server_duration',
      };
    }

    const ingressToPrefinish = serverPrefinish - serverIngress;
    if (totalClientMs < ingressToPrefinish) {
      return {
        reqId: clientSample.reqId,
        kind: clientSample.kind,
        status: clientSample.status,
        isValid: false,
        invalidReason: 'client_shorter_than_server',
      };
    }

    return {
      reqId: clientSample.reqId,
      kind: clientSample.kind,
      status: clientSample.status,
      isValid: true,
      gapMs,
      totalClientMs,
      serverDurationMs,
    };
  }

  // Finite timestamp check for same-process samples with timestamps
  if (
    !Number.isFinite(clientStart) ||
    !Number.isFinite(serverIngress) ||
    !Number.isFinite(serverFinish) ||
    (clientBodyConsumed !== undefined && !Number.isFinite(clientBodyConsumed)) ||
    (headersResolved !== undefined && !Number.isFinite(headersResolved))
  ) {
    return {
      reqId: clientSample.reqId,
      kind: clientSample.kind,
      status: clientSample.status,
      isValid: false,
      invalidReason: 'non_finite_timing_value',
    };
  }

  const bodyEnd = clientBodyConsumed !== undefined ? clientBodyConsumed : clientStart + totalClientMs;
  const expectedClientDuration = bodyEnd - clientStart;
  const expectedServerDuration = serverFinish - serverIngress;

  // Consistency between recorded durations and timestamps within tolerance
  if (Math.abs(totalClientMs - expectedClientDuration) > TIMING_TOLERANCE_MS) {
    return {
      reqId: clientSample.reqId,
      kind: clientSample.kind,
      status: clientSample.status,
      isValid: false,
      invalidReason: 'inconsistent_client_duration',
    };
  }

  if (Math.abs(serverDurationMs - expectedServerDuration) > TIMING_TOLERANCE_MS) {
    return {
      reqId: clientSample.reqId,
      kind: clientSample.kind,
      status: clientSample.status,
      isValid: false,
      invalidReason: 'inconsistent_server_duration',
    };
  }

  const preIngress = serverIngress - clientStart;
  const serverProcessing = serverFinish - serverIngress;
  const postFinish = bodyEnd - serverFinish;

  // Ordering checks: preIngress >= 0, serverProcessing >= 0, postFinish >= 0
  if (preIngress < 0 || serverProcessing < 0 || postFinish < 0) {
    return {
      reqId: clientSample.reqId,
      kind: clientSample.kind,
      status: clientSample.status,
      isValid: false,
      invalidReason: 'invalid_timing_order',
    };
  }

  let headersResolvedMs: number | undefined;
  let bodyTransferMs: number | undefined;

  if (headersResolved !== undefined) {
    const toHeaders = headersResolved - clientStart;
    const toBody = bodyEnd - headersResolved;
    if (toHeaders < 0 || toBody < 0) {
      return {
        reqId: clientSample.reqId,
        kind: clientSample.kind,
        status: clientSample.status,
        isValid: false,
        invalidReason: 'invalid_header_timing_order',
      };
    }
    headersResolvedMs = toHeaders;
    bodyTransferMs = toBody;
  }

  return {
    reqId: clientSample.reqId,
    kind: clientSample.kind,
    status: clientSample.status,
    isValid: true,
    preIngressMs: preIngress,
    serverProcessingMs: serverProcessing,
    postFinishMs: postFinish,
    headersResolvedMs,
    bodyTransferMs,
    gapMs,
    totalClientMs,
    serverDurationMs,
  };
}

export interface CapacityIntegrityAssertionGroup {
  readonly name: string;
  readonly unmatched_count: number;
  readonly invalid_count: number;
}

export function assertCapacityPopulationIntegrity(groups: readonly CapacityIntegrityAssertionGroup[]): void {
  for (const group of groups) {
    if (group.unmatched_count !== 0) {
      throw new Error(`Integrity check failed: ${group.name} group had ${group.unmatched_count} unmatched timing samples`);
    }
    if (group.invalid_count !== 0) {
      throw new Error(`Integrity check failed: ${group.name} group had ${group.invalid_count} invalid timing samples`);
    }
  }
}

export function computeCorrelatedSegmentSummary(
  clientSamples: readonly RequestTimingSample[],
  serverTimings: ReadonlyMap<string, ServerTimingRecord>
): CorrelatedSegmentSummary {
  const clientCount = clientSamples.length;
  const clientP95 = computePercentile(clientSamples.map(s => s.totalClientMs), 0.95);

  let matchedCount = 0;
  let unmatchedCount = 0;
  let invalidCount = 0;

  const invalidReasonCounts: Record<InvalidTimingReason, number> = {
    unmatched_server_timing: 0,
    status_code_mismatch: 0,
    non_finite_timing_value: 0,
    negative_duration: 0,
    client_shorter_than_server: 0,
    inconsistent_client_duration: 0,
    inconsistent_server_duration: 0,
    invalid_timing_order: 0,
    invalid_header_timing_order: 0,
    unknown_invalid_reason: 0,
  };

  const validPreIngress: number[] = [];
  const validServerProcessing: number[] = [];
  const validPostFinish: number[] = [];
  const validHeadersResolved: number[] = [];
  const validBodyTransfer: number[] = [];
  const validGaps: number[] = [];
  const validServerDurations: number[] = [];

  let hasTimestampDecomposition = false;

  for (const clientSample of clientSamples) {
    const serverRecord = serverTimings.get(clientSample.reqId);
    if (!serverRecord) {
      unmatchedCount++;
      invalidReasonCounts.unmatched_server_timing++;
      continue;
    }
    matchedCount++;

    const sample = correlateRequestSample(clientSample, serverRecord);
    if (!sample.isValid) {
      invalidCount++;
      const reasonKey = normalizeInvalidTimingReason(sample.invalidReason);
      invalidReasonCounts[reasonKey]++;
      continue;
    }

    if (sample.preIngressMs !== undefined) {
      hasTimestampDecomposition = true;
      validPreIngress.push(sample.preIngressMs);
    }
    if (sample.serverProcessingMs !== undefined) validServerProcessing.push(sample.serverProcessingMs);
    if (sample.postFinishMs !== undefined) validPostFinish.push(sample.postFinishMs);
    if (sample.headersResolvedMs !== undefined) validHeadersResolved.push(sample.headersResolvedMs);
    if (sample.bodyTransferMs !== undefined) validBodyTransfer.push(sample.bodyTransferMs);
    if (sample.gapMs !== undefined) validGaps.push(sample.gapMs);
    if (sample.serverDurationMs !== undefined) validServerDurations.push(sample.serverDurationMs);
  }

  const serverP95 = computePercentile(validServerDurations, 0.95);
  const serverMax = validServerDurations.length > 0 ? Math.round(Math.max(...validServerDurations)) : 0;

  const gapP50 = computePercentile(validGaps, 0.50);
  const gapP95 = computePercentile(validGaps, 0.95);
  const gapMax = validGaps.length > 0 ? Math.round(Math.max(...validGaps)) : 0;

  return {
    client_count: clientCount,
    matched_count: matchedCount,
    unmatched_count: unmatchedCount,
    invalid_count: invalidCount,
    invalid_reason_counts: Object.freeze({ ...invalidReasonCounts }),

    client_p95_ms: clientP95,
    server_p95_ms: serverP95,
    server_max_ms: serverMax,
    matched_server_count: matchedCount,
    matched_server_p95_ms: serverP95,
    matched_server_max_ms: serverMax,
    gap_p50_ms: gapP50,
    gap_p95_ms: gapP95,
    gap_max_ms: gapMax,

    // When timestamp decomposition is unavailable (e.g. child_process mode), report null, not 0
    pre_ingress: hasTimestampDecomposition ? computePercentileSummary(validPreIngress) : null,
    server_processing: hasTimestampDecomposition ? computePercentileSummary(validServerProcessing) : null,
    post_finish: hasTimestampDecomposition ? computePercentileSummary(validPostFinish) : null,
    headers_resolved: hasTimestampDecomposition ? computePercentileSummary(validHeadersResolved) : null,
    body_transfer: hasTimestampDecomposition ? computePercentileSummary(validBodyTransfer) : null,
  };
}
