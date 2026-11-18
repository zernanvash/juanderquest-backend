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
  };
}

const IMPOSSIBLE_SPEED_KMH = 150;
const REGULAR_VISITS = 5;
export const SUKI_REWARD_KINDS = ['free_item', 'percent_off', 'amount_off', 'promo'] as const;
export type SukiRewardKind = (typeof SUKI_REWARD_KINDS)[number];

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

function publicProgram(p: ProgramRow, distanceM?: number) {
  const value = numberOrNull(p.reward_value);
  return {
    id: p.id,
    title: p.title,
    reward_kind: p.reward_kind,
    reward_value: value,
    reward_text: p.reward_text,
    reward_tag: rewardTag(p.reward_kind, value),
    visits_required: p.visits_required,
    mode: p.mode,
    status: p.status,
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
    status: r.status as 'issued' | 'claimed',
    expires_at: new Date(r.expires_at).toISOString(),
    expired: r.status === 'issued' && new Date(r.expires_at).getTime() <= now.getTime(),
    claimed_at: r.claimed_at ? new Date(r.claimed_at).toISOString() : null,
  };
}

function cardView(card: any, today: string) {
  return {
    card_id: card.id as string,
    cycle: card.cycle as number,
    visits: card.visits as number,
    required: card.cycle_required as number,
    total_visits: card.total_visits as number,
    visited_today: card.last_visit_at ? manilaDateString(new Date(card.last_visit_at)) === today : false,
    last_visit_at: card.last_visit_at ? new Date(card.last_visit_at).toISOString() : null,
  };
}

export interface VisitResult {
  visit_id: string;
  replayed: boolean;
  program: ReturnType<typeof publicProgram>;
  card: ReturnType<typeof cardView>;
  reward_issued: ReturnType<typeof rewardView>;
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

interface ProgramInput {
  title: string;
  reward_kind: SukiRewardKind;
  reward_value?: number | null;
  reward_text: string;
  visits_required?: number;
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

  async listMyCards(userId: string, now = new Date()) {
    const today = manilaDateString(now);
    const cards = await this.pool.query(
      `SELECT ${PROGRAM_COLUMNS}, c.id AS card_id, c.cycle, c.cycle_required, c.visits, c.total_visits, c.last_visit_at
         FROM suki_cards c
         JOIN suki_programs p ON p.id = c.program_id
         JOIN merchants m ON m.id = p.merchant_id
        WHERE c.user_id = $1
        ORDER BY c.last_visit_at DESC NULLS LAST, c.created_at DESC`,
      [userId],
    );
    const rewards = await this.pool.query(`SELECT * FROM suki_rewards WHERE user_id = $1 ORDER BY created_at ASC`, [
      userId,
    ]);
    const byCard = new Map<string, any[]>();
    for (const r of rewards.rows) {
      const list = byCard.get(r.card_id) ?? [];
      list.push(r);
      byCard.set(r.card_id, list);
    }
    return {
      cards: cards.rows.map((row: any) => {
        const all = (byCard.get(row.card_id) ?? []).map((r) => rewardView(r, now)!);
        const open = all.filter((r) => r.status === 'issued');
        // `reward` (§6.4): the oldest claimable reward, else the latest one (claimed or expired) so the card
        // can show "Claimed"/"Expired"; `rewards` lists every unclaimed reward (additive).
        const reward = open.find((r) => !r.expired) ?? all[all.length - 1] ?? null;
        return {
          ...cardView({ ...row, id: row.card_id }, today),
          program: publicProgram(row),
          reward,
          rewards: open,
        };
      }),
    };
  }

  async listPrograms(input: { userId?: string; lat?: number; lng?: number; limit?: number }) {
    const isTest = input.userId ? (await getStampEligibility(this.pool, input.userId)).isTest : false;
    const result = await this.pool.query(
      `${PROGRAM_SELECT}
        WHERE p.status = 'active' AND m.status = 'active' AND m.is_published = TRUE AND p.is_test = $1`,
      [isTest],
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
    return { programs: rows.slice(0, limit).map(({ p, distance }) => publicProgram(p, distance)) };
  }

  /** Public read for the web landing page and the app's card page. */
  async getProgram(id: string, userId?: string, now = new Date()) {
    const p = await this.program(id);
    if (!p || p.merchant_status !== 'active' || !p.merchant_published || p.status === 'draft')
      throw new SukiError('SUKI_NOT_FOUND', 404, 'This Suki Card was not found.');
    let myCard: ReturnType<typeof cardView> | null = null;
    let rewards: Array<ReturnType<typeof rewardView>> = [];
    if (userId) {
      const card = (
        await this.pool.query('SELECT * FROM suki_cards WHERE program_id = $1 AND user_id = $2', [id, userId])
      ).rows[0];
      if (card) {
        myCard = cardView(card, manilaDateString(now));
        rewards = (
          await this.pool.query(
            `SELECT * FROM suki_rewards WHERE card_id = $1 AND status = 'issued' ORDER BY created_at`,
            [card.id],
          )
        ).rows.map((r: any) => rewardView(r, now));
      }
    }
    return { program: publicProgram(p), my_card: myCard, rewards };
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
    const card = (
      await this.pool.query('SELECT * FROM suki_cards WHERE program_id = $1 AND user_id = $2', [programId, userId])
    ).rows[0];
    if (!card) return { visited_today: false, card: null };
    const view = cardView(card, manilaDateString(now));
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
    const p = await this.program(visit.program_id);
    const card = (await this.pool.query('SELECT * FROM suki_cards WHERE id = $1', [visit.card_id])).rows[0];
    return {
      visit_id: visit.id,
      replayed: true,
      program: publicProgram(p!),
      card: cardView(card, manilaDateString(now)),
      reward_issued: null,
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
      await client.query(
        `INSERT INTO suki_cards (id, program_id, user_id, cycle_required, is_test)
         VALUES ($1, $2, $3, $4, $5) ON CONFLICT (program_id, user_id) DO NOTHING`,
        [`sukic_${randomUUID()}`, program.id, input.userId, program.visits_required, program.is_test],
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

      let visits = card.visits + 1;
      let cycle = card.cycle;
      let cycleRequired = card.cycle_required;
      let reward: any = null;
      if (visits >= cycleRequired) {
        reward = await this.insertReward(client, (code) => [
          `sukir_${randomUUID()}`,
          card.id,
          program.id,
          input.userId,
          cycle,
          program.reward_kind,
          program.reward_value,
          program.reward_text,
          code,
          new Date(now.getTime() + settings.rewardDays * 86_400_000).toISOString(),
          program.is_test,
          now.toISOString(),
        ]);
        visits = 0;
        cycle += 1;
        cycleRequired = program.visits_required;
      }
      const updated = (
        await client.query(
          `UPDATE suki_cards SET visits = $2, cycle = $3, cycle_required = $4, total_visits = total_visits + 1,
                  first_visit_at = COALESCE(first_visit_at, $5), last_visit_at = $5
            WHERE id = $1 RETURNING *`,
          [card.id, visits, cycle, cycleRequired, now.toISOString()],
        )
      ).rows[0];

      const xp = await this.awardXp(client, input.userId, visitId, today, program.is_test, settings);
      const badges = await this.awardBadges(client, input.userId, visitId, program.is_test, now);
      if (reward) {
        await runIsolatedProducer(client, '[suki] reward notification failed:', async () => {
          await notify(client, {
            userId: input.userId,
            kind: 'suki_reward',
            eventKey: `suki_reward:${reward.id}`,
            title: 'Suki reward unlocked',
            message: `${program.reward_text} at ${program.merchant_name}`,
            href: `/suki/${program.id}`,
            isTest: program.is_test,
            push: { category: 'account', collapseKey: `suki:${program.id}` },
          });
        });
      }
      await client.query('COMMIT');
      result = {
        visit_id: visitId,
        replayed: false,
        program: publicProgram(program),
        card: cardView(updated, today),
        reward_issued: rewardView(reward, now),
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
  private async insertReward(client: PoolClient, params: (code: string) => unknown[]) {
    for (let attempt = 0; ; attempt += 1) {
      await client.query('SAVEPOINT suki_reward_code');
      try {
        const row = (
          await client.query(
            `INSERT INTO suki_rewards (id, card_id, program_id, user_id, cycle, reward_kind, reward_value, reward_text,
                                       code, expires_at, is_test, created_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
            params(newRewardCode()),
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
    const member = await this.requireMember(userId);
    const merchant = (
      await this.pool.query('SELECT id, name, is_published, gps_lat, gps_lng FROM merchants WHERE id = $1', [
        member.merchantId,
      ])
    ).rows[0];
    const p = (await this.pool.query(`${PROGRAM_SELECT} WHERE p.merchant_id = $1`, [member.merchantId])).rows[0] as
      ProgramRow | undefined;
    const hasLocation = merchant.gps_lat != null && merchant.gps_lng != null;
    return {
      role: member.role,
      program: p
        ? {
            ...publicProgram(p),
            radius_m: p.radius_m,
            standee_version: p.standee_version,
            paused_by: p.paused_by,
            pause_reason: p.pause_reason,
          }
        : null,
      shop_location: hasLocation ? { lat: merchant.gps_lat, lng: merchant.gps_lng } : null,
      checklist: { has_location: hasLocation, is_published: Boolean(merchant.is_published) },
    };
  }

  async upsertProgram(userId: string, body: ProgramInput) {
    await this.requireEnabled();
    const member = await this.requireMember(userId, true);
    const valued = body.reward_kind === 'percent_off' || body.reward_kind === 'amount_off';
    const value = valued ? (body.reward_value ?? null) : null;
    const max = body.reward_kind === 'percent_off' ? 100 : 5000;
    if (valued && !(Number.isInteger(value) && value! >= 1 && value! <= max))
      throw new SukiError(
        'VALIDATION_ERROR',
        400,
        body.reward_kind === 'percent_off'
          ? 'Percent off must be a whole number from 1 to 100.'
          : 'Peso off must be a whole number from 1 to 5000.',
      );
    await this.pool.query(
      `INSERT INTO suki_programs (id, merchant_id, title, reward_kind, reward_value, reward_text, visits_required, mode, radius_m, is_test)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (merchant_id) DO UPDATE SET title = EXCLUDED.title, reward_kind = EXCLUDED.reward_kind,
         reward_value = EXCLUDED.reward_value, reward_text = EXCLUDED.reward_text,
         visits_required = EXCLUDED.visits_required, mode = EXCLUDED.mode, radius_m = EXCLUDED.radius_m,
         updated_at = NOW()`,
      [
        `suki_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
        member.merchantId,
        body.title.trim(),
        body.reward_kind,
        value,
        body.reward_text.trim(),
        body.visits_required ?? 10,
        body.mode ?? 'standee',
        body.radius_m ?? 75,
        member.merchantIsTest,
      ],
    );
    return this.merchantView(userId);
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
  async scan(staffId: string, rawCode: string, now = new Date()) {
    const settings = await this.requireEnabled();
    const member = await this.requireMember(staffId);
    const code = normaliseCounterCode(rawCode);
    if (code.startsWith(SUKI_PASS_PREFIX)) return this.scanPass(staffId, member, code, settings, now);
    if (code.startsWith('SUKI-')) return this.scanReward(staffId, member, code, now);
    if (code.startsWith('JDQ-')) return this.scanVoucher(staffId, member, code, now);
    throw new SukiError('CODE_UNKNOWN', 400, 'That is not a JuanderQuest code.');
  }

  private async scanPass(staffId: string, member: Membership, code: string, settings: SukiSettings, now: Date) {
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
    const [byDay, customers, newToApp, rewards, vouchers, regulars] = await Promise.all([
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
      `SELECT p.id, p.title, p.status, p.paused_by, p.pause_reason, p.mode, p.visits_required, p.reward_text, p.is_test,
              m.id AS merchant_id, m.name AS merchant_name, m.municipality, m.town_area_id,
              (SELECT COUNT(*)::int FROM suki_cards c WHERE c.program_id = p.id) AS cards,
              (SELECT COUNT(*)::int FROM suki_visits v WHERE v.program_id = p.id AND v.created_at > NOW() - INTERVAL '30 days') AS visits_30d,
              (SELECT COUNT(*)::int FROM suki_visits v WHERE v.program_id = p.id AND v.flagged_reason IS NOT NULL) AS flagged
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
