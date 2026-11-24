import { randomUUID } from 'crypto';
import type { Pool, PoolClient } from 'pg';
import { canonicalSettings } from '../settings/schema.js';
import { calculateHaversineDistance, withinRadius } from '../db/index.js';
import { manilaDateString, nextManilaMidnightUtc } from '../stamps/time.js';
import { getStampEligibility } from '../stamps/service.js';
import { handleSukiVisit } from '../stamps/hooks.js';
import { progressionRepo } from '../progression/repository.js';
import { notify } from '../social/notify.js';
import { runIsolatedProducer } from '../social/activity.js';
import { scopeFilterSql, type AdminScope } from '../admin/scope.js';
import {
  customerLabel,
  formatCardNo,
  newRewardCode,
  normaliseCounterCode,
  parseStandee,
  signSukiPass,
  standeeUrl,
  SUKI_PASS_PREFIX,
  verifySukiPass,
} from './codes.js';

/** Plan 107 — Suki Card merchant loyalty cards. No mJDQ is created or moved here. */

export class SukiError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export interface SukiSettings {
  enabled: boolean;
  visitXp: number;
  xpVisitsPerDay: number;
  rewardDays: number;
  maxAccuracyM: number;
  pointsEnabled: boolean;
  maxPointsPerDay: number;
}

type Db = Pick<Pool, 'query'>;

export async function loadSukiSettings(db: Db): Promise<SukiSettings> {
  let stored: Record<string, unknown> = {};
  try {
    const result = await db.query('SELECT values FROM system_settings_document WHERE id = 1');
    stored = (result.rows[0]?.values ?? {}) as Record<string, unknown>;
  } catch {
    stored = {};
  }
  const values = canonicalSettings(stored);
  return {
    enabled: values.suki_enabled === true,
    visitXp: Number(values.suki_visit_explorer_xp),
    xpVisitsPerDay: Number(values.suki_xp_visits_per_day),
    rewardDays: Number(values.suki_reward_days),
    maxAccuracyM: Number(values.suki_max_accuracy_m),
    pointsEnabled: values.suki_points_enabled === true,
    maxPointsPerDay: Number(values.suki_max_points_per_day),
  };
}

const IMPOSSIBLE_SPEED_KMH = 150;
const REGULAR_VISITS = 5;
const MAX_POINTS_MENU_ITEMS = 12;
export const SUKI_REWARD_KINDS = ['free_item', 'percent_off', 'amount_off', 'promo'] as const;
export type SukiRewardKind = (typeof SUKI_REWARD_KINDS)[number];
export const SUKI_ICON_KEYS = ['gift', 'coffee', 'meal', 'snack', 'dessert', 'drink', 'discount', 'promo'] as const;
export type SukiIconKey = (typeof SUKI_ICON_KEYS)[number];
export const SUKI_SKIN_KEYS = ['jdq_classic'] as const;
export type SukiSkinKey = (typeof SUKI_SKIN_KEYS)[number];

export interface SukiTierSpec {
  visit_number: number;
  reward_kind: SukiRewardKind;
  reward_value: number | null;
  reward_text: string;
  icon_key: SukiIconKey;
}

interface ProgramRow {
  id: string;
  merchant_id: string;
  title: string;
  reward_kind: SukiRewardKind;
  reward_value: string | null;
  reward_text: string;
  visits_required: number;
  mode: 'standee' | 'staff_scan';
  radius_m: number;
  standee_version: number;
  status: 'draft' | 'active' | 'paused';
  paused_by: 'merchant' | 'admin' | null;
  pause_reason: string | null;
  is_test: boolean;
  points_enabled: boolean;
  points_per_visit: number;
  pesos_per_point: string | null;
  max_points_per_visit: number;
  points_expire_days: number | null;
  skin_key: string;
  merchant_name: string;
  merchant_status: string;
  merchant_published: boolean;
  merchant_municipality: string | null;
  merchant_logo_url: string | null;
  merchant_lat: number | null;
  merchant_lng: number | null;
}

const PROGRAM_COLUMNS = `p.*, m.name AS merchant_name, m.status AS merchant_status,
       m.is_published AS merchant_published, m.municipality AS merchant_municipality,
       m.logo_url AS merchant_logo_url, m.gps_lat AS merchant_lat, m.gps_lng AS merchant_lng`;
const PROGRAM_SELECT = `SELECT ${PROGRAM_COLUMNS} FROM suki_programs p JOIN merchants m ON m.id = p.merchant_id`;

const numberOrNull = (raw: string | number | null | undefined) =>
  raw === null || raw === undefined ? null : Number(raw);

/** A short label for the reward tag: "FREE", "10% OFF", "₱20 OFF" or "PROMO". */
export function rewardTag(kind: SukiRewardKind, value: number | null): string {
  if (kind === 'percent_off') return `${value}% OFF`;
  if (kind === 'amount_off') return `₱${value} OFF`;
  if (kind === 'promo') return 'PROMO';
  return 'FREE';
}

function tierView(t: any) {
  const value = numberOrNull(t.reward_value);
  return {
    visit_number: Number(t.visit_number),
    reward_kind: t.reward_kind as SukiRewardKind,
    reward_value: value,
    reward_text: String(t.reward_text),
    reward_tag: rewardTag(t.reward_kind as SukiRewardKind, value),
    icon_key: (t.icon_key ?? 'gift') as SukiIconKey,
  };
}

function fallbackTierFromProgram(p: Partial<ProgramRow> & { visits_required: number }): SukiTierSpec[] {
  const kind = (p.reward_kind ?? 'free_item') as SukiRewardKind;
  return [
    {
      visit_number: Number(p.visits_required),
      reward_kind: kind,
      reward_value: numberOrNull(p.reward_value),
      reward_text: p.reward_text ?? 'Suki reward',
      icon_key: 'gift',
    },
  ];
}

function parseCycleTiers(raw: unknown): SukiTierSpec[] | null {
  if (!raw) return null;
  const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!Array.isArray(parsed) || parsed.length === 0) return null;
  return parsed.map((t: any) => ({
    visit_number: Number(t.visit_number),
    reward_kind: t.reward_kind as SukiRewardKind,
    reward_value: numberOrNull(t.reward_value),
    reward_text: String(t.reward_text),
    icon_key: (t.icon_key ?? 'gift') as SukiIconKey,
  }));
}

function buildTierStates(tiers: SukiTierSpec[], cycleRewards: any[]) {
  return tiers.map((t) => {
    const match = cycleRewards.find(
      (r) => (r.source ?? 'visits') === 'visits' && Number(r.tier_visit) === t.visit_number,
    );
    const state: 'locked' | 'issued' | 'claimed' =
      match?.status === 'claimed' ? 'claimed' : match ? 'issued' : 'locked';
    return { ...tierView(t), state };
  });
}

function pointsConfigView(p: Partial<ProgramRow>, settings?: SukiSettings) {
  return {
    enabled: Boolean(settings ? settings.pointsEnabled && p.points_enabled : p.points_enabled),
    program_enabled: Boolean(p.points_enabled),
    per_visit: Number(p.points_per_visit ?? 10),
    pesos_per_point: numberOrNull(p.pesos_per_point),
    max_per_visit: Number(p.max_points_per_visit ?? 200),
    expire_days: p.points_expire_days ?? null,
  };
}

function pointsMenuItemView(row: any) {
  return {
    id: row.id as string,
    program_id: row.program_id as string,
    title: row.title as string,
    points_cost: Number(row.points_cost),
    icon_key: (row.icon_key ?? 'gift') as SukiIconKey,
    is_active: Boolean(row.is_active),
    sort_order: Number(row.sort_order ?? 0),
  };
}

function publicProgram(p: ProgramRow, distanceM?: number, tiers?: SukiTierSpec[], settings?: SukiSettings) {
  const value = numberOrNull(p.reward_value);
  return {
    id: p.id,
    title: p.title,
    reward_kind: p.reward_kind,
    reward_value: value,
    reward_text: p.reward_text,
    reward_tag: rewardTag(p.reward_kind, value),
    visits_required: p.visits_required,
    skin_key: (p.skin_key ?? 'jdq_classic') as SukiSkinKey,
    mode: p.mode,
    status: p.status,
    ...(tiers ? { tiers: tiers.map(tierView) } : {}),
    ...(settings ? { points: pointsConfigView(p, settings) } : {}),
    merchant: {
      id: p.merchant_id,
      name: p.merchant_name,
      municipality: p.merchant_municipality,
      logo_url: p.merchant_logo_url,
    },
    ...(distanceM !== undefined ? { distance_m: Math.round(distanceM) } : {}),
  };
}

function rewardView(r: any, now = new Date()) {
  if (!r) return null;
  const value = numberOrNull(r.reward_value);
  return {
    id: r.id as string,
    code: r.code as string,
    reward_kind: r.reward_kind as SukiRewardKind,
    reward_value: value,
    reward_text: r.reward_text as string,
    reward_tag: rewardTag(r.reward_kind, value),
    tier_visit: r.tier_visit ?? null,
    source: (r.source ?? 'visits') as 'visits' | 'points',
    points_cost: r.points_cost != null ? Number(r.points_cost) : null,
    status: r.status as 'issued' | 'claimed',
    expires_at: new Date(r.expires_at).toISOString(),
    expired: r.status === 'issued' && new Date(r.expires_at).getTime() <= now.getTime(),
    claimed_at: r.claimed_at ? new Date(r.claimed_at).toISOString() : null,
  };
}

function cardView(card: any, today: string, program?: Partial<ProgramRow>, settings?: SukiSettings) {
  return {
    card_id: card.id as string,
    card_no: formatCardNo(card.id as string),
    cycle: card.cycle as number,
    visits: card.visits as number,
    required: card.cycle_required as number,
    total_visits: card.total_visits as number,
    visited_today: card.last_visit_at ? manilaDateString(new Date(card.last_visit_at)) === today : false,
    last_visit_at: card.last_visit_at ? new Date(card.last_visit_at).toISOString() : null,
    points: {
      enabled: Boolean(settings?.pointsEnabled && program?.points_enabled),
      balance: Number(card.points_balance ?? 0),
      lifetime: Number(card.points_lifetime ?? 0),
      per_visit: Number(program?.points_per_visit ?? 10),
    },
  };
}

export interface VisitResult {
  visit_id: string;
  replayed: boolean;
  program: ReturnType<typeof publicProgram>;
  card: ReturnType<typeof cardView>;
  reward_issued: ReturnType<typeof rewardView>;
  rewards_issued: NonNullable<ReturnType<typeof rewardView>>[];
  points_awarded: number;
  xp_awarded: number;
  badges: string[];
  mission_completed: boolean;
  customer: string;
}

interface Membership {
  merchantId: string;
  role: string;
  merchantIsTest: boolean;
}

export interface TierInput {
  visit_number: number;
  reward_kind: SukiRewardKind;
  reward_value?: number | null;
  reward_text: string;
  icon_key?: SukiIconKey;
}

interface ProgramInput {
  title: string;
  reward_kind?: SukiRewardKind;
  reward_value?: number | null;
  reward_text?: string;
  visits_required?: number;
  tiers?: TierInput[];
  points_enabled?: boolean;
  points_per_visit?: number;
  pesos_per_point?: number | null;
  max_points_per_visit?: number;
  points_expire_days?: number | null;
  skin_key?: SukiSkinKey;
  mode?: 'standee' | 'staff_scan';
  radius_m?: number;
}

export class SukiService {
  constructor(private readonly pool: Pool) {}

  settings() {
    return loadSukiSettings(this.pool);
  }

  async requireEnabled() {
    const settings = await this.settings();
    if (!settings.enabled) throw new SukiError('SUKI_DISABLED', 503, 'Suki Cards are coming soon.');
    return settings;
  }

  // ---------- reads ----------

  private async program(id: string): Promise<ProgramRow | null> {
    const result = await this.pool.query(`${PROGRAM_SELECT} WHERE p.id = $1`, [id]);
    return (result.rows[0] as ProgramRow) ?? null;
  }

  private async loadTiersForPrograms(programIds: string[]): Promise<Map<string, SukiTierSpec[]>> {
    const map = new Map<string, SukiTierSpec[]>();
    if (!programIds.length) return map;
    const rows = (
      await this.pool.query(
        `SELECT program_id, visit_number, reward_kind, reward_value, reward_text, icon_key
           FROM suki_reward_tiers
          WHERE program_id = ANY($1)
          ORDER BY visit_number ASC`,
        [programIds],
      )
    ).rows;
    for (const r of rows) {
      const list = map.get(r.program_id) ?? [];
      list.push({
        visit_number: Number(r.visit_number),
        reward_kind: r.reward_kind as SukiRewardKind,
        reward_value: numberOrNull(r.reward_value),
        reward_text: String(r.reward_text),
        icon_key: (r.icon_key ?? 'gift') as SukiIconKey,
      });
      map.set(r.program_id, list);
    }
    return map;
  }

  private async loadPointsMenuForPrograms(programIds: string[], activeOnly = true) {
    const map = new Map<string, ReturnType<typeof pointsMenuItemView>[]>();
    if (!programIds.length) return map;
    const whereActive = activeOnly ? ' AND is_active = TRUE' : '';
    const rows = (
      await this.pool.query(
        `SELECT * FROM suki_point_items
          WHERE program_id = ANY($1)${whereActive}
          ORDER BY sort_order ASC, points_cost ASC, created_at ASC`,
        [programIds],
      )
    ).rows;
    for (const r of rows) {
      const list = map.get(r.program_id) ?? [];
      list.push(pointsMenuItemView(r));
      map.set(r.program_id, list);
    }
    return map;
  }

  async listMyCards(userId: string, now = new Date()) {
    const today = manilaDateString(now);
    const [settings, holderRes, cards, rewards] = await Promise.all([
      this.settings(),
      this.pool.query('SELECT display_name, handle, created_at FROM users WHERE id = $1', [userId]),
      this.pool.query(
        `SELECT ${PROGRAM_COLUMNS}, c.id AS card_id, c.cycle, c.cycle_required, c.visits, c.total_visits,
                c.last_visit_at, c.points_balance, c.points_lifetime, c.cycle_tiers
           FROM suki_cards c
           JOIN suki_programs p ON p.id = c.program_id
           JOIN merchants m ON m.id = p.merchant_id
          WHERE c.user_id = $1
          ORDER BY c.last_visit_at DESC NULLS LAST, c.created_at DESC`,
        [userId],
      ),
      this.pool.query(`SELECT * FROM suki_rewards WHERE user_id = $1 ORDER BY created_at ASC`, [userId]),
    ]);
    const h = holderRes.rows[0];
    const holder = h
      ? {
          display_name: (h.display_name as string) || 'Traveler',
          handle: (h.handle as string | null) ?? null,
          member_since: h.created_at ? new Date(h.created_at).toISOString() : null,
        }
      : null;

    const programIds = Array.from(new Set(cards.rows.map((r: any) => String(r.id))));
    const [tiersByProgram, menuByProgram] = await Promise.all([
      this.loadTiersForPrograms(programIds),
      this.loadPointsMenuForPrograms(programIds, true),
    ]);

    const byCard = new Map<string, any[]>();
    for (const r of rewards.rows) {
      const list = byCard.get(r.card_id) ?? [];
      list.push(r);
      byCard.set(r.card_id, list);
    }
    return {
      holder,
      cards: cards.rows.map((row: any) => {
        const rawRewards = byCard.get(row.card_id) ?? [];
        const all = rawRewards.map((r) => rewardView(r, now)!);
        const open = all.filter((r) => r.status === 'issued');
        // `reward` (§6.4): the oldest claimable reward, else the latest one (claimed or expired) so the card
        // can show "Claimed"/"Expired"; `rewards` lists every unclaimed reward (additive).
        const reward = open.find((r) => !r.expired) ?? all[all.length - 1] ?? null;
        const programTiers = tiersByProgram.get(row.id) ?? fallbackTierFromProgram(row);
        const cardTiers = parseCycleTiers(row.cycle_tiers) ?? programTiers;
        const cycleRewards = rawRewards.filter((r) => Number(r.cycle) === Number(row.cycle));
        const tiers = buildTierStates(cardTiers, cycleRewards);
        const pointsOn = settings.pointsEnabled && Boolean(row.points_enabled);
        const cardObj = cardView({ ...row, id: row.card_id }, today, row, settings);
        return {
          ...cardObj,
          skin_key: (row.skin_key ?? 'jdq_classic') as SukiSkinKey,
          holder,
          tiers,
          program: publicProgram(row, undefined, programTiers, settings),
          points_menu: pointsOn ? (menuByProgram.get(row.id) ?? []) : [],
          reward,
          rewards: open,
        };
      }),
    };
  }

  async listPrograms(input: { userId?: string; lat?: number; lng?: number; limit?: number }) {
    const [settings, eligibility] = await Promise.all([
      this.settings(),
      input.userId ? getStampEligibility(this.pool, input.userId) : Promise.resolve({ isTest: false, eligible: true }),
    ]);
    const isTest = eligibility.isTest;
    const result = await this.pool.query(
      `${PROGRAM_SELECT}
        WHERE p.status = 'active' AND m.status = 'active' AND m.is_published = TRUE AND p.is_test = $1
          -- v0.3.10: never list the viewer's own shop among the shops near them.
          AND NOT EXISTS (SELECT 1 FROM merchant_memberships mm
                           WHERE mm.merchant_id = m.id AND mm.user_id = $2 AND mm.status = 'active')`,
      [isTest, input.userId ?? ''],
    );
    const limit = Math.min(Math.max(Number(input.limit) || 20, 1), 30);
    const hasPoint = Number.isFinite(input.lat) && Number.isFinite(input.lng);
    const rows = (result.rows as ProgramRow[]).map((p) => ({
      p,
      distance:
        hasPoint && p.merchant_lat != null && p.merchant_lng != null
          ? calculateHaversineDistance(input.lat!, input.lng!, p.merchant_lat, p.merchant_lng)
          : undefined,
    }));
    if (hasPoint) rows.sort((a, b) => (a.distance ?? Number.MAX_VALUE) - (b.distance ?? Number.MAX_VALUE));
    else rows.sort((a, b) => a.p.merchant_name.localeCompare(b.p.merchant_name));
    const sliced = rows.slice(0, limit);
    const tiersMap = await this.loadTiersForPrograms(sliced.map(({ p }) => p.id));
    return {
      programs: sliced.map(({ p, distance }) =>
        publicProgram(p, distance, tiersMap.get(p.id) ?? fallbackTierFromProgram(p), settings),
      ),
    };
  }

  /** Public read for the web landing page and the app's card page. */
  async getProgram(id: string, userId?: string, now = new Date()) {
    const p = await this.program(id);
    if (!p || p.merchant_status !== 'active' || !p.merchant_published || p.status === 'draft')
      throw new SukiError('SUKI_NOT_FOUND', 404, 'This Suki Card was not found.');
    const [settings, tiersMap, menuMap] = await Promise.all([
      this.settings(),
      this.loadTiersForPrograms([p.id]),
      this.loadPointsMenuForPrograms([p.id], true),
    ]);
    const tiers = tiersMap.get(p.id) ?? fallbackTierFromProgram(p);
    const pointsOn = settings.pointsEnabled && Boolean(p.points_enabled);
    const pointsMenu = pointsOn ? (menuMap.get(p.id) ?? []) : [];

    let myCard: (ReturnType<typeof cardView> & { tiers?: ReturnType<typeof buildTierStates> }) | null = null;
    let rewards: Array<ReturnType<typeof rewardView>> = [];
    if (userId) {
      const card = (
        await this.pool.query('SELECT * FROM suki_cards WHERE program_id = $1 AND user_id = $2', [id, userId])
      ).rows[0];
      if (card) {
        const allRewards = (
          await this.pool.query(`SELECT * FROM suki_rewards WHERE card_id = $1 ORDER BY created_at`, [card.id])
        ).rows;
        const cardTiers = parseCycleTiers(card.cycle_tiers) ?? tiers;
        const cycleRewards = allRewards.filter((r: any) => Number(r.cycle) === Number(card.cycle));
        myCard = {
          ...cardView(card, manilaDateString(now), p, settings),
          tiers: buildTierStates(cardTiers, cycleRewards),
        };
        rewards = allRewards.filter((r: any) => r.status === 'issued').map((r: any) => rewardView(r, now));
      }
    }
    return {
      program: publicProgram(p, undefined, tiers, settings),
      points_menu: pointsMenu,
      my_card: myCard,
      rewards,
    };
  }

  async listMyRedemptions(userId: string) {
    const result = await this.pool.query(
      `SELECT r.id, r.code, r.cost_points, r.source, r.created_at, r.used_at,
              v.id AS voucher_id, v.title, v.description, m.id AS merchant_id, m.name AS merchant_name
         FROM redemptions r
         JOIN vouchers v ON v.id = r.voucher_id
         JOIN merchants m ON m.id = v.merchant_id
        WHERE r.user_id = $1
        ORDER BY r.created_at DESC
        LIMIT 100`,
      [userId],
    );
    return {
      items: result.rows.map((r: any) => ({
        id: r.id,
        code: r.code,
        cost_points: r.cost_points,
        source: r.source,
        created_at: new Date(r.created_at).toISOString(),
        used_at: r.used_at ? new Date(r.used_at).toISOString() : null,
        voucher: { id: r.voucher_id, title: r.title, description: r.description },
        merchant: { id: r.merchant_id, name: r.merchant_name },
      })),
    };
  }

  // ---------- customer commands ----------

  private assertProgramLive(p: ProgramRow | null): asserts p is ProgramRow {
    if (!p) throw new SukiError('SUKI_NOT_FOUND', 404, 'This Suki Card was not found.');
    if (p.status !== 'active' || p.merchant_status !== 'active' || !p.merchant_published)
      throw new SukiError('SUKI_NOT_ACTIVE', 409, 'This Suki Card is not active right now.');
  }

  private async assertCustomer(p: ProgramRow, userId: string) {
    const eligibility = await getStampEligibility(this.pool, userId);
    if (!eligibility.eligible)
      throw new SukiError('EMAIL_NOT_VERIFIED', 403, 'Verify your email to collect Suki visits.');
    if (eligibility.isTest !== Boolean(p.is_test))
      throw new SukiError('SUKI_NOT_FOUND', 404, 'This Suki Card was not found.');
    const member = await this.pool.query(
      'SELECT 1 FROM merchant_memberships WHERE merchant_id = $1 AND user_id = $2 LIMIT 1',
      [p.merchant_id, userId],
    );
    if (member.rows.length)
      throw new SukiError('SELF_VISIT_FORBIDDEN', 403, 'Shop members cannot collect visits on their own card.');
  }

  async recordStandeeVisit(
    userId: string,
    input: { standee: string; lat: number; lng: number; accuracy_m: number; idempotency_key: string },
    now = new Date(),
  ): Promise<VisitResult> {
    const settings = await this.requireEnabled();
    const replay = await this.replay(userId, input.idempotency_key, now);
    if (replay) return replay;
    const parsed = parseStandee(input.standee);
    if (!parsed || !parsed.signatureOk)
      throw new SukiError('STANDEE_INVALID', 400, 'That is not a valid Suki Card QR.');
    const p = await this.program(parsed.programId);
    if (!p) throw new SukiError('STANDEE_INVALID', 400, 'That is not a valid Suki Card QR.');
    if (parsed.version !== p.standee_version)
      throw new SukiError('STANDEE_REPLACED', 409, 'This QR was replaced. Ask the shop for the new one.');
    this.assertProgramLive(p);
    if (p.mode !== 'standee')
      throw new SukiError('SUKI_STAFF_SCAN_ONLY', 409, 'This shop scans your pass. Show your Suki pass to the staff.');
    await this.assertCustomer(p, userId);
    if (p.merchant_lat == null || p.merchant_lng == null)
      throw new SukiError('SHOP_LOCATION_MISSING', 409, 'This shop has not pinned its location yet.');
    if (!Number.isFinite(input.accuracy_m) || input.accuracy_m > settings.maxAccuracyM)
      throw new SukiError('LOCATION_ACCURACY_TOO_LOW', 422, 'Your GPS is weak. Step outside or wait a moment.');
    const range = withinRadius(input.lat, input.lng, p.merchant_lat, p.merchant_lng, p.radius_m, input.accuracy_m);
    if (!range.ok)
      throw new SukiError('OUT_OF_RANGE', 422, 'You need to be at the shop to collect a visit.', {
        distance_m: Math.round(range.distance),
      });
    return this.recordVisit({
      programId: p.id,
      userId,
      method: 'standee',
      lat: input.lat,
      lng: input.lng,
      accuracyM: input.accuracy_m,
      staffId: null,
      passJti: null,
      idempotencyKey: input.idempotency_key,
      settings,
      now,
    });
  }

  async issuePass(userId: string, programId: string) {
    await this.requireEnabled();
    const p = await this.program(programId);
    this.assertProgramLive(p);
    await this.assertCustomer(p, userId);
    const { pass, expiresAt } = signSukiPass(p.id, userId);
    return { pass, expires_at: expiresAt };
  }

  async passStatus(userId: string, programId: string, now = new Date()) {
    const [settings, p, card] = await Promise.all([
      this.settings(),
      this.program(programId),
      this.pool.query('SELECT * FROM suki_cards WHERE program_id = $1 AND user_id = $2', [programId, userId]),
    ]);
    const row = card.rows[0];
    if (!row) return { visited_today: false, card: null };
    const view = cardView(row, manilaDateString(now), p ?? undefined, settings);
    return { visited_today: view.visited_today, card: view };
  }

  private async replay(userId: string, key: string, now: Date): Promise<VisitResult | null> {
    const visit = (
      await this.pool.query(
        'SELECT id, card_id, program_id, merchant_id FROM suki_visits WHERE user_id = $1 AND idempotency_key = $2',
        [userId, key],
      )
    ).rows[0];
    if (!visit) return null;
    const [settings, p, card] = await Promise.all([
      this.settings(),
      this.program(visit.program_id),
      this.pool.query('SELECT * FROM suki_cards WHERE id = $1', [visit.card_id]),
    ]);
    return {
      visit_id: visit.id,
      replayed: true,
      program: publicProgram(p!),
      card: cardView(card.rows[0], manilaDateString(now), p ?? undefined, settings),
      reward_issued: null,
      rewards_issued: [],
      points_awarded: 0,
      xp_awarded: 0,
      badges: [],
      mission_completed: false,
      customer: customerLabel(userId, visit.merchant_id),
    };
  }

  /** The one write path for a visit (standee or staff scan). */
  private async recordVisit(input: {
    programId: string;
    userId: string;
    method: 'standee' | 'staff_scan';
    lat: number | null;
    lng: number | null;
    accuracyM: number | null;
    staffId: string | null;
    passJti: string | null;
    idempotencyKey: string | null;
    amountSpent?: number | null;
    settings: SukiSettings;
    now: Date;
  }): Promise<VisitResult> {
    const { now, settings } = input;
    const today = manilaDateString(now);
    const client = await this.pool.connect();
    let result: VisitResult;
    try {
      await client.query('BEGIN');
      const p = (await client.query(`${PROGRAM_SELECT} WHERE p.id = $1 FOR UPDATE OF p`, [input.programId])).rows[0] as
        ProgramRow | undefined;
      this.assertProgramLive(p ?? null);
      const program = p as ProgramRow;
      const tierRows = (
        await client.query(
          `SELECT visit_number, reward_kind, reward_value, reward_text, icon_key
             FROM suki_reward_tiers WHERE program_id = $1 ORDER BY visit_number ASC`,
          [program.id],
        )
      ).rows;
      const programTiers: SukiTierSpec[] = tierRows.length
        ? tierRows.map((t: any) => ({
            visit_number: Number(t.visit_number),
            reward_kind: t.reward_kind as SukiRewardKind,
            reward_value: numberOrNull(t.reward_value),
            reward_text: String(t.reward_text),
            icon_key: (t.icon_key ?? 'gift') as SukiIconKey,
          }))
        : fallbackTierFromProgram(program);

      await client.query(
        `INSERT INTO suki_cards (id, program_id, user_id, cycle_required, cycle_tiers, is_test)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6) ON CONFLICT (program_id, user_id) DO NOTHING`,
        [
          `sukic_${randomUUID()}`,
          program.id,
          input.userId,
          program.visits_required,
          JSON.stringify(programTiers),
          program.is_test,
        ],
      );
      const card = (
        await client.query('SELECT * FROM suki_cards WHERE program_id = $1 AND user_id = $2 FOR UPDATE', [
          program.id,
          input.userId,
        ])
      ).rows[0];
      if (card.last_visit_at && manilaDateString(new Date(card.last_visit_at)) === today)
        throw new SukiError('ALREADY_VISITED_TODAY', 409, 'You already visited today. Come back tomorrow!', {
          next_at: nextManilaMidnightUtc(now).toISOString(),
        });

      const flagged = await this.impossibleTravel(client, input.userId, program, now);
      const visitId = `sukiv_${randomUUID()}`;
      await client.query(
        `INSERT INTO suki_visits (id, card_id, program_id, merchant_id, user_id, method, manila_date, lat, lng,
                                  accuracy_m, staff_user_id, pass_jti, idempotency_key, flagged_reason, is_test, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        [
          visitId,
          card.id,
          program.id,
          program.merchant_id,
          input.userId,
          input.method,
          today,
          input.lat,
          input.lng,
          input.accuracyM,
          input.staffId,
          input.passJti,
          input.idempotencyKey,
          flagged,
          program.is_test,
          now.toISOString(),
        ],
      );

      const cycleTiers =
        parseCycleTiers(card.cycle_tiers) ??
        (Number(card.cycle_required) === Number(program.visits_required)
          ? programTiers
          : fallbackTierFromProgram({ ...program, visits_required: Number(card.cycle_required) }));

      let visits = Number(card.visits) + 1;
      let cycle = Number(card.cycle);
      let cycleRequired = Number(card.cycle_required);
      let nextCycleTiers = cycleTiers;

      const unlockedTiers = cycleTiers.filter((t) => Number(t.visit_number) === visits);
      const issuedRewards: any[] = [];
      for (const tier of unlockedTiers) {
        const rw = await this.insertReward(client, (code) => ({
          id: `sukir_${randomUUID()}`,
          cardId: card.id,
          programId: program.id,
          userId: input.userId,
          cycle,
          tierVisit: tier.visit_number,
          source: 'visits',
          pointsCost: null,
          idempotencyKey: null,
          rewardKind: tier.reward_kind,
          rewardValue: tier.reward_value,
          rewardText: tier.reward_text,
          code,
          expiresAt: new Date(now.getTime() + settings.rewardDays * 86_400_000).toISOString(),
          isTest: program.is_test,
          createdAt: now.toISOString(),
        }));
        issuedRewards.push(rw);
      }

      if (visits >= cycleRequired) {
        visits = 0;
        cycle += 1;
        cycleRequired = program.visits_required;
        nextCycleTiers = programTiers;
      }

      const pointsAwarded = await this.awardPoints(client, {
        cardId: card.id,
        program,
        userId: input.userId,
        visitId,
        method: input.method,
        staffId: input.staffId,
        amountSpent: input.amountSpent ?? null,
        settings,
        now,
      });

      const updated = (
        await client.query(
          `UPDATE suki_cards
              SET visits = $2,
                  cycle = $3,
                  cycle_required = $4,
                  cycle_tiers = $5::jsonb,
                  total_visits = total_visits + 1,
                  points_balance = points_balance + $6,
                  points_lifetime = points_lifetime + $6,
                  first_visit_at = COALESCE(first_visit_at, $7),
                  last_visit_at = $7
            WHERE id = $1 RETURNING *`,
          [card.id, visits, cycle, cycleRequired, JSON.stringify(nextCycleTiers), pointsAwarded, now.toISOString()],
        )
      ).rows[0];

      const xp = await this.awardXp(client, input.userId, visitId, today, program.is_test, settings);
      const badges = await this.awardBadges(client, input.userId, visitId, program.is_test, now);
      for (const rw of issuedRewards) {
        await runIsolatedProducer(client, '[suki] reward notification failed:', async () => {
          await notify(client, {
            userId: input.userId,
            kind: 'suki_reward',
            eventKey: `suki_reward:${rw.id}`,
            title: 'Suki reward unlocked',
            message: `${rw.reward_text} at ${program.merchant_name}`,
            href: `/suki/${program.id}`,
            isTest: program.is_test,
            push: { category: 'account', collapseKey: `suki:${program.id}` },
          });
        });
      }
      await client.query('COMMIT');
      const issuedViews = issuedRewards.map((rw) => rewardView(rw, now)!);
      result = {
        visit_id: visitId,
        replayed: false,
        program: publicProgram(program, undefined, programTiers, settings),
        card: cardView(updated, today, program, settings),
        reward_issued: issuedViews[0] ?? null,
        rewards_issued: issuedViews,
        points_awarded: pointsAwarded,
        xp_awarded: xp,
        badges,
        mission_completed: false,
        customer: customerLabel(input.userId, program.merchant_id),
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw this.mapConstraint(error, now);
    } finally {
      client.release();
    }
    // After commit: the on-site check_in mission takes the pool, not this transaction.
    const mission = await handleSukiVisit(this.pool, { userId: input.userId, visitId: result.visit_id, now });
    result.mission_completed = Boolean((mission as { completed?: boolean } | null)?.completed);
    return result;
  }

  /** Inserts a reward, retrying a fresh code on the (unlikely) unique-code clash, like voucher codes. */
  private async insertReward(
    client: PoolClient,
    build: (code: string) => {
      id: string;
      cardId: string;
      programId: string;
      userId: string;
      cycle: number;
      tierVisit: number | null;
      source: 'visits' | 'points';
      pointsCost: number | null;
      idempotencyKey: string | null;
      rewardKind: SukiRewardKind;
      rewardValue: number | null;
      rewardText: string;
      code: string;
      expiresAt: string;
      isTest: boolean;
      createdAt: string;
    },
  ) {
    for (let attempt = 0; ; attempt += 1) {
      await client.query('SAVEPOINT suki_reward_code');
      try {
        const v = build(newRewardCode());
        const row = (
          await client.query(
            `INSERT INTO suki_rewards (
               id, card_id, program_id, user_id, cycle, tier_visit, source, points_cost, idempotency_key,
               reward_kind, reward_value, reward_text, code, expires_at, is_test, created_at
             )
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
            [
              v.id,
              v.cardId,
              v.programId,
              v.userId,
              v.cycle,
              v.tierVisit,
              v.source,
              v.pointsCost,
              v.idempotencyKey,
              v.rewardKind,
              v.rewardValue,
              v.rewardText,
              v.code,
              v.expiresAt,
              v.isTest,
              v.createdAt,
            ],
          )
        ).rows[0];
        await client.query('RELEASE SAVEPOINT suki_reward_code');
        return row;
      } catch (error) {
        const pg = error as { code?: string; constraint?: string };
        if (pg?.code !== '23505' || pg.constraint !== 'suki_rewards_code_key' || attempt >= 4) throw error;
        await client.query('ROLLBACK TO SAVEPOINT suki_reward_code');
      }
    }
  }

  private async awardPoints(
    client: PoolClient,
    input: {
      cardId: string;
      program: ProgramRow;
      userId: string;
      visitId: string;
      method: 'standee' | 'staff_scan';
      staffId: string | null;
      amountSpent: number | null;
      settings: SukiSettings;
      now: Date;
    },
  ): Promise<number> {
    if (!input.settings.pointsEnabled || !input.program.points_enabled) return 0;
    const endUtc = nextManilaMidnightUtc(input.now);
    const startUtc = new Date(endUtc.getTime() - 86_400_000);
    const todayRow = (
      await client.query(
        `SELECT COALESCE(SUM(delta), 0)::int AS n
           FROM suki_point_ledger
          WHERE user_id = $1 AND reason IN ('visit','spend') AND delta > 0
            AND created_at >= $2 AND created_at < $3`,
        [input.userId, startUtc.toISOString(), endUtc.toISOString()],
      )
    ).rows[0];
    let remaining = Math.max(0, input.settings.maxPointsPerDay - Number(todayRow?.n ?? 0));
    if (remaining <= 0) return 0;

    const visitPts = Math.min(Math.max(0, Number(input.program.points_per_visit ?? 0)), remaining);
    if (visitPts > 0) {
      remaining -= visitPts;
      await client.query(
        `INSERT INTO suki_point_ledger (id, card_id, program_id, user_id, delta, reason, visit_id, staff_user_id, is_test, created_at)
         VALUES ($1,$2,$3,$4,$5,'visit',$6,$7,$8,$9)`,
        [
          `sukipt_${randomUUID()}`,
          input.cardId,
          input.program.id,
          input.userId,
          visitPts,
          input.visitId,
          input.staffId,
          input.program.is_test,
          input.now.toISOString(),
        ],
      );
    }

    let spendPts = 0;
    const pesosPerPoint = numberOrNull(input.program.pesos_per_point);
    if (
      input.method === 'staff_scan' &&
      input.amountSpent != null &&
      Number.isFinite(input.amountSpent) &&
      input.amountSpent > 0 &&
      pesosPerPoint != null &&
      pesosPerPoint > 0 &&
      remaining > 0
    ) {
      const raw = Math.floor(input.amountSpent / pesosPerPoint);
      const cappedPerVisit = Math.min(raw, Math.max(1, Number(input.program.max_points_per_visit ?? 200)));
      spendPts = Math.min(cappedPerVisit, remaining);
      if (spendPts > 0) {
        await client.query(
          `INSERT INTO suki_point_ledger (id, card_id, program_id, user_id, delta, reason, visit_id, amount_spent, staff_user_id, is_test, created_at)
           VALUES ($1,$2,$3,$4,$5,'spend',$6,$7,$8,$9,$10)`,
          [
            `sukipt_${randomUUID()}`,
            input.cardId,
            input.program.id,
            input.userId,
            spendPts,
            input.visitId,
            input.amountSpent,
            input.staffId,
            input.program.is_test,
            input.now.toISOString(),
          ],
        );
      }
    }

    return visitPts + spendPts;
  }

  async redeemPoints(userId: string, body: { item_id: string; idempotency_key: string }, now = new Date()) {
    const settings = await this.requireEnabled();
    if (!settings.pointsEnabled) throw new SukiError('POINTS_DISABLED', 503, 'Suki Points are not enabled right now.');

    const today = manilaDateString(now);
    const replayExisting = await this.pool.query(
      'SELECT * FROM suki_rewards WHERE user_id = $1 AND idempotency_key = $2',
      [userId, body.idempotency_key],
    );
    if (replayExisting.rows[0]) {
      const rw = replayExisting.rows[0];
      const [p, cardRow] = await Promise.all([
        this.program(rw.program_id),
        this.pool.query('SELECT * FROM suki_cards WHERE id = $1', [rw.card_id]),
      ]);
      return {
        replayed: true,
        reward: rewardView(rw, now),
        card: cardView(cardRow.rows[0], today, p ?? undefined, settings),
      };
    }

    const itemRes = await this.pool.query(
      `SELECT i.id AS item_id, i.title AS item_title, i.points_cost AS item_points_cost,
              i.icon_key AS item_icon_key, i.is_active AS item_is_active, ${PROGRAM_COLUMNS}
         FROM suki_point_items i
         JOIN suki_programs p ON p.id = i.program_id
         JOIN merchants m ON m.id = p.merchant_id
        WHERE i.id = $1`,
      [body.item_id],
    );
    const item = itemRes.rows[0];
    if (!item || !item.item_is_active)
      throw new SukiError('POINTS_ITEM_NOT_FOUND', 404, 'This points reward is not available.');
    const programRow = item as ProgramRow;
    this.assertProgramLive(programRow);
    if (!programRow.points_enabled)
      throw new SukiError('POINTS_DISABLED', 409, 'This shop does not use Suki Points right now.');
    await this.assertCustomer(programRow, userId);

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const dupInTx = await client.query('SELECT * FROM suki_rewards WHERE user_id = $1 AND idempotency_key = $2', [
        userId,
        body.idempotency_key,
      ]);
      if (dupInTx.rows[0]) {
        const rw = dupInTx.rows[0];
        const cardRow = (await client.query('SELECT * FROM suki_cards WHERE id = $1', [rw.card_id])).rows[0];
        await client.query('ROLLBACK');
        return {
          replayed: true,
          reward: rewardView(rw, now),
          card: cardView(cardRow, today, programRow, settings),
        };
      }

      const card = (
        await client.query('SELECT * FROM suki_cards WHERE program_id = $1 AND user_id = $2 FOR UPDATE', [
          programRow.id,
          userId,
        ])
      ).rows[0];
      const cost = Number(item.item_points_cost);
      if (!card || Number(card.points_balance ?? 0) < cost)
        throw new SukiError('POINTS_INSUFFICIENT', 409, 'You do not have enough Suki Points for this reward.', {
          balance: Number(card?.points_balance ?? 0),
          cost,
        });

      const reward = await this.insertReward(client, (code) => ({
        id: `sukir_${randomUUID()}`,
        cardId: card.id,
        programId: programRow.id,
        userId,
        cycle: Number(card.cycle),
        tierVisit: null,
        source: 'points',
        pointsCost: cost,
        idempotencyKey: body.idempotency_key,
        rewardKind: 'free_item',
        rewardValue: null,
        rewardText: String(item.item_title),
        code,
        expiresAt: new Date(now.getTime() + settings.rewardDays * 86_400_000).toISOString(),
        isTest: Boolean(programRow.is_test),
        createdAt: now.toISOString(),
      }));

      await client.query(
        `INSERT INTO suki_point_ledger (id, card_id, program_id, user_id, delta, reason, reward_id, is_test, created_at)
         VALUES ($1,$2,$3,$4,$5,'redeem',$6,$7,$8)`,
        [
          `sukipt_${randomUUID()}`,
          card.id,
          programRow.id,
          userId,
          -cost,
          reward.id,
          Boolean(programRow.is_test),
          now.toISOString(),
        ],
      );

      const updatedCard = (
        await client.query('UPDATE suki_cards SET points_balance = points_balance - $2 WHERE id = $1 RETURNING *', [
          card.id,
          cost,
        ])
      ).rows[0];

      await runIsolatedProducer(client, '[suki] points reward notification failed:', async () => {
        await notify(client, {
          userId,
          kind: 'suki_reward',
          eventKey: `suki_reward:${reward.id}`,
          title: 'Suki points reward redeemed',
          message: `${item.item_title} at ${programRow.merchant_name}`,
          href: `/suki/${programRow.id}`,
          isTest: Boolean(programRow.is_test),
          push: { category: 'account', collapseKey: `suki:${programRow.id}` },
        });
      });

      await client.query('COMMIT');
      return {
        replayed: false,
        reward: rewardView(reward, now),
        card: cardView(updatedCard, today, programRow, settings),
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      const pg = error as { code?: string; constraint?: string };
      if (pg?.code === '23505' && pg.constraint === 'uq_suki_rewards_user_idempotency') {
        const rw = (
          await this.pool.query('SELECT * FROM suki_rewards WHERE user_id = $1 AND idempotency_key = $2', [
            userId,
            body.idempotency_key,
          ])
        ).rows[0];
        if (rw) {
          const cardRow = (await this.pool.query('SELECT * FROM suki_cards WHERE id = $1', [rw.card_id])).rows[0];
          return {
            replayed: true,
            reward: rewardView(rw, now),
            card: cardView(cardRow, today, programRow, settings),
          };
        }
      }
      throw this.mapConstraint(error, now);
    } finally {
      client.release();
    }
  }

  async listCardPoints(userId: string, cardId: string, opts: { cursor?: string; limit?: number } = {}) {
    const card = (await this.pool.query('SELECT * FROM suki_cards WHERE id = $1 AND user_id = $2', [cardId, userId]))
      .rows[0];
    if (!card) throw new SukiError('SUKI_NOT_FOUND', 404, 'This Suki Card was not found.');

    const limit = Math.min(Math.max(Math.trunc(Number(opts.limit) || 25), 1), 50);
    let cursorCreatedAt: string | null = null;
    let cursorId: string | null = null;
    if (opts.cursor) {
      const idx = opts.cursor.indexOf('|');
      if (idx > 0) {
        const ts = opts.cursor.slice(0, idx);
        const id = opts.cursor.slice(idx + 1);
        if (!Number.isNaN(Date.parse(ts)) && id) {
          cursorCreatedAt = ts;
          cursorId = id;
        }
      }
    }

    const params: unknown[] = [card.id];
    let cursorSql = '';
    if (cursorCreatedAt && cursorId) {
      params.push(cursorCreatedAt, cursorId);
      cursorSql = ' AND (created_at < $2 OR (created_at = $2 AND id < $3))';
    }
    params.push(limit + 1);
    const rows = (
      await this.pool.query(
        `SELECT id, delta, reason, visit_id, reward_id, amount_spent, created_at
           FROM suki_point_ledger
          WHERE card_id = $1${cursorSql}
          ORDER BY created_at DESC, id DESC
          LIMIT $${params.length}`,
        params,
      )
    ).rows;
    const hasMore = rows.length > limit;
    const slice = rows.slice(0, limit);
    const last = slice[slice.length - 1];
    return {
      card_id: card.id as string,
      balance: Number(card.points_balance ?? 0),
      lifetime: Number(card.points_lifetime ?? 0),
      items: slice.map((r: any) => ({
        id: r.id as string,
        delta: Number(r.delta),
        reason: r.reason as 'visit' | 'spend' | 'redeem' | 'expire' | 'admin_adjust',
        visit_id: (r.visit_id as string | null) ?? null,
        reward_id: (r.reward_id as string | null) ?? null,
        amount_spent: numberOrNull(r.amount_spent),
        created_at: new Date(r.created_at).toISOString(),
      })),
      next_cursor: hasMore && last ? `${new Date(last.created_at).toISOString()}|${last.id}` : null,
    };
  }

  private mapConstraint(error: unknown, now: Date) {
    const pg = error as { code?: string; constraint?: string };
    if (pg?.code !== '23505') return error;
    if (pg.constraint === 'suki_visits_card_id_manila_date_key')
      return new SukiError('ALREADY_VISITED_TODAY', 409, 'You already visited today. Come back tomorrow!', {
        next_at: nextManilaMidnightUtc(now).toISOString(),
      });
    if (pg.constraint === 'suki_visits_pass_jti_key')
      return new SukiError('PASS_USED', 409, 'This pass was already used. Ask the customer to show a new one.');
    if (pg.constraint === 'suki_visits_user_id_idempotency_key_key')
      return new SukiError('IDEMPOTENCY_CONFLICT', 409, 'This visit was already sent.');
    return error;
  }

  private async impossibleTravel(client: PoolClient, userId: string, p: ProgramRow, now: Date) {
    if (p.merchant_lat == null || p.merchant_lng == null) return null;
    const prev = (
      await client.query(
        `SELECT v.created_at, m.gps_lat, m.gps_lng FROM suki_visits v JOIN merchants m ON m.id = v.merchant_id
          WHERE v.user_id = $1 AND v.merchant_id <> $2 ORDER BY v.created_at DESC LIMIT 1`,
        [userId, p.merchant_id],
      )
    ).rows[0];
    if (!prev || prev.gps_lat == null || prev.gps_lng == null) return null;
    const km = calculateHaversineDistance(prev.gps_lat, prev.gps_lng, p.merchant_lat, p.merchant_lng) / 1000;
    const hours = Math.max((now.getTime() - new Date(prev.created_at).getTime()) / 3_600_000, 1 / 60);
    return km / hours > IMPOSSIBLE_SPEED_KMH ? 'impossible_travel' : null;
  }

  private async awardXp(
    client: PoolClient,
    userId: string,
    visitId: string,
    today: string,
    isTest: boolean,
    settings: SukiSettings,
  ) {
    if (settings.visitXp <= 0 || settings.xpVisitsPerDay <= 0) return 0;
    const earlier = await client.query(
      'SELECT COUNT(*)::int AS n FROM suki_visits WHERE user_id = $1 AND manila_date = $2 AND id <> $3',
      [userId, today, visitId],
    );
    if (earlier.rows[0].n >= settings.xpVisitsPerDay) return 0;
    const event = await progressionRepo.recordProgressionEvent(
      {
        id: randomUUID(),
        user_id: userId,
        track: 'explorer',
        delta: settings.visitXp,
        source_type: 'suki_visit',
        source_id: visitId,
        award_kind: 'xp',
        rule_version: 'suki-v1',
        earned_at: new Date().toISOString(),
        is_test: isTest,
        reversal_of: null,
      },
      client,
    );
    if (!event) return 0;
    await progressionRepo.updateProgressionTotals(userId, { explorerXp: settings.visitXp }, client);
    return settings.visitXp;
  }

  private async awardBadges(client: PoolClient, userId: string, visitId: string, isTest: boolean, now: Date) {
    const stats = (
      await client.query(
        `SELECT
           (SELECT COUNT(*)::int FROM suki_rewards WHERE user_id = $1) AS rewards,
           (SELECT COUNT(*)::int FROM suki_cards WHERE user_id = $1 AND total_visits >= $2) AS regular_shops,
           (SELECT COUNT(DISTINCT lower(m.municipality))::int FROM suki_cards c
              JOIN suki_programs p ON p.id = c.program_id JOIN merchants m ON m.id = p.merchant_id
             WHERE c.user_id = $1 AND c.total_visits > 0 AND m.municipality IS NOT NULL) AS towns`,
        [userId, REGULAR_VISITS],
      )
    ).rows[0];
    const earned: string[] = [];
    const wanted: Array<[string, boolean]> = [
      ['suki_first_card', stats.rewards >= 1],
      ['suki_three_shops', stats.regular_shops >= 3],
      ['suki_three_towns', stats.towns >= 3],
    ];
    for (const [achievementId, ok] of wanted) {
      if (!ok) continue;
      const award = await progressionRepo.awardAchievement(
        {
          id: randomUUID(),
          user_id: userId,
          achievement_id: achievementId,
          season: 'all_time',
          source_evidence_id: `suki_visit_${visitId}`,
          awarded_at: now.toISOString(),
          is_test: isTest,
        },
        client,
      );
      if (award) earned.push(achievementId);
    }
    return earned;
  }

  // ---------- merchant ----------

  async membership(userId: string): Promise<Membership | null> {
    const row = (
      await this.pool.query(
        `SELECT m.id, mm.role, m.is_test FROM merchant_memberships mm JOIN merchants m ON m.id = mm.merchant_id
          WHERE mm.user_id = $1 AND mm.status = 'active' AND m.status = 'active'
          ORDER BY (mm.role = 'owner') DESC, mm.created_at, m.id LIMIT 1`,
        [userId],
      )
    ).rows[0];
    return row ? { merchantId: row.id, role: row.role, merchantIsTest: Boolean(row.is_test) } : null;
  }

  async requireMember(userId: string, ownerOnly = false) {
    const member = await this.membership(userId);
    if (!member) throw new SukiError('MERCHANT_MEMBERSHIP_REQUIRED', 403, 'An active merchant account is required.');
    if (ownerOnly && member.role !== 'owner')
      throw new SukiError('MERCHANT_OWNER_REQUIRED', 403, 'Only the shop owner can change the Suki Card.');
    return member;
  }

  async merchantView(userId: string) {
    const [settings, member] = await Promise.all([this.settings(), this.requireMember(userId)]);
    const merchant = (
      await this.pool.query('SELECT id, name, is_published, gps_lat, gps_lng FROM merchants WHERE id = $1', [
        member.merchantId,
      ])
    ).rows[0];
    const p = (await this.pool.query(`${PROGRAM_SELECT} WHERE p.merchant_id = $1`, [member.merchantId])).rows[0] as
      ProgramRow | undefined;
    const hasLocation = merchant.gps_lat != null && merchant.gps_lng != null;
    let tiers: SukiTierSpec[] = [];
    let pointsMenu: ReturnType<typeof pointsMenuItemView>[] = [];
    if (p) {
      const [tiersMap, menuMap] = await Promise.all([
        this.loadTiersForPrograms([p.id]),
        this.loadPointsMenuForPrograms([p.id], false),
      ]);
      tiers = tiersMap.get(p.id) ?? fallbackTierFromProgram(p);
      pointsMenu = menuMap.get(p.id) ?? [];
    }
    return {
      role: member.role,
      global_points_enabled: settings.pointsEnabled,
      program: p
        ? {
            ...publicProgram(p, undefined, tiers, settings),
            radius_m: p.radius_m,
            standee_version: p.standee_version,
            paused_by: p.paused_by,
            pause_reason: p.pause_reason,
          }
        : null,
      points_menu: pointsMenu,
      shop_location: hasLocation ? { lat: merchant.gps_lat, lng: merchant.gps_lng } : null,
      checklist: { has_location: hasLocation, is_published: Boolean(merchant.is_published) },
    };
  }

  private normalizeTiers(body: ProgramInput): SukiTierSpec[] {
    const validateOne = (raw: TierInput): SukiTierSpec => {
      const valued = raw.reward_kind === 'percent_off' || raw.reward_kind === 'amount_off';
      const value = valued ? (raw.reward_value ?? null) : null;
      if (raw.reward_kind === 'percent_off') {
        if (!Number.isInteger(value) || value! < 5 || value! > 50)
          throw new SukiError('VALIDATION_ERROR', 400, 'Percent off must be a whole number from 5 to 50.');
      } else if (raw.reward_kind === 'amount_off') {
        if (!Number.isInteger(value) || value! < 10 || value! > 500)
          throw new SukiError('VALIDATION_ERROR', 400, 'Peso off must be a whole number from 10 to 500.');
      }
      const text = raw.reward_text.trim();
      if (text.length < 3 || text.length > 120)
        throw new SukiError('VALIDATION_ERROR', 400, 'Reward description must be 3 to 120 characters.');
      if (!Number.isInteger(raw.visit_number) || raw.visit_number < 1 || raw.visit_number > 20)
        throw new SukiError('VALIDATION_ERROR', 400, 'Tier visit number must be between 1 and 20.');
      return {
        visit_number: raw.visit_number,
        reward_kind: raw.reward_kind,
        reward_value: value,
        reward_text: text,
        icon_key: raw.icon_key ?? 'gift',
      };
    };

    if (body.tiers && body.tiers.length > 0) {
      if (body.tiers.length > 4)
        throw new SukiError('VALIDATION_ERROR', 400, 'You can configure up to 4 milestone tiers.');
      const normalized = body.tiers.map(validateOne);
      for (let i = 1; i < normalized.length; i += 1) {
        if (normalized[i].visit_number <= normalized[i - 1].visit_number)
          throw new SukiError('VALIDATION_ERROR', 400, 'Milestone tier visit numbers must strictly increase.');
      }
      const lastVisit = normalized[normalized.length - 1].visit_number;
      if (lastVisit < 3 || lastVisit > 20)
        throw new SukiError('VALIDATION_ERROR', 400, 'The final milestone must be between 3 and 20 visits.');
      return normalized;
    }

    if (!body.reward_kind || !body.reward_text)
      throw new SukiError('VALIDATION_ERROR', 400, 'Provide reward details or a milestone ladder.');
    const visitsRequired = body.visits_required ?? 10;
    if (!Number.isInteger(visitsRequired) || visitsRequired < 3 || visitsRequired > 20)
      throw new SukiError('VALIDATION_ERROR', 400, 'Visits required must be between 3 and 20.');
    return [
      validateOne({
        visit_number: visitsRequired,
        reward_kind: body.reward_kind,
        reward_value: body.reward_value,
        reward_text: body.reward_text,
        icon_key: 'gift',
      }),
    ];
  }

  async upsertProgram(userId: string, body: ProgramInput) {
    await this.requireEnabled();
    const member = await this.requireMember(userId, true);
    const tiers = this.normalizeTiers(body);
    const lastTier = tiers[tiers.length - 1];

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const existing = (
        await client.query('SELECT * FROM suki_programs WHERE merchant_id = $1 FOR UPDATE', [member.merchantId])
      ).rows[0];
      const programId = (existing?.id as string | undefined) ?? `suki_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
      const pointsEnabled =
        body.points_enabled !== undefined ? body.points_enabled : Boolean(existing?.points_enabled ?? false);
      const pointsPerVisit =
        body.points_per_visit !== undefined ? body.points_per_visit : Number(existing?.points_per_visit ?? 10);
      const pesosPerPoint =
        body.pesos_per_point !== undefined ? body.pesos_per_point : numberOrNull(existing?.pesos_per_point);
      const maxPointsPerVisit =
        body.max_points_per_visit !== undefined
          ? body.max_points_per_visit
          : Number(existing?.max_points_per_visit ?? 200);
      const pointsExpireDays =
        body.points_expire_days !== undefined ? body.points_expire_days : (existing?.points_expire_days ?? null);
      const skinKey = body.skin_key ?? (existing?.skin_key as SukiSkinKey | undefined) ?? 'jdq_classic';
      const mode = body.mode ?? (existing?.mode as 'standee' | 'staff_scan' | undefined) ?? 'standee';
      const radiusM = body.radius_m ?? Number(existing?.radius_m ?? 75);

      await client.query(
        `INSERT INTO suki_programs (
           id, merchant_id, title, reward_kind, reward_value, reward_text, visits_required, mode, radius_m, is_test,
           points_enabled, points_per_visit, pesos_per_point, max_points_per_visit, points_expire_days, skin_key
         )
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
         ON CONFLICT (merchant_id) DO UPDATE SET
           title = EXCLUDED.title,
           reward_kind = EXCLUDED.reward_kind,
           reward_value = EXCLUDED.reward_value,
           reward_text = EXCLUDED.reward_text,
           visits_required = EXCLUDED.visits_required,
           mode = EXCLUDED.mode,
           radius_m = EXCLUDED.radius_m,
           points_enabled = EXCLUDED.points_enabled,
           points_per_visit = EXCLUDED.points_per_visit,
           pesos_per_point = EXCLUDED.pesos_per_point,
           max_points_per_visit = EXCLUDED.max_points_per_visit,
           points_expire_days = EXCLUDED.points_expire_days,
           skin_key = EXCLUDED.skin_key,
           updated_at = NOW()`,
        [
          programId,
          member.merchantId,
          body.title.trim(),
          lastTier.reward_kind,
          lastTier.reward_value,
          lastTier.reward_text,
          lastTier.visit_number,
          mode,
          radiusM,
          member.merchantIsTest,
          pointsEnabled,
          pointsPerVisit,
          pesosPerPoint,
          maxPointsPerVisit,
          pointsExpireDays,
          skinKey,
        ],
      );

      await client.query('DELETE FROM suki_reward_tiers WHERE program_id = $1', [programId]);
      for (const tier of tiers) {
        await client.query(
          `INSERT INTO suki_reward_tiers (id, program_id, visit_number, reward_kind, reward_value, reward_text, icon_key)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [
            `sukitier_${randomUUID()}`,
            programId,
            tier.visit_number,
            tier.reward_kind,
            tier.reward_value,
            tier.reward_text,
            tier.icon_key,
          ],
        );
      }

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    return this.merchantView(userId);
  }

  async merchantPointsMenu(userId: string) {
    await this.requireEnabled();
    const member = await this.requireMember(userId);
    const own = await this.ownProgram(member.merchantId);
    const rows = (
      await this.pool.query(
        'SELECT * FROM suki_point_items WHERE program_id = $1 ORDER BY sort_order ASC, points_cost ASC, created_at ASC',
        [own.id],
      )
    ).rows;
    return { items: rows.map(pointsMenuItemView) };
  }

  async createPointsMenuItem(
    userId: string,
    body: { title: string; points_cost: number; icon_key?: SukiIconKey; sort_order?: number },
  ) {
    await this.requireEnabled();
    const member = await this.requireMember(userId, true);
    const own = await this.ownProgram(member.merchantId);
    const activeCount = (
      await this.pool.query(
        'SELECT COUNT(*)::int AS n FROM suki_point_items WHERE program_id = $1 AND is_active = TRUE',
        [own.id],
      )
    ).rows[0].n as number;
    if (activeCount >= MAX_POINTS_MENU_ITEMS)
      throw new SukiError('POINTS_MENU_LIMIT', 409, 'You can list up to 12 active points rewards.');

    const row = (
      await this.pool.query(
        `INSERT INTO suki_point_items (id, program_id, title, points_cost, icon_key, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [
          `sukipi_${randomUUID()}`,
          own.id,
          body.title.trim(),
          body.points_cost,
          body.icon_key ?? 'gift',
          body.sort_order ?? 0,
        ],
      )
    ).rows[0];
    return { item: pointsMenuItemView(row) };
  }

  async updatePointsMenuItem(
    userId: string,
    itemId: string,
    body: {
      title?: string;
      points_cost?: number;
      icon_key?: SukiIconKey;
      is_active?: boolean;
      sort_order?: number;
    },
  ) {
    await this.requireEnabled();
    const member = await this.requireMember(userId, true);
    const own = await this.ownProgram(member.merchantId);
    const existing = (
      await this.pool.query('SELECT * FROM suki_point_items WHERE id = $1 AND program_id = $2', [itemId, own.id])
    ).rows[0];
    if (!existing) throw new SukiError('POINTS_ITEM_NOT_FOUND', 404, 'Points menu item not found.');

    if (body.is_active === true && !existing.is_active) {
      const activeCount = (
        await this.pool.query(
          'SELECT COUNT(*)::int AS n FROM suki_point_items WHERE program_id = $1 AND is_active = TRUE',
          [own.id],
        )
      ).rows[0].n as number;
      if (activeCount >= MAX_POINTS_MENU_ITEMS)
        throw new SukiError('POINTS_MENU_LIMIT', 409, 'You can list up to 12 active points rewards.');
    }

    const updated = (
      await this.pool.query(
        `UPDATE suki_point_items
            SET title = COALESCE($3, title),
                points_cost = COALESCE($4, points_cost),
                icon_key = COALESCE($5, icon_key),
                is_active = COALESCE($6, is_active),
                sort_order = COALESCE($7, sort_order),
                updated_at = NOW()
          WHERE id = $1 AND program_id = $2 RETURNING *`,
        [
          itemId,
          own.id,
          body.title !== undefined ? body.title.trim() : null,
          body.points_cost ?? null,
          body.icon_key ?? null,
          body.is_active ?? null,
          body.sort_order ?? null,
        ],
      )
    ).rows[0];
    return { item: pointsMenuItemView(updated) };
  }

  async deletePointsMenuItem(userId: string, itemId: string) {
    await this.requireEnabled();
    const member = await this.requireMember(userId, true);
    const own = await this.ownProgram(member.merchantId);
    const deleted = (
      await this.pool.query('DELETE FROM suki_point_items WHERE id = $1 AND program_id = $2 RETURNING id', [
        itemId,
        own.id,
      ])
    ).rows[0];
    if (!deleted) throw new SukiError('POINTS_ITEM_NOT_FOUND', 404, 'Points menu item not found.');
    return { deleted: true, id: deleted.id as string };
  }

  async setLocation(userId: string, body: { lat: number; lng: number; accuracy_m: number }) {
    await this.requireEnabled();
    const member = await this.requireMember(userId, true);
    if (!(body.accuracy_m <= 50))
      throw new SukiError('LOCATION_ACCURACY_TOO_LOW', 422, 'Stand at the counter and wait for a GPS fix within 50 m.');
    await this.pool.query('UPDATE merchants SET gps_lat = $2, gps_lng = $3 WHERE id = $1', [
      member.merchantId,
      body.lat,
      body.lng,
    ]);
    return this.merchantView(userId);
  }

  private async ownProgram(merchantId: string) {
    const row = (
      await this.pool.query('SELECT id, status, paused_by FROM suki_programs WHERE merchant_id = $1', [merchantId])
    ).rows[0];
    if (!row) throw new SukiError('SUKI_NOT_FOUND', 404, 'Set up your Suki Card first.');
    return row as { id: string; status: string; paused_by: string | null };
  }

  async activate(userId: string) {
    await this.requireEnabled();
    const member = await this.requireMember(userId, true);
    const own = await this.ownProgram(member.merchantId);
    if (own.status === 'paused' && own.paused_by === 'admin')
      throw new SukiError('SUKI_ADMIN_PAUSED', 409, 'Your LGU tourism office paused this Suki Card.');
    const view = await this.merchantView(userId);
    if (!view.checklist.has_location)
      throw new SukiError('SHOP_LOCATION_MISSING', 409, 'Pin your shop location first.');
    if (!view.checklist.is_published)
      throw new SukiError('SHOP_NOT_PUBLISHED', 409, 'Publish your shop profile first.');
    await this.pool.query(
      `UPDATE suki_programs SET status = 'active', paused_by = NULL, pause_reason = NULL, updated_at = NOW() WHERE id = $1`,
      [own.id],
    );
    return this.merchantView(userId);
  }

  async pause(userId: string) {
    const member = await this.requireMember(userId, true);
    const own = await this.ownProgram(member.merchantId);
    if (own.paused_by !== 'admin')
      await this.pool.query(
        `UPDATE suki_programs SET status = 'paused', paused_by = 'merchant', updated_at = NOW() WHERE id = $1`,
        [own.id],
      );
    return this.merchantView(userId);
  }

  async standee(userId: string) {
    const member = await this.requireMember(userId);
    const p = (await this.pool.query(`${PROGRAM_SELECT} WHERE p.merchant_id = $1`, [member.merchantId])).rows[0] as
      ProgramRow | undefined;
    if (!p) throw new SukiError('SUKI_NOT_FOUND', 404, 'Set up your Suki Card first.');
    return {
      url: standeeUrl(p.id, p.standee_version),
      version: p.standee_version,
      title: p.title,
      reward_text: p.reward_text,
      reward_tag: rewardTag(p.reward_kind, numberOrNull(p.reward_value)),
      visits_required: p.visits_required,
      shop_name: p.merchant_name,
    };
  }

  async rotateStandee(userId: string) {
    await this.requireEnabled();
    const member = await this.requireMember(userId, true);
    const own = await this.ownProgram(member.merchantId);
    await this.pool.query(
      'UPDATE suki_programs SET standee_version = standee_version + 1, updated_at = NOW() WHERE id = $1',
      [own.id],
    );
    return this.standee(userId);
  }

  /** The single counter scanner: a Suki pass, a Suki reward code, or a Shop voucher / sponsor perk code. */
  async scan(staffId: string, rawCode: string, now = new Date(), amountSpent: number | null = null) {
    const code = normaliseCounterCode(rawCode);
    // v0.3.10: Shop vouchers and sponsor perks (`JDQ-…`) are confirmed at the counter even while Suki Cards
    // are switched off; Suki passes and reward codes still need `suki_enabled`.
    if (code.startsWith('JDQ-')) return this.scanVoucher(staffId, await this.requireMember(staffId), code, now);
    const settings = await this.requireEnabled();
    const member = await this.requireMember(staffId);
    if (code.startsWith(SUKI_PASS_PREFIX)) return this.scanPass(staffId, member, code, settings, now, amountSpent);
    if (code.startsWith('SUKI-')) return this.scanReward(staffId, member, code, now);
    throw new SukiError('CODE_UNKNOWN', 400, 'That is not a JuanderQuest code.');
  }

  private async scanPass(
    staffId: string,
    member: Membership,
    code: string,
    settings: SukiSettings,
    now: Date,
    amountSpent: number | null = null,
  ) {
    const check = verifySukiPass(code);
    if (!check.ok)
      throw check.code === 'PASS_EXPIRED'
        ? new SukiError('PASS_EXPIRED', 410, 'This pass expired. Ask the customer to show a new one.')
        : new SukiError('PASS_INVALID', 400, 'That pass is not valid.');
    const p = await this.program(check.claims.programId);
    if (!p || p.merchant_id !== member.merchantId)
      throw new SukiError('PASS_OTHER_SHOP', 403, 'This pass is for a different shop.');
    this.assertProgramLive(p);
    await this.assertCustomer(p, check.claims.userId);
    const visit = await this.recordVisit({
      programId: p.id,
      userId: check.claims.userId,
      method: 'staff_scan',
      lat: null,
      lng: null,
      accuracyM: null,
      staffId,
      passJti: check.claims.jti,
      idempotencyKey: null,
      amountSpent,
      settings,
      now,
    });
    const shown = visit.reward_issued
      ? visit.reward_issued.reward_text
      : `Visit ${visit.card.visits} of ${visit.card.required}`;
    return {
      kind: 'visit' as const,
      customer: visit.customer,
      title: visit.reward_issued ? 'Visit recorded. Reward unlocked!' : 'Visit recorded',
      detail: shown,
      points_awarded: visit.points_awarded,
      visit,
    };
  }

  private async scanReward(staffId: string, member: Membership, code: string, now: Date) {
    const reward = (
      await this.pool.query(
        'SELECT r.*, p.merchant_id FROM suki_rewards r JOIN suki_programs p ON p.id = r.program_id WHERE r.code = $1',
        [code],
      )
    ).rows[0];
    if (!reward || reward.merchant_id !== member.merchantId)
      throw new SukiError('REWARD_NOT_FOUND', 404, 'That reward is not for this shop.');
    if (reward.status === 'claimed')
      throw new SukiError('REWARD_ALREADY_CLAIMED', 409, 'This reward was already claimed.', {
        claimed_at: new Date(reward.claimed_at).toISOString(),
      });
    if (new Date(reward.expires_at).getTime() <= now.getTime())
      throw new SukiError('REWARD_EXPIRED', 410, 'This reward has expired.');
    const claimed = (
      await this.pool.query(
        `UPDATE suki_rewards SET status = 'claimed', claimed_at = $2, claimed_by = $3
          WHERE id = $1 AND status = 'issued' RETURNING *`,
        [reward.id, now.toISOString(), staffId],
      )
    ).rows[0];
    if (!claimed) throw new SukiError('REWARD_ALREADY_CLAIMED', 409, 'This reward was already claimed.');
    return {
      kind: 'reward' as const,
      customer: customerLabel(reward.user_id, member.merchantId),
      title: 'Reward claimed',
      detail: reward.reward_text as string,
      reward: rewardView(claimed, now),
    };
  }

  private async scanVoucher(staffId: string, member: Membership, code: string, now: Date) {
    const redemption = (
      await this.pool.query(
        `SELECT r.id, r.user_id, r.used_at, v.title, v.merchant_id FROM redemptions r
           JOIN vouchers v ON v.id = r.voucher_id WHERE r.code = $1`,
        [code],
      )
    ).rows[0];
    if (!redemption || redemption.merchant_id !== member.merchantId)
      throw new SukiError('CODE_NOT_FOUND', 404, 'That voucher is not for this shop.');
    if (redemption.used_at)
      throw new SukiError('CODE_ALREADY_USED', 409, 'This voucher was already used.', {
        used_at: new Date(redemption.used_at).toISOString(),
      });
    const used = (
      await this.pool.query(
        'UPDATE redemptions SET used_at = $2, used_by = $3 WHERE id = $1 AND used_at IS NULL RETURNING used_at',
        [redemption.id, now.toISOString(), staffId],
      )
    ).rows[0];
    if (!used) throw new SukiError('CODE_ALREADY_USED', 409, 'This voucher was already used.');
    return {
      kind: 'voucher' as const,
      customer: customerLabel(redemption.user_id, member.merchantId),
      title: 'Voucher confirmed',
      detail: redemption.title as string,
    };
  }

  async stats(userId: string, days = 30, now = new Date()) {
    const member = await this.requireMember(userId);
    const span = Math.min(Math.max(Math.trunc(days) || 30, 7), 90);
    const params = [member.merchantId, manilaDateString(now), span];
    const inWindow = `v.merchant_id = $1 AND v.manila_date > ($2::date - $3::int)`;
    const [byDay, customers, newToApp, rewards, vouchers, regulars, pointsAgg, rewardsByTier] = await Promise.all([
      this.pool.query(
        `SELECT v.manila_date::text AS date, COUNT(*)::int AS visits FROM suki_visits v
          WHERE ${inWindow} GROUP BY v.manila_date ORDER BY v.manila_date`,
        params,
      ),
      this.pool.query(
        `SELECT COUNT(*)::int AS unique_customers, COUNT(*) FILTER (WHERE n >= 2)::int AS repeat_customers
           FROM (SELECT v.user_id, COUNT(*) AS n FROM suki_visits v WHERE ${inWindow} GROUP BY v.user_id) s`,
        params,
      ),
      this.pool.query(
        `SELECT COUNT(*)::int AS n FROM suki_cards c
           JOIN suki_programs p ON p.id = c.program_id JOIN users u ON u.id = c.user_id
          WHERE p.merchant_id = $1 AND c.first_visit_at IS NOT NULL
            AND c.first_visit_at > ($2::date - $3::int)
            AND u.created_at >= c.first_visit_at - INTERVAL '7 days'`,
        params,
      ),
      this.pool.query(
        `SELECT COUNT(*)::int AS issued, COUNT(*) FILTER (WHERE r.status = 'claimed')::int AS claimed
           FROM suki_rewards r JOIN suki_programs p ON p.id = r.program_id
          WHERE p.merchant_id = $1 AND r.created_at > ($2::date - $3::int)`,
        params,
      ),
      this.pool.query(
        `SELECT COUNT(*)::int AS confirmed FROM redemptions r JOIN vouchers v ON v.id = r.voucher_id
          WHERE v.merchant_id = $1 AND r.used_at > ($2::date - $3::int)`,
        params,
      ),
      this.pool.query(
        `SELECT v.user_id, COUNT(*)::int AS visits FROM suki_visits v WHERE ${inWindow}
          GROUP BY v.user_id ORDER BY visits DESC, MIN(v.created_at) LIMIT 5`,
        params,
      ),
      this.pool.query(
        `SELECT COALESCE(SUM(l.delta) FILTER (WHERE l.delta > 0), 0)::int AS issued,
                COALESCE(SUM(-l.delta) FILTER (WHERE l.delta < 0 AND l.reason = 'redeem'), 0)::int AS redeemed
           FROM suki_point_ledger l JOIN suki_programs p ON p.id = l.program_id
          WHERE p.merchant_id = $1 AND l.created_at > ($2::date - $3::int)`,
        params,
      ),
      this.pool.query(
        `SELECT r.tier_visit, r.source, COUNT(*)::int AS issued,
                COUNT(*) FILTER (WHERE r.status = 'claimed')::int AS claimed
           FROM suki_rewards r JOIN suki_programs p ON p.id = r.program_id
          WHERE p.merchant_id = $1 AND r.created_at > ($2::date - $3::int)
          GROUP BY r.tier_visit, r.source
          ORDER BY r.source ASC, r.tier_visit ASC NULLS LAST`,
        params,
      ),
    ]);
    return {
      days: span,
      visits_by_day: byDay.rows as Array<{ date: string; visits: number }>,
      unique_customers: customers.rows[0].unique_customers as number,
      repeat_customers: customers.rows[0].repeat_customers as number,
      new_to_app: newToApp.rows[0].n as number,
      rewards_issued: rewards.rows[0].issued as number,
      rewards_claimed: rewards.rows[0].claimed as number,
      vouchers_confirmed: vouchers.rows[0].confirmed as number,
      points_issued: Number(pointsAgg.rows[0]?.issued ?? 0),
      points_redeemed: Number(pointsAgg.rows[0]?.redeemed ?? 0),
      rewards_by_tier: rewardsByTier.rows.map((r: any) => ({
        tier_visit: r.tier_visit ?? null,
        source: r.source as string,
        issued: Number(r.issued),
        claimed: Number(r.claimed),
      })),
      top_regulars: regulars.rows.map((r: any) => ({
        label: customerLabel(r.user_id, member.merchantId),
        visits: r.visits,
      })),
    };
  }

  // ---------- admin (area-scoped) ----------

  async adminPrograms(scope: AdminScope, status?: string) {
    const filter = scopeFilterSql(scope, 'merchants_vouchers', 'm.town_area_id', 1);
    const values: unknown[] = [...filter.values];
    let where = filter.sql;
    if (status) {
      values.push(status);
      where += ` AND p.status = $${values.length}`;
    }
    const result = await this.pool.query(
      `SELECT p.id, p.title, p.status, p.paused_by, p.pause_reason, p.mode, p.visits_required, p.reward_text,
              p.points_enabled, p.skin_key, p.is_test,
              m.id AS merchant_id, m.name AS merchant_name, m.municipality, m.town_area_id,
              (SELECT COUNT(*)::int FROM suki_cards c WHERE c.program_id = p.id) AS cards,
              (SELECT COUNT(*)::int FROM suki_visits v WHERE v.program_id = p.id AND v.created_at > NOW() - INTERVAL '30 days') AS visits_30d,
              (SELECT COUNT(*)::int FROM suki_visits v WHERE v.program_id = p.id AND v.flagged_reason IS NOT NULL) AS flagged,
              (SELECT COUNT(*)::int FROM suki_reward_tiers t WHERE t.program_id = p.id) AS tiers_count,
              (SELECT COALESCE(SUM(l.delta) FILTER (WHERE l.delta > 0), 0)::int
                 FROM suki_point_ledger l WHERE l.program_id = p.id AND l.created_at > NOW() - INTERVAL '30 days') AS points_issued_30d,
              (SELECT COALESCE(SUM(-l.delta) FILTER (WHERE l.delta < 0 AND l.reason = 'redeem'), 0)::int
                 FROM suki_point_ledger l WHERE l.program_id = p.id AND l.created_at > NOW() - INTERVAL '30 days') AS points_redeemed_30d
         FROM suki_programs p JOIN merchants m ON m.id = p.merchant_id
        WHERE ${where}
        ORDER BY m.municipality NULLS LAST, m.name`,
      values,
    );
    return { items: result.rows };
  }

  async adminProgramArea(id: string) {
    const row = (
      await this.pool.query(
        `SELECT p.id, p.status, p.paused_by, p.pause_reason, m.town_area_id
           FROM suki_programs p JOIN merchants m ON m.id = p.merchant_id WHERE p.id = $1`,
        [id],
      )
    ).rows[0];
    if (!row) throw new SukiError('SUKI_NOT_FOUND', 404, 'This Suki Card was not found.');
    return row as {
      id: string;
      status: string;
      paused_by: string | null;
      pause_reason: string | null;
      town_area_id: string | null;
    };
  }

  async adminSetPaused(id: string, paused: boolean, reason: string | null) {
    if (paused)
      await this.pool.query(
        `UPDATE suki_programs SET status = 'paused', paused_by = 'admin', pause_reason = $2, updated_at = NOW() WHERE id = $1`,
        [id, reason],
      );
    else
      await this.pool.query(
        `UPDATE suki_programs SET status = 'active', paused_by = NULL, pause_reason = NULL, updated_at = NOW()
          WHERE id = $1 AND paused_by = 'admin'`,
        [id],
      );
  }

  async adminTowns(scope: AdminScope, weeks = 8) {
    const span = Math.min(Math.max(Math.trunc(weeks) || 8, 1), 26);
    const filter = scopeFilterSql(scope, 'merchants_vouchers', 'm.town_area_id', 2);
    const result = await this.pool.query(
      `SELECT COALESCE(m.municipality, 'Unknown') AS town,
              to_char(date_trunc('week', v.manila_date::timestamp), 'YYYY-MM-DD') AS week,
              COUNT(*)::int AS visits, COUNT(DISTINCT v.merchant_id)::int AS shops,
              COUNT(DISTINCT v.user_id)::int AS unique_customers
         FROM suki_visits v JOIN merchants m ON m.id = v.merchant_id
        WHERE v.manila_date > (CURRENT_DATE - ($1::int * 7)) AND v.is_test = FALSE AND ${filter.sql}
        GROUP BY 1, 2 ORDER BY 2 DESC, 1`,
      [span, ...filter.values],
    );
    return { weeks: span, items: result.rows };
  }
}
