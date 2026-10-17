import type { Pool } from 'pg';
import { env } from '../config/env.js';
import { getPool } from '../db/pool.js';
import { lockGovernanceSnapshot, commitGovernanceTransaction } from '../governance/transaction.js';
import { finalizePlan, lockPlan, refreshQuestMirror, setQuestFundingState } from './plans.js';
import { releaseFundingHold } from './holds.js';
import { fundingTx, publishFunding } from './transaction.js';

export async function runFundingScheduler(pool: Pool) {
  const client = await pool.connect();
  const tx = fundingTx(client);
  const quests = new Set<string>();
  try {
    await client.query('BEGIN');
    await lockGovernanceSnapshot(client);
    const lease = await client.query('SELECT pg_try_advisory_xact_lock(78639471) AS acquired');
    if (!lease.rows[0]?.acquired) { await client.query('ROLLBACK'); return { acquired: false, processed: 0 }; }
    const due = await client.query(
      `SELECT DISTINCT p.id FROM quest_funding_plans p WHERE
       (p.status='pending_sponsors' AND (p.sponsorship_deadline<=clock_timestamp() OR p.ends_at<=clock_timestamp()))
       OR (p.status='scheduled' AND p.starts_at<=clock_timestamp()) OR (p.status='active' AND p.ends_at<=clock_timestamp())
       OR p.status='closing' OR EXISTS(SELECT 1 FROM quest_funding_holds h WHERE h.plan_id=p.id AND h.status='held' AND h.expires_at<=clock_timestamp())
       ORDER BY p.id LIMIT 100`);
    for (const row of due.rows) {
      const plan = await lockPlan(client, row.id);
      quests.add(plan.quest_id);
      const expiredHolds = await client.query(
        `SELECT h.* FROM quest_funding_holds h JOIN quest_attempts a ON a.id=h.attempt_id
         WHERE h.plan_id=$1 AND h.status='held' AND h.expires_at<=clock_timestamp() AND a.status<>'submitted'
           AND NOT EXISTS(SELECT 1 FROM submissions s WHERE s.quest_id=$2 AND s.user_id=h.user_id AND s.status='pending')
         ORDER BY h.id FOR UPDATE OF h`, [plan.id, plan.quest_id]);
      for (const hold of expiredHolds.rows) await releaseFundingHold(tx, hold, plan, plan.created_by, 'expired');
      const now = Date.now();
      if (plan.status === 'pending_sponsors' && (new Date(plan.sponsorship_deadline).getTime() <= now || new Date(plan.ends_at).getTime() <= now)) {
        await finalizePlan(tx, plan, plan.created_by, 'expired');
      } else if (['active','scheduled'].includes(plan.status) && new Date(plan.ends_at).getTime() <= now) {
        await client.query("UPDATE quest_funding_plans SET status='closing',close_reason='window_ended',closing_at=NOW(),version=version+1,updated_at=NOW() WHERE id=$1", [plan.id]);
        await setQuestFundingState(client, plan.quest_id, 'closing');
        await finalizePlan(tx, plan, plan.created_by);
      } else if (plan.status === 'scheduled' && new Date(plan.starts_at).getTime() <= now) {
        await client.query("UPDATE quest_funding_plans SET status='active',activated_at=NOW(),version=version+1,updated_at=NOW() WHERE id=$1", [plan.id]);
        await setQuestFundingState(client, plan.quest_id, 'active');
      } else if (plan.status === 'closing') await finalizePlan(tx, plan, plan.created_by);
    }
    await commitGovernanceTransaction(client);
    publishFunding(tx.groups);
    for (const questId of quests) await refreshQuestMirror(pool, questId);
    return { acquired: true, processed: due.rows.length };
  } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
  finally { client.release(); }
}

let started = false;
export function initFundingScheduler() {
  if (started || !env.QUEST_FUNDING_ENABLED || env.NODE_ENV === 'test') return;
  started = true;
  let running = false;
  const tick = async () => {
    const pool = getPool(); if (!pool || running) return;
    running = true;
    try { await runFundingScheduler(pool); }
    catch (error) { console.error('[funding-scheduler]', error); }
    finally { running = false; }
  };
  const timer = setInterval(() => { void tick(); }, 60_000);
  timer.unref();
  void tick();
}
