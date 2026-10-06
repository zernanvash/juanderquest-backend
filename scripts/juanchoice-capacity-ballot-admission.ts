import assert from 'node:assert/strict';

export interface BallotAdmissionOptions {
  /** Maximum number of concurrent ballot permits granted (0 disables the gate). */
  readonly limit: number;
  /** Maximum number of callers allowed to wait in the queue before failing closed. Default 100. */
  readonly maxQueueDepth?: number;
}

export interface BallotAdmissionStats {
  readonly limit: number;
  readonly peakQueue: number;
  readonly totalWaiters: number;
  readonly waitDurationSamplesMs: readonly number[];
}

interface QueuedWaiter {
  readonly enqueuedAt: number;
  readonly resolve: (release: () => void) => void;
  readonly reject: (reason?: unknown) => void;
  readonly cleanup?: () => void;
}

export class BallotAdmissionController {
  private readonly limit: number;
  private readonly maxQueueDepth: number;
  private activeCount = 0;
  private peakQueue = 0;
  private totalWaiters = 0;
  private readonly queue: QueuedWaiter[] = [];
  private readonly waitDurationSamplesMs: number[] = [];

  constructor(options: BallotAdmissionOptions) {
    assert(
      Number.isInteger(options.limit) && options.limit >= 0,
      'BallotAdmission limit must be a non-negative integer'
    );
    this.limit = options.limit;
    this.maxQueueDepth = options.maxQueueDepth ?? 100;
    assert(
      Number.isInteger(this.maxQueueDepth) && this.maxQueueDepth > 0,
      'BallotAdmission maxQueueDepth must be a positive integer'
    );
  }

  getLimit(): number {
    return this.limit;
  }

  getPeakQueue(): number {
    return this.peakQueue;
  }

  getActiveCount(): number {
    return this.activeCount;
  }

  getQueueDepth(): number {
    return this.queue.length;
  }

  getWaitSamples(): readonly number[] {
    return this.waitDurationSamplesMs;
  }

  getStats(): BallotAdmissionStats {
    return {
      limit: this.limit,
      peakQueue: this.peakQueue,
      totalWaiters: this.totalWaiters,
      waitDurationSamplesMs: [...this.waitDurationSamplesMs],
    };
  }

  getWaitPercentiles(): { p50_ms: number; p95_ms: number; max_ms: number } {
    if (this.waitDurationSamplesMs.length === 0) {
      return { p50_ms: 0, p95_ms: 0, max_ms: 0 };
    }
    const sorted = [...this.waitDurationSamplesMs].sort((a, b) => a - b);
    const roundMs = (v: number) => Math.round(v * 1000) / 1000;
    const rank = (p: number) => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)] ?? 0;
    return {
      p50_ms: roundMs(rank(0.5)),
      p95_ms: roundMs(rank(0.95)),
      max_ms: roundMs(sorted[sorted.length - 1] ?? 0),
    };
  }

  /**
   * Acquire a permit. Returns a release function that is idempotent.
   * If limit is 0, admission gating is disabled: executes immediately and release is a no-op.
   * If signal is aborted before permit acquisition, the waiter is removed and rejected without consuming or leaking a permit.
   */
  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (this.limit === 0) {
      return () => {
        // No-op release when gate is disabled
      };
    }

    if (signal?.aborted) {
      const err = new Error('Ballot admission request aborted before acquisition');
      err.name = 'AbortError';
      throw err;
    }

    if (this.activeCount < this.limit) {
      this.activeCount++;
      return this.createReleaseFn();
    }

    if (this.queue.length >= this.maxQueueDepth) {
      throw new Error(`Ballot admission queue limit (${this.maxQueueDepth}) exceeded; failing closed`);
    }

    const enqueuedAt = performance.now();
    this.totalWaiters++;

    return new Promise<() => void>((resolve, reject) => {
      let abortHandler: (() => void) | undefined;

      const waiter: QueuedWaiter = {
        enqueuedAt,
        resolve: (releaseFn: () => void) => {
          if (abortHandler && signal) {
            signal.removeEventListener('abort', abortHandler);
          }
          const waitMs = Math.max(0, performance.now() - enqueuedAt);
          this.waitDurationSamplesMs.push(waitMs);
          resolve(releaseFn);
        },
        reject: (reason?: unknown) => {
          if (abortHandler && signal) {
            signal.removeEventListener('abort', abortHandler);
          }
          reject(reason);
        },
      };

      if (signal) {
        abortHandler = () => {
          const index = this.queue.indexOf(waiter);
          if (index !== -1) {
            this.queue.splice(index, 1);
            const err = new Error('Ballot admission request aborted while queued');
            err.name = 'AbortError';
            waiter.reject(err);
          }
        };
        signal.addEventListener('abort', abortHandler, { once: true });
      }

      this.queue.push(waiter);
      if (this.queue.length > this.peakQueue) {
        this.peakQueue = this.queue.length;
      }
    });
  }

  private createReleaseFn(): () => void {
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      this.activeCount--;

      while (this.queue.length > 0) {
        const next = this.queue.shift()!;
        this.activeCount++;
        next.resolve(this.createReleaseFn());
        return;
      }
    };
  }
}

/**
 * Validates and resolves the JDQ_CAPACITY_BALLOT_ADMISSION environment variable.
 * Must be 0 (default/disabled) or an integer between 1 and poolMax - 1.
 */
export function resolveBallotAdmission(envValue: string | undefined, poolMax: number): number {
  assert(
    Number.isInteger(poolMax) && poolMax >= 1,
    'poolMax must be an integer >= 1 to resolve ballot admission'
  );

  if (envValue === undefined || envValue.trim() === '') {
    return 0;
  }

  const trimmed = envValue.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`JDQ_CAPACITY_BALLOT_ADMISSION must be an integer (0 or 1..poolMax-1), received "${envValue}"`);
  }

  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`JDQ_CAPACITY_BALLOT_ADMISSION must be a safe integer, received "${envValue}"`);
  }

  if (parsed === 0) {
    return 0;
  }

  const maxAllowed = poolMax - 1;
  if (maxAllowed < 1) {
    throw new Error(
      `Cannot enable ballot admission when poolMax is ${poolMax}; required range 1..${maxAllowed} is empty`
    );
  }

  if (parsed < 1 || parsed > maxAllowed) {
    throw new Error(
      `JDQ_CAPACITY_BALLOT_ADMISSION must be 0 (disabled) or between 1 and ${maxAllowed} (poolMax - 1), received ${parsed}`
    );
  }

  return parsed;
}

/** Check if a request path matches the ballot route. */
const BALLOT_ROUTE_REGEX = /^\/api\/v1\/juanchoice\/campaigns\/[^/]+\/ballot(?:\?.*)?$/;

export function isBallotRequest(method: string | undefined, url: string | undefined): boolean {
  if (method !== 'PUT' || !url) {
    return false;
  }
  return BALLOT_ROUTE_REGEX.test(url);
}
