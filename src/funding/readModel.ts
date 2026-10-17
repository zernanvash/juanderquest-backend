import type { Pool } from 'pg';

/** Public quest discovery only receives active/closing plans and non-sensitive sponsor/perk details. */
export async function publicFundingSummaries(pool: Pool, questIds: string[], isTest: boolean) {
  if (!questIds.length) return new Map<string, any>();
  const plans = await pool.query(
    `SELECT p.id,p.quest_id,p.mode,p.status,p.ends_at,p.reward_points,p.fee_points,
       p.planned_completions,p.round_number
      FROM quest_funding_plans p JOIN quests q ON q.id=p.quest_id
     WHERE p.quest_id=ANY($1::text[]) AND p.is_test=$2 AND q.is_test=p.is_test
       AND p.status IN ('active','closing')
     ORDER BY p.quest_id,p.round_number DESC`,
    [questIds,isTest]);

  // Pick one current public round per quest. Separate bounded reads deliberately
  // avoid correlated subqueries: those produced valid PostgreSQL but pg-mem
  // could neither execute nor faithfully test when a quest had no funding rows.
  const selected = new Map<string, any>();
  for (const plan of plans.rows) {
    if (!selected.has(plan.quest_id)) selected.set(plan.quest_id, plan);
  }
  if (!selected.size) return new Map<string, any>();

  const planIds = [...selected.values()].map((plan: any) => plan.id);
  const [contributions, sponsorRows, perkRows] = await Promise.all([
    pool.query(
      `SELECT plan_id,COALESCE(SUM(remaining_points),0)::bigint AS available_points
         FROM quest_funding_contributions
        WHERE plan_id=ANY($1::text[]) AND is_test=$2 GROUP BY plan_id`,
      [planIds,isTest]),
    pool.query(
      `SELECT s.plan_id,m.name,m.logo_url
         FROM quest_sponsorships s JOIN merchants m ON m.id=s.merchant_id
        WHERE s.plan_id=ANY($1::text[]) AND s.status='accepted' AND s.promo=TRUE AND s.is_test=$2
        ORDER BY s.created_at,s.id`,
      [planIds,isTest]),
    pool.query(
      `SELECT perk.plan_id,v.title,perk.total_qty-perk.granted_qty AS remaining,perk.id
         FROM quest_voucher_perks perk JOIN quest_sponsorships s ON s.id=perk.sponsorship_id
         JOIN vouchers v ON v.id=perk.voucher_id AND v.is_active=TRUE
        WHERE perk.plan_id=ANY($1::text[]) AND perk.granted_qty<perk.total_qty
          AND s.status='accepted' AND s.is_test=$2
        ORDER BY perk.id`,
      [planIds,isTest]),
  ]);

  const availableByPlan = new Map(contributions.rows.map((row: any) => [row.plan_id, Number(row.available_points)]));
  const sponsorsByPlan = new Map<string, Array<{ name: string; logo: string | null }>>();
  for (const row of sponsorRows.rows) {
    const entries = sponsorsByPlan.get(row.plan_id) ?? [];
    entries.push({ name: row.name, logo: row.logo_url ?? null });
    sponsorsByPlan.set(row.plan_id, entries);
  }
  const perkByPlan = new Map<string, { title: string; remaining: number }>();
  for (const row of perkRows.rows) {
    if (!perkByPlan.has(row.plan_id)) {
      perkByPlan.set(row.plan_id, { title: row.title, remaining: Number(row.remaining) });
    }
  }

  return new Map([...selected.entries()].map(([questId, row]: [string, any]) => {
    const available = availableByPlan.get(row.id) ?? 0;
    const cost = Number(row.reward_points) + Number(row.fee_points);
    const estimate = cost > 0 ? Math.floor(available / cost) : 0;
    return [questId, {
      mode: row.mode,
      status: row.status,
      ends_at: new Date(row.ends_at).toISOString(),
      reward_points: Number(row.reward_points),
      completions_left_estimate: Math.min(Number(row.planned_completions), estimate),
      sponsors: sponsorsByPlan.get(row.id) ?? [],
      perk: perkByPlan.get(row.id) ?? null,
      simulated: true,
    }];
  }));
}
