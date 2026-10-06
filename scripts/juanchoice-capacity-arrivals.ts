export type ArrivalKind = 'overview' | 'standings' | '0' | '1';

export interface RawArrivalRecord {
  kind: ArrivalKind;
  ingressMs: number;
  finishMs: number;
}

export interface ArrivalGroupMetrics {
  count: number;
  ingressSpanMs: number;
  maxIngressIn100ms: number;
  maxIngressIn1s: number;
  maxSimultaneousInFlight: number;
}

export type ArrivalGroupKey = 'overview' | 'standings' | '0' | '1' | 'allRead' | 'allBallot';

export type ArrivalSummaryResult = Record<ArrivalGroupKey, ArrivalGroupMetrics>;

const VALID_KINDS: Set<string> = new Set(['overview', 'standings', '0', '1']);

function createEmptyMetrics(): ArrivalGroupMetrics {
  return {
    count: 0,
    ingressSpanMs: 0,
    maxIngressIn100ms: 0,
    maxIngressIn1s: 0,
    maxSimultaneousInFlight: 0,
  };
}

function calculateMaxSlidingIngress(ingressTimes: number[], windowMs: number): number {
  if (ingressTimes.length === 0) return 0;
  let maxCount = 0;
  let left = 0;
  for (let right = 0; right < ingressTimes.length; right++) {
    while (ingressTimes[right] - ingressTimes[left] > windowMs) {
      left++;
    }
    const currentCount = right - left + 1;
    if (currentCount > maxCount) {
      maxCount = currentCount;
    }
  }
  return maxCount;
}

function calculateMaxConcurrency(intervals: Array<{ ingressMs: number; finishMs: number }>): number {
  if (intervals.length === 0) return 0;

  // Events: start (+1), end (-1).
  // Intervals are half-open: [ingressMs, finishMs).
  // If finishMs === ingressMs (zero duration), it never contributes positive duration,
  // or if considered instant, it starts and ends at the exact same moment.
  // Using standard half-open [ingressMs, finishMs):
  // At a boundary T where one request ends and another starts, end is processed before or after?
  // In half-open [ingress, finish), at time T = finish, the request is already finished.
  // So end events at time T should be processed before start events at time T.
  type Event = { time: number; type: -1 | 1 };
  const events: Event[] = [];

  for (const item of intervals) {
    if (item.finishMs === item.ingressMs) {
      // Zero-duration request: active for 0 time.
      // Must not produce negative concurrency. Does not increase simultaneous in-flight count.
      continue;
    }
    events.push({ time: item.ingressMs, type: 1 });
    events.push({ time: item.finishMs, type: -1 });
  }

  // Sort events by time ascending.
  // For ties in time: -1 (finishes) come before 1 (starts) for half-open [ingress, finish).
  events.sort((a, b) => {
    if (a.time !== b.time) {
      return a.time - b.time;
    }
    return a.type - b.type; // -1 comes before 1
  });

  let currentInFlight = 0;
  let maxInFlight = 0;

  for (const ev of events) {
    currentInFlight += ev.type;
    if (currentInFlight < 0) {
      currentInFlight = 0; // defensive guard against negative concurrency
    }
    if (currentInFlight > maxInFlight) {
      maxInFlight = currentInFlight;
    }
  }

  return maxInFlight;
}

function computeMetricsForRecords(records: RawArrivalRecord[]): ArrivalGroupMetrics {
  if (records.length === 0) {
    return createEmptyMetrics();
  }

  const ingressTimes = records.map((r) => r.ingressMs).sort((a, b) => a - b);
  const minIngress = ingressTimes[0];
  const maxIngress = ingressTimes[ingressTimes.length - 1];
  const ingressSpanMs = maxIngress - minIngress;

  const maxIngressIn100ms = calculateMaxSlidingIngress(ingressTimes, 100);
  const maxIngressIn1s = calculateMaxSlidingIngress(ingressTimes, 1000);

  const maxSimultaneousInFlight = calculateMaxConcurrency(records);

  return {
    count: records.length,
    ingressSpanMs,
    maxIngressIn100ms,
    maxIngressIn1s,
    maxSimultaneousInFlight,
  };
}

export function summarizeArrivals(records: RawArrivalRecord[]): ArrivalSummaryResult {
  if (!Array.isArray(records)) {
    throw new TypeError('Records must be an array');
  }

  // Validation
  for (const record of records) {
    if (!record || typeof record !== 'object') {
      throw new TypeError('Record must be an object');
    }
    if (!VALID_KINDS.has(record.kind)) {
      throw new Error(`Invalid kind: ${record.kind}`);
    }
    if (
      typeof record.ingressMs !== 'number' ||
      !Number.isFinite(record.ingressMs) ||
      record.ingressMs < 0
    ) {
      throw new Error(`Invalid ingressMs: ${record.ingressMs}`);
    }
    if (
      typeof record.finishMs !== 'number' ||
      !Number.isFinite(record.finishMs) ||
      record.finishMs < 0
    ) {
      throw new Error(`Invalid finishMs: ${record.finishMs}`);
    }
    if (record.finishMs < record.ingressMs) {
      throw new Error(`finishMs (${record.finishMs}) cannot be less than ingressMs (${record.ingressMs})`);
    }
  }

  const byKind: Record<ArrivalKind, RawArrivalRecord[]> = {
    overview: [],
    standings: [],
    '0': [],
    '1': [],
  };

  const allRead: RawArrivalRecord[] = [];
  const allBallot: RawArrivalRecord[] = [];

  for (const rec of records) {
    byKind[rec.kind].push(rec);
    if (rec.kind === 'overview' || rec.kind === 'standings') {
      allRead.push(rec);
    } else if (rec.kind === '0' || rec.kind === '1') {
      allBallot.push(rec);
    }
  }

  return {
    overview: computeMetricsForRecords(byKind.overview),
    standings: computeMetricsForRecords(byKind.standings),
    '0': computeMetricsForRecords(byKind['0']),
    '1': computeMetricsForRecords(byKind['1']),
    allRead: computeMetricsForRecords(allRead),
    allBallot: computeMetricsForRecords(allBallot),
  };
}
