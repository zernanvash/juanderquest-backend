import { perkBonus } from '../juanchoice/perks.js';
import { createHash, randomUUID } from 'crypto';
import type { Pool, PoolClient } from 'pg';
import { canonicalSettings } from '../settings/schema.js';
import {
  addManilaDays,
  daysBetweenManila,
  manilaDateString,
  manilaMonthKey,
  manilaWeekBounds,
  manilaWeekId,
  nextManilaMidnightUtc,
} from './time.js';

export class StampsError extends Error {
  constructor(readonly code: string, readonly status: number, message: string) { super(message); }
}

interface Db {
  query(text: string, params?: any[]): Promise<any>;
}

export interface RewardSettings {
  weeklyCap: number;
  dailyClaimStamps: number;
  day7Stamps: number;
  chestRequired: number;
  chestStamps: number;
  shieldPrice: number;
  shieldsMax: number;
}

export interface StampAwardInput {
  userId: string;
  amount: number;
  source: string;
  sourceKey: string;
  manilaDate: string;
  weekId: string;
  reason?: string | null;
  isTest: boolean;
  settings: RewardSettings;
}

export interface StampEligibility {
  eligible: boolean;
  isTest: boolean;
}

export interface StampAwardResult {
  awarded: number;
  capped: boolean;
  inserted: boolean;
}

export interface StreakRow {
  current_streak: number;
  best_streak: number;
  last_claim_date: string | null;
  shields_held: number;
}

export interface DailyMissionRow {
  id: string;
  kind: string;
  title: string;
  stamps: number;
  on_site: boolean;
}

const numberSetting = (values: Record<string, unknown>, key: string, fallback: number): number => {
  const raw = Number(values[key]);
  return Number.isFinite(raw) ? raw : fallback;
};

export async function loadRewardSettings(db: Db): Promise<RewardSettings> {
  let stored: Record<string, unknown> = {};
  try {
    const result = await db.query('SELECT values FROM system_settings_document WHERE id = 1');
    stored = (result.rows[0]?.values ?? {}) as Record<string, unknown>;
  } catch {
    stored = {};
  }
  const canonical = canonicalSettings(stored);
  return {
    weeklyCap: numberSetting(canonical, 'stamps_weekly_cap', 250),
    dailyClaimStamps: numberSetting(canonical, 'stamps_daily_claim_stamps', 5),
    day7Stamps: numberSetting(canonical, 'stamps_daily_claim_day7_stamps', 25),
    chestRequired: numberSetting(canonical, 'stamps_weekly_chest_required', 5),
    chestStamps: numberSetting(canonical, 'stamps_weekly_chest_stamps', 30),
    shieldPrice: numberSetting(canonical, 'stamps_streak_shield_price', 100),
    shieldsMax: numberSetting(canonical, 'stamps_streak_shields_max', 2),
  };
}

export async function getStampEligibility(db: Db, userId: string): Promise<StampEligibility> {
  const result = await db.query(
    `SELECT u.is_test,
            (SELECT e.is_verified FROM account_emails e
              WHERE e.user_id = u.id AND e.is_primary = TRUE
              ORDER BY e.created_at ASC LIMIT 1) AS email_verified
       FROM users u WHERE u.id = $1`,
    [userId],
  );
  const row = result.rows[0];
  if (!row) return { eligible: false, isTest: false };
  return { eligible: row.email_verified !== false, isTest: Boolean(row.is_test) };
}

export async function isEligibleForStamps(db: Db, userId: string): Promise<boolean> {
  return (await getStampEligibility(db, userId)).eligible;
}

async function withTransaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function lockBalance(client: PoolClient, userId: string): Promise<number> {
  await client.query(
    'INSERT INTO stamp_balances(user_id, balance) VALUES($1, 0) ON CONFLICT (user_id) DO NOTHING',
    [userId],
  );
  const result = await client.query('SELECT balance FROM stamp_balances WHERE user_id = $1 FOR UPDATE', [userId]);
  return Number(result.rows[0]?.balance ?? 0);
}

async function ensureStreakRow(client: PoolClient, userId: string): Promise<void> {
  await client.query(
    'INSERT INTO user_streaks(user_id) VALUES($1) ON CONFLICT (user_id) DO NOTHING',
    [userId],
  );
}

async function lockStreak(client: PoolClient, userId: string): Promise<StreakRow> {
  await ensureStreakRow(client, userId);
  const result = await client.query(
    `SELECT current_streak, best_streak, last_claim_date::text AS last_claim_date, shields_held
       FROM user_streaks WHERE user_id = $1 FOR UPDATE`,
    [userId],
  );
  const row = result.rows[0];
  return {
    current_streak: Number(row?.current_streak ?? 0),
    best_streak: Number(row?.best_streak ?? 0),
    last_claim_date: row?.last_claim_date ?? null,
    shields_held: Number(row?.shields_held ?? 0),
  };
}

async function readStreak(client: Db, userId: string): Promise<StreakRow> {
  const result = await client.query(
    `SELECT current_streak, best_streak, last_claim_date::text AS last_claim_date, shields_held
       FROM user_streaks WHERE user_id = $1`,
    [userId],
  );
  const row = result.rows[0];
  return {
    current_streak: Number(row?.current_streak ?? 0),
    best_streak: Number(row?.best_streak ?? 0),
    last_claim_date: row?.last_claim_date ?? null,
    shields_held: Number(row?.shields_held ?? 0),
  };
}

async function weekStampsUsed(client: Db, userId: string, week: string): Promise<number> {
  const result = await client.query(
    `SELECT COALESCE(SUM(delta), 0)::int AS used
       FROM stamp_ledger WHERE user_id = $1 AND week_id = $2 AND delta > 0`,
    [userId, week],
  );
  return Number(result.rows[0]?.used ?? 0);
}

/** Assumes the caller already holds the user's stamp_balances row lock. */
async function awardStampsWithLock(client: PoolClient, input: StampAwardInput): Promise<StampAwardResult> {
  const used = await weekStampsUsed(client, input.userId, input.weekId);
  const remaining = Math.max(0, input.settings.weeklyCap - used);
  const awarded = Math.max(0, Math.min(input.amount, remaining));
  const capped = awarded < input.amount;
  const reason = capped ? `${input.reason ? `${input.reason}:` : ''}weekly_cap` : (input.reason ?? null);
  const inserted = await client.query(
    `INSERT INTO stamp_ledger(user_id, delta, source, source_key, manila_date, week_id, reason, is_test)
     VALUES($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (user_id, source, source_key) DO NOTHING
     RETURNING id`,
    [input.userId, awarded, input.source, input.sourceKey, input.manilaDate, input.weekId, reason, input.isTest],
  );
  if (!inserted.rowCount) return { awarded: 0, capped: false, inserted: false };
  if (awarded > 0) {
    await client.query(
      'UPDATE stamp_balances SET balance = balance + $2, updated_at = NOW() WHERE user_id = $1',
      [input.userId, awarded],
    );
  }
  return { awarded, capped, inserted: true };
}

async function ensureMonthlyShield(
  client: PoolClient,
  userId: string,
  manilaDate: string,
  settings: RewardSettings,
): Promise<boolean> {
  const streak = await lockStreak(client, userId);
  const sourceKey = `monthly:${manilaMonthKey(manilaDate)}`;
  const existing = await client.query(
    `SELECT 1 FROM streak_shield_events WHERE user_id = $1 AND kind = 'grant' AND source_key = $2`,
    [userId, sourceKey],
  );
  if (existing.rowCount) return false;
  const granted = streak.shields_held < settings.shieldsMax;
  await client.query(
    `INSERT INTO streak_shield_events(user_id, kind, source_key, delta, manila_date, reason)
     VALUES($1, 'grant', $2, $3, $4, $5)
     ON CONFLICT (user_id, kind, source_key) DO NOTHING`,
    [userId, sourceKey, granted ? 1 : 0, manilaDate, granted ? 'monthly_free' : 'max_held'],
  );
  if (granted) {
    await client.query(
      'UPDATE user_streaks SET shields_held = shields_held + 1, updated_at = NOW() WHERE user_id = $1',
      [userId],
    );
  }
  return granted;
}

function hashKey(value: string): string {
  return createHash('md5').update(value).digest('hex');
}

async function ensureDailyAssignments(client: PoolClient, userId: string, manilaDate: string): Promise<void> {
  const count = await client.query(
    'SELECT COUNT(*)::int AS count FROM user_daily_missions WHERE user_id = $1 AND manila_date = $2',
    [userId, manilaDate],
  );
  if (Number(count.rows[0]?.count ?? 0) >= 3) return;
  const missions = await client.query(
    `SELECT id, kind, title, stamps, on_site FROM daily_missions WHERE active = TRUE`,
  );
  const rows = missions.rows as DailyMissionRow[];
  const rank = (mission: DailyMissionRow) => hashKey(`${userId}|${manilaDate}|${mission.id}`);
  const atHome = rows.filter((m) => !m.on_site).sort((a, b) => rank(a).localeCompare(rank(b))).slice(0, 2);
  const onSite = rows.filter((m) => m.on_site).sort((a, b) => rank(a).localeCompare(rank(b))).slice(0, 1);
  for (const mission of [...atHome, ...onSite]) {
    await client.query(
      `INSERT INTO user_daily_missions(user_id, manila_date, mission_id, progress, target)
       VALUES($1, $2, $3, 0, 1) ON CONFLICT (user_id, manila_date, mission_id) DO NOTHING`,
      [userId, manilaDate, mission.id],
    );
  }
}

async function chestSnapshot(client: Db, userId: string, week: string, settings: RewardSettings) {
  const bounds = weekBoundsFromId(week);
  const count = await client.query(
    `SELECT COUNT(*)::int AS count FROM user_daily_missions
      WHERE user_id = $1 AND manila_date BETWEEN $2 AND $3 AND completed_at IS NOT NULL`,
    [userId, bounds.start, bounds.end],
  );
  const earned = await client.query(
    `SELECT 1 FROM stamp_ledger WHERE user_id = $1 AND source = 'weekly_chest' AND source_key = $2`,
    [userId, week],
  );
  const completed = Number(count.rows[0]?.count ?? 0);
  return {
    completed_missions: completed,
    required: settings.chestRequired,
    stamps: settings.chestStamps,
    earned: Boolean(earned.rowCount),
  };
}

function weekBoundsFromId(week: string): { start: string; end: string } {
  const [isoYear, weekPart] = week.split('-W').map(Number);
  const jan4 = new Date(Date.UTC(isoYear, 0, 4));
  const jan4Day = jan4.getUTCDay();
  const daysBack = jan4Day === 0 ? 6 : jan4Day - 1;
  const week1Monday = new Date(Date.UTC(isoYear, 0, 4 - daysBack));
  const monday = new Date(week1Monday.getTime() + (weekPart - 1) * 7 * 86_400_000);
  const start = monday.toISOString().slice(0, 10);
  return { start, end: addManilaDays(start, 6) };
}

async function claimSnapshot(client: PoolClient, userId: string, date: string, week: string, settings: RewardSettings) {
  const claim = await client.query(
    `SELECT dc.cycle_day, dc.stamps, dc.created_at,
            sl.delta AS awarded, sl.reason AS ledger_reason
       FROM daily_claims dc
       LEFT JOIN stamp_ledger sl
         ON sl.user_id = dc.user_id AND sl.source = 'daily_claim' AND sl.source_key = dc.manila_date::text
      WHERE dc.user_id = $1 AND dc.manila_date = $2`,
    [userId, date],
  );
  const latest = await client.query(
    `SELECT manila_date::text AS manila_date, cycle_day
       FROM daily_claims WHERE user_id = $1 ORDER BY manila_date DESC LIMIT 1`,
    [userId],
  );
  const today = claim.rows[0];
  const previous = latest.rows[0];
  const nextCycleDay = previous ? (Number(previous.cycle_day) >= 7 ? 1 : Number(previous.cycle_day) + 1) : 1;
  const cycleDay = today ? Number(today.cycle_day) : nextCycleDay;
  const claimedDays = today ? cycleDay : Math.max(0, nextCycleDay - 1);
  const balance = await client.query('SELECT balance FROM stamp_balances WHERE user_id = $1', [userId]);
  const streak = await readStreak(client, userId);
  const used = await weekStampsUsed(client, userId, week);
  const chest = await chestSnapshot(client, userId, week, settings);
  const calendar = Array.from({ length: 7 }, (_, index) => {
    const day = index + 1;
    return { day, stamps: day === 7 ? settings.day7Stamps : settings.dailyClaimStamps, claimed: day <= claimedDays };
  });
  return {
    date,
    week_id: week,
    next_reset_at: nextManilaMidnightUtc(new Date(`${date}T00:00:00+08:00`)).toISOString(),
    balance: Number(balance.rows[0]?.balance ?? 0),
    week: { used, cap: settings.weeklyCap, remaining: Math.max(0, settings.weeklyCap - used) },
    claim: {
      claimed_today: Boolean(today),
      cycle_day: cycleDay,
      claimed_days: claimedDays,
      nominal_stamps: dayStampsFor(cycleDay, settings),
      awarded: today ? Number(today.awarded ?? 0) : 0,
      capped: String(today?.ledger_reason ?? '').includes('weekly_cap'),
      claimed_at: today?.created_at ? new Date(today.created_at).toISOString() : null,
      calendar,
    },
    streak: {
      current: streak.current_streak,
      best: streak.best_streak,
      last_claim_date: streak.last_claim_date,
      shields_held: streak.shields_held,
      shields_max: settings.shieldsMax,
      shield_price: settings.shieldPrice,
    },
    chest,
  };
}

function dayStampsFor(cycleDay: number, settings: RewardSettings): number {
  return cycleDay === 7 ? settings.day7Stamps : settings.dailyClaimStamps;
}

export interface ClaimDailyOptions {
  now?: Date;
  idempotencyKey?: string | null;
}

export async function claimDaily(pool: Pool, userId: string, options: ClaimDailyOptions = {}) {
  const now = options.now ?? new Date();
  const date = manilaDateString(now);
  const week = manilaWeekId(date);
  return withTransaction(pool, async (client) => {
    const eligibility = await getStampEligibility(client, userId);
    if (!eligibility.eligible) {
      throw new StampsError('ACCOUNT_NOT_VERIFIED', 403, 'Verify your account before claiming stamp rewards.');
    }
    await lockBalance(client, userId);
    const settings = await loadRewardSettings(client);
    const existing = await client.query(
      'SELECT 1 FROM daily_claims WHERE user_id = $1 AND manila_date = $2',
      [userId, date],
    );
    if (existing.rowCount) {
      return { ...(await claimSnapshot(client, userId, date, week, settings)), replayed: true };
    }
    await ensureMonthlyShield(client, userId, date, settings);
    const streak = await lockStreak(client, userId);
    const previous = await client.query(
      `SELECT cycle_day FROM daily_claims WHERE user_id = $1 AND manila_date < $2
        ORDER BY manila_date DESC LIMIT 1`,
      [userId, date],
    );
    const cycleDay = previous.rows[0]
      ? (Number(previous.rows[0].cycle_day) >= 7 ? 1 : Number(previous.rows[0].cycle_day) + 1)
      : 1;
    const nominalStamps = dayStampsFor(cycleDay, settings);
    let current = 1;
    let consumedShields = 0;
    if (streak.last_claim_date) {
      const gap = daysBetweenManila(streak.last_claim_date, date);
      if (gap === 1) {
        current = streak.current_streak + 1;
      } else if (gap > 1) {
        const missed = gap - 1;
        if (streak.shields_held >= missed) {
          consumedShields = missed;
          current = streak.current_streak + 1;
          await client.query(
            `INSERT INTO streak_shield_events(user_id, kind, source_key, delta, manila_date, reason)
             VALUES($1, 'consume', $2, $3, $4, 'missed_day')
             ON CONFLICT (user_id, kind, source_key) DO NOTHING`,
            [userId, `miss:${streak.last_claim_date}:${date}`, -missed, date],
          );
        } else {
          current = 1;
        }
      } else {
        current = Math.max(1, streak.current_streak);
      }
    }
    const best = Math.max(streak.best_streak, current);
    await client.query(
      `UPDATE user_streaks
          SET current_streak = $2, best_streak = $3, last_claim_date = $4,
              shields_held = GREATEST(0, shields_held - $5), updated_at = NOW()
        WHERE user_id = $1`,
      [userId, current, best, date, consumedShields],
    );
    await client.query(
      `INSERT INTO daily_claims(user_id, manila_date, cycle_day, stamps)
       VALUES($1, $2, $3, $4)`,
      [userId, date, cycleDay, nominalStamps],
    );
    await awardStampsWithLock(client, {
      userId, amount: nominalStamps, source: 'daily_claim', sourceKey: date,
      manilaDate: date, weekId: week, reason: 'daily_claim', isTest: eligibility.isTest, settings,
    });
    // Plan 65: a reigning daily_stamp_bonus adds stamps as its own ledger row, still inside the weekly cap.
    const stampBonus = await perkBonus(client, eligibility.isTest, perk => perk.key === 'daily_stamp_bonus');
    if (stampBonus.value > 0) {
      await awardStampsWithLock(client, {
        userId, amount: Math.round(stampBonus.value), source: 'juanchoice_perk', sourceKey: `daily:${date}`,
        manilaDate: date, weekId: week, reason: 'juanchoice_daily_bonus', isTest: eligibility.isTest, settings,
      });
    }
    return { ...(await claimSnapshot(client, userId, date, week, settings)), replayed: false };
  });
}

export async function getDailyState(pool: Pool, userId: string, options: { now?: Date } = {}) {
  const now = options.now ?? new Date();
  const date = manilaDateString(now);
  const week = manilaWeekId(date);
  return withTransaction(pool, async (client) => {
    const settings = await loadRewardSettings(client);
    const eligibility = await getStampEligibility(client, userId);
    if (eligibility.eligible) {
      await ensureMonthlyShield(client, userId, date, settings);
    }
    await ensureDailyAssignments(client, userId, date);
    const snapshot = await claimSnapshot(client, userId, date, week, settings);
    const missions = await client.query(
      `SELECT dm.id, dm.kind, dm.title, dm.stamps, dm.on_site,
              udm.progress, udm.target, udm.completed_at
         FROM user_daily_missions udm
         JOIN daily_missions dm ON dm.id = udm.mission_id
        WHERE udm.user_id = $1 AND udm.manila_date = $2
        ORDER BY dm.on_site ASC, dm.id ASC`,
      [userId, date],
    );
    const qotd = await client.query(
      'SELECT 1 FROM qotd_answers WHERE user_id = $1 AND manila_date = $2',
      [userId, date],
    );
    return {
      ...snapshot,
      missions: missions.rows.map((row: any) => ({
        id: row.id,
        kind: row.kind,
        title: row.title,
        stamps: Number(row.stamps),
        on_site: Boolean(row.on_site),
        progress: Number(row.progress),
        target: Number(row.target),
        completed: Boolean(row.completed_at),
        completed_at: row.completed_at ? new Date(row.completed_at).toISOString() : null,
      })),
      qotd: { answered: Boolean(qotd.rowCount) },
    };
  });
}

export interface MissionEventOptions {
  now?: Date;
  sourceKey: string;
}

export async function recordMissionEvent(
  pool: Pool,
  userId: string,
  kind: string,
  options: MissionEventOptions,
) {
  const now = options.now ?? new Date();
  const date = manilaDateString(now);
  const week = manilaWeekId(date);

  // Cheap read first: most destination views/cheers arrive after today's missions
  // are already complete. Avoid opening a transaction and locking the balance
  // unless assignments are missing or a matching mission is still incomplete.
  const prepared = await pool.query(
    `SELECT
       EXISTS (SELECT 1 FROM user_daily_missions udm
                 JOIN daily_missions dm ON dm.id = udm.mission_id
                WHERE udm.user_id = $1 AND udm.manila_date = $2 AND dm.kind = $3
                  AND udm.completed_at IS NULL) AS matching,
       EXISTS (SELECT 1 FROM user_daily_missions
                WHERE user_id = $1 AND manila_date = $2) AS assigned`,
    [userId, date, kind],
  );
  if (prepared.rows[0]?.assigned && !prepared.rows[0]?.matching) {
    return { completed: false, reason: 'not_assigned' as const };
  }

  return withTransaction(pool, async (client) => {
    const eligibility = await getStampEligibility(client, userId);
    if (!eligibility.eligible) {
      return { completed: false, reason: 'ineligible' as const };
    }
    await lockBalance(client, userId);
    const settings = await loadRewardSettings(client);
    await ensureDailyAssignments(client, userId, date);
    const assigned = await client.query(
      `SELECT dm.id, dm.kind, dm.title, dm.stamps, dm.on_site, udm.target
         FROM user_daily_missions udm
         JOIN daily_missions dm ON dm.id = udm.mission_id
        WHERE udm.user_id = $1 AND udm.manila_date = $2 AND dm.kind = $3
          AND udm.completed_at IS NULL`,
      [userId, date, kind],
    );
    const mission = assigned.rows[0];
    if (!mission) return { completed: false, reason: 'not_assigned' as const };
    const updated = await client.query(
      `UPDATE user_daily_missions
          SET progress = target, completed_at = NOW()
        WHERE user_id = $1 AND manila_date = $2 AND mission_id = $3 AND completed_at IS NULL
        RETURNING mission_id`,
      [userId, date, mission.id],
    );
    if (!updated.rowCount) return { completed: false, reason: 'already_completed' as const };
    const award = await awardStampsWithLock(client, {
      userId,
      amount: Number(mission.stamps),
      source: 'mission',
      sourceKey: `${date}:${mission.id}`,
      manilaDate: date,
      weekId: week,
      reason: kind,
      isTest: eligibility.isTest,
      settings,
    });
    const chest = await chestSnapshot(client, userId, week, settings);
    let chestAwarded = 0;
    if (chest.completed_missions >= settings.chestRequired && !chest.earned) {
      const chestResult = await awardStampsWithLock(client, {
        userId,
        amount: settings.chestStamps,
        source: 'weekly_chest',
        sourceKey: week,
        manilaDate: date,
        weekId: week,
        reason: 'weekly_chest',
        isTest: eligibility.isTest,
        settings,
      });
      chestAwarded = chestResult.awarded;
    }
    return {
      completed: true,
      reason: 'completed' as const,
      mission_id: mission.id,
      kind,
      awarded: award.awarded,
      capped: award.capped,
      chest_awarded: chestAwarded,
      source_key: options.sourceKey,
    };
  });
}

export async function spendStamps(
  pool: Pool,
  userId: string,
  item: string,
  idempotencyKey: string,
  options: { now?: Date } = {},
) {
  if (item !== 'streak_shield') {
    throw new StampsError('UNSUPPORTED_ITEM', 400, 'Only streak shields are purchasable with stamps in this phase.');
  }
  const now = options.now ?? new Date();
  const date = manilaDateString(now);
  return withTransaction(pool, async (client) => {
    const eligibility = await getStampEligibility(client, userId);
    if (!eligibility.eligible) {
      throw new StampsError('ACCOUNT_NOT_VERIFIED', 403, 'Verify your account before spending stamps.');
    }
    const balance = await lockBalance(client, userId);
    const settings = await loadRewardSettings(client);
    const replay = await client.query(
      `SELECT delta FROM stamp_ledger
        WHERE user_id = $1 AND source = 'spend:streak_shield' AND source_key = $2`,
      [userId, idempotencyKey],
    );
    if (replay.rowCount) {
      const streak = await readStreak(client, userId);
      return {
        item, price: settings.shieldPrice, balance, shields_held: streak.shields_held,
        replayed: true,
      };
    }
    const streak = await lockStreak(client, userId);
    if (streak.shields_held >= settings.shieldsMax) {
      throw new StampsError('MAX_SHIELDS', 409, 'You already hold the maximum number of streak shields.');
    }
    if (balance < settings.shieldPrice) {
      throw new StampsError('INSUFFICIENT_STAMPS', 409, 'You do not have enough stamps for a streak shield.');
    }
    const inserted = await client.query(
      `INSERT INTO stamp_ledger(user_id, delta, source, source_key, manila_date, week_id, reason, is_test)
       VALUES($1, $2, 'spend:streak_shield', $3, $4, $5, 'streak_shield', $6)
       ON CONFLICT (user_id, source, source_key) DO NOTHING
       RETURNING id`,
      [userId, -settings.shieldPrice, idempotencyKey, date, manilaWeekId(date), eligibility.isTest],
    );
    if (!inserted.rowCount) {
      return { item, price: settings.shieldPrice, balance, shields_held: streak.shields_held, replayed: true };
    }
    await client.query(
      'UPDATE stamp_balances SET balance = balance - $2, updated_at = NOW() WHERE user_id = $1',
      [userId, settings.shieldPrice],
    );
    await client.query(
      'UPDATE user_streaks SET shields_held = shields_held + 1, updated_at = NOW() WHERE user_id = $1',
      [userId],
    );
    await client.query(
      `INSERT INTO streak_shield_events(user_id, kind, source_key, delta, manila_date, reason)
       VALUES($1, 'purchase', $2, 1, $3, 'streak_shield')
       ON CONFLICT (user_id, kind, source_key) DO NOTHING`,
      [userId, idempotencyKey, date],
    );
    return {
      item,
      price: settings.shieldPrice,
      balance: balance - settings.shieldPrice,
      shields_held: streak.shields_held + 1,
      replayed: false,
    };
  });
}

export async function getStampHistory(
  pool: Pool,
  userId: string,
  options: { cursor?: number | null; limit?: number } = {},
) {
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 50);
  const cursor = options.cursor ?? null;
  const result = await pool.query(
    `SELECT id, delta, source, reason, manila_date::text AS manila_date, created_at
       FROM stamp_ledger
      WHERE user_id = $1 AND ($2::bigint IS NULL OR id < $2::bigint)
      ORDER BY id DESC LIMIT $3`,
    [userId, cursor, limit],
  );
  const balance = await pool.query('SELECT balance FROM stamp_balances WHERE user_id = $1', [userId]);
  const items = result.rows.map((row: any) => ({
    id: Number(row.id),
    delta: Number(row.delta),
    source: row.source,
    reason: row.reason,
    manila_date: row.manila_date,
    created_at: new Date(row.created_at).toISOString(),
  }));
  return {
    balance: Number(balance.rows[0]?.balance ?? 0),
    items,
    next_cursor: items.length === limit ? items[items.length - 1].id : null,
  };
}

export async function ensureQuestionOfTheDay(client: Db, date: string): Promise<string | null> {
  await client.query(
    `INSERT INTO question_of_the_day(manila_date, question_id)
     SELECT $1::date, q.id
       FROM qotd_questions q
      WHERE q.active = TRUE
      ORDER BY md5(q.id || $1::text)
      LIMIT 1
     ON CONFLICT (manila_date) DO NOTHING`,
    [date],
  );
  const result = await client.query(
    'SELECT question_id FROM question_of_the_day WHERE manila_date = $1',
    [date],
  );
  return result.rows[0]?.question_id ?? null;
}

async function qotdPayload(client: Db, questionId: string) {
  const question = await client.query(
    `SELECT id, question_text, explanation, source_url
       FROM qotd_questions WHERE id = $1`,
    [questionId],
  );
  const row = question.rows[0];
  if (!row) return null;
  const options = await client.query(
    'SELECT id, ordinal, option_text FROM qotd_options WHERE question_id = $1 ORDER BY ordinal',
    [questionId],
  );
  return {
    id: row.id,
    text: row.question_text,
    explanation: row.explanation,
    source_url: row.source_url,
    quiz_title: 'Pangasinan Heritage',
    options: options.rows.map((option: any) => ({
      id: option.id,
      ordinal: Number(option.ordinal),
      text: option.option_text,
    })),
  };
}

export async function getQuestionOfTheDay(
  pool: Pool,
  userId: string | null,
  options: { now?: Date } = {},
) {
  const now = options.now ?? new Date();
  const date = manilaDateString(now);
  return withTransaction(pool, async (client) => {
    const questionId = await ensureQuestionOfTheDay(client, date);
    if (!questionId) {
      return { date, question: null, answered: false, answer: null };
    }
    const question = await qotdPayload(client, questionId);
    if (!question) return { date, question: null, answered: false, answer: null };
    let answer: null | { correct: boolean; option_id: string; explanation: string | null; source_url: string | null } = null;
    if (userId) {
      const answered = await client.query(
        'SELECT selected_option_id, correct FROM qotd_answers WHERE user_id = $1 AND manila_date = $2',
        [userId, date],
      );
      const row = answered.rows[0];
      if (row) {
        answer = {
          correct: Boolean(row.correct),
          option_id: row.selected_option_id,
          explanation: question.explanation,
          source_url: question.source_url,
        };
      }
    }
    return {
      date,
      question: {
        id: question.id,
        text: question.text,
        quiz_title: question.quiz_title,
        options: question.options,
      },
      answered: Boolean(answer),
      answer,
    };
  });
}

export async function answerQuestionOfTheDay(
  pool: Pool,
  userId: string,
  optionId: string,
  options: { now?: Date } = {},
) {
  const now = options.now ?? new Date();
  const date = manilaDateString(now);
  const result = await withTransaction(pool, async (client) => {
    const questionId = await ensureQuestionOfTheDay(client, date);
    if (!questionId) throw new StampsError('QOTD_UNAVAILABLE', 404, 'No active question is available today.');
    const option = await client.query(
      `SELECT id, is_correct FROM qotd_options
        WHERE id = $1 AND question_id = $2`,
      [optionId, questionId],
    );
    const selected = option.rows[0];
    if (!selected) throw new StampsError('INVALID_OPTION', 400, 'That option does not belong to today\'s question.');
    const inserted = await client.query(
      `INSERT INTO qotd_answers(user_id, manila_date, selected_option_id, correct)
       VALUES($1, $2, $3, $4)
       ON CONFLICT (user_id, manila_date) DO NOTHING
       RETURNING correct`,
      [userId, date, selected.id, Boolean(selected.is_correct)],
    );
    if (!inserted.rowCount) {
      throw new StampsError('ALREADY_ANSWERED', 409, 'You already answered today\'s question.');
    }
    const correctOption = await client.query(
      'SELECT id FROM qotd_options WHERE question_id = $1 AND is_correct = TRUE LIMIT 1',
      [questionId],
    );
    const detail = await client.query(
      'SELECT explanation, source_url FROM qotd_questions WHERE id = $1',
      [questionId],
    );
    return {
      date,
      correct: Boolean(selected.is_correct),
      correct_option_id: correctOption.rows[0]?.id ?? null,
      explanation: detail.rows[0]?.explanation ?? null,
      source_url: detail.rows[0]?.source_url ?? null,
    };
  });
  return result;
}

export async function listDailyMissions(pool: Pool) {
  const result = await pool.query(
    'SELECT id, kind, title, stamps, on_site, active FROM daily_missions ORDER BY on_site ASC, id ASC',
  );
  return result.rows.map((row: any) => ({
    id: row.id, kind: row.kind, title: row.title, stamps: Number(row.stamps),
    on_site: Boolean(row.on_site), active: Boolean(row.active),
  }));
}

export async function upsertDailyMission(
  pool: Pool,
  input: { id?: string; kind: string; title: string; stamps: number; on_site: boolean; active?: boolean },
) {
  const id = input.id ?? `mission-${input.kind.replace(/[^a-z0-9_]/g, '-')}`;
  const result = await pool.query(
    `INSERT INTO daily_missions(id, kind, title, stamps, on_site, active)
     VALUES($1, $2, $3, $4, $5, $6)
     ON CONFLICT (kind) DO UPDATE
       SET title = EXCLUDED.title, stamps = EXCLUDED.stamps, on_site = EXCLUDED.on_site,
           active = EXCLUDED.active, updated_at = NOW()
     RETURNING id, kind, title, stamps, on_site, active`,
    [id, input.kind, input.title, input.stamps, input.on_site, input.active ?? true],
  );
  const row = result.rows[0];
  return {
    id: row.id, kind: row.kind, title: row.title, stamps: Number(row.stamps),
    on_site: Boolean(row.on_site), active: Boolean(row.active),
  };
}

export async function setDailyMissionActive(pool: Pool, id: string, active: boolean) {
  const result = await pool.query(
    'UPDATE daily_missions SET active = $2, updated_at = NOW() WHERE id = $1 RETURNING id',
    [id, active],
  );
  if (!result.rowCount) throw new StampsError('NOT_FOUND', 404, 'Mission not found.');
}

export interface QotdOptionInput {
  option_text: string;
  is_correct: boolean;
}

export interface QotdQuestionInput {
  question_text: string;
  explanation: string;
  source_url?: string | null;
  options: QotdOptionInput[];
}

export interface QotdQuestionPatch {
  question_text?: string;
  explanation?: string;
  source_url?: string | null;
  active?: boolean;
  options?: QotdOptionInput[];
}

function validateQotdOptions(options: QotdOptionInput[]): void {
  if (!Array.isArray(options) || options.length !== 4) {
    throw new StampsError('INVALID_QOTD', 400, 'Provide exactly four options.');
  }
  if (options.filter((option) => option.is_correct).length !== 1) {
    throw new StampsError('INVALID_QOTD', 400, 'Exactly one option must be marked correct.');
  }
  if (options.some((option) => !option.option_text?.trim())) {
    throw new StampsError('INVALID_QOTD', 400, 'Every option needs text.');
  }
}

async function qotdQuestionWithOptions(client: Db, id: string) {
  const question = await client.query(
    `SELECT id, question_text, explanation, source_url, active, created_by, created_at
       FROM qotd_questions WHERE id = $1`,
    [id],
  );
  const row = question.rows[0];
  if (!row) return null;
  const options = await client.query(
    'SELECT id, ordinal, option_text, is_correct FROM qotd_options WHERE question_id = $1 ORDER BY ordinal',
    [id],
  );
  return {
    id: row.id,
    question_text: row.question_text,
    explanation: row.explanation,
    source_url: row.source_url,
    active: Boolean(row.active),
    created_by: row.created_by,
    created_at: row.created_at ? new Date(row.created_at).toISOString() : null,
    options: options.rows.map((option: any) => ({
      id: option.id,
      ordinal: Number(option.ordinal),
      option_text: option.option_text,
      is_correct: Boolean(option.is_correct),
    })),
  };
}

export async function listQotdPoolQuestions(pool: Pool) {
  const questions = await pool.query(
    `SELECT id FROM qotd_questions ORDER BY created_at DESC, id ASC`,
  );
  return Promise.all(questions.rows.map((row: any) => qotdQuestionWithOptions(pool, row.id)));
}

export async function createQotdQuestion(pool: Pool, input: QotdQuestionInput, createdBy: string) {
  validateQotdOptions(input.options);
  const id = `qotd-${randomUUID()}`;
  return withTransaction(pool, async (client) => {
    await client.query(
      `INSERT INTO qotd_questions(id, question_text, explanation, source_url, active, created_by)
       VALUES($1, $2, $3, $4, TRUE, $5)`,
      [id, input.question_text, input.explanation, input.source_url ?? null, createdBy],
    );
    for (const [index, option] of input.options.entries()) {
      await client.query(
        `INSERT INTO qotd_options(id, question_id, ordinal, option_text, is_correct)
         VALUES($1, $2, $3, $4, $5)`,
        [`qotd-opt-${randomUUID()}`, id, index + 1, option.option_text.trim(), option.is_correct],
      );
    }
    return qotdQuestionWithOptions(client, id);
  });
}

export async function updateQotdQuestion(pool: Pool, id: string, patch: QotdQuestionPatch) {
  if (patch.options !== undefined) validateQotdOptions(patch.options);
  return withTransaction(pool, async (client) => {
    const existing = await client.query('SELECT id FROM qotd_questions WHERE id = $1', [id]);
    if (!existing.rowCount) throw new StampsError('NOT_FOUND', 404, 'QotD question not found.');
    await client.query(
      `UPDATE qotd_questions
          SET question_text = COALESCE($2, question_text),
              explanation = COALESCE($3, explanation),
              source_url = CASE WHEN $4::boolean THEN $5 ELSE source_url END,
              active = COALESCE($6, active),
              updated_at = NOW()
        WHERE id = $1`,
      [id, patch.question_text ?? null, patch.explanation ?? null,
        patch.source_url !== undefined, patch.source_url ?? null, patch.active ?? null],
    );
    if (patch.options) {
      await client.query('DELETE FROM qotd_options WHERE question_id = $1', [id]);
      for (const [index, option] of patch.options.entries()) {
        await client.query(
          `INSERT INTO qotd_options(id, question_id, ordinal, option_text, is_correct)
           VALUES($1, $2, $3, $4, $5)`,
          [`qotd-opt-${randomUUID()}`, id, index + 1, option.option_text.trim(), option.is_correct],
        );
      }
    }
    return qotdQuestionWithOptions(client, id);
  });
}

export async function scheduleQuestionOfTheDay(pool: Pool, date: string, questionId: string) {
  const question = await pool.query(
    'SELECT id FROM qotd_questions WHERE id = $1 AND active = TRUE',
    [questionId],
  );
  if (!question.rowCount) {
    throw new StampsError('INVALID_QUESTION', 400, 'Pick an active question from the QotD pool.');
  }
  await pool.query(
    `INSERT INTO question_of_the_day(manila_date, question_id) VALUES($1, $2)
     ON CONFLICT (manila_date) DO UPDATE SET question_id = EXCLUDED.question_id, created_at = NOW()`,
    [date, questionId],
  );
}

export async function listQotdCandidates(pool: Pool, limit = 50) {
  const result = await pool.query(
    `SELECT id, question_text, active
       FROM qotd_questions
      ORDER BY active DESC, created_at ASC, id ASC LIMIT $1`,
    [Math.min(Math.max(limit, 1), 100)],
  );
  return result.rows.map((row: any) => ({
    id: row.id, question_text: row.question_text, active: Boolean(row.active),
  }));
}

export async function stampAdminStats(pool: Pool, options: { now?: Date } = {}) {
  const now = options.now ?? new Date();
  const date = manilaDateString(now);
  const week = manilaWeekId(date);
  const bounds = manilaWeekBounds(date);
  const [claims, missions, capHits, travelers, outstanding] = await Promise.all([
    pool.query(
      `SELECT COUNT(*)::int AS count FROM daily_claims dc
         JOIN users u ON u.id = dc.user_id
        WHERE dc.manila_date = $1 AND u.is_test = FALSE`,
      [date],
    ),
    pool.query(
      `SELECT COUNT(*)::int AS count FROM user_daily_missions udm
         JOIN users u ON u.id = udm.user_id
        WHERE udm.manila_date = $1 AND udm.completed_at IS NOT NULL AND u.is_test = FALSE`,
      [date],
    ),
    pool.query(
      `SELECT COUNT(*)::int AS count FROM stamp_ledger
        WHERE week_id = $1 AND reason LIKE '%weekly_cap%' AND is_test = FALSE`,
      [week],
    ),
    pool.query(
      'SELECT COUNT(DISTINCT user_id)::int AS count FROM stamp_ledger WHERE manila_date = $1 AND is_test = FALSE',
      [date],
    ),
    pool.query(
      `SELECT COALESCE(SUM(b.balance), 0)::int AS total FROM stamp_balances b
         JOIN users u ON u.id = b.user_id
        WHERE u.is_test = FALSE`,
    ),
  ]);
  return {
    date,
    week_id: week,
    week_start: bounds.start,
    week_end: bounds.end,
    claims_today: Number(claims.rows[0]?.count ?? 0),
    missions_completed_today: Number(missions.rows[0]?.count ?? 0),
    weekly_cap_hits: Number(capHits.rows[0]?.count ?? 0),
    travelers_today: Number(travelers.rows[0]?.count ?? 0),
    outstanding_balance: Number(outstanding.rows[0]?.total ?? 0),
  };
}

export { addManilaDays, daysBetweenManila, manilaDateString, manilaWeekId, nextManilaMidnightUtc };
