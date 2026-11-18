import { randomUUID } from 'crypto';
import type { Pool, PoolClient } from 'pg';
import { withinRadius } from '../db/index.js';
import { canonicalSettings } from '../settings/schema.js';
import { FundingError, fundingCommand, type FundingTx } from './transaction.js';
import { activateIfFunded, ensurePlanAccounts, lockPlan, refreshQuestMirror } from './plans.js';
import { insertFundingNotification, notifyMerchantOwners } from './notifications.js';

export type SponsorshipConditionType = 'same_town' | 'visits_shop' | 'min_players' | 'creator_good_standing';

export interface SponsorshipConditionInput {
  type: SponsorshipConditionType;
  value?: number;
}

export interface EvaluatedSponsorshipCondition {
  type: SponsorshipConditionType;
  value?: number;
  met: boolean | 'unknown';
  detail: string;
}

const VALID_CONDITION_TYPES = new Set<SponsorshipConditionType>([
  'same_town',
  'visits_shop',
  'min_players',
  'creator_good_standing',
]);

export function normalizeTown(raw: string | null | undefined): string {
  if (!raw) return '';
  return raw
    .trim()
    .toLowerCase()
    .replace(/\bsta\.\s*/g, 'santa ')
    .replace(/\bsto\.\s*/g, 'santo ')
    .replace(/\s+/g, ' ')
    .replace(/\s+city$/i, '')
    .trim();
}

export function normalizeConditionsInput(raw: unknown): SponsorshipConditionInput[] {
  if (!Array.isArray(raw)) {
    throw new FundingError('INVALID_CONDITIONS', 400, 'Conditions must be an array.');
  }
  if (raw.length > 4) {
    throw new FundingError('INVALID_CONDITIONS', 400, 'At most 4 conditions may be specified.');
  }
  const seen = new Set<SponsorshipConditionType>();
  const normalized: SponsorshipConditionInput[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') {
      throw new FundingError('INVALID_CONDITIONS', 400, 'Each condition must be an object.');
    }
    const type = (item as any).type as SponsorshipConditionType;
    if (!VALID_CONDITION_TYPES.has(type) || seen.has(type)) {
      throw new FundingError('INVALID_CONDITIONS', 400, 'Conditions contain an invalid or duplicate type.');
    }
    seen.add(type);
    if (type === 'min_players') {
      const value = Number((item as any).value);
      if (!Number.isInteger(value) || value < 1 || value > 1000) {
        throw new FundingError('INVALID_CONDITIONS', 400, 'min_players requires an integer value between 1 and 1000.');
      }
      normalized.push({ type, value });
    } else {
      if ((item as any).value !== undefined && (item as any).value !== null) {
        throw new FundingError('INVALID_CONDITIONS', 400, `Condition ${type} does not take a value.`);
      }
      normalized.push({ type });
    }
  }
  return normalized;
}

export async function evaluateConditions(
  client: Pick<PoolClient, 'query'>,
  sponsorship: {
    plan_id: string;
    merchant_id: string;
    requested_by?: string;
    conditions?: unknown;
  },
): Promise<EvaluatedSponsorshipCondition[]> {
  const rawList = Array.isArray(sponsorship.conditions) ? sponsorship.conditions : [];
  if (rawList.length === 0) return [];

  const metaRes = await client.query(
    `SELECT q.id AS quest_id, q.author_id, q.location_name, q.gps_lat AS quest_lat, q.gps_lng AS quest_lng,
            q.steps AS quest_steps, q.is_test,
            (SELECT s.municipality FROM spots s WHERE s.quest_id = q.id ORDER BY s.created_at DESC LIMIT 1) AS spot_municipality,
            (SELECT s2.municipality FROM reviewed_quest_spot_bindings b JOIN spots s2 ON s2.id = b.spot_id
              WHERE b.quest_id = q.id AND b.status = 'active' ORDER BY b.created_at DESC LIMIT 1) AS bound_municipality,
            m.name AS merchant_name, m.municipality AS merchant_municipality,
            aa.name AS town_area_name,
            app.municipality AS app_municipality, app.gps_lat AS shop_lat, app.gps_lng AS shop_lng
       FROM quest_funding_plans p
       JOIN quests q ON q.id = p.quest_id
       JOIN merchants m ON m.id = $2
       LEFT JOIN admin_areas aa ON aa.id = m.town_area_id
       LEFT JOIN merchant_affiliate_applications app ON app.id = m.source_application_id
      WHERE p.id = $1`,
    [sponsorship.plan_id, sponsorship.merchant_id],
  );
  const meta = metaRes.rows[0];
  if (!meta) return [];

  const out: EvaluatedSponsorshipCondition[] = [];
  for (const raw of rawList) {
    const cond = raw as SponsorshipConditionInput;
    if (cond.type === 'same_town') {
      const questTownRaw = String(meta.spot_municipality || meta.bound_municipality || meta.location_name || '').trim();
      const shopTownRaw = String(
        meta.town_area_name || meta.app_municipality || meta.merchant_municipality || '',
      ).trim();
      const qNorm = normalizeTown(questTownRaw);
      const sNorm = normalizeTown(shopTownRaw);
      const met = Boolean(qNorm && sNorm && qNorm === sNorm);
      let detail: string;
      if (!qNorm || !sNorm) {
        detail = !qNorm ? 'Quest town is unknown' : 'Shop town is unknown';
      } else if (met) {
        detail = `Quest and shop are both in ${questTownRaw}`;
      } else {
        detail = `Quest is in ${questTownRaw}; shop is in ${shopTownRaw}`;
      }
      out.push({ type: 'same_town', met, detail });
    } else if (cond.type === 'visits_shop') {
      const shopLat = meta.shop_lat != null ? Number(meta.shop_lat) : NaN;
      const shopLng = meta.shop_lng != null ? Number(meta.shop_lng) : NaN;
      if (!Number.isFinite(shopLat) || !Number.isFinite(shopLng)) {
        out.push({
          type: 'visits_shop',
          met: 'unknown',
          detail: 'Shop location has no GPS coordinates yet',
        });
      } else {
        const points: Array<[number, number]> = [];
        const qLat = Number(meta.quest_lat);
        const qLng = Number(meta.quest_lng);
        if (Number.isFinite(qLat) && Number.isFinite(qLng)) points.push([qLat, qLng]);
        const steps = Array.isArray(meta.quest_steps) ? meta.quest_steps : [];
        for (const step of steps) {
          const sLat = step?.verification?.fence?.lat ?? step?.gps_lat;
          const sLng = step?.verification?.fence?.lng ?? step?.gps_lng;
          if (sLat != null && sLng != null && Number.isFinite(Number(sLat)) && Number.isFinite(Number(sLng))) {
            points.push([Number(sLat), Number(sLng)]);
          }
        }
        let anyOk = false;
        let minDistance = Infinity;
        for (const [lat, lng] of points) {
          const check = withinRadius(lat, lng, shopLat, shopLng, 300);
          if (Number.isFinite(check.distance) && check.distance < minDistance) {
            minDistance = check.distance;
          }
          if (check.ok) anyOk = true;
        }
        const detail =
          points.length === 0 || !Number.isFinite(minDistance)
            ? 'Quest has no GPS coordinates'
            : anyOk
              ? `Visits within 300 m of shop (${Math.round(minDistance)} m)`
              : `Closest stop is ${Math.round(minDistance)} m from shop (needs ≤ 300 m)`;
        out.push({ type: 'visits_shop', met: anyOk, detail });
      }
    } else if (cond.type === 'min_players') {
      const target = Number(cond.value ?? 1);
      const countRes = await client.query(
        `SELECT COUNT(DISTINCT qa.user_id)::int AS cnt
           FROM quest_attempts qa
           JOIN users u ON u.id = qa.user_id
          WHERE qa.quest_id = $1 AND qa.status = 'completed' AND u.is_test = $2`,
        [meta.quest_id, Boolean(meta.is_test)],
      );
      const completed = Number(countRes.rows[0]?.cnt ?? 0);
      out.push({
        type: 'min_players',
        value: target,
        met: completed >= target,
        detail: `${completed} of ${target} players`,
      });
    } else if (cond.type === 'creator_good_standing') {
      const creatorId = meta.author_id || sponsorship.requested_by;
      const standingRes = await client.query(
        `SELECT
           EXISTS (SELECT 1 FROM account_emails ae WHERE ae.user_id = $1 AND ae.is_verified = TRUE) AS email_verified,
           EXISTS (
             SELECT 1 FROM spots sp
              WHERE sp.created_by = $1
                AND sp.status IN ('held', 'hidden_pending_review', 'unpublished', 'rejected')
           ) AS has_bad_spot`,
        [creatorId],
      );
      const row = standingRes.rows[0];
      const emailVerified = Boolean(row?.email_verified);
      const hasBadSpot = Boolean(row?.has_bad_spot);
      const met = emailVerified && !hasBadSpot;
      const detail = met
        ? 'Verified creator in good standing'
        : !emailVerified
          ? 'Creator email is not verified'
          : 'Creator has a held or hidden destination';
      out.push({ type: 'creator_good_standing', met, detail });
    }
  }
  return out;
}

type Terms = {
  points: number;
  voucher_id?: string | null;
  voucher_qty: number;
  promo: boolean;
  message?: string | null;
};

function validTerms(terms: Terms) {
  if (
    !Number.isSafeInteger(terms.points) ||
    terms.points < 0 ||
    terms.points > 1_000_000_000 ||
    !Number.isSafeInteger(terms.voucher_qty) ||
    terms.voucher_qty < 0 ||
    terms.voucher_qty > 0 !== Boolean(terms.voucher_id) ||
    (!terms.points && !terms.voucher_qty && !terms.promo) ||
    (terms.message?.length ?? 0) > 500
  ) {
    throw new FundingError(
      'INVALID_SPONSORSHIP_TERMS',
      400,
      'Provide points, a valid voucher quantity, or a promotional placement.',
    );
  }
}

async function assertOwner(client: any, actorId: string, merchantId: string, scope: boolean) {
  const row = (
    await client.query(
      `SELECT m.id,m.is_test,m.status,m.is_published,m.sponsoring_suspended,mm.role,mm.status AS membership_status,u.is_test AS user_scope
       FROM merchants m JOIN merchant_memberships mm ON mm.merchant_id=m.id AND mm.user_id=$2
       JOIN users u ON u.id=mm.user_id WHERE m.id=$1 FOR UPDATE OF m,mm`,
      [merchantId, actorId],
    )
  ).rows[0];
  if (
    !row ||
    row.status !== 'active' ||
    row.is_published !== true ||
    row.role !== 'owner' ||
    row.membership_status !== 'active'
  ) {
    throw new FundingError('MERCHANT_OWNER_REQUIRED', 403, 'An active published merchant owner is required.');
  }
  if (row.sponsoring_suspended) {
    throw new FundingError('SPONSORING_SUSPENDED', 409, 'Merchant sponsoring is currently suspended.');
  }
  if (Boolean(row.is_test) !== scope || Boolean(row.user_scope) !== scope)
    throw new FundingError('SCOPE_MISMATCH', 403, 'Merchant and account scopes do not match.');
  return row;
}

async function assertVoucher(client: any, merchantId: string, voucherId: string | undefined | null, quantity: number) {
  if (!quantity) return;
  const result = await client.query('SELECT id FROM vouchers WHERE id=$1 AND merchant_id=$2 AND is_active=TRUE', [
    voucherId,
    merchantId,
  ]);
  if (!result.rows[0])
    throw new FundingError(
      'VOUCHER_NOT_OWNED_BY_MERCHANT',
      409,
      'The sponsored voucher must be active and owned by this merchant.',
    );
}

async function sponsorshipForUpdate(client: any, id: string) {
  const result = await client.query('SELECT * FROM quest_sponsorships WHERE id=$1 FOR UPDATE', [id]);
  if (!result.rows[0]) throw new FundingError('NOT_FOUND', 404, 'Sponsorship request not found.');
  return result.rows[0];
}

async function acceptTerms(
  tx: FundingTx,
  sponsorship: any,
  terms: Terms,
  actorId: string,
  merchantAccepts: boolean,
  acknowledgeUnmet = false,
) {
  const plan = await lockPlan(tx.client, sponsorship.plan_id);
  if (
    !['pending_sponsors', 'active'].includes(plan.status) ||
    new Date(sponsorship.expires_at).getTime() <= Date.now()
  ) {
    throw new FundingError('SPONSORSHIP_STATE', 409, 'This sponsorship request is no longer open.');
  }
  if (Boolean(plan.is_test) !== Boolean(sponsorship.is_test))
    throw new FundingError('SCOPE_MISMATCH', 409, 'Sponsorship and funding scopes do not match.');
  if (merchantAccepts) await assertOwner(tx.client, actorId, sponsorship.merchant_id, Boolean(plan.is_test));
  else if (sponsorship.requested_by !== actorId)
    throw new FundingError(
      'QUEST_NOT_DESTINATION_AUTHOR',
      403,
      'Only the requesting destination author may accept a counter.',
    );
  const evaluatedConditions = await evaluateConditions(tx.client, sponsorship);
  const unmet = evaluatedConditions.filter((c) => c.met !== true);
  if (unmet.length > 0 && (!merchantAccepts || !acknowledgeUnmet)) {
    throw new FundingError('CONDITIONS_NOT_MET', 409, 'Deal conditions are not met yet.', {
      conditions: evaluatedConditions,
    });
  }
  const override = merchantAccepts && unmet.length > 0 && acknowledgeUnmet;
  if (override) {
    tx.auditMetadata = { override: true, accepted_with_unmet: unmet };
  }
  await assertVoucher(tx.client, sponsorship.merchant_id, terms.voucher_id, terms.voucher_qty);

  if (terms.points > 0) {
    await tx.client.query(
      `INSERT INTO points_accounts(id,kind,merchant_id,is_test) VALUES($1,'merchant',$2,$3) ON CONFLICT(id) DO NOTHING`,
      [`merchant:${sponsorship.merchant_id}`, sponsorship.merchant_id, plan.is_test],
    );
    const account = (
      await tx.client.query('SELECT balance_points,is_test FROM points_accounts WHERE id=$1 FOR UPDATE', [
        `merchant:${sponsorship.merchant_id}`,
      ])
    ).rows[0];
    if (!account || Boolean(account.is_test) !== Boolean(plan.is_test))
      throw new FundingError('SCOPE_MISMATCH', 409, 'Merchant point scope does not match.');
    const prior = (
      await tx.client.query(
        "SELECT * FROM quest_funding_contributions WHERE plan_id=$1 AND merchant_id=$2 AND funder_kind='merchant' FOR UPDATE",
        [plan.id, sponsorship.merchant_id],
      )
    ).rows[0];
    const existingCap = Number(prior?.remaining_points ?? 0);
    if (plan.mode === 'window' && Number(account.balance_points) < existingCap + terms.points) {
      throw new FundingError('INSUFFICIENT_POINTS', 409, 'The merchant balance does not cover this sponsorship cap.');
    }
    if (plan.mode === 'budget') {
      await tx.transfer({
        from: { id: `merchant:${sponsorship.merchant_id}`, kind: 'merchant' },
        to: { id: `quest_budget:${plan.id}`, kind: 'quest_budget' },
        points: terms.points,
        type: 'quest_fund_lock',
        referenceType: 'quest_sponsorship',
        referenceId: sponsorship.id,
        actorId,
        metadata: { merchant_id: sponsorship.merchant_id, plan_id: plan.id },
      });
    }
    if (prior)
      await tx.client.query(
        'UPDATE quest_funding_contributions SET committed_points=committed_points+$2,remaining_points=remaining_points+$2,updated_at=NOW() WHERE id=$1',
        [prior.id, terms.points],
      );
    else
      await tx.client.query(
        `INSERT INTO quest_funding_contributions(id,plan_id,funder_kind,merchant_id,sponsorship_id,is_test,committed_points,remaining_points)
       VALUES($1,$2,'merchant',$3,$4,$5,$6,$6)`,
        [randomUUID(), plan.id, sponsorship.merchant_id, sponsorship.id, plan.is_test, terms.points],
      );
    await ensurePlanAccounts(tx.client, plan);
  }
  if (terms.voucher_qty > 0) {
    await tx.client.query(
      `INSERT INTO quest_voucher_perks(id,plan_id,sponsorship_id,voucher_id,total_qty) VALUES($1,$2,$3,$4,$5)`,
      [randomUUID(), plan.id, sponsorship.id, terms.voucher_id, terms.voucher_qty],
    );
  }
  const updated = (
    await tx.client.query(
      `UPDATE quest_sponsorships
          SET status='accepted',points=$2,voucher_id=$3,voucher_qty=$4,promo=$5,message=$6,responded_by=$7,responded_at=NOW(),updated_at=NOW(),
              accepted_with_unmet=$8::jsonb,
              override_acknowledged_at=CASE WHEN $9 THEN NOW() ELSE NULL END
        WHERE id=$1 RETURNING *`,
      [
        sponsorship.id,
        terms.points,
        terms.voucher_qty ? (terms.voucher_id ?? sponsorship.voucher_id) : null,
        terms.voucher_qty,
        terms.promo,
        terms.message ?? null,
        actorId,
        override ? JSON.stringify(unmet) : null,
        override,
      ],
    )
  ).rows[0];
  if (merchantAccepts)
    await insertFundingNotification(tx.client, {
      userId: sponsorship.requested_by,
      isTest: Boolean(plan.is_test),
      eventKey: `sponsorship:${sponsorship.id}:accepted:${Number(sponsorship.terms_version)}`,
      kind: 'sponsorship',
      title: 'Merchant accepted your sponsorship request',
      message: `The merchant sponsorship for this Eco-Quest is accepted with ${terms.points} demo points${terms.voucher_qty ? ' and a voucher perk' : ''}.`,
      href: `/funding?quest_id=${encodeURIComponent(plan.quest_id)}`,
    });
  else
    await notifyMerchantOwners(
      tx.client,
      sponsorship.merchant_id,
      Boolean(plan.is_test),
      `sponsorship:${sponsorship.id}:counter-accepted:${Number(sponsorship.terms_version)}`,
      'sponsorship',
      'Author accepted your sponsorship counter-offer',
      'The destination author accepted your revised Eco-Quest sponsorship terms.',
      '/merchant/funding',
    );
  if (plan.status === 'pending_sponsors') await activateIfFunded(tx, plan);
  return { ...updated, conditions: evaluatedConditions };
}

export class SponsorshipService {
  constructor(private readonly pool: Pool) {}

  async directory(
    questId: string,
    actorId: string,
    options: { q?: string; page?: number; lat?: number; lng?: number },
  ) {
    const client = await this.pool.connect();
    try {
      const quest = (
        await client.query(
          `SELECT q.id,q.is_test,q.author_id,q.gps_lat,q.gps_lng,
            COALESCE((SELECT s.municipality FROM spots s WHERE s.quest_id=q.id ORDER BY s.created_at DESC LIMIT 1),
              (SELECT s2.municipality FROM reviewed_quest_spot_bindings b JOIN spots s2 ON s2.id=b.spot_id
                WHERE b.quest_id=q.id AND b.status='active' ORDER BY b.created_at DESC LIMIT 1)) AS municipality
           FROM quests q WHERE q.id=$1`,
          [questId],
        )
      ).rows[0];
      if (!quest) throw new FundingError('NOT_FOUND', 404, 'Quest not found.');
      if (quest.author_id !== actorId)
        throw new FundingError(
          'QUEST_NOT_DESTINATION_AUTHOR',
          403,
          'Only the destination author can request sponsorship.',
        );
      const actor = (await client.query('SELECT is_test FROM users WHERE id=$1', [actorId])).rows[0];
      if (!actor || Boolean(actor.is_test) !== Boolean(quest.is_test))
        throw new FundingError('SCOPE_MISMATCH', 403, 'Account and quest scopes do not match.');
      const page = Math.max(1, Math.min(1000, options.page ?? 1));
      const query = (options.q ?? '').trim().slice(0, 100);
      // Distance origin: the builder's current pin when given, else the saved quest location.
      const validPin =
        Number.isFinite(options.lat) &&
        Number.isFinite(options.lng) &&
        Math.abs(options.lat!) <= 90 &&
        Math.abs(options.lng!) <= 180;
      const originLat = validPin ? options.lat! : quest.gps_lat == null ? null : Number(quest.gps_lat);
      const originLng = validPin ? options.lng! : quest.gps_lng == null ? null : Number(quest.gps_lng);
      const result = await client.query(
        `SELECT id,name,municipality,category,logo_url,description,vouchers,same_municipality,
            CASE WHEN distance_m IS NULL THEN NULL ELSE ROUND(distance_m)::int END AS distance_m
         FROM (SELECT m.id,m.name,m.municipality,m.category,m.logo_url,m.description,
          COALESCE((SELECT jsonb_agg(jsonb_build_object('id',v.id,'title',v.title,'description',v.description)
            ORDER BY v.title,v.id) FROM vouchers v WHERE v.merchant_id=m.id AND v.is_active=TRUE), '[]'::jsonb) AS vouchers,
          (m.municipality IS NOT DISTINCT FROM $2) AS same_municipality,
          CASE WHEN $5::double precision IS NULL OR $6::double precision IS NULL OR app.gps_lat IS NULL OR app.gps_lng IS NULL
            THEN NULL
            ELSE 12742000 * ASIN(LEAST(1, SQRT(
              POWER(SIN(RADIANS(app.gps_lat - $5::double precision) / 2), 2) +
              COS(RADIANS($5::double precision)) * COS(RADIANS(app.gps_lat)) *
              POWER(SIN(RADIANS(app.gps_lng - $6::double precision) / 2), 2))))
          END AS distance_m
         FROM merchants m LEFT JOIN merchant_affiliate_applications app ON app.id=m.source_application_id
         WHERE m.status='active' AND m.is_published=TRUE AND m.is_test=$1
           AND ($3='' OR m.name ILIKE '%'||$3||'%' OR COALESCE(m.category,'') ILIKE '%'||$3||'%')) d
         ORDER BY same_municipality DESC,distance_m ASC NULLS LAST,name,id LIMIT 20 OFFSET $4`,
        [quest.is_test, quest.municipality ?? null, query, (page - 1) * 20, originLat, originLng],
      );
      return { items: result.rows, page, simulated: true };
    } finally {
      client.release();
    }
  }

  async request(actorId: string, planId: string, merchantId: string, terms: Terms, key: string) {
    validTerms(terms);
    const result = await fundingCommand(
      this.pool,
      actorId,
      'sponsorship.request',
      key,
      { planId, merchantId, terms },
      async (tx) => {
        const plan = await lockPlan(tx.client, planId, actorId);
        if (!['pending_sponsors', 'active'].includes(plan.status))
          throw new FundingError('FUNDING_PLAN_STATE', 409, 'This round is not accepting sponsor requests.');
        const merchant = (
          await tx.client.query(
            "SELECT id,is_test,sponsoring_suspended FROM merchants WHERE id=$1 AND status='active' AND is_published=TRUE FOR UPDATE",
            [merchantId],
          )
        ).rows[0];
        if (!merchant) throw new FundingError('MERCHANT_NOT_FOUND', 404, 'Active published merchant not found.');
        if (merchant.sponsoring_suspended)
          throw new FundingError('SPONSORING_SUSPENDED', 409, 'Merchant sponsoring is currently suspended.');
        if (Boolean(merchant.is_test) !== Boolean(plan.is_test))
          throw new FundingError('SCOPE_MISMATCH', 409, 'Merchant and quest scopes do not match.');
        await assertVoucher(tx.client, merchantId, terms.voucher_id, terms.voucher_qty);
        const settings = (await tx.client.query('SELECT values FROM system_settings_document WHERE id=1')).rows[0];
        const cap = Number(canonicalSettings(settings?.values ?? {}).max_open_sponsorship_requests_per_plan);
        const count = await tx.client.query(
          "SELECT COUNT(*)::int AS count FROM quest_sponsorships WHERE plan_id=$1 AND status IN ('requested','countered')",
          [planId],
        );
        if (Number(count.rows[0].count) >= cap)
          throw new FundingError(
            'SPONSORSHIP_REQUEST_LIMIT',
            429,
            'This funding round already has the maximum open sponsorship requests.',
          );
        const expires =
          plan.status === 'pending_sponsors' && plan.sponsorship_deadline ? plan.sponsorship_deadline : plan.ends_at;
        const inserted = await tx.client.query(
          `INSERT INTO quest_sponsorships(id,plan_id,merchant_id,requested_by,status,points,voucher_id,voucher_qty,promo,message,expires_at,is_test)
         VALUES($1,$2,$3,$4,'requested',$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
          [
            randomUUID(),
            planId,
            merchantId,
            actorId,
            terms.points,
            terms.voucher_id ?? null,
            terms.voucher_qty,
            terms.promo,
            terms.message ?? null,
            expires,
            plan.is_test,
          ],
        );
        const quest = (await tx.client.query('SELECT title FROM quests WHERE id=$1', [plan.quest_id])).rows[0];
        await notifyMerchantOwners(
          tx.client,
          merchantId,
          Boolean(plan.is_test),
          `sponsorship:${inserted.rows[0].id}:requested`,
          'sponsorship',
          'New Eco-Quest sponsorship request',
          `A destination author invited your business to sponsor “${quest?.title ?? 'an Eco-Quest'}”.`,
          '/merchant/funding',
        );
        return inserted.rows[0];
      },
    );
    return result;
  }

  async topUp(actorId: string, planId: string, points: number, key: string) {
    if (!Number.isSafeInteger(points) || points <= 0 || points > 1_000_000_000)
      throw new FundingError('INVALID_AMOUNT', 400, 'Top-up points must be a positive supported amount.');
    return fundingCommand(this.pool, actorId, 'funding.merchant_top_up', key, { planId, points }, async (tx) => {
      const plan = await lockPlan(tx.client, planId);
      if (plan.status !== 'active' || new Date(plan.ends_at).getTime() <= Date.now())
        throw new FundingError('FUNDING_PLAN_STATE', 409, 'Only an active funding round can receive merchant top-ups.');
      const accepted = (
        await tx.client.query(
          "SELECT * FROM quest_sponsorships WHERE plan_id=$1 AND status='accepted' AND is_test=$2 ORDER BY id FOR UPDATE",
          [planId, plan.is_test],
        )
      ).rows;
      const owned = [] as any[];
      for (const sponsorship of accepted) {
        const membership = await tx.client.query(
          "SELECT 1 FROM merchant_memberships WHERE merchant_id=$1 AND user_id=$2 AND role='owner' AND status='active'",
          [sponsorship.merchant_id, actorId],
        );
        if (membership.rows.length) owned.push(sponsorship);
      }
      const sponsorship = owned[0];
      if (!sponsorship)
        throw new FundingError(
          'MERCHANT_OWNER_REQUIRED',
          403,
          'Only an existing sponsor owner may add points to this round.',
        );
      await assertOwner(tx.client, actorId, sponsorship.merchant_id, Boolean(plan.is_test));
      const contribution = (
        await tx.client.query(
          "SELECT * FROM quest_funding_contributions WHERE plan_id=$1 AND merchant_id=$2 AND funder_kind='merchant' FOR UPDATE",
          [planId, sponsorship.merchant_id],
        )
      ).rows[0];
      if (!contribution || Boolean(contribution.is_test) !== Boolean(plan.is_test))
        throw new FundingError(
          'SCOPE_MISMATCH',
          409,
          'Sponsor contribution is unavailable or belongs to another scope.',
        );
      const account = (
        await tx.client.query('SELECT balance_points,is_test FROM points_accounts WHERE id=$1 FOR UPDATE', [
          `merchant:${sponsorship.merchant_id}`,
        ])
      ).rows[0];
      if (!account || Boolean(account.is_test) !== Boolean(plan.is_test))
        throw new FundingError('SCOPE_MISMATCH', 409, 'Merchant point scope does not match.');
      if (plan.mode === 'window' && Number(account.balance_points) < Number(contribution.remaining_points) + points)
        throw new FundingError(
          'INSUFFICIENT_POINTS',
          409,
          'The merchant balance does not cover this additional spending cap.',
        );
      if (plan.mode === 'budget')
        await tx.transfer({
          from: { id: `merchant:${sponsorship.merchant_id}`, kind: 'merchant' },
          to: { id: `quest_budget:${planId}`, kind: 'quest_budget' },
          points,
          type: 'quest_fund_lock',
          referenceType: 'quest_sponsorship',
          referenceId: sponsorship.id,
          actorId,
          metadata: { merchant_id: sponsorship.merchant_id, top_up: true },
        });
      await tx.client.query(
        'UPDATE quest_funding_contributions SET committed_points=committed_points+$2,remaining_points=remaining_points+$2,updated_at=NOW() WHERE id=$1',
        [contribution.id, points],
      );
      return { plan_id: planId, merchant_id: sponsorship.merchant_id, added_points: points, simulated: true };
    });
  }

  async counter(
    actorId: string,
    id: string,
    terms: Terms & { conditions?: SponsorshipConditionInput[] },
    version: number,
    key: string,
  ) {
    validTerms(terms);
    const hasConditions = terms.conditions !== undefined;
    const validatedConditions = hasConditions ? normalizeConditionsInput(terms.conditions) : undefined;
    return fundingCommand(this.pool, actorId, 'sponsorship.counter', key, { id, terms, version }, async (tx) => {
      const sponsorship = await sponsorshipForUpdate(tx.client, id);
      if (sponsorship.status !== 'requested' || Number(sponsorship.terms_version) !== version)
        throw new FundingError('SPONSORSHIP_TERMS_CHANGED', 409, 'Refresh this request before countering.');
      const plan = await lockPlan(tx.client, sponsorship.plan_id);
      if (
        !['pending_sponsors', 'active'].includes(plan.status) ||
        new Date(sponsorship.expires_at).getTime() <= Date.now()
      )
        throw new FundingError('SPONSORSHIP_STATE', 409, 'This sponsorship request has expired or is no longer open.');
      await assertOwner(tx.client, actorId, sponsorship.merchant_id, Boolean(plan.is_test));
      await assertVoucher(
        tx.client,
        sponsorship.merchant_id,
        terms.voucher_id ?? sponsorship.voucher_id,
        terms.voucher_qty,
      );
      const result = await tx.client.query(
        `UPDATE quest_sponsorships SET status='countered',counter_points=$2,counter_voucher_qty=$3,counter_promo=$4,counter_message=$5,
             conditions=CASE WHEN $7 THEN $8::jsonb ELSE conditions END,
             terms_version=terms_version+1,responded_by=$6,responded_at=NOW(),updated_at=NOW() WHERE id=$1 RETURNING *`,
        [
          id,
          terms.points,
          terms.voucher_qty,
          terms.promo,
          terms.message ?? null,
          actorId,
          hasConditions,
          JSON.stringify(validatedConditions ?? []),
        ],
      );
      const title =
        (await tx.client.query('SELECT title FROM quests WHERE id=$1', [plan.quest_id])).rows[0]?.title ??
        'an Eco-Quest';
      await insertFundingNotification(tx.client, {
        userId: sponsorship.requested_by,
        isTest: Boolean(plan.is_test),
        eventKey: `sponsorship:${id}:countered:${version + 1}`,
        kind: 'sponsorship',
        title: 'Merchant sent a sponsorship counter-offer',
        message: `The merchant proposed revised sponsorship terms for “${title}”. Review them before accepting.`,
        href: `/funding?quest_id=${encodeURIComponent(plan.quest_id)}`,
      });
      const updatedRow = result.rows[0];
      return { ...updatedRow, conditions: await evaluateConditions(tx.client, updatedRow) };
    });
  }

  async setConditions(actorId: string, id: string, rawConditions: unknown) {
    const validated = normalizeConditionsInput(rawConditions);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const sponsorship = await sponsorshipForUpdate(client, id);
      if (!['requested', 'countered'].includes(sponsorship.status)) {
        throw new FundingError('SPONSORSHIP_STATE', 409, 'Only an open sponsorship request can update conditions.');
      }
      const plan = await lockPlan(client, sponsorship.plan_id);
      if (
        !['pending_sponsors', 'active'].includes(plan.status) ||
        new Date(sponsorship.expires_at).getTime() <= Date.now()
      ) {
        throw new FundingError('SPONSORSHIP_STATE', 409, 'This sponsorship request is no longer open.');
      }
      await assertOwner(client, actorId, sponsorship.merchant_id, Boolean(plan.is_test));
      const updated = (
        await client.query(
          'UPDATE quest_sponsorships SET conditions=$2::jsonb,updated_at=NOW() WHERE id=$1 RETURNING *',
          [id, JSON.stringify(validated)],
        )
      ).rows[0];
      const evaluated = await evaluateConditions(client, updated);
      await client.query('COMMIT');
      return { ...updated, conditions: evaluated };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async accept(actorId: string, id: string, version: number, key: string, acknowledgeUnmet = false) {
    const result = await fundingCommand(
      this.pool,
      actorId,
      'sponsorship.accept',
      key,
      acknowledgeUnmet ? { id, version, acknowledge_unmet: true } : { id, version },
      async (tx) => {
        const sponsorship = await sponsorshipForUpdate(tx.client, id);
        if (sponsorship.status !== 'requested' || Number(sponsorship.terms_version) !== version)
          throw new FundingError('SPONSORSHIP_TERMS_CHANGED', 409, 'Refresh this request before accepting it.');
        return acceptTerms(
          tx,
          sponsorship,
          {
            points: Number(sponsorship.points),
            voucher_id: sponsorship.voucher_id,
            voucher_qty: Number(sponsorship.voucher_qty),
            promo: Boolean(sponsorship.promo),
            message: sponsorship.message,
          },
          actorId,
          true,
          acknowledgeUnmet,
        );
      },
    );
    const quest = (
      await this.pool.query(
        'SELECT p.quest_id FROM quest_sponsorships s JOIN quest_funding_plans p ON p.id=s.plan_id WHERE s.id=$1',
        [id],
      )
    ).rows[0];
    if (quest) await refreshQuestMirror(this.pool, quest.quest_id);
    return result;
  }

  async acceptCounter(actorId: string, id: string, version: number, key: string) {
    const result = await fundingCommand(
      this.pool,
      actorId,
      'sponsorship.accept_counter',
      key,
      { id, version },
      async (tx) => {
        const sponsorship = await sponsorshipForUpdate(tx.client, id);
        if (
          sponsorship.status !== 'countered' ||
          Number(sponsorship.terms_version) !== version ||
          sponsorship.requested_by !== actorId
        )
          throw new FundingError(
            'SPONSORSHIP_TERMS_CHANGED',
            409,
            'The counter changed or this is not your sponsorship request.',
          );
        const merchantRow = (
          await tx.client.query('SELECT sponsoring_suspended FROM merchants WHERE id=$1', [sponsorship.merchant_id])
        ).rows[0];
        if (merchantRow?.sponsoring_suspended)
          throw new FundingError('SPONSORING_SUSPENDED', 409, 'Merchant sponsoring is currently suspended.');
        const terms = {
          points: Number(sponsorship.counter_points ?? sponsorship.points),
          voucher_id: sponsorship.voucher_id,
          voucher_qty: Number(sponsorship.counter_voucher_qty ?? sponsorship.voucher_qty),
          promo: Boolean(sponsorship.counter_promo ?? sponsorship.promo),
          message: sponsorship.counter_message ?? sponsorship.message,
        };
        return acceptTerms(tx, sponsorship, terms, actorId, false);
      },
    );
    const quest = (
      await this.pool.query(
        'SELECT p.quest_id FROM quest_sponsorships s JOIN quest_funding_plans p ON p.id=s.plan_id WHERE s.id=$1',
        [id],
      )
    ).rows[0];
    if (quest) await refreshQuestMirror(this.pool, quest.quest_id);
    return result;
  }

  async decide(actorId: string, id: string, action: 'decline' | 'withdraw', key: string, reason?: string) {
    return fundingCommand(this.pool, actorId, `sponsorship.${action}`, key, { id, action, reason }, async (tx) => {
      const sponsorship = await sponsorshipForUpdate(tx.client, id);
      const plan = await lockPlan(tx.client, sponsorship.plan_id);
      if (new Date(sponsorship.expires_at).getTime() <= Date.now())
        throw new FundingError('SPONSORSHIP_STATE', 409, 'This sponsorship request has expired.');
      if (action === 'withdraw') {
        if (sponsorship.requested_by !== actorId || !['requested', 'countered'].includes(sponsorship.status))
          throw new FundingError('SPONSORSHIP_STATE', 409, 'Only the requesting author may withdraw an open request.');
      } else {
        await assertOwner(tx.client, actorId, sponsorship.merchant_id, Boolean(plan.is_test));
        if (!['requested', 'countered'].includes(sponsorship.status))
          throw new FundingError('SPONSORSHIP_STATE', 409, 'Only an open request can be declined.');
      }
      const status = action === 'withdraw' ? 'withdrawn' : 'declined';
      const updated = (
        await tx.client.query(
          'UPDATE quest_sponsorships SET status=$2,counter_message=$3,responded_by=$4,responded_at=NOW(),updated_at=NOW(),terms_version=terms_version+1 WHERE id=$1 RETURNING *',
          [id, status, reason?.slice(0, 500) ?? null, actorId],
        )
      ).rows[0];
      if (action === 'withdraw') {
        await notifyMerchantOwners(
          tx.client,
          sponsorship.merchant_id,
          Boolean(plan.is_test),
          `sponsorship:${id}:withdrawn:${updated.terms_version}`,
          'sponsorship',
          'Sponsorship request withdrawn',
          'The destination author withdrew their Eco-Quest sponsorship request.',
          '/merchant/funding',
        );
      } else {
        const title =
          (await tx.client.query('SELECT title FROM quests WHERE id=$1', [plan.quest_id])).rows[0]?.title ??
          'this Eco-Quest';
        await insertFundingNotification(tx.client, {
          userId: sponsorship.requested_by,
          isTest: Boolean(plan.is_test),
          eventKey: `sponsorship:${id}:declined:${updated.terms_version}`,
          kind: 'sponsorship',
          title: 'Merchant declined the sponsorship request',
          message: `The merchant declined the request for “${title}”.`,
          href: `/funding?quest_id=${encodeURIComponent(plan.quest_id)}`,
        });
      }
      return updated;
    });
  }

  async inbox(actorId: string, status?: string) {
    const client = await this.pool.connect();
    try {
      const allowed = ['requested', 'countered', 'accepted', 'declined', 'withdrawn', 'expired'];
      if (status && !allowed.includes(status))
        throw new FundingError('INVALID_STATUS', 400, 'Unsupported sponsorship status.');
      const result = await client.query(
        `SELECT s.*,p.quest_id,p.status AS plan_status,q.title AS quest_title,sp.name AS spot_name
           FROM quest_sponsorships s JOIN quest_funding_plans p ON p.id=s.plan_id JOIN quests q ON q.id=p.quest_id
           LEFT JOIN spots sp ON sp.quest_id=q.id JOIN merchant_memberships mm ON mm.merchant_id=s.merchant_id
          JOIN merchants m ON m.id=s.merchant_id JOIN users u ON u.id=mm.user_id
          WHERE mm.user_id=$1 AND mm.status='active' AND mm.role IN ('owner','staff') AND m.status='active'
            AND m.is_test=s.is_test AND u.is_test=s.is_test AND ($2::text IS NULL OR s.status=$2)
          ORDER BY s.updated_at DESC,s.id LIMIT 100`,
        [actorId, status ?? null],
      );
      const items = await Promise.all(
        result.rows.map(async (row) => ({
          ...row,
          conditions: await evaluateConditions(client, row),
        })),
      );
      return { items, simulated: true };
    } finally {
      client.release();
    }
  }
}
