import type { AlphaSessionScope } from '../repositories/users.js';

export type AlphaBatchQueryFn = (ids: string[]) => Promise<Map<string, AlphaSessionScope>>;

export interface AlphaSessionScopeBatcherOptions {
  maxBatchSize?: number;
  maxUnresolvedCallers?: number;
  delayMs?: number;
}

interface PendingCaller {
  resolve: (value: AlphaSessionScope | null) => void;
  reject: (reason?: any) => void;
}

const STATIC_CAPACITY_ERROR_MESSAGE = 'Batch capacity full.';
const STATIC_CLOSED_ERROR_MESSAGE = 'Batcher is closed.';
const STATIC_INVALID_ID_ERROR_MESSAGE = 'Invalid user ID.';

const STATIC_INVALID_OPTIONS_ERROR_MESSAGE = 'Invalid batcher options.';

function validateIntegerRange(value: unknown, min: number, max: number): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

export class AlphaSessionScopeBatcher {
  private readonly queryFn: AlphaBatchQueryFn;
  private readonly maxBatchSize: number;
  private readonly maxUnresolvedCallers: number;
  private readonly delayMs: number;

  private queue: Map<string, PendingCaller[]> = new Map();
  private pendingCallerCount: number = 0;
  private timer: NodeJS.Timeout | null = null;
  private isInFlight: boolean = false;
  private inFlightCallers: PendingCaller[] = [];
  private isClosed: boolean = false;

  constructor(
    queryFn: AlphaBatchQueryFn,
    options: AlphaSessionScopeBatcherOptions = {}
  ) {
    if (typeof queryFn !== 'function') {
      throw new Error('AlphaSessionScopeBatcher requires a valid query function.');
    }
    this.queryFn = queryFn;

    const maxBatchSize = options.maxBatchSize ?? 100;
    if (!validateIntegerRange(maxBatchSize, 1, 100)) {
      throw new Error(STATIC_INVALID_OPTIONS_ERROR_MESSAGE);
    }
    this.maxBatchSize = maxBatchSize;

    const maxUnresolvedCallers = options.maxUnresolvedCallers ?? 500;
    if (!validateIntegerRange(maxUnresolvedCallers, 1, 500)) {
      throw new Error(STATIC_INVALID_OPTIONS_ERROR_MESSAGE);
    }
    this.maxUnresolvedCallers = maxUnresolvedCallers;

    const delayMs = options.delayMs ?? 2;
    if (!validateIntegerRange(delayMs, 0, 2)) {
      throw new Error(STATIC_INVALID_OPTIONS_ERROR_MESSAGE);
    }
    this.delayMs = delayMs;
  }

  public lookup(id: string): Promise<AlphaSessionScope | null> {
    if (this.isClosed) {
      return Promise.reject(new Error(STATIC_CLOSED_ERROR_MESSAGE));
    }

    if (typeof id !== 'string' || id.trim().length === 0 || id.length > 128) {
      return Promise.reject(new Error(STATIC_INVALID_ID_ERROR_MESSAGE));
    }

    const currentTotalUnresolved = this.pendingCallerCount + this.inFlightCallers.length;
    if (currentTotalUnresolved >= this.maxUnresolvedCallers) {
      return Promise.reject(new Error(STATIC_CAPACITY_ERROR_MESSAGE));
    }

    return new Promise<AlphaSessionScope | null>((resolve, reject) => {
      let callers = this.queue.get(id);
      if (!callers) {
        callers = [];
        this.queue.set(id, callers);
      }

      callers.push({ resolve, reject });
      this.pendingCallerCount++;

      this.scheduleFlush();
    });
  }

  public close(): void {
    if (this.isClosed) {
      return;
    }
    this.isClosed = true;

    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    const closedError = new Error(STATIC_CLOSED_ERROR_MESSAGE);

    // Reject all callers in queue
    for (const callers of this.queue.values()) {
      for (const caller of callers) {
        caller.reject(closedError);
      }
    }
    this.queue.clear();
    this.pendingCallerCount = 0;

    // Reject all in-flight callers
    for (const caller of this.inFlightCallers) {
      caller.reject(closedError);
    }
    this.inFlightCallers = [];
  }

  private scheduleFlush(): void {
    if (this.isClosed) {
      return;
    }

    // If an in-flight query is already running, wait until it settles
    if (this.isInFlight) {
      return;
    }

    // If we have enough unique IDs to fill an entire batch, flush immediately
    if (this.queue.size >= this.maxBatchSize) {
      if (this.timer !== null) {
        clearTimeout(this.timer);
        this.timer = null;
      }
      this.executeBatch();
      return;
    }

    // Otherwise, ensure a timer is set within delayMs
    if (this.timer === null) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.executeBatch();
      }, this.delayMs);

      if (typeof this.timer.unref === 'function') {
        this.timer.unref();
      }
    }
  }

  private executeBatch(): void {
    if (this.isClosed || this.isInFlight || this.queue.size === 0) {
      return;
    }

    // Select up to maxBatchSize unique IDs
    const batchMap = new Map<string, PendingCaller[]>();
    for (const [id, callers] of this.queue) {
      batchMap.set(id, callers);
      this.queue.delete(id);
      this.pendingCallerCount -= callers.length;
      if (batchMap.size >= this.maxBatchSize) {
        break;
      }
    }

    const batchIds = Array.from(batchMap.keys());
    const batchCallersList: PendingCaller[] = [];
    for (const callers of batchMap.values()) {
      for (const caller of callers) {
        batchCallersList.push(caller);
      }
    }

    this.inFlightCallers = batchCallersList;
    this.isInFlight = true;

    (async () => {
      try {
        const resultMap = await this.queryFn(batchIds);

        // If closed while query was in-flight, do not resolve callers or leak results
        if (this.isClosed) {
          return;
        }

        for (const [id, callers] of batchMap.entries()) {
          const scope = resultMap?.get(id) ?? null;
          for (const caller of callers) {
            caller.resolve(scope);
          }
        }
      } catch (err) {
        if (this.isClosed) {
          return;
        }
        for (const callers of batchMap.values()) {
          for (const caller of callers) {
            caller.reject(err);
          }
        }
      } finally {
        this.inFlightCallers = [];
        this.isInFlight = false;

        // If there are more pending items in queue and not closed, schedule next batch
        if (!this.isClosed && this.queue.size > 0) {
          this.scheduleFlush();
        }
      }
    })();
  }
}
