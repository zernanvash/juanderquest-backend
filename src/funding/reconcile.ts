import type { Pool } from 'pg';
import { MJDQ_PER_JDQ } from '../governance/store.js';

export async function reconcileFunding(pool:Pool){
  const [plans,accounts,groups]=await Promise.all([
    pool.query(
      `SELECT p.id,p.quest_id,p.is_test,p.status,p.mode,
        COALESCE(SUM(c.committed_points),0)::numeric AS committed,
        COALESCE(SUM(c.remaining_points::numeric+c.held_points::numeric+c.paid_reward_points::numeric+
          c.paid_fee_points::numeric+c.refunded_points::numeric),0)::numeric AS accounted
       FROM quest_funding_plans p LEFT JOIN quest_funding_contributions c ON c.plan_id=p.id AND c.is_test=p.is_test
       GROUP BY p.id HAVING COALESCE(SUM(c.committed_points::numeric),0)<>
         COALESCE(SUM(c.remaining_points::numeric+c.held_points::numeric+c.paid_reward_points::numeric+
           c.paid_fee_points::numeric+c.refunded_points::numeric),0)
       ORDER BY p.id`),
    pool.query(
      `SELECT a.id,a.kind,a.is_test,a.balance_points::numeric*${MJDQ_PER_JDQ} AS balance_mjdq,
        COALESCE(SUM(l.amount_mjdq),0)::numeric AS ledger_mjdq
       FROM points_accounts a LEFT JOIN governance_ledger l ON l.account=a.id
       GROUP BY a.id HAVING a.balance_points::numeric*${MJDQ_PER_JDQ}<>COALESCE(SUM(l.amount_mjdq),0)
       ORDER BY a.id`),
    pool.query(
      `SELECT transaction_group_id,COUNT(*)::int AS rows,SUM(amount_mjdq)::numeric AS net_mjdq
       FROM governance_ledger WHERE type IN ('merchant_points_simulated_purchase','merchant_points_admin_grant','merchant_points_admin_correction',
         'merchant_points_voucher_income','quest_fund_lock','quest_fund_hold','quest_fund_release','quest_fund_refund','quest_reward_paid','quest_fee')
       GROUP BY transaction_group_id HAVING COUNT(*)<>2 OR SUM(amount_mjdq)<>0 ORDER BY transaction_group_id`),
  ]);
  return {ok:plans.rows.length===0&&accounts.rows.length===0&&groups.rows.length===0,
    plans:{mismatches:plans.rows.length,items:plans.rows.slice(0,100)},
    point_accounts:{mismatches:accounts.rows.length,items:accounts.rows.slice(0,100)},
    ledger_groups:{mismatches:groups.rows.length,items:groups.rows.slice(0,100)},
    scope:'funding point accounts and funding transaction groups only',simulated:true};
}
