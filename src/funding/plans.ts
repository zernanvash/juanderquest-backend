import { randomUUID } from 'crypto';
import type { Pool, PoolClient } from 'pg';
import { db } from '../db/index.js';
import { canonicalSettings } from '../settings/schema.js';
import { feeForReward, targetForCompletions } from './allocate.js';
import { FundingError, fundingCommand, type FundingTx } from './transaction.js';
import type { PointAccountRef } from './ledger.js';
import { notifyPlanStakeholders } from './notifications.js';

export interface PlanTerms { mode: 'budget' | 'window'; planned_completions: number; starts_at: string; ends_at: string }
export const OPEN_PLAN_STATES = ['draft', 'pending_sponsors', 'scheduled', 'active', 'closing'];

export async function fundingSettings(client: PoolClient) {
  const result = await client.query('SELECT values FROM system_settings_document WHERE id=1');
  return canonicalSettings(result.rows[0]?.values ?? {});
}

export async function lockPlan(client: PoolClient, id: string, actorId?: string, admin = false) {
  const result = await client.query(
    `SELECT p.*, q.author_id, q.is_test AS quest_scope, q.version AS current_quest_version
     FROM quest_funding_plans p JOIN quests q ON q.id=p.quest_id WHERE p.id=$1 FOR UPDATE OF p`, [id]);
  const plan = result.rows[0];
  if (!plan) throw new FundingError('NOT_FOUND', 404, 'Funding plan not found.');
  if (Boolean(plan.is_test) !== Boolean(plan.quest_scope)) throw new FundingError('SCOPE_MISMATCH', 409, 'Funding and quest scopes do not match.');
  if (actorId && !admin && (plan.created_by !== actorId || plan.author_id !== actorId)) {
    throw new FundingError('QUEST_NOT_DESTINATION_AUTHOR', 403, 'Only the destination author may manage this funding plan.');
  }
  if (actorId) {
    const actor = await client.query('SELECT is_test FROM users WHERE id=$1', [actorId]);
    if (!actor.rows[0] || (!admin && Boolean(actor.rows[0].is_test) !== Boolean(plan.is_test))) {
      throw new FundingError('SCOPE_MISMATCH', 403, 'Account and funding scopes do not match.');
    }
  }
  return plan;
}

export function funderAccount(contribution: any): PointAccountRef {
  return contribution.funder_kind === 'author'
    ? { id: contribution.funder_user_id, userId: contribution.funder_user_id, kind: 'traveler' }
    : { id: `merchant:${contribution.merchant_id}`, kind: 'merchant' };
}

export async function ensurePlanAccounts(client: PoolClient, plan: any) {
  for (const kind of ['quest_budget', 'quest_hold'] as const) {
    await client.query(
      'INSERT INTO points_accounts(id,kind,plan_id,is_test) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO NOTHING',
      [`${kind}:${plan.id}`, kind, plan.id, plan.is_test]);
  }
}

export async function setQuestFundingState(client: PoolClient, questId: string, state: string) {
  const status = state === 'active' || state === 'closing' ? 'published'
    : ['closed', 'expired', 'cancelled'].includes(state) ? 'paused' : 'draft';
  await client.query('UPDATE quests SET status=$2,is_active=$3,updated_at=NOW() WHERE id=$1', [questId, status, state === 'active']);
}

export async function refreshQuestMirror(pool: Pool, questId: string) {
  const result = await pool.query('SELECT status,is_active FROM quests WHERE id=$1', [questId]);
  const quest = db.quests.find(row => row.id === questId);
  if (quest && result.rows[0]) Object.assign(quest, result.rows[0]);
}

function validateWindow(terms: PlanTerms, settings: Record<string, any>) {
  if (!['budget','window'].includes(terms.mode) || !Number.isInteger(terms.planned_completions) || terms.planned_completions < 1 || terms.planned_completions > 10_000) {
    throw new FundingError('INVALID_FUNDING_TERMS', 400, 'Choose a supported funding model and completion target.');
  }
  const start = Date.parse(terms.starts_at), end = Date.parse(terms.ends_at);
  const duration = (end - start) / 86_400_000;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= Date.now() ||
      duration < Number(settings.funding_window_min_days) || duration > Number(settings.funding_window_max_days)) {
    throw new FundingError('FUNDING_WINDOW_INVALID', 400, 'Choose a future end date and a window within the configured length.');
  }
}

export async function activateIfFunded(tx: FundingTx, plan: any) {
  if (!['draft', 'pending_sponsors'].includes(plan.status)) return plan;
  if (new Date(plan.ends_at).getTime() <= Date.now() || (plan.sponsorship_deadline && new Date(plan.sponsorship_deadline).getTime() <= Date.now())) {
    throw new FundingError('FUNDING_PLAN_STATE', 409, 'This round has passed its funding deadline.');
  }
  const total = await tx.client.query('SELECT COALESCE(SUM(committed_points),0)::bigint AS total FROM quest_funding_contributions WHERE plan_id=$1 AND is_test=$2', [plan.id, plan.is_test]);
  if (Number(total.rows[0].total) < Number(plan.target_points)) return plan;
  const result = await tx.client.query(
    `UPDATE quest_funding_plans SET status=CASE WHEN starts_at<=clock_timestamp() THEN 'active' ELSE 'scheduled' END,
       activated_at=CASE WHEN starts_at<=clock_timestamp() THEN NOW() ELSE NULL END,version=version+1,updated_at=NOW()
     WHERE id=$1 RETURNING *`, [plan.id]);
  await setQuestFundingState(tx.client, plan.quest_id, result.rows[0].status);
  await notifyPlanStakeholders(tx.client, result.rows[0], `funding-plan:${plan.id}:activated`,
    result.rows[0].status === 'active' ? 'Eco-Quest funding is active' : 'Eco-Quest funding is scheduled',
    result.rows[0].status === 'active'
      ? 'The reward pool met its target. Travelers can now start this funded Eco-Quest.'
      : 'The reward pool met its target. This Eco-Quest will open at its scheduled start time.');
  return result.rows[0];
}

/** Finalize only once every existing hold has resolved. */
export async function finalizePlan(tx: FundingTx, plan: any, actorId: string, terminal = 'closed') {
  const live = await tx.client.query("SELECT 1 FROM quest_funding_holds WHERE plan_id=$1 AND status='held' LIMIT 1", [plan.id]);
  if (live.rows.length) return false;
  const contributions = await tx.client.query('SELECT * FROM quest_funding_contributions WHERE plan_id=$1 ORDER BY id FOR UPDATE', [plan.id]);
  for (const contribution of contributions.rows) {
    if (Boolean(contribution.is_test) !== Boolean(plan.is_test)) throw new FundingError('SCOPE_MISMATCH', 409, 'Contribution scope does not match.');
    const points = Number(contribution.remaining_points);
    if (points > 0 && plan.mode === 'budget') {
      await tx.transfer({ from: { id: `quest_budget:${plan.id}`, kind: 'quest_budget' }, to: funderAccount(contribution),
        points, type: 'quest_fund_refund', referenceType: 'quest_funding_plan', referenceId: plan.id, actorId,
        metadata: { contribution_id: contribution.id } });
    }
    await tx.client.query('UPDATE quest_funding_contributions SET remaining_points=0,refunded_points=refunded_points+$2,updated_at=NOW() WHERE id=$1', [contribution.id, points]);
  }
  await tx.client.query('UPDATE quest_funding_plans SET status=$2,closed_at=NOW(),version=version+1,updated_at=NOW() WHERE id=$1', [plan.id, terminal]);
  await tx.client.query("UPDATE quest_sponsorships SET status='expired',updated_at=NOW() WHERE plan_id=$1 AND status IN ('requested','countered')", [plan.id]);
  await setQuestFundingState(tx.client, plan.quest_id, terminal);
  await notifyPlanStakeholders(tx.client, plan, `funding-plan:${plan.id}:${terminal}`,
    terminal === 'expired' ? 'Eco-Quest funding round expired' : 'Eco-Quest funding round closed',
    terminal === 'expired'
      ? 'The sponsorship window ended. Remaining locked demo points were returned to their funders.'
      : 'This funding round has ended. Any unused locked demo points were returned to their funders.');
  return true;
}

export class FundingPlansService {
  constructor(readonly pool: Pool) {}

  async create(actorId: string, questId: string, terms: PlanTerms, key: string) {
    const result = await fundingCommand(this.pool, actorId, 'funding.create', key, { questId, ...terms }, async tx => {
      const q = await tx.client.query('SELECT * FROM quests WHERE id=$1 FOR UPDATE', [questId]);
      const quest = q.rows[0];
      if (!quest) throw new FundingError('NOT_FOUND', 404, 'Quest not found.');
      if (quest.author_id !== actorId) throw new FundingError('QUEST_NOT_DESTINATION_AUTHOR', 403, 'Only the destination author may fund this quest.');
      const actor = await tx.client.query('SELECT is_test FROM users WHERE id=$1', [actorId]);
      if (!actor.rows[0] || Boolean(actor.rows[0].is_test) !== Boolean(quest.is_test)) throw new FundingError('SCOPE_MISMATCH', 403, 'Account and quest scopes do not match.');
      if (!['draft', 'paused'].includes(quest.status)) throw new FundingError('FUNDING_PLAN_STATE', 409, 'Create funding while the quest is draft or paused.');
      const unfinished = await tx.client.query(
        `SELECT 1 FROM quest_attempts WHERE quest_id=$1 AND status IN ('in_progress','submitted')
         UNION ALL SELECT 1 FROM submissions WHERE quest_id=$1 AND status='pending' LIMIT 1`, [questId]);
      if (unfinished.rows.length) throw new FundingError('FUNDING_PLAN_STATE', 409, 'Resolve existing attempts before opening a funding round.');
      if (![50, 75, 100].includes(Number(quest.reward_points))) throw new FundingError('INVALID_REWARD_TIER', 400, 'Select a 50, 75 or 100 point reward tier.');
      const existing = await tx.client.query('SELECT 1 FROM quest_funding_plans WHERE quest_id=$1 AND status=ANY($2::text[])', [questId, OPEN_PLAN_STATES]);
      if (existing.rows.length) throw new FundingError('FUNDING_PLAN_EXISTS', 409, 'This quest already has an open funding round.');
      const settings = await fundingSettings(tx.client);
      validateWindow(terms, settings);
      const round = await tx.client.query('SELECT COALESCE(MAX(round_number),0)+1 AS next FROM quest_funding_plans WHERE quest_id=$1', [questId]);
      const feeBps = Number(settings.quest_funding_fee_bps);
      const inserted = await tx.client.query(
        `INSERT INTO quest_funding_plans(id,quest_id,quest_version,round_number,mode,status,reward_points,fee_bps,fee_points,
          planned_completions,target_points,starts_at,ends_at,created_by,is_test)
         VALUES($1,$2,$3,$4,$5,'draft',$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
        [randomUUID(), questId, quest.version, round.rows[0].next, terms.mode, quest.reward_points, feeBps,
          feeForReward(quest.reward_points, feeBps), terms.planned_completions,
          targetForCompletions(quest.reward_points, feeBps, terms.planned_completions), terms.starts_at, terms.ends_at, actorId, quest.is_test]);
      await ensurePlanAccounts(tx.client, inserted.rows[0]);
      await tx.client.query('UPDATE quests SET funding_required=TRUE WHERE id=$1', [questId]);
      await setQuestFundingState(tx.client, questId, 'draft');
      return inserted.rows[0];
    });
    await refreshQuestMirror(this.pool, questId);
    return result;
  }

  async update(actorId: string, id: string, terms: PlanTerms & { expected_version: number }, key: string) {
    return fundingCommand(this.pool, actorId, 'funding.update', key, { id, ...terms }, async tx => {
      const plan = await lockPlan(tx.client, id, actorId);
      if (plan.status !== 'draft' || plan.version !== terms.expected_version) throw new FundingError('FUNDING_PLAN_STATE', 409, 'Refresh the draft before editing its terms.');
      const contributed = await tx.client.query('SELECT 1 FROM quest_funding_contributions WHERE plan_id=$1 LIMIT 1', [id]);
      if (contributed.rows.length && terms.mode !== plan.mode) throw new FundingError('FUNDING_PLAN_STATE', 409, 'Cancel and recreate a funded draft to change its funding model.');
      const settings = await fundingSettings(tx.client);
      validateWindow(terms, settings);
      const updated = await tx.client.query(
        `UPDATE quest_funding_plans SET mode=$2,planned_completions=$3,target_points=$4,starts_at=$5,ends_at=$6,version=version+1,updated_at=NOW()
         WHERE id=$1 RETURNING *`, [id, terms.mode, terms.planned_completions,
          targetForCompletions(plan.reward_points, plan.fee_bps, terms.planned_completions), terms.starts_at, terms.ends_at]);
      return updated.rows[0];
    });
  }

  async contribute(actorId: string, id: string, points: number, key: string) {
    if (!Number.isSafeInteger(points) || points <= 0 || points > 1_000_000_000) throw new FundingError('INVALID_AMOUNT', 400, 'Contribution must be a positive supported point amount.');
    const result = await fundingCommand(this.pool, actorId, 'funding.self_contribute', key, { id, points }, async tx => {
      const plan = await lockPlan(tx.client, id, actorId);
      if (!['draft', 'pending_sponsors', 'active'].includes(plan.status)) throw new FundingError('FUNDING_PLAN_STATE', 409, 'This round cannot accept a contribution.');
      const existing = await tx.client.query("SELECT * FROM quest_funding_contributions WHERE plan_id=$1 AND funder_kind='author' ORDER BY id FOR UPDATE", [id]);
      const balance = await tx.client.query('SELECT demo_points FROM users WHERE id=$1', [actorId]);
      const previous = Number(existing.rows[0]?.remaining_points ?? 0);
      if (Number(balance.rows[0]?.demo_points ?? 0) < points + (plan.mode === 'window' ? previous : 0)) throw new FundingError('INSUFFICIENT_POINTS', 409, 'Your available points do not cover this contribution.');
      if (plan.mode === 'budget') await tx.transfer({ from: { id: actorId, userId: actorId, kind: 'traveler' },
        to: { id: `quest_budget:${id}`, kind: 'quest_budget' }, points, type: 'quest_fund_lock',
        referenceType: 'quest_funding_plan', referenceId: id, actorId, idempotencyKey: key });
      if (existing.rows[0]) await tx.client.query('UPDATE quest_funding_contributions SET committed_points=committed_points+$2,remaining_points=remaining_points+$2,updated_at=NOW() WHERE id=$1', [existing.rows[0].id, points]);
      else await tx.client.query("INSERT INTO quest_funding_contributions(id,plan_id,funder_kind,funder_user_id,committed_points,remaining_points,is_test) VALUES($1,$2,'author',$3,$4,$4,$5)", [randomUUID(), id, actorId, points, plan.is_test]);
      const updated = plan.status === 'pending_sponsors' ? await activateIfFunded(tx, plan) : plan;
      return { plan: updated, contributed_points: points };
    });
    await refreshQuestMirror(this.pool, result.plan.quest_id);
    return result;
  }

  async submit(actorId: string, id: string, key: string) {
    const result = await fundingCommand(this.pool, actorId, 'funding.submit', key, { id }, async tx => {
      const plan = await lockPlan(tx.client, id, actorId);
      if (plan.status !== 'draft') throw new FundingError('FUNDING_PLAN_STATE', 409, 'Only a draft funding plan can be submitted.');
      if (new Date(plan.ends_at).getTime() <= Date.now()) throw new FundingError('FUNDING_WINDOW_INVALID', 409, 'The funding window has ended.');
      const settings = await fundingSettings(tx.client);
      const fee = Number(settings.quest_funding_fee_bps);
      const submitted = await tx.client.query(
        `UPDATE quest_funding_plans SET status='pending_sponsors',fee_bps=$2,fee_points=$3,target_points=$4,
          hold_ttl_hours=$5,sponsorship_deadline_days=$6,sponsorship_deadline=NOW()+($6::int * INTERVAL '1 day'),
          version=version+1,updated_at=NOW() WHERE id=$1 RETURNING *`,
        [id, fee, feeForReward(plan.reward_points, fee), targetForCompletions(plan.reward_points, fee, plan.planned_completions),
          settings.funding_hold_ttl_hours, settings.sponsorship_deadline_days]);
      return activateIfFunded(tx, submitted.rows[0]);
    });
    await refreshQuestMirror(this.pool, result.quest_id);
    return result;
  }

  async close(actorId: string, id: string, key: string, admin = false) {
    const result = await fundingCommand(this.pool, actorId, 'funding.close', key, { id, admin }, async tx => {
      const plan = await lockPlan(tx.client, id, actorId, admin);
      if (!['active', 'closing'].includes(plan.status)) throw new FundingError('FUNDING_PLAN_STATE', 409, 'Only an active round can close.');
      await tx.client.query("UPDATE quest_funding_plans SET status='closing',close_reason=$2,closing_at=COALESCE(closing_at,NOW()),version=version+1,updated_at=NOW() WHERE id=$1", [id, admin ? 'admin_closed' : 'author_closed']);
      await setQuestFundingState(tx.client, plan.quest_id, 'closing');
      await finalizePlan(tx, plan, actorId);
      return (await tx.client.query('SELECT * FROM quest_funding_plans WHERE id=$1', [id])).rows[0];
    });
    await refreshQuestMirror(this.pool, result.quest_id);
    return result;
  }

  async cancel(actorId: string, id: string, key: string) {
    const result = await fundingCommand(this.pool, actorId, 'funding.cancel', key, { id }, async tx => {
      const plan = await lockPlan(tx.client, id, actorId);
      if (!['draft', 'pending_sponsors', 'scheduled'].includes(plan.status)) throw new FundingError('FUNDING_PLAN_STATE', 409, 'An active round must be closed instead.');
      await finalizePlan(tx, plan, actorId, 'cancelled');
      return (await tx.client.query('SELECT * FROM quest_funding_plans WHERE id=$1', [id])).rows[0];
    });
    await refreshQuestMirror(this.pool, result.quest_id);
    return result;
  }

  async extend(actorId: string, id: string, endsAt: string, key: string) {
    return fundingCommand(this.pool, actorId, 'funding.extend', key, { id, endsAt }, async tx => {
      const plan = await lockPlan(tx.client, id, actorId);
      if (!['active','scheduled'].includes(plan.status) || Date.parse(endsAt) <= new Date(plan.ends_at).getTime()) throw new FundingError('FUNDING_WINDOW_INVALID', 409, 'The new end date must extend an open round.');
      validateWindow({ ...plan, ends_at: endsAt }, await fundingSettings(tx.client));
      return (await tx.client.query('UPDATE quest_funding_plans SET ends_at=$2,version=version+1,updated_at=NOW() WHERE id=$1 RETURNING *', [id, endsAt])).rows[0];
    });
  }

  async get(actorId: string, id: string, admin = false) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      const plan = await lockPlan(client, id, actorId, admin);
      const contributions = await client.query('SELECT * FROM quest_funding_contributions WHERE plan_id=$1 ORDER BY created_at,id', [id]);
      const holds = await client.query('SELECT * FROM quest_funding_holds WHERE plan_id=$1 ORDER BY created_at DESC LIMIT 200', [id]);
      const sponsorships = await client.query('SELECT * FROM quest_sponsorships WHERE plan_id=$1 ORDER BY created_at,id', [id]);
      await client.query('COMMIT');
      return { ...plan, contributions: contributions.rows, holds: holds.rows, sponsorships: sponsorships.rows, simulated: true };
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }

  async latestForQuest(actorId:string,questId:string,admin=false){
    const quest=(await this.pool.query('SELECT author_id,is_test FROM quests WHERE id=$1',[questId])).rows[0];
    if(!quest)throw new FundingError('NOT_FOUND',404,'Quest not found.');
    const actor=(await this.pool.query('SELECT is_test FROM users WHERE id=$1',[actorId])).rows[0];
    if(!admin&&(!actor||quest.author_id!==actorId||Boolean(actor.is_test)!==Boolean(quest.is_test)))throw new FundingError('QUEST_NOT_DESTINATION_AUTHOR',403,'Only this quest author may view its funding plans.');
    const plan=(await this.pool.query('SELECT id FROM quest_funding_plans WHERE quest_id=$1 ORDER BY round_number DESC LIMIT 1',[questId])).rows[0];
    if(!plan)return {plan:null};
    return {plan:await this.get(actorId,plan.id,admin)};
  }
}
