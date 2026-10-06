import { randomUUID } from 'node:crypto';
import { env } from '../config/env.js';
import { reconcileMonthlySchedules } from '../juanchoice/monthly-service.js';

const instanceId = randomUUID();
let timer: NodeJS.Timeout | null = null;
let running: Promise<void> | null = null;
let stopped = true;
let failures = 0;
let lastAttemptAt: string | null = null;
let lastSuccessAt: string | null = null;
let lastFailureAt: string | null = null;
let nextAttemptAt: string | null = null;
let lastSummary: Awaited<ReturnType<typeof reconcileMonthlySchedules>> | null = null;

export function getJuanChoiceSchedulerStatus() {
  return {
    instance_id: instanceId,
    configured_enabled: env.JUANCHOICE_ENABLED && env.JUANCHOICE_SCHEDULER_ENABLED,
    active: !stopped,
    in_flight: running !== null,
    consecutive_failures: failures,
    last_attempt_at: lastAttemptAt,
    last_success_at: lastSuccessAt,
    last_failure_at: lastFailureAt,
    next_attempt_at: nextAttemptAt,
    last_summary: lastSummary ? { ...lastSummary } : null,
  };
}

async function tick(): Promise<void> {
  if (stopped || running) return;
  running = (async () => {
    lastAttemptAt = new Date().toISOString();
    nextAttemptAt = null;
    try {
      const summary = await reconcileMonthlySchedules(env.JUANCHOICE_SCHEDULER_BATCH_SIZE);
      lastSummary = summary;
      if (summary.failed) throw new Error(`${summary.failed} monthly schedules failed reconciliation`);
      failures = 0;
      lastSuccessAt = new Date().toISOString();
    } catch (error) {
      failures++;
      lastFailureAt = new Date().toISOString();
      console.error('[juanchoice-scheduler]',error);
    }
  })();
  try { await running; }
  finally {
    running = null;
    if (!stopped) {
      const backoff = Math.min(8, Math.pow(1.5,failures));
      const jitter = Math.floor(Math.random()*Math.min(1000,env.JUANCHOICE_SCHEDULER_INTERVAL_MS/5));
      const delayMs = env.JUANCHOICE_SCHEDULER_INTERVAL_MS*backoff+jitter;
      nextAttemptAt = new Date(Date.now()+delayMs).toISOString();
      timer = setTimeout(() => void tick(),delayMs);
      timer.unref?.();
    }
  }
}

export function initJuanChoiceScheduler(): void {
  if (!stopped || !env.JUANCHOICE_ENABLED || !env.JUANCHOICE_SCHEDULER_ENABLED) return;
  stopped = false;
  nextAttemptAt = new Date().toISOString();
  timer = setTimeout(() => void tick(),0);
  timer.unref?.();
}

export async function stopJuanChoiceScheduler(timeoutMs=5000): Promise<void> {
  stopped = true;
  if (timer) clearTimeout(timer);
  timer = null;
  nextAttemptAt = null;
  if (running) await Promise.race([running,new Promise<void>(resolve => setTimeout(resolve,timeoutMs))]);
}
