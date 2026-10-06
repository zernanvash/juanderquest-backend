export interface MonotonicInterval {
  readonly start: number;
  readonly end: number;
}

export function validInterval(value: unknown): value is MonotonicInterval {
  if (!value || typeof value !== 'object') return false;
  const { start, end } = value as Record<string, unknown>;
  return typeof start === 'number' && typeof end === 'number'
    && Number.isFinite(start) && Number.isFinite(end) && start <= end;
}

export function overlapDuration(a: MonotonicInterval, b: MonotonicInterval): number {
  if (!validInterval(a) || !validInterval(b)) return 0;
  return Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
}

export function retainLongestIntervals<T extends MonotonicInterval>(
  intervals: readonly T[], incoming: T, limit = 20
): T[] {
  if (!Number.isSafeInteger(limit) || limit < 1 || !validInterval(incoming)) return [...intervals];
  return [...intervals.filter(validInterval), incoming]
    .sort((a, b) => (b.end - b.start) - (a.end - a.start) || a.start - b.start)
    .slice(0, limit);
}

export interface StallOverlapReport {
  measurement_scope: 'same_process_request_window';
  interpretation: 'correlation_only';
  gap_count: number;
  max_gap_duration_ms: number;
  slowest_wallet_batch_duration_ms: number;
  max_overlap_duration_ms: number;
  slow_wallet_batches_intersecting_gap_count: number;
}

export function stallOverlapReport(
  gaps: readonly MonotonicInterval[], walletBatches: readonly MonotonicInterval[]
): StallOverlapReport {
  const validGaps = gaps.filter(validInterval);
  const validBatches = walletBatches.filter(validInterval);
  let maxOverlap = 0;
  let intersectingBatches = 0;
  for (const batch of validBatches) {
    let intersects = false;
    for (const gap of validGaps) {
      const overlap = overlapDuration(batch, gap);
      if (overlap > 0) intersects = true;
      maxOverlap = Math.max(maxOverlap, overlap);
    }
    if (intersects) intersectingBatches++;
  }
  return {
    measurement_scope: 'same_process_request_window',
    interpretation: 'correlation_only',
    gap_count: validGaps.length,
    max_gap_duration_ms: Math.round(Math.max(0, ...validGaps.map(gap => gap.end - gap.start))),
    slowest_wallet_batch_duration_ms: Math.round(Math.max(0, ...validBatches.map(batch => batch.end - batch.start))),
    max_overlap_duration_ms: Math.round(maxOverlap),
    slow_wallet_batches_intersecting_gap_count: intersectingBatches,
  };
}

/** Bounded, identity-free monotonic positions for matching local CPU samples. */
export function stallTimelineReport(
  gaps: readonly MonotonicInterval[], walletBatches: readonly MonotonicInterval[], limit = 3
): { clock: 'performance_now_ms'; gaps: MonotonicInterval[]; wallet_batches: MonotonicInterval[] } {
  const take = (values: readonly MonotonicInterval[]) => values.filter(validInterval).slice(0, limit)
    .map(value => ({ start: Math.round(value.start), end: Math.round(value.end) }));
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > 3) throw new Error('Invalid stall timeline limit');
  return { clock: 'performance_now_ms', gaps: take(gaps), wallet_batches: take(walletBatches) };
}
