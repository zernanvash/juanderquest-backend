import { randomUUID } from 'crypto';
import type { Pool, PoolClient } from 'pg';
import { MJDQ_PER_JDQ } from '../governance/store.js';
import { OPEN_PLAN_STATES, finalizePlan, lockPlan, refreshQuestMirror } from './plans.js';
import { releaseFundingHold } from './holds.js';
import { FundingError, fundingCommand } from './transaction.js';

export interface AdminActor {
  id: string;
  role: string;
}

async function recordAdminAudit(
  client: Pick<PoolClient, 'query'>,
  actor: AdminActor,
  entry: {
    action: string;
    subjectType: string;
    subjectId: string;
    areaId?: string | null;
    before?: unknown;
    after?: unknown;
  },
) {
  await client.query(
    `INSERT INTO admin_audit_log(id, actor_id, actor_role, area_id, action, subject_type, subject_id, before, after)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb)`,
    [
      randomUUID(),
      actor.id,
      actor.role,
      entry.areaId ?? null,
      entry.action,
      entry.subjectType,
      entry.subjectId,
      entry.before === undefined ? null : JSON.stringify(entry.before),
      entry.after === undefined ? null : JSON.stringify(entry.after),
    ],
  );
}

export async function getPlanTreasury(pool: Pool, planId: string) {
  const planRes = await pool.query(
    `SELECT id, quest_id, mode, status, target_points, reward_points, fee_points, is_test
       FROM quest_funding_plans WHERE id = $1`,
    [planId],
  );
  const plan = planRes.rows[0];
  if (!plan) throw new FundingError('NOT_FOUND', 404, 'Funding plan not found.');

  const [contribRes, holdsRes, accountsRes] = await Promise.all([
    pool.query(
      `SELECT c.id, c.funder_kind, c.funder_user_id, c.merchant_id, c.committed_points,
              c.remaining_points, c.held_points, c.paid_reward_points, c.paid_fee_points, c.refunded_points,
              u.display_name AS author_display_name, m.name AS merchant_name
         FROM quest_funding_contributions c
         LEFT JOIN users u ON u.id = c.funder_user_id
         LEFT JOIN merchants m ON m.id = c.merchant_id
        WHERE c.plan_id = $1
        ORDER BY c.created_at, c.id`,
      [planId],
    ),
    pool.query(
      `SELECT COUNT(*)::int AS live_count,
              COALESCE(SUM(reward_points + fee_points), 0)::bigint AS live_points
         FROM quest_funding_holds
        WHERE plan_id = $1 AND status = 'held'`,
      [planId],
    ),
    pool.query(
      `SELECT id, kind, balance_points
         FROM points_accounts
        WHERE plan_id = $1
        ORDER BY kind, id`,
      [planId],
    ),
  ]);

  let committed = 0;
  let available = 0;
  let held = 0;
  let paidRewards = 0;
  let paidFees = 0;
  let refunded = 0;
  let mismatches = 0;

  const contributions = contribRes.rows.map((row: any) => {
    const cCommitted = Number(row.committed_points);
    const cRemaining = Number(row.remaining_points);
    const cHeld = Number(row.held_points);
    const cPaidReward = Number(row.paid_reward_points);
    const cPaidFee = Number(row.paid_fee_points);
    const cRefunded = Number(row.refunded_points);
    const accounted = cRemaining + cHeld + cPaidReward + cPaidFee + cRefunded;
    const ok = cCommitted === accounted;
    if (!ok) mismatches += 1;
    committed += cCommitted;
    available += cRemaining;
    held += cHeld;
    paidRewards += cPaidReward;
    paidFees += cPaidFee;
    refunded += cRefunded;
    return {
      id: row.id,
      funder_kind: row.funder_kind,
      funder_name:
        row.funder_kind === 'merchant'
          ? row.merchant_name || row.merchant_id
          : row.author_display_name || row.funder_user_id,
      committed_points: cCommitted,
      remaining_points: cRemaining,
      held_points: cHeld,
      paid_reward_points: cPaidReward,
      paid_fee_points: cPaidFee,
      refunded_points: cRefunded,
      accounted_points: accounted,
      ok,
    };
  });

  const liveHoldsCount = Number(holdsRes.rows[0]?.live_count ?? 0);
  const liveHoldsPoints = Number(holdsRes.rows[0]?.live_points ?? 0);

  return {
    plan_id: plan.id,
    quest_id: plan.quest_id,
    mode: plan.mode,
    status: plan.status,
    is_test: Boolean(plan.is_test),
    target_points: Number(plan.target_points),
    committed_points: committed,
    available_points: available,
    held_points: held,
    paid_reward_points: paidRewards,
    paid_fee_points: paidFees,
    refunded_points: refunded,
    live_holds_count: liveHoldsCount,
    live_holds_points: liveHoldsPoints,
    accounts: accountsRes.rows.map((a: any) => ({
      id: a.id,
      kind: a.kind,
      balance_points: Number(a.balance_points),
    })),
    reconciliation: {
      ok: mismatches === 0,
      mismatches,
      contributions,
    },
    simulated: true,
  };
}

export async function getPlanTransactions(pool: Pool, planId: string, typeFilter?: string | null) {
  const planRes = await pool.query('SELECT id FROM quest_funding_plans WHERE id = $1', [planId]);
  if (!planRes.rows[0]) throw new FundingError('NOT_FOUND', 404, 'Funding plan not found.');

  const [sponsorshipsRes, holdsRes] = await Promise.all([
    pool.query('SELECT id FROM quest_sponsorships WHERE plan_id = $1', [planId]),
    pool.query('SELECT id FROM quest_funding_holds WHERE plan_id = $1', [planId]),
  ]);

  const planAccounts = [`quest_budget:${planId}`, `quest_hold:${planId}`];
  const sponsorshipIds = sponsorshipsRes.rows.map((r: any) => String(r.id));
  const holdIds = holdsRes.rows.map((r: any) => String(r.id));

  const groupRows = await pool.query(
    `SELECT DISTINCT transaction_group_id
       FROM governance_ledger
      WHERE account = ANY($1::text[])
         OR (reference_type = 'quest_funding_plan' AND reference_id = $2)
         OR (reference_type = 'quest_sponsorship' AND reference_id = ANY($3::text[]))
         OR (reference_type = 'quest_funding_hold' AND reference_id = ANY($4::text[]))`,
    [planAccounts, planId, sponsorshipIds, holdIds],
  );

  const groupIds = groupRows.rows.map((r: any) => String(r.transaction_group_id));
  if (!groupIds.length) return { plan_id: planId, items: [], simulated: true };

  const ledgerRows = await pool.query(
    `SELECT id, transaction_group_id, type, account, amount_mjdq, reference_type, reference_id, actor_id, metadata, created_at
       FROM governance_ledger
      WHERE transaction_group_id = ANY($1::text[])
        AND ($2::text IS NULL OR type = $2)
      ORDER BY created_at DESC, id`,
    [groupIds, typeFilter || null],
  );

  const byGroup = new Map<string, any[]>();
  for (const row of ledgerRows.rows) {
    const list = byGroup.get(row.transaction_group_id) ?? [];
    list.push(row);
    byGroup.set(row.transaction_group_id, list);
  }

  const items = [...byGroup.entries()].map(([groupId, rows]) => {
    const debit = rows.find((r) => Number(r.amount_mjdq) < 0);
    const credit = rows.find((r) => Number(r.amount_mjdq) > 0);
    const sample = credit ?? debit ?? rows[0];
    const amountMjdq = Math.abs(Number(sample.amount_mjdq));
    return {
      transaction_group_id: groupId,
      type: sample.type,
      points: Math.round(amountMjdq / MJDQ_PER_JDQ),
      amount_mjdq: amountMjdq,
      from_account: debit?.account ?? 'unknown',
      to_account: credit?.account ?? 'unknown',
      reference_type: sample.reference_type,
      reference_id: sample.reference_id,
      actor_id: sample.actor_id,
      metadata: sample.metadata ?? null,
      created_at: new Date(sample.created_at).toISOString(),
    };
  });

  items.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  return { plan_id: planId, items, simulated: true };
}

export async function setPlanHoldsPaused(
  pool: Pool,
  actor: AdminActor,
  planId: string,
  paused: boolean,
  reason: string | undefined,
  key: string,
) {
  return fundingCommand(
    pool,
    actor.id,
    paused ? 'funding.pause_holds' : 'funding.resume_holds',
    key,
    { planId, paused, reason: reason ?? null },
    async (tx) => {
      const before = await lockPlan(tx.client, planId, actor.id, true);
      if (!['active', 'closing', 'scheduled', 'pending_sponsors'].includes(before.status)) {
        throw new FundingError('FUNDING_PLAN_STATE', 409, 'Cannot change hold state on a finalized funding round.');
      }
      const updated = (
        await tx.client.query(
          `UPDATE quest_funding_plans
              SET holds_paused = $2,
                  holds_paused_reason = $3,
                  holds_paused_at = CASE WHEN $2 THEN NOW() ELSE NULL END,
                  version = version + 1,
                  updated_at = NOW()
            WHERE id = $1 RETURNING *`,
          [planId, paused, paused ? (reason?.trim() ?? null) : null],
        )
      ).rows[0];
      await recordAdminAudit(tx.client, actor, {
        action: paused ? 'funding_plan.holds_paused' : 'funding_plan.holds_resumed',
        subjectType: 'quest_funding_plan',
        subjectId: planId,
        before: { holds_paused: Boolean(before.holds_paused), holds_paused_reason: before.holds_paused_reason ?? null },
        after: { holds_paused: paused, holds_paused_reason: updated.holds_paused_reason ?? null },
      });
      return updated;
    },
  );
}

export async function setPlanFlagged(
  pool: Pool,
  actor: AdminActor,
  planId: string,
  flagged: boolean,
  note: string,
  key: string,
) {
  return fundingCommand(pool, actor.id, 'funding.flag', key, { planId, flagged, note }, async (tx) => {
    const before = await lockPlan(tx.client, planId, actor.id, true);
    const updated = (
      await tx.client.query(
        `UPDATE quest_funding_plans
              SET admin_flagged = $2,
                  admin_flag_note = $3,
                  admin_flagged_at = CASE WHEN $2 THEN NOW() ELSE NULL END,
                  admin_flagged_by = CASE WHEN $2 THEN $4 ELSE NULL END,
                  version = version + 1,
                  updated_at = NOW()
            WHERE id = $1 RETURNING *`,
        [planId, flagged, flagged ? note.trim() : null, actor.id],
      )
    ).rows[0];
    await recordAdminAudit(tx.client, actor, {
      action: flagged ? 'funding_plan.flagged' : 'funding_plan.unflagged',
      subjectType: 'quest_funding_plan',
      subjectId: planId,
      before: { admin_flagged: Boolean(before.admin_flagged), admin_flag_note: before.admin_flag_note ?? null },
      after: { admin_flagged: flagged, admin_flag_note: updated.admin_flag_note ?? null },
    });
    return updated;
  });
}

export async function releaseStuckHold(
  pool: Pool,
  actor: AdminActor,
  holdId: string,
  reason: string | undefined,
  key: string,
) {
  let questId: string | null = null;
  const result = await fundingCommand(
    pool,
    actor.id,
    'funding.admin_release_hold',
    key,
    { holdId, reason: reason ?? null },
    async (tx) => {
      const holdRes = await tx.client.query('SELECT * FROM quest_funding_holds WHERE id = $1 FOR UPDATE', [holdId]);
      const hold = holdRes.rows[0];
      if (!hold) throw new FundingError('NOT_FOUND', 404, 'Funding hold not found.');
      if (hold.status !== 'held') {
        throw new FundingError('FUNDING_PLAN_STATE', 409, 'This reward reservation has already resolved.');
      }
      const plan = await lockPlan(tx.client, hold.plan_id, actor.id, true);
      questId = plan.quest_id;

      const [attemptRes, pendingSubRes] = await Promise.all([
        tx.client.query('SELECT status FROM quest_attempts WHERE id = $1', [hold.attempt_id]),
        tx.client.query("SELECT 1 FROM submissions WHERE user_id=$1 AND quest_id=$2 AND status='pending' LIMIT 1", [
          hold.user_id,
          plan.quest_id,
        ]),
      ]);
      const attemptStatus = attemptRes.rows[0]?.status ?? null;
      if (attemptStatus === 'submitted' || pendingSubRes.rows.length > 0) {
        throw new FundingError('SUBMISSION_PENDING', 409, 'Cannot release a hold while proof review is pending.');
      }
      const isExpired = new Date(hold.expires_at).getTime() <= Date.now();
      const isOrphaned = !attemptStatus || !['in_progress', 'submitted'].includes(attemptStatus);
      if (!isExpired && !isOrphaned) {
        throw new FundingError('HOLD_NOT_EXPIRED', 409, 'Only expired or orphaned holds can be released.');
      }

      const releaseReason = reason?.trim() || 'admin_released_stuck_hold';
      await releaseFundingHold(tx, hold, plan, actor.id, releaseReason);
      if (plan.status === 'closing') {
        await finalizePlan(tx, plan, actor.id);
      }
      await recordAdminAudit(tx.client, actor, {
        action: 'funding_hold.released',
        subjectType: 'quest_funding_hold',
        subjectId: hold.id,
        before: { status: hold.status, expires_at: hold.expires_at },
        after: { status: 'released', release_reason: releaseReason },
      });
      return {
        hold_id: hold.id,
        plan_id: plan.id,
        status: 'released',
        released_points: Number(hold.reward_points) + Number(hold.fee_points),
      };
    },
  );
  if (questId) await refreshQuestMirror(pool, questId);
  return result;
}

export async function listMerchantFunding(pool: Pool, includeTest = false) {
  const [merchantsRes, balancesRes, creditsRes, contribRes, sponsorshipsRes] = await Promise.all([
    pool.query(
      `SELECT id, name, category, municipality, status, is_published, is_test,
              sponsoring_suspended, sponsoring_suspended_reason, sponsoring_suspended_at, created_at
         FROM merchants
        WHERE ($1::boolean = TRUE OR is_test = FALSE)
        ORDER BY name, id`,
      [includeTest],
    ),
    pool.query("SELECT merchant_id, balance_points FROM points_accounts WHERE kind = 'merchant'"),
    pool.query(
      `SELECT merchant_id,
              COALESCE(SUM(CASE WHEN points > 0 THEN points ELSE 0 END), 0)::bigint AS total_credited,
              MAX(created_at) AS last_credit_at
         FROM merchant_point_credits
        GROUP BY merchant_id`,
    ),
    pool.query(
      `SELECT c.merchant_id,
              COALESCE(SUM(c.committed_points), 0)::bigint AS total_sponsored,
              COUNT(DISTINCT CASE WHEN p.status = ANY($1::text[]) THEN p.id END)::int AS active_rounds,
              MAX(c.updated_at) AS last_contrib_at
         FROM quest_funding_contributions c
         JOIN quest_funding_plans p ON p.id = c.plan_id
        WHERE c.funder_kind = 'merchant' AND c.merchant_id IS NOT NULL
        GROUP BY c.merchant_id`,
      [OPEN_PLAN_STATES],
    ),
    pool.query(
      `SELECT merchant_id, status, accepted_with_unmet, updated_at
         FROM quest_sponsorships`,
    ),
  ]);

  const balanceByMerchant = new Map(balancesRes.rows.map((r: any) => [r.merchant_id, Number(r.balance_points)]));
  const creditByMerchant = new Map(creditsRes.rows.map((r: any) => [r.merchant_id, r]));
  const contribByMerchant = new Map(contribRes.rows.map((r: any) => [r.merchant_id, r]));

  const sponsorshipsByMerchant = new Map<
    string,
    { counts: Record<string, number>; unmetAccepted: number; lastAt: number | null }
  >();
  for (const row of sponsorshipsRes.rows) {
    const entry = sponsorshipsByMerchant.get(row.merchant_id) ?? {
      counts: { requested: 0, countered: 0, accepted: 0, declined: 0, withdrawn: 0, expired: 0 },
      unmetAccepted: 0,
      lastAt: null,
    };
    entry.counts[row.status] = (entry.counts[row.status] ?? 0) + 1;
    if (row.status === 'accepted' && Array.isArray(row.accepted_with_unmet) && row.accepted_with_unmet.length > 0) {
      entry.unmetAccepted += 1;
    }
    const ts = Date.parse(row.updated_at);
    if (Number.isFinite(ts) && (entry.lastAt === null || ts > entry.lastAt)) entry.lastAt = ts;
    sponsorshipsByMerchant.set(row.merchant_id, entry);
  }

  return merchantsRes.rows.map((m: any) => {
    const credit = creditByMerchant.get(m.id);
    const contrib = contribByMerchant.get(m.id);
    const sp = sponsorshipsByMerchant.get(m.id);
    const timestamps = [
      credit?.last_credit_at ? Date.parse(credit.last_credit_at) : NaN,
      contrib?.last_contrib_at ? Date.parse(contrib.last_contrib_at) : NaN,
      sp?.lastAt ?? NaN,
    ].filter((t) => Number.isFinite(t));
    const lastActivity = timestamps.length ? new Date(Math.max(...timestamps)).toISOString() : null;
    return {
      merchant_id: m.id,
      name: m.name,
      category: m.category ?? null,
      municipality: m.municipality ?? null,
      status: m.status,
      is_published: Boolean(m.is_published),
      is_test: Boolean(m.is_test),
      sponsoring_suspended: Boolean(m.sponsoring_suspended),
      sponsoring_suspended_reason: m.sponsoring_suspended_reason ?? null,
      sponsoring_suspended_at: m.sponsoring_suspended_at ? new Date(m.sponsoring_suspended_at).toISOString() : null,
      balance_points: balanceByMerchant.get(m.id) ?? 0,
      total_credited: Number(credit?.total_credited ?? 0),
      total_sponsored: Number(contrib?.total_sponsored ?? 0),
      sponsorship_counts: sp?.counts ?? {
        requested: 0,
        countered: 0,
        accepted: 0,
        declined: 0,
        withdrawn: 0,
        expired: 0,
      },
      accepted_with_unmet_count: sp?.unmetAccepted ?? 0,
      active_rounds_sponsored: Number(contrib?.active_rounds ?? 0),
      last_activity: lastActivity,
    };
  });
}

export async function getMerchantFundingDetail(pool: Pool, merchantId: string) {
  const merchantRes = await pool.query(
    `SELECT id, name, category, municipality, status, is_published, is_test,
            sponsoring_suspended, sponsoring_suspended_reason, sponsoring_suspended_at, created_at
       FROM merchants WHERE id = $1`,
    [merchantId],
  );
  const merchant = merchantRes.rows[0];
  if (!merchant) throw new FundingError('MERCHANT_NOT_FOUND', 404, 'Merchant not found.');

  const [balanceRes, creditsRes, contributionsRes, sponsorshipsRes] = await Promise.all([
    pool.query("SELECT balance_points FROM points_accounts WHERE kind = 'merchant' AND merchant_id = $1", [merchantId]),
    pool.query(
      `SELECT id, source, points, reference, actor_id, ledger_group_id, reverses_credit_id, created_at
         FROM merchant_point_credits
        WHERE merchant_id = $1
        ORDER BY created_at DESC, id LIMIT 100`,
      [merchantId],
    ),
    pool.query(
      `SELECT c.*, p.quest_id, p.round_number, p.mode, p.status AS plan_status, q.title AS quest_title
         FROM quest_funding_contributions c
         JOIN quest_funding_plans p ON p.id = c.plan_id
         JOIN quests q ON q.id = p.quest_id
        WHERE c.merchant_id = $1 AND c.funder_kind = 'merchant'
        ORDER BY c.created_at DESC, c.id`,
      [merchantId],
    ),
    pool.query(
      `SELECT s.*, p.quest_id, p.round_number, p.status AS plan_status, q.title AS quest_title
         FROM quest_sponsorships s
         JOIN quest_funding_plans p ON p.id = s.plan_id
         JOIN quests q ON q.id = p.quest_id
        WHERE s.merchant_id = $1
        ORDER BY s.updated_at DESC, s.id`,
      [merchantId],
    ),
  ]);

  return {
    merchant: {
      ...merchant,
      sponsoring_suspended: Boolean(merchant.sponsoring_suspended),
      balance_points: Number(balanceRes.rows[0]?.balance_points ?? 0),
    },
    credits: creditsRes.rows,
    contributions: contributionsRes.rows,
    sponsorships: sponsorshipsRes.rows,
    simulated: true,
  };
}

export async function setMerchantSponsoringSuspended(
  pool: Pool,
  actor: AdminActor,
  merchantId: string,
  suspended: boolean,
  reason: string | undefined,
  key: string,
) {
  return fundingCommand(
    pool,
    actor.id,
    suspended ? 'merchant.sponsoring_suspend' : 'merchant.sponsoring_resume',
    key,
    { merchantId, suspended, reason: reason ?? null },
    async (tx) => {
      const beforeRes = await tx.client.query(
        'SELECT id, name, sponsoring_suspended, sponsoring_suspended_reason FROM merchants WHERE id = $1 FOR UPDATE',
        [merchantId],
      );
      const before = beforeRes.rows[0];
      if (!before) throw new FundingError('MERCHANT_NOT_FOUND', 404, 'Merchant not found.');

      const updated = (
        await tx.client.query(
          `UPDATE merchants
              SET sponsoring_suspended = $2,
                  sponsoring_suspended_reason = $3,
                  sponsoring_suspended_at = CASE WHEN $2 THEN NOW() ELSE NULL END
            WHERE id = $1
            RETURNING id, name, status, is_published, is_test, sponsoring_suspended, sponsoring_suspended_reason, sponsoring_suspended_at`,
          [merchantId, suspended, suspended ? (reason?.trim() ?? null) : null],
        )
      ).rows[0];

      await recordAdminAudit(tx.client, actor, {
        action: suspended ? 'merchant.sponsoring_suspended' : 'merchant.sponsoring_resumed',
        subjectType: 'merchant',
        subjectId: merchantId,
        before: {
          sponsoring_suspended: Boolean(before.sponsoring_suspended),
          sponsoring_suspended_reason: before.sponsoring_suspended_reason ?? null,
        },
        after: {
          sponsoring_suspended: suspended,
          sponsoring_suspended_reason: updated.sponsoring_suspended_reason ?? null,
        },
      });
      return updated;
    },
  );
}
