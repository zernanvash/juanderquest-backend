import { performance } from 'node:perf_hooks';
import type { Pool, PoolClient } from 'pg';

export type AcquisitionPhase = 'mixed_ballot_burst' | 'idle_read' | 'unscoped';

export interface AcquisitionSample {
  readonly elapsedMs: number;
  readonly phase: AcquisitionPhase;
  readonly success: boolean;
}

export interface AcquisitionStats {
  readonly count: number;
  readonly p50_ms: number;
  readonly p95_ms: number;
  readonly max_ms: number;
  readonly errorCount: number;
}

export interface AcquisitionProbeSummary {
  readonly all: AcquisitionStats;
  readonly mixed_ballot_burst: AcquisitionStats;
  readonly idle_read: AcquisitionStats;
  readonly unscoped: AcquisitionStats;
}

export interface AcquisitionProbe {
  setPhase(phase: 'mixed_ballot_burst' | 'idle_read'): void;
  getSamples(): readonly AcquisitionSample[];
  getSummary(): AcquisitionProbeSummary;
  restore(): void;
}

export function computePercentile(sortedValues: readonly number[], p: number): number {
  if (sortedValues.length === 0) return 0;
  const index = Math.min(sortedValues.length - 1, Math.ceil(sortedValues.length * p) - 1);
  return Math.round(sortedValues[index] ?? 0);
}

export function summarizeSamples(samples: readonly AcquisitionSample[]): AcquisitionStats {
  const durations = samples
    .map(s => (Number.isFinite(s.elapsedMs) && s.elapsedMs >= 0 ? s.elapsedMs : 0))
    .sort((a, b) => a - b);
  const count = durations.length;
  const p50_ms = computePercentile(durations, 0.50);
  const p95_ms = computePercentile(durations, 0.95);
  const max_ms = durations.length > 0 ? Math.round(durations[durations.length - 1] ?? 0) : 0;
  const errorCount = samples.filter(s => !s.success).length;

  return {
    count,
    p50_ms,
    p95_ms,
    max_ms,
    errorCount,
  };
}

export function installAcquisitionProbe(
  pool: Pool,
  getRequestPhase?: () => AcquisitionPhase
): AcquisitionProbe {
  const samples: AcquisitionSample[] = [];
  let currentPhase: 'mixed_ballot_burst' | 'idle_read' = 'idle_read';
  const originalConnect = pool.connect;

  function recordSample(elapsedMs: number, phase: AcquisitionPhase, success: boolean): void {
    const safeElapsed = Number.isFinite(elapsedMs) && elapsedMs >= 0 ? elapsedMs : 0;
    samples.push({
      elapsedMs: safeElapsed,
      phase,
      success,
    });
  }

  function resolvePhase(): AcquisitionPhase {
    if (getRequestPhase) {
      const phase = getRequestPhase();
      if (phase !== 'mixed_ballot_burst' && phase !== 'idle_read' && phase !== 'unscoped') {
        throw new Error(`Invalid acquisition phase resolved from getRequestPhase: ${String(phase)}`);
      }
      return phase;
    }
    return currentPhase;
  }

  // Override connect on the pool instance only
  pool.connect = function (this: Pool, ...args: unknown[]): any {
    const started = performance.now();
    const phaseAtInvocation = resolvePhase();
    const cb = typeof args[0] === 'function' ? (args[0] as (...cbArgs: unknown[]) => void) : undefined;

    if (cb) {
      const wrappedCb = function (err: Error | undefined, client: PoolClient | undefined, done: (release?: any) => void) {
        const elapsed = performance.now() - started;
        recordSample(elapsed, phaseAtInvocation, !err);
        return cb(err, client, done);
      };
      return Reflect.apply(originalConnect, this, [wrappedCb]);
    }

    const result = Reflect.apply(originalConnect, this, args) as Promise<PoolClient>;
    return result.then(
      (client: PoolClient) => {
        const elapsed = performance.now() - started;
        recordSample(elapsed, phaseAtInvocation, true);
        return client;
      },
      (err: unknown) => {
        const elapsed = performance.now() - started;
        recordSample(elapsed, phaseAtInvocation, false);
        throw err;
      }
    );
  } as typeof pool.connect;

  return {
    setPhase(phase: 'mixed_ballot_burst' | 'idle_read') {
      if (phase !== 'mixed_ballot_burst' && phase !== 'idle_read') {
        throw new Error(`Invalid phase passed to setPhase: ${String(phase)}`);
      }
      currentPhase = phase;
    },
    getSamples() {
      return samples;
    },
    getSummary() {
      return {
        all: summarizeSamples(samples),
        mixed_ballot_burst: summarizeSamples(samples.filter(s => s.phase === 'mixed_ballot_burst')),
        idle_read: summarizeSamples(samples.filter(s => s.phase === 'idle_read')),
        unscoped: summarizeSamples(samples.filter(s => s.phase === 'unscoped')),
      };
    },
    restore() {
      pool.connect = originalConnect;
    },
  };
}
