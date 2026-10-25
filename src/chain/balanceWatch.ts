import type { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { getPool } from '../db/pool.js';
import { getChainConfig } from './config.js';
import { getChainStateReader, isLowBalance, type ChainStateReader } from './stateReader.js';
import { enqueuePush } from '../push/enqueue.js';
import { manilaDayStartUtc } from '../social/time.js';

/** Arbitrary stable advisory-lock key ("JDQB") so only one process checks at a time. */
const CHAIN_BALANCE_WATCH_LOCK_KEY = 0x4a445142;

let timer: NodeJS.Timeout | null = null;
let running = false;

export interface BalanceWatchResult { checked: number; low: number; notified: number }

/**
 * Plan 49 §4b: warn every admin when a server wallet that pays gas runs low.
 * One inbox notification (+ an 'account' push) per wallet per Manila day.
 */
export async function runBalanceWatch(pool: Pool, reader: ChainStateReader, chainId: number,
  now: Date = new Date()): Promise<BalanceWatchResult> {
  const wallets = await pool.query(
    `SELECT address, label, low_balance_pol FROM chain_wallets
      WHERE chain_id = $1 AND active = TRUE AND needs_gas = TRUE AND low_balance_pol IS NOT NULL`, [chainId]);
  const day = manilaDayStartUtc(now).toISOString().slice(0, 10);
  let low = 0;
  let notified = 0;
  for (const w of wallets.rows) {
    const live = await reader.wallet(w.address);
    if (!isLowBalance(live.balancePol, w.low_balance_pol, true)) continue;
    low += 1;
    const balance = Number(live.balancePol).toFixed(4);
    const threshold = Number(w.low_balance_pol).toString();
    const admins = await pool.query(`SELECT id, is_test FROM users WHERE role = 'admin'`);
    for (const admin of admins.rows) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const inserted = await client.query(
          `INSERT INTO user_notifications (id, user_id, event_key, kind, title, message, href, is_test)
           VALUES ($1, $2, $3, 'chain_alert', $4, $5, '/notifications', $6)
           ON CONFLICT (user_id, event_key) DO NOTHING RETURNING id`,
          [randomUUID(), admin.id, `chain-low:${chainId}:${w.address}:${day}`,
            `Low POL: ${w.label}`.slice(0, 120),
            `${w.label} has ${balance} POL (alert below ${threshold}). Top up from the treasury wallet.`.slice(0, 500),
            Boolean(admin.is_test)]);
        const notificationId = inserted.rows[0]?.id as string | undefined;
        if (notificationId) {
          await enqueuePush(client as any, {
            userId: admin.id, category: 'account', collapseKey: `chain-low:${w.address}:${day}`,
            notificationId, title: `Low POL: ${w.label}`,
            body: `${balance} POL left. Top up from the treasury wallet.`, href: '/notifications',
            isTest: Boolean(admin.is_test),
          }, now);
          notified += 1;
        }
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('[chain-balance-watch] notify failed:', err instanceof Error ? err.message : err);
      } finally {
        client.release();
      }
    }
  }
  return { checked: wallets.rows.length, low, notified };
}

async function tick(): Promise<void> {
  if (running) return;
  const pool = getPool();
  if (!pool) return;
  running = true;
  const client = await pool.connect();
  let locked = false;
  try {
    locked = Boolean((await client.query('SELECT pg_try_advisory_lock($1) AS acquired',
      [CHAIN_BALANCE_WATCH_LOCK_KEY])).rows[0]?.acquired);
    if (!locked) return;
    const config = getChainConfig();
    const result = await runBalanceWatch(pool, getChainStateReader(config.rpcUrls, config.chainId), config.chainId);
    if (result.low > 0) console.log(`[chain-balance-watch] ${result.low} low wallet(s), ${result.notified} notification(s)`);
  } catch (err) {
    console.error('[chain-balance-watch] tick failed:', err instanceof Error ? err.message : err);
  } finally {
    if (locked) await client.query('SELECT pg_advisory_unlock($1)', [CHAIN_BALANCE_WATCH_LOCK_KEY]).catch(() => {});
    client.release();
    running = false;
  }
}

/** Off unless CHAIN_ALERTS_ENABLED. Never keeps the process alive. */
export function startChainBalanceWatch(): void {
  const config = getChainConfig();
  if (!config.alertsEnabled || timer) return;
  timer = setInterval(() => { void tick(); }, config.lowBalanceCheckMinutes * 60_000);
  timer.unref?.();
  const first = setTimeout(() => { void tick(); }, 30_000);
  first.unref?.();
  console.log(`[chain-balance-watch] started (every ${config.lowBalanceCheckMinutes} min)`);
}

export function stopChainBalanceWatch(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
    console.log('[chain-balance-watch] stopped');
  }
}
