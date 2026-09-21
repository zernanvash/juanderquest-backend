import { progressionService } from '../progression/service.js';
import { env } from '../config/env.js';

export interface OutboxWorkerOptions {
  intervalMs?: number;
  batchSize?: number;
  workerId?: string;
}

export class OutboxWorker {
  private timer: NodeJS.Timeout | null = null;
  private isRunning = false;
  private isProcessing = false;
  private consecutiveErrors = 0;
  private intervalMs: number;
  private batchSize: number;
  private workerId: string;

  constructor(options: OutboxWorkerOptions = {}) {
    this.intervalMs = options.intervalMs ?? env.PROGRESSION_OUTBOX_WORKER_INTERVAL_MS ?? 5000;
    this.batchSize = options.batchSize ?? env.PROGRESSION_OUTBOX_WORKER_BATCH_SIZE ?? 20;
    this.workerId = options.workerId ?? `outbox-worker-${process.pid}-${Date.now()}`;
  }

  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    this.consecutiveErrors = 0;
    this.scheduleNextTick(0);
  }

  private scheduleNextTick(delayMs: number): void {
    if (!this.isRunning) return;
    this.timer = setTimeout(async () => {
      await this.tick();
    }, delayMs);
    if (this.timer.unref) {
      this.timer.unref();
    }
  }

  private async tick(): Promise<void> {
    if (!this.isRunning || this.isProcessing) return;
    this.isProcessing = true;
    try {
      await progressionService.processOutboxBatch(this.batchSize, this.workerId);
      this.consecutiveErrors = 0;
    } catch (err: any) {
      this.consecutiveErrors++;
      console.error('[outbox-worker] Batch processing error:', err?.message || err);
    } finally {
      this.isProcessing = false;
      if (this.isRunning) {
        // Exponential backoff with jitter on consecutive errors
        const backoffMultiplier = Math.min(Math.pow(1.5, this.consecutiveErrors), 10);
        const jitter = Math.floor(Math.random() * 500);
        const nextDelay = Math.floor(this.intervalMs * backoffMultiplier) + jitter;
        this.scheduleNextTick(nextDelay);
      }
    }
  }

  async stop(timeoutMs = 5000): Promise<void> {
    this.isRunning = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const start = Date.now();
    // Wait for in-flight batch to drain within timeoutMs
    while (this.isProcessing && Date.now() - start < timeoutMs) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

export const defaultOutboxWorker = new OutboxWorker({
  intervalMs: env.PROGRESSION_OUTBOX_WORKER_INTERVAL_MS,
  batchSize: env.PROGRESSION_OUTBOX_WORKER_BATCH_SIZE,
});

export function initOutboxWorker(): void {
  if (env.PROGRESSION_ENABLED && env.PROGRESSION_OUTBOX_WORKER_ENABLED) {
    defaultOutboxWorker.start();
    process.on('SIGTERM', async () => {
      await defaultOutboxWorker.stop();
    });
    process.on('SIGINT', async () => {
      await defaultOutboxWorker.stop();
    });
  }
}
