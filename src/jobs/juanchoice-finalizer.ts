import { env } from '../config/env.js';
import { finalizeDueCampaigns } from '../juanchoice/service.js';

let timer: NodeJS.Timeout | null = null;
let running = false;

export function initJuanChoiceFinalizer(): void {
  if (!env.JUANCHOICE_ENABLED || !env.JUANCHOICE_WRITES_ENABLED || !env.JUANCHOICE_FINALIZER_WORKER_ENABLED || timer) return;
  timer = setInterval(async () => {
    if (running) return;
    running = true;
    try { await finalizeDueCampaigns(); }
    catch (error) { console.error('[juanchoice-finalizer]', error); }
    finally { running = false; }
  }, env.JUANCHOICE_FINALIZER_INTERVAL_MS);
  timer.unref?.();
}

export function stopJuanChoiceFinalizer(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
