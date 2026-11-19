import { randomUUID } from 'crypto';
import type { Pool } from 'pg';
import { calculateHaversineDistance } from '../db/index.js';
import { canonicalSettings } from '../settings/schema.js';
import { customerLabel } from '../suki/codes.js';

export const MAX_ACTIVE_MERCHANT_VOUCHERS = 20;
export const MAX_ACTIVE_MERCHANT_STAFF = 5;
export const VOUCHER_ICON_KEYS = ['meal', 'coffee', 'souvenir', 'ticket', 'discount', 'gift'] as const;
export type VoucherIconKey = (typeof VOUCHER_ICON_KEYS)[number];

export class WorkspaceError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'WorkspaceError';
  }
}

export interface MerchantMemberContext {
  merchantId: string;
  merchantName: string;
  municipality: string | null;
  role: 'owner' | 'staff';
  isTest: boolean;
}

function maskEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const at = email.indexOf('@');
  if (at <= 1) return email;
  return `${email[0]}***${email.slice(at)}`;
}

export async function resolveMerchantMember(
  pool: Pool,
  userId: string,
  ownerOnly = false,
): Promise<MerchantMemberContext> {
  const res = await pool.query(
    `SELECT m.id, m.name, m.municipality, m.is_test AS merchant_is_test,
            mm.role, u.is_test AS user_is_test
       FROM merchant_memberships mm
       JOIN merchants m ON m.id = mm.merchant_id
       JOIN users u ON u.id = mm.user_id
      WHERE mm.user_id = $1 AND mm.status = 'active' AND m.status = 'active'
      ORDER BY (mm.role = 'owner') DESC, mm.created_at, m.id
      LIMIT 1`,
    [userId],
  );
  const row = res.rows[0];
  if (!row) {
    throw new WorkspaceError('MERCHANT_MEMBERSHIP_REQUIRED', 403, 'An active merchant account is required.');
  }
  if (Boolean(row.user_is_test) !== Boolean(row.merchant_is_test)) {
    throw new WorkspaceError('SCOPE_MISMATCH', 403, 'Merchant and account scopes do not match.');
  }
  if (ownerOnly && row.role !== 'owner') {
    throw new WorkspaceError('MERCHANT_OWNER_REQUIRED', 403, 'Only the shop owner can perform this action.');
  }
  return {
    merchantId: String(row.id),
    merchantName: String(row.name),
    municipality: row.municipality ? String(row.municipality) : null,
    role: row.role === 'owner' ? 'owner' : 'staff',
    isTest: Boolean(row.merchant_is_test),
  };
}

export async function listManageVouchers(pool: Pool, userId: string) {
  const ctx = await resolveMerchantMember(pool, userId, false);
  const res = await pool.query(
    `SELECT v.id, v.title, v.description, v.cost_points, v.availability, v.is_active,
            v.stock_limit, v.valid_days, v.icon_key, v.partner_label,
            v.created_at, v.updated_at,
            (SELECT COUNT(*)::int FROM redemptions r WHERE r.voucher_id = v.id) AS redeemed_count,
            (SELECT COUNT(*)::int FROM redemptions r WHERE r.voucher_id = v.id AND r.used_at IS NOT NULL) AS used_count
       FROM vouchers v
      WHERE v.merchant_id = $1
      ORDER BY v.is_active DESC, v.created_at DESC, v.id`,
    [ctx.merchantId],
  );
  return {
    merchant_id: ctx.merchantId,
    role: ctx.role,
    items: res.rows.map((r: any) => ({
      ...r,
      stock_limit: r.stock_limit == null ? null : Number(r.stock_limit),
      valid_days: r.valid_days == null ? null : Number(r.valid_days),
      redeemed_count: Number(r.redeemed_count ?? 0),
      used_count: Number(r.used_count ?? 0),
      created_at: r.created_at ? new Date(r.created_at).toISOString() : null,
      updated_at: r.updated_at ? new Date(r.updated_at).toISOString() : null,
    })),
  };
}

export interface CreateVoucherInput {
  title: string;
  description: string;
  cost_points: number;
  stock_limit?: number | null;
  valid_days?: number | null;
  icon_key?: VoucherIconKey | null;
}

export async function createMerchantVoucher(pool: Pool, userId: string, input: CreateVoucherInput) {
  const ctx = await resolveMerchantMember(pool, userId, true);
  const countRes = await pool.query(
    `SELECT COUNT(*)::int AS cnt FROM vouchers WHERE merchant_id = $1 AND is_active = TRUE`,
    [ctx.merchantId],
  );
  if (Number(countRes.rows[0]?.cnt ?? 0) >= MAX_ACTIVE_MERCHANT_VOUCHERS) {
    throw new WorkspaceError(
      'VOUCHER_LIMIT_REACHED',
      409,
      `A merchant can have at most ${MAX_ACTIVE_MERCHANT_VOUCHERS} active vouchers.`,
    );
  }
  const id = `v_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const partnerLabel = ctx.municipality ? `${ctx.merchantName} · ${ctx.municipality}` : ctx.merchantName;
  const res = await pool.query(
    `INSERT INTO vouchers
       (id, merchant_id, title, description, cost_points, is_active, availability, partner_label, icon_key, stock_limit, valid_days, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, TRUE, 'preview', $6, $7, $8, $9, NOW(), NOW())
     RETURNING *`,
    [
      id,
      ctx.merchantId,
      input.title.trim(),
      input.description.trim(),
      input.cost_points,
      partnerLabel,
      input.icon_key ?? 'gift',
      input.stock_limit ?? null,
      input.valid_days ?? null,
    ],
  );
  return res.rows[0];
}

export interface UpdateVoucherInput {
  title?: string;
  description?: string;
  cost_points?: number;
  stock_limit?: number | null;
  valid_days?: number | null;
  icon_key?: VoucherIconKey | null;
  is_active?: boolean;
}

export async function updateMerchantVoucher(pool: Pool, userId: string, voucherId: string, input: UpdateVoucherInput) {
  const ctx = await resolveMerchantMember(pool, userId, true);
  const existing = await pool.query(`SELECT * FROM vouchers WHERE id = $1 AND merchant_id = $2 LIMIT 1`, [
    voucherId,
    ctx.merchantId,
  ]);
  if (!existing.rows.length) {
    throw new WorkspaceError('VOUCHER_NOT_FOUND', 404, 'Voucher not found.');
  }
  const cur = existing.rows[0];
  if (input.is_active === true && cur.is_active === false) {
    const countRes = await pool.query(
      `SELECT COUNT(*)::int AS cnt FROM vouchers WHERE merchant_id = $1 AND is_active = TRUE`,
      [ctx.merchantId],
    );
    if (Number(countRes.rows[0]?.cnt ?? 0) >= MAX_ACTIVE_MERCHANT_VOUCHERS) {
      throw new WorkspaceError(
        'VOUCHER_LIMIT_REACHED',
        409,
        `A merchant can have at most ${MAX_ACTIVE_MERCHANT_VOUCHERS} active vouchers.`,
      );
    }
  }
  const res = await pool.query(
    `UPDATE vouchers
        SET title = $3,
            description = $4,
            cost_points = $5,
            stock_limit = $6,
            valid_days = $7,
            icon_key = $8,
            is_active = $9,
            updated_at = NOW()
      WHERE id = $1 AND merchant_id = $2
      RETURNING *`,
    [
      voucherId,
      ctx.merchantId,
      input.title !== undefined ? input.title.trim() : cur.title,
      input.description !== undefined ? input.description.trim() : cur.description,
      input.cost_points !== undefined ? input.cost_points : cur.cost_points,
      input.stock_limit !== undefined ? input.stock_limit : cur.stock_limit,
      input.valid_days !== undefined ? input.valid_days : cur.valid_days,
      input.icon_key !== undefined ? input.icon_key : cur.icon_key,
      input.is_active !== undefined ? input.is_active : cur.is_active,
    ],
  );
  return res.rows[0];
}

export async function archiveMerchantVoucher(pool: Pool, userId: string, voucherId: string) {
  const ctx = await resolveMerchantMember(pool, userId, true);
  const res = await pool.query(
    `UPDATE vouchers SET is_active = FALSE, updated_at = NOW() WHERE id = $1 AND merchant_id = $2 RETURNING id, is_active`,
    [voucherId, ctx.merchantId],
  );
  if (!res.rows.length) {
    throw new WorkspaceError('VOUCHER_NOT_FOUND', 404, 'Voucher not found.');
  }
  return res.rows[0];
}

export async function listMerchantStaff(pool: Pool, userId: string) {
  const ctx = await resolveMerchantMember(pool, userId, false);
  const res = await pool.query(
    `SELECT mm.id, mm.user_id, mm.role, mm.status, mm.created_at, mm.updated_at,
            u.display_name, u.email
       FROM merchant_memberships mm
       JOIN users u ON u.id = mm.user_id
      WHERE mm.merchant_id = $1
      ORDER BY (mm.role = 'owner') DESC, (mm.status = 'active') DESC, mm.created_at ASC`,
    [ctx.merchantId],
  );
  return {
    merchant_id: ctx.merchantId,
    items: res.rows.map((r: any) => ({
      id: r.id,
      user_id: r.user_id,
      display_name: r.display_name,
      email: ctx.role === 'owner' ? r.email : maskEmail(r.email),
      role: r.role,
      status: r.status,
      created_at: new Date(r.created_at).toISOString(),
      updated_at: new Date(r.updated_at).toISOString(),
    })),
  };
}

export async function addMerchantStaff(pool: Pool, actorId: string, email: string) {
  const ctx = await resolveMerchantMember(pool, actorId, true);
  const normalized = email.trim().toLowerCase();
  const userRes = await pool.query(
    `SELECT u.id, u.display_name, u.email, u.is_test,
            EXISTS (
              SELECT 1 FROM account_emails ae
               WHERE ae.user_id = u.id AND ae.is_verified = TRUE
            ) AS email_verified
       FROM users u
      WHERE (
        LOWER(u.email) = $1
        OR EXISTS (
          SELECT 1 FROM account_emails ae
           WHERE ae.user_id = u.id AND ae.normalized_email = $1 AND ae.is_verified = TRUE
        )
      )
      LIMIT 1`,
    [normalized],
  );
  const target = userRes.rows[0];
  if (!target || Boolean(target.is_test) !== ctx.isTest || !target.email_verified) {
    throw new WorkspaceError('STAFF_USER_NOT_FOUND', 404, 'No verified user account found with that email.');
  }

  const existingRes = await pool.query(
    `SELECT id, role, status FROM merchant_memberships WHERE merchant_id = $1 AND user_id = $2 LIMIT 1`,
    [ctx.merchantId, target.id],
  );
  const existing = existingRes.rows[0];
  if (existing?.role === 'owner' && existing?.status === 'active') {
    throw new WorkspaceError('ALREADY_MERCHANT_OWNER', 409, 'This user is already an active owner of this shop.');
  }

  if (!existing || existing.status !== 'active') {
    const activeStaffRes = await pool.query(
      `SELECT COUNT(*)::int AS cnt FROM merchant_memberships
        WHERE merchant_id = $1 AND role = 'staff' AND status = 'active'`,
      [ctx.merchantId],
    );
    if (Number(activeStaffRes.rows[0]?.cnt ?? 0) >= MAX_ACTIVE_MERCHANT_STAFF) {
      throw new WorkspaceError(
        'STAFF_LIMIT_REACHED',
        409,
        `A merchant can have at most ${MAX_ACTIVE_MERCHANT_STAFF} active staff members.`,
      );
    }
  }

  const membershipRes = await pool.query(
    `INSERT INTO merchant_memberships (id, merchant_id, user_id, role, status, created_at, updated_at)
     VALUES ($1, $2, $3, 'staff', 'active', NOW(), NOW())
     ON CONFLICT (merchant_id, user_id)
     DO UPDATE SET role = 'staff', status = 'active', updated_at = NOW()
     RETURNING id, merchant_id, user_id, role, status, created_at, updated_at`,
    [`mm_${randomUUID()}`, ctx.merchantId, target.id],
  );
  const row = membershipRes.rows[0];
  return {
    ...row,
    display_name: target.display_name,
    email: target.email,
    created_at: new Date(row.created_at).toISOString(),
    updated_at: new Date(row.updated_at).toISOString(),
  };
}

export async function revokeMerchantStaff(pool: Pool, actorId: string, staffUserId: string) {
  const ctx = await resolveMerchantMember(pool, actorId, true);
  const existing = await pool.query(
    `SELECT id, role, status FROM merchant_memberships WHERE merchant_id = $1 AND user_id = $2 LIMIT 1`,
    [ctx.merchantId, staffUserId],
  );
  if (!existing.rows.length) {
    throw new WorkspaceError('STAFF_NOT_FOUND', 404, 'Staff member not found.');
  }
  if (existing.rows[0].role === 'owner') {
    throw new WorkspaceError('CANNOT_REMOVE_OWNER', 409, 'Shop owners cannot be removed via staff management.');
  }
  const updated = await pool.query(
    `UPDATE merchant_memberships SET status = 'revoked', updated_at = NOW()
      WHERE merchant_id = $1 AND user_id = $2
      RETURNING id, user_id, role, status, updated_at`,
    [ctx.merchantId, staffUserId],
  );
  return {
    ...updated.rows[0],
    updated_at: new Date(updated.rows[0].updated_at).toISOString(),
  };
}

export async function getCounterHistory(pool: Pool, userId: string, rawLimit?: number) {
  const ctx = await resolveMerchantMember(pool, userId, false);
  const limit = Math.min(Math.max(Math.trunc(Number(rawLimit) || 50), 1), 100);
  const res = await pool.query(
    `SELECT kind, user_id, code, method, detail, actor_name, at
       FROM (
         SELECT 'visit'::text AS kind, v.user_id, NULL::text AS code, v.method, p.title AS detail,
                su.display_name AS actor_name, v.created_at AS at
           FROM suki_visits v
           JOIN suki_programs p ON p.id = v.program_id
           LEFT JOIN users su ON su.id = v.staff_user_id
          WHERE v.merchant_id = $1
         UNION ALL
         SELECT 'suki_reward'::text AS kind, r.user_id, r.code, 'counter'::text AS method, r.reward_text AS detail,
                cu.display_name AS actor_name, r.claimed_at AS at
           FROM suki_rewards r
           JOIN suki_programs p ON p.id = r.program_id
           LEFT JOIN users cu ON cu.id = r.claimed_by
          WHERE p.merchant_id = $1 AND r.status = 'claimed' AND r.claimed_at IS NOT NULL
         UNION ALL
         SELECT 'voucher'::text AS kind, red.user_id, red.code, red.source AS method, v.title AS detail,
                uu.display_name AS actor_name, red.used_at AS at
           FROM redemptions red
           JOIN vouchers v ON v.id = red.voucher_id
           LEFT JOIN users uu ON uu.id = red.used_by
          WHERE v.merchant_id = $1 AND red.used_at IS NOT NULL
       ) events
      ORDER BY at DESC
      LIMIT $2`,
    [ctx.merchantId, limit],
  );
  return {
    merchant_id: ctx.merchantId,
    items: res.rows.map((r: any) => ({
      kind: r.kind,
      customer: customerLabel(String(r.user_id), ctx.merchantId),
      code: r.code ?? null,
      method: r.method ?? null,
      detail: r.detail,
      staff_name: r.actor_name ?? null,
      at: new Date(r.at).toISOString(),
    })),
  };
}

export async function getMerchantAnalytics(pool: Pool, userId: string, rawDays?: number) {
  const ctx = await resolveMerchantMember(pool, userId, false);
  const days = Math.min(Math.max(Math.trunc(Number(rawDays) || 30), 7), 90);
  const windowParams = [ctx.merchantId, days];
  const windowStartExpr = `((NOW() AT TIME ZONE 'Asia/Manila')::date - ($2::int - 1))::timestamp AT TIME ZONE 'Asia/Manila'`;

  const [fundingRes, completionsRes, catalogRes, vouchersRes, sukiVisitsRes, sukiRewardsRes] = await Promise.all([
    pool.query(
      `SELECT
         (SELECT COUNT(*)::int FROM quest_sponsorships s
           JOIN quest_funding_plans p ON p.id = s.plan_id
          WHERE s.merchant_id = $1 AND s.status = 'accepted' AND p.status IN ('active', 'closing')) AS active_sponsorships,
         COALESCE(SUM(c.committed_points), 0)::bigint AS total_points_committed,
         COALESCE(SUM(c.paid_reward_points + c.paid_fee_points), 0)::bigint AS total_points_paid
       FROM quest_funding_contributions c
      WHERE c.merchant_id = $1 AND c.funder_kind = 'merchant'`,
      [ctx.merchantId],
    ),
    pool.query(
      `SELECT COUNT(DISTINCT h.id)::int AS funded_completions
         FROM quest_funding_holds h
         JOIN quest_sponsorships s ON s.plan_id = h.plan_id
        WHERE s.merchant_id = $1 AND s.status = 'accepted' AND h.status = 'paid'`,
      [ctx.merchantId],
    ),
    pool.query(`SELECT COUNT(*)::int AS active_catalog_count FROM vouchers WHERE merchant_id = $1 AND is_active = TRUE`, [
      ctx.merchantId,
    ]),
    pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE r.source = 'purchase' AND r.created_at >= ${windowStartExpr})::int AS shop_redeemed_in_window,
         COUNT(*) FILTER (WHERE r.source = 'quest_sponsor_perk' AND r.created_at >= ${windowStartExpr})::int AS perks_granted_in_window,
         COUNT(*) FILTER (WHERE r.used_at IS NOT NULL AND r.used_at >= ${windowStartExpr})::int AS confirmed_at_counter_in_window
       FROM redemptions r
       JOIN vouchers v ON v.id = r.voucher_id
      WHERE v.merchant_id = $1`,
      windowParams,
    ),
    pool.query(
      `SELECT
         COUNT(*)::int AS visits_in_window,
         COUNT(DISTINCT sv.user_id)::int AS unique_customers,
         (
           SELECT COUNT(*)::int FROM (
             SELECT sv2.user_id FROM suki_visits sv2
              WHERE sv2.merchant_id = $1 AND sv2.created_at >= ${windowStartExpr}
              GROUP BY sv2.user_id HAVING COUNT(*) >= 2
           ) rep
         ) AS repeat_customers
       FROM suki_visits sv
      WHERE sv.merchant_id = $1 AND sv.created_at >= ${windowStartExpr}`,
      windowParams,
    ),
    pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE sr.created_at >= ${windowStartExpr})::int AS rewards_issued,
         COUNT(*) FILTER (WHERE sr.status = 'claimed' AND sr.claimed_at >= ${windowStartExpr})::int AS rewards_claimed
       FROM suki_rewards sr
       JOIN suki_programs sp ON sp.id = sr.program_id
      WHERE sp.merchant_id = $1`,
      windowParams,
    ),
  ]);

  const f = fundingRes.rows[0] ?? {};
  const v = vouchersRes.rows[0] ?? {};
  const sv = sukiVisitsRes.rows[0] ?? {};
  const sr = sukiRewardsRes.rows[0] ?? {};

  return {
    merchant_id: ctx.merchantId,
    days,
    funding: {
      active_sponsorships: Number(f.active_sponsorships ?? 0),
      total_points_committed: Number(f.total_points_committed ?? 0),
      total_points_paid: Number(f.total_points_paid ?? 0),
      funded_completions: Number(completionsRes.rows[0]?.funded_completions ?? 0),
    },
    vouchers: {
      active_catalog_count: Number(catalogRes.rows[0]?.active_catalog_count ?? 0),
      shop_redeemed_in_window: Number(v.shop_redeemed_in_window ?? 0),
      perks_granted_in_window: Number(v.perks_granted_in_window ?? 0),
      confirmed_at_counter_in_window: Number(v.confirmed_at_counter_in_window ?? 0),
    },
    suki: {
      visits_in_window: Number(sv.visits_in_window ?? 0),
      unique_customers: Number(sv.unique_customers ?? 0),
      repeat_customers: Number(sv.repeat_customers ?? 0),
      rewards_issued: Number(sr.rewards_issued ?? 0),
      rewards_claimed: Number(sr.rewards_claimed ?? 0),
    },
  };
}

export interface PublicDirectoryQuery {
  municipality?: string;
  category?: string;
  q?: string;
  lat?: number;
  lng?: number;
  page?: number;
  limit?: number;
  isTest: boolean;
}

export async function listPublicMerchants(pool: Pool, query: PublicDirectoryQuery) {
  const page = Math.min(Math.max(Math.trunc(Number(query.page) || 1), 1), 1000);
  const limit = Math.min(Math.max(Math.trunc(Number(query.limit) || 20), 1), 50);
  const municipality = (query.municipality ?? '').trim().slice(0, 100);
  const category = (query.category ?? '').trim().slice(0, 50);
  const q = (query.q ?? '').trim().slice(0, 100);
  const hasOrigin =
    Number.isFinite(query.lat) &&
    Number.isFinite(query.lng) &&
    Math.abs(query.lat!) <= 90 &&
    Math.abs(query.lng!) <= 180;

  let sukiEnabled = false;
  try {
    const settingsRes = await pool.query('SELECT values FROM system_settings_document WHERE id = 1');
    sukiEnabled = canonicalSettings(settingsRes.rows[0]?.values ?? {}).suki_enabled === true;
  } catch {
    sukiEnabled = false;
  }

  const res = await pool.query(
    `SELECT m.id, m.name, m.category, m.municipality, m.location, m.description,
            m.logo_url, m.banner_url, m.spot_id,
            COALESCE(m.gps_lat, app.gps_lat) AS gps_lat,
            COALESCE(m.gps_lng, app.gps_lng) AS gps_lng,
            (SELECT COUNT(*)::int FROM vouchers v WHERE v.merchant_id = m.id AND v.is_active = TRUE) AS active_voucher_count,
            EXISTS (
              SELECT 1 FROM suki_programs sp WHERE sp.merchant_id = m.id AND sp.status = 'active'
            ) AS has_live_suki
       FROM merchants m
       LEFT JOIN merchant_affiliate_applications app ON app.id = m.source_application_id
      WHERE m.status = 'active'
        AND m.is_published = TRUE
        AND m.is_test = $1
        AND ($2 = '' OR LOWER(COALESCE(m.municipality, '')) = LOWER($2))
        AND ($3 = '' OR LOWER(COALESCE(m.category, '')) = LOWER($3))
        AND (
          $4 = ''
          OR m.name ILIKE '%' || $4 || '%'
          OR COALESCE(m.description, '') ILIKE '%' || $4 || '%'
          OR COALESCE(m.category, '') ILIKE '%' || $4 || '%'
          OR COALESCE(m.municipality, '') ILIKE '%' || $4 || '%'
        )
      ORDER BY m.name ASC, m.id ASC`,
    [query.isTest, municipality, category, q],
  );

  const enriched = res.rows.map((r: any) => {
    const gpsLat = r.gps_lat == null ? null : Number(r.gps_lat);
    const gpsLng = r.gps_lng == null ? null : Number(r.gps_lng);
    const distanceM =
      hasOrigin && gpsLat != null && gpsLng != null
        ? Math.round(calculateHaversineDistance(query.lat!, query.lng!, gpsLat, gpsLng))
        : null;
    return {
      id: r.id,
      name: r.name,
      category: r.category ?? null,
      municipality: r.municipality ?? null,
      location: r.location ?? null,
      description: r.description ?? '',
      logo_url: r.logo_url ?? null,
      banner_url: r.banner_url ?? null,
      spot_id: r.spot_id ?? null,
      gps_lat: gpsLat,
      gps_lng: gpsLng,
      distance_m: distanceM,
      active_voucher_count: Number(r.active_voucher_count ?? 0),
      has_active_suki: sukiEnabled && Boolean(r.has_live_suki),
    };
  });

  if (hasOrigin) {
    enriched.sort((a, b) => {
      if (a.distance_m == null && b.distance_m == null) return String(a.name).localeCompare(String(b.name));
      if (a.distance_m == null) return 1;
      if (b.distance_m == null) return -1;
      return a.distance_m - b.distance_m || String(a.name).localeCompare(String(b.name));
    });
  }

  const offset = (page - 1) * limit;
  return {
    items: enriched.slice(offset, offset + limit),
    page,
    limit,
    total: enriched.length,
  };
}
