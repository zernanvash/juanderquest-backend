import { randomUUID } from 'crypto';
import type { Pool, PoolClient } from 'pg';
import { env } from '../config/env.js';
import { db } from '../db/index.js';
import { lockGovernanceSnapshot, commitGovernanceTransaction } from '../governance/transaction.js';
import { hasCompletedQuest } from '../services/quest-completion.js';
import { allocatePoints } from './allocate.js';
import { FundingError, fundingCommand, fundingTx, publishFunding, type FundingTx } from './transaction.js';
import { ensurePlanAccounts, finalizePlan, funderAccount, lockPlan, refreshQuestMirror, setQuestFundingState } from './plans.js';

export async function hasFundingPlan(client: Pick<PoolClient, 'query'>, questId: string): Promise<boolean> {
  return (await client.query('SELECT 1 FROM quest_funding_plans WHERE quest_id=$1 LIMIT 1', [questId])).rows.length > 0;
}

export async function requireFundingHold(client: Pick<PoolClient, 'query'>, userId: string, questId: string) {
  if (!await hasFundingPlan(client, questId)) {
    const quest = await client.query('SELECT funding_required FROM quests WHERE id=$1', [questId]);
    if (quest.rows[0]?.funding_required) throw new FundingError('FUNDED_ATTEMPT_REQUIRED', 409, 'This Eco-Quest has not secured funding yet.');
    return;
  }
  const held = await client.query(
    `SELECT h.id FROM quest_funding_holds h JOIN quest_funding_plans p ON p.id=h.plan_id
     JOIN quest_attempts a ON a.id=h.attempt_id WHERE p.quest_id=$1 AND h.user_id=$2 AND h.status='held'
       AND (h.expires_at>clock_timestamp() OR a.status='submitted') LIMIT 1`, [questId, userId]);
  if (!held.rows[0]) throw new FundingError('FUNDED_ATTEMPT_REQUIRED', 409, 'Accept this Eco-Quest to reserve its reward before submitting proof.');
}

async function hasPendingReview(client: PoolClient, hold: any, questId: string) {
  const pending = await client.query(
    `SELECT 1 FROM quest_attempts WHERE id=$1 AND status='submitted'
     UNION ALL SELECT 1 FROM submissions WHERE user_id=$2 AND quest_id=$3 AND status='pending' LIMIT 1`,
    [hold.attempt_id, hold.user_id, questId]);
  return pending.rows.length > 0;
}

export async function releaseFundingHold(tx: FundingTx, hold: any, plan: any, actorId: string, reason: string) {
  if (hold.status !== 'held') return;
  const allocations = await tx.client.query(
    `SELECT c.*, a.reward_part, a.fee_part FROM quest_funding_hold_allocations a
     JOIN quest_funding_contributions c ON c.id=a.contribution_id WHERE a.hold_id=$1 ORDER BY c.id FOR UPDATE OF c`, [hold.id]);
  for (const row of allocations.rows) {
    const points = Number(row.reward_part) + Number(row.fee_part);
    if (points > 0) await tx.transfer({ from: { id: `quest_hold:${plan.id}`, kind: 'quest_hold' },
      to: plan.mode === 'budget' ? { id: `quest_budget:${plan.id}`, kind: 'quest_budget' } : funderAccount(row),
      points, type: 'quest_fund_release', referenceType: 'quest_funding_hold', referenceId: hold.id, actorId,
      metadata: { contribution_id: row.id, reason } });
    await tx.client.query('UPDATE quest_funding_contributions SET held_points=held_points-$2,remaining_points=remaining_points+$2,updated_at=NOW() WHERE id=$1', [row.id, points]);
  }
  await tx.client.query("UPDATE quest_funding_holds SET status='released',released_at=NOW(),release_reason=$2 WHERE id=$1", [hold.id, reason]);
  await tx.client.query("UPDATE quest_attempts SET status='abandoned',updated_at=NOW() WHERE id=$1 AND status='in_progress'", [hold.attempt_id]);
}

export async function startFundedAttempt(pool: Pool, questId: string, userId: string) {
  if (!await hasFundingPlan(pool, questId)) {
    const quest = await pool.query('SELECT funding_required FROM quests WHERE id=$1', [questId]);
    if (quest.rows[0]?.funding_required) throw new FundingError('FUNDING_PLAN_REQUIRED', 409, 'This Eco-Quest needs funding before travelers can start.');
    return null;
  }
  if (!env.QUEST_FUNDING_ENABLED) throw new FundingError('QUEST_FUNDING_UNAVAILABLE', 503, 'Funded quest starts are temporarily unavailable.');
  const client = await pool.connect();
  const tx = fundingTx(client);
  let committed = false;
  try {
    await client.query('BEGIN');
    await lockGovernanceSnapshot(client);
    const latest = await client.query('SELECT id FROM quest_funding_plans WHERE quest_id=$1 ORDER BY round_number DESC LIMIT 1', [questId]);
    const plan = await lockPlan(client, latest.rows[0].id);
    const quest = (await client.query('SELECT * FROM quests WHERE id=$1', [questId])).rows[0];
    const user = (await client.query('SELECT id,is_test FROM users WHERE id=$1', [userId])).rows[0];
    if (!user || Boolean(user.is_test) !== Boolean(plan.is_test)) throw new FundingError('SCOPE_MISMATCH', 403, 'Traveler and quest scopes do not match.');
    if (quest.author_id === userId) throw new FundingError('CREATOR_SELF_ATTEMPT', 403, 'Authors cannot earn rewards from their own quest.');
    if (await hasCompletedQuest(db, userId, questId, client)) throw new FundingError('ALREADY_COMPLETED', 409, 'You have already completed this quest.');
    const sponsorOwner = await client.query(
      `SELECT 1 FROM quest_sponsorships s JOIN merchant_memberships m ON m.merchant_id=s.merchant_id
       WHERE s.plan_id=$1 AND s.status='accepted' AND m.user_id=$2 AND m.role='owner' AND m.status='active' LIMIT 1`, [plan.id, userId]);
    if (sponsorOwner.rows.length) throw new FundingError('SPONSOR_SELF_ATTEMPT', 403, 'Merchant owners cannot earn rewards from a quest they sponsor.');
    const previous = await client.query(
      `SELECT h.*, a.status AS attempt_status FROM quest_funding_holds h JOIN quest_attempts a ON a.id=h.attempt_id
       WHERE h.plan_id=$1 AND h.user_id=$2 AND h.status='held' FOR UPDATE OF h`, [plan.id, userId]);
    if (previous.rows[0]) {
      const hold = previous.rows[0];
      if (new Date(hold.expires_at).getTime() > Date.now() || await hasPendingReview(client, hold, questId)) {
        const attempt = (await client.query('SELECT * FROM quest_attempts WHERE id=$1', [hold.attempt_id])).rows[0];
        await commitGovernanceTransaction(client); committed = true;
        return { attempt, funding_hold: hold, resumed: true };
      }
      await releaseFundingHold(tx, hold, plan, userId, 'expired');
    }
    if (plan.status !== 'active' || new Date(plan.starts_at).getTime() > Date.now() || new Date(plan.ends_at).getTime() <= Date.now()) {
      throw new FundingError('QUEST_NOT_OPEN', 409, 'This funding round is not open for new attempts.');
    }
    if (plan.quest_version !== quest.version) throw new FundingError('FUNDING_PLAN_STATE', 409, 'The quest changed after funding was agreed.');
    const contributions = await client.query('SELECT * FROM quest_funding_contributions WHERE plan_id=$1 ORDER BY id FOR UPDATE', [plan.id]);
    const capacities = [];
    for (const contribution of contributions.rows) {
      if (Boolean(contribution.is_test) !== Boolean(plan.is_test)) throw new FundingError('SCOPE_MISMATCH', 409, 'Contribution scope does not match.');
      let available = Number(contribution.remaining_points);
      if (plan.mode === 'window') {
        if (contribution.funder_kind === 'author') {
          const live = await client.query('SELECT demo_points,is_test FROM users WHERE id=$1', [contribution.funder_user_id]);
          if (!live.rows[0] || Boolean(live.rows[0].is_test) !== Boolean(plan.is_test)) throw new FundingError('SCOPE_MISMATCH', 409, 'Funder scope does not match.');
          available = Math.min(available, Number(live.rows[0].demo_points));
        } else {
          const live = await client.query('SELECT balance_points,is_test FROM points_accounts WHERE id=$1', [`merchant:${contribution.merchant_id}`]);
          if (!live.rows[0] || Boolean(live.rows[0].is_test) !== Boolean(plan.is_test)) throw new FundingError('SCOPE_MISMATCH', 409, 'Merchant account scope does not match.');
          available = Math.min(available, Number(live.rows[0].balance_points));
        }
      }
      capacities.push({ contributionId: contribution.id, availablePoints: available, createdAt: contribution.created_at });
    }
    const cost = Number(plan.reward_points) + Number(plan.fee_points);
    if (capacities.reduce((sum, row) => sum + row.availablePoints, 0) < cost) {
      if (plan.mode === 'budget') {
        await client.query("UPDATE quest_funding_plans SET status='closing',close_reason='budget_exhausted',closing_at=NOW(),updated_at=NOW() WHERE id=$1", [plan.id]);
        await setQuestFundingState(client, questId, 'closing');
        await finalizePlan(tx, plan, userId);
        await commitGovernanceTransaction(client); committed = true; publishFunding(tx.groups);
        await refreshQuestMirror(pool, questId);
      }
      throw new FundingError(plan.mode === 'budget' ? 'QUEST_BUDGET_EXHAUSTED' : 'QUEST_FUNDING_UNAVAILABLE', 409, 'The funders cannot cover another reward reservation.');
    }
    const allocated = allocatePoints(cost, capacities);
    const feeParts = new Map(allocatePoints(Number(plan.fee_points), allocated.map(row => ({ ...row, availablePoints: row.points }))).map(row => [row.contributionId, row.points]));
    await ensurePlanAccounts(client, plan);
    await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [userId]);
    const steps = Array.isArray(quest.steps) && quest.steps.length ? quest.steps : [
      { step_order: 1, title: 'Destination check-in', description: 'Submit location proof for review.', checkpoint_type: 'location', required: true }];
    const attemptId = `attempt_${randomUUID()}`;
    const attempt = (await client.query(
      `INSERT INTO quest_attempts(id,quest_id,user_id,version,current_step,total_steps,status,steps_snapshot,verified_steps,required_steps)
       VALUES($1,$2,$3,$4,1,$5,'in_progress',$6::jsonb,0,$7) RETURNING *`,
      [attemptId, questId, userId, quest.version, steps.length, JSON.stringify(steps), steps.filter((s: any) => s.required !== false).length])).rows[0];
    for (const step of steps) await client.query(
      `INSERT INTO quest_step_evidence(id,attempt_id,quest_id,user_id,step_order,checkpoint_type,status,required,title,description)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [randomUUID(), attemptId, questId, userId, step.step_order, step.checkpoint_type, step.step_order === 1 ? 'ready' : 'not_started', step.required !== false, step.title, step.description ?? null]);
    const hold = (await client.query(
      `INSERT INTO quest_funding_holds(id,plan_id,attempt_id,user_id,reward_points,fee_points,status,expires_at)
       VALUES($1,$2,$3,$4,$5,$6,'held',LEAST(NOW()+($7::int*INTERVAL '1 hour'),$8::timestamptz+INTERVAL '24 hours')) RETURNING *`,
      [randomUUID(), plan.id, attemptId, userId, plan.reward_points, plan.fee_points, plan.hold_ttl_hours, plan.ends_at])).rows[0];
    if (plan.mode === 'budget') await tx.transfer({ from: { id: `quest_budget:${plan.id}`, kind: 'quest_budget' },
      to: { id: `quest_hold:${plan.id}`, kind: 'quest_hold' }, points: cost, type: 'quest_fund_hold', referenceType: 'quest_funding_hold', referenceId: hold.id, actorId: userId });
    for (const row of allocated) {
      const contribution = contributions.rows.find(c => c.id === row.contributionId);
      if (row.points > 0 && plan.mode === 'window') await tx.transfer({ from: funderAccount(contribution), to: { id: `quest_hold:${plan.id}`, kind: 'quest_hold' },
        points: row.points, type: 'quest_fund_hold', referenceType: 'quest_funding_hold', referenceId: hold.id, actorId: userId });
      const fee = feeParts.get(row.contributionId) ?? 0;
      await client.query('INSERT INTO quest_funding_hold_allocations(hold_id,contribution_id,reward_part,fee_part) VALUES($1,$2,$3,$4)', [hold.id, row.contributionId, row.points-fee, fee]);
      await client.query('UPDATE quest_funding_contributions SET remaining_points=remaining_points-$2,held_points=held_points+$2,updated_at=NOW() WHERE id=$1', [row.contributionId, row.points]);
    }
    if (plan.mode === 'budget' && capacities.reduce((sum, row) => sum + row.availablePoints, 0) - cost < cost) {
      await client.query("UPDATE quest_funding_plans SET status='closing',close_reason='budget_exhausted',closing_at=NOW(),version=version+1,updated_at=NOW() WHERE id=$1", [plan.id]);
      await setQuestFundingState(client, questId, 'closing');
    }
    await commitGovernanceTransaction(client); committed = true; publishFunding(tx.groups);
    await refreshQuestMirror(pool, questId);
    return { attempt, funding_hold: hold, resumed: false };
  } catch (error) { if (!committed) await client.query('ROLLBACK').catch(() => undefined); throw error; }
  finally { client.release(); }
}

export async function settleFundingHold(client: PoolClient, userId: string, questId: string, referenceId: string, actorId: string) {
  if (!await hasFundingPlan(client, questId)) return null;
  const candidate = await client.query(
    `SELECT h.id,h.plan_id FROM quest_funding_holds h JOIN quest_funding_plans p ON p.id=h.plan_id
     WHERE p.quest_id=$1 AND h.user_id=$2 AND h.status='held' ORDER BY h.created_at DESC LIMIT 1`, [questId, userId]);
  if (!candidate.rows[0]) throw new FundingError('FUNDED_ATTEMPT_REQUIRED', 409, 'No reserved reward is available for this completion.');
  const tx = fundingTx(client);
  const plan = await lockPlan(client, candidate.rows[0].plan_id);
  const hold = (await client.query('SELECT * FROM quest_funding_holds WHERE id=$1 FOR UPDATE', [candidate.rows[0].id])).rows[0];
  const submitted = await client.query(
    `SELECT 1 FROM quest_attempts WHERE id=$1 AND status='submitted'
     UNION ALL SELECT 1 FROM submissions WHERE id=$2 AND user_id=$3 AND quest_id=$4 AND created_at<=$5::timestamptz AND status IN ('pending','approved') LIMIT 1`,
    [hold.attempt_id, referenceId, userId, questId, hold.expires_at]);
  if (new Date(hold.expires_at).getTime() <= Date.now() && !submitted.rows.length) throw new FundingError('FUNDING_HOLD_EXPIRED', 409, 'This reward reservation expired before submission.');
  const allocations = await client.query(
    `SELECT a.*,c.is_test FROM quest_funding_hold_allocations a JOIN quest_funding_contributions c ON c.id=a.contribution_id
     WHERE a.hold_id=$1 ORDER BY c.id FOR UPDATE OF c`, [hold.id]);
  for (const row of allocations.rows) {
    if (Boolean(row.is_test) !== Boolean(plan.is_test)) throw new FundingError('SCOPE_MISMATCH', 409, 'Contribution scope does not match.');
    await client.query('UPDATE quest_funding_contributions SET held_points=held_points-$2-$3,paid_reward_points=paid_reward_points+$2,paid_fee_points=paid_fee_points+$3,updated_at=NOW() WHERE id=$1', [row.contribution_id, row.reward_part, row.fee_part]);
  }
  const rewardGroup = await tx.transfer({ from: { id: `quest_hold:${plan.id}`, kind: 'quest_hold' }, to: { id: userId, userId, kind: 'traveler' },
    points: Number(hold.reward_points), type: 'quest_reward_paid', referenceType: 'quest_funding_hold', referenceId: hold.id, actorId,
    metadata: { quest_id: questId, completion_reference: referenceId } });
  if (Number(hold.fee_points) > 0) await tx.transfer({ from: { id: `quest_hold:${plan.id}`, kind: 'quest_hold' }, to: { id: plan.is_test ? 'treasury:test' : 'treasury', kind: 'treasury' },
    points: Number(hold.fee_points), type: 'quest_fee', referenceType: 'quest_funding_hold', referenceId: hold.id, actorId });
  await client.query("UPDATE quest_funding_holds SET status='paid',settled_at=NOW() WHERE id=$1", [hold.id]);
  await client.query("UPDATE quest_attempts SET status='completed',completed_at=NOW(),updated_at=NOW() WHERE id=$1", [hold.attempt_id]);
  if (plan.status === 'closing') await finalizePlan(tx, plan, actorId);
  return { awardedPoints: Number(hold.reward_points), newPoints: rewardGroup.userBalanceUpdate!.demoPoints, fundedGroups: tx.groups, fundingHoldId: hold.id, fundedAttemptId: hold.attempt_id };
}

export async function abandonFundedAttempt(pool: Pool, questId: string, attemptId: string, userId: string, key: string) {
  return fundingCommand(pool,userId,'funding.abandon',key,{questId,attemptId},async tx => {
    const existing = await tx.client.query('SELECT h.*,p.quest_id FROM quest_funding_holds h JOIN quest_funding_plans p ON p.id=h.plan_id WHERE h.attempt_id=$1 AND h.user_id=$2 AND p.quest_id=$3', [attemptId,userId,questId]);
    const hold = existing.rows[0];
    if (!hold) throw new FundingError('NOT_FOUND',404,'Reward reservation not found.');
    const plan = await lockPlan(tx.client,hold.plan_id);
    if (hold.status !== 'held') throw new FundingError('FUNDING_PLAN_STATE',409,'This reward reservation has already resolved.');
    if (await hasPendingReview(tx.client,hold,questId)) throw new FundingError('SUBMISSION_PENDING',409,'Wait for the pending review before abandoning this attempt.');
    await releaseFundingHold(tx,hold,plan,userId,'traveler_abandoned');
    if (plan.status === 'closing') await finalizePlan(tx,plan,userId);
    return { attempt_id: attemptId, status: 'abandoned', released_points: Number(hold.reward_points)+Number(hold.fee_points) };
  });
}
