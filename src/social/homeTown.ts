import { getPool } from '../db/pool.js';
import { ensureAreaCache, getCachedAreas, matchSpotToAreas } from '../maps/areas-service.js';
import { distanceMeters } from '../maps/geometry.js';
import { PANGASINAN_MUNICIPALITIES } from '../routes/affiliates.js';

export type HomeTownSource = 'gps' | 'manual' | null;

export interface HomeTownDaysProgress {
  current_days: number;
  required_days: number;
  leading_town: string | null;
}

export interface HomeTownState {
  home_municipality: string | null;
  home_town_source: HomeTownSource;
  home_town_gps: boolean;
  days_progress: HomeTownDaysProgress;
}

export interface SightingInput {
  lat: number;
  lng: number;
  accuracy: number;
  is_mocked: boolean;
  now?: Date;
}

export interface SightingResult {
  accepted: boolean;
  ignored_reason?: string;
  state: HomeTownState;
}

const REQUIRED_DAYS = 5;
const WINDOW_DAYS = 30;
const MAX_ACCURACY_METERS = 100;
const MAX_SPEED_KMH = 150;

interface MemorySighting {
  townAreaId: string;
  townName: string;
  lat: number;
  lng: number;
  day: string;
  createdAt: Date;
}

const memoryUsers = new Map<string, { town: string | null; source: HomeTownSource; gps: boolean }>();
const memorySightings = new Map<string, MemorySighting[]>();

/** The canonical spelling of a Pangasinan town, or undefined if it is not one. */
export function canonicalTown(input: string): string | undefined {
  const key = input.trim().toLowerCase();
  return PANGASINAN_MUNICIPALITIES.find((t) => t.toLowerCase() === key);
}

function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function cutoffDayKey(now: Date): string {
  const d = new Date(now.getTime() - (WINDOW_DAYS - 1) * 86_400_000);
  return dayKey(d);
}

export async function getHomeTownState(userId: string, now = new Date()): Promise<HomeTownState> {
  const pool = getPool();
  if (!pool) {
    const entry = memoryUsers.get(userId) ?? { town: null, source: null, gps: true };
    const cutoff = cutoffDayKey(now);
    const counts = new Map<string, { name: string; days: Set<string>; latest: number }>();
    for (const s of memorySightings.get(userId) ?? []) {
      if (s.day < cutoff) continue;
      const cur = counts.get(s.townAreaId) ?? { name: s.townName, days: new Set(), latest: 0 };
      cur.days.add(s.day);
      cur.latest = Math.max(cur.latest, s.createdAt.getTime());
      counts.set(s.townAreaId, cur);
    }
    const sorted = Array.from(counts.values()).sort((a, b) => b.days.size - a.days.size || b.latest - a.latest);
    const top = sorted[0];
    return {
      home_municipality: entry.town,
      home_town_source: entry.source,
      home_town_gps: entry.gps,
      days_progress: {
        current_days: top ? top.days.size : 0,
        required_days: REQUIRED_DAYS,
        leading_town: top ? top.name : null,
      },
    };
  }

  const userRes = await pool.query<{
    home_municipality: string | null;
    home_town_source: string | null;
    home_town_gps: boolean | null;
  }>('SELECT home_municipality, home_town_source, home_town_gps FROM users WHERE id = $1', [userId]);
  const row = userRes.rows[0];
  const cutoff = cutoffDayKey(now);
  const progressRes = await pool.query<{ town_name: string; days: number }>(
    `SELECT town_name, COUNT(DISTINCT day)::int AS days
       FROM home_town_sightings
      WHERE user_id = $1 AND day >= $2::date
      GROUP BY town_area_id, town_name
      ORDER BY days DESC, MAX(created_at) DESC
      LIMIT 1`,
    [userId, cutoff],
  );
  const top = progressRes.rows[0];
  const rawSource = row?.home_town_source;
  const source: HomeTownSource = rawSource === 'gps' || rawSource === 'manual' ? rawSource : null;

  return {
    home_municipality: row?.home_municipality ?? null,
    home_town_source: source,
    home_town_gps: row?.home_town_gps ?? true,
    days_progress: {
      current_days: top?.days ?? 0,
      required_days: REQUIRED_DAYS,
      leading_town: top?.town_name ?? null,
    },
  };
}

export async function getHomeTown(userId: string): Promise<string | null> {
  const state = await getHomeTownState(userId);
  return state.home_municipality;
}

export async function setHomeTown(
  userId: string,
  town: string | null,
  source: HomeTownSource = 'manual',
): Promise<void> {
  const pool = getPool();
  if (!pool) {
    const cur = memoryUsers.get(userId) ?? { town: null, source: null, gps: true };
    memoryUsers.set(userId, { ...cur, town, source });
    return;
  }
  await pool.query('UPDATE users SET home_municipality = $2, home_town_source = $3 WHERE id = $1', [
    userId,
    town,
    source,
  ]);
}

export async function setHomeTownGps(userId: string, enabled: boolean): Promise<HomeTownState> {
  const pool = getPool();
  if (!pool) {
    const cur = memoryUsers.get(userId) ?? { town: null, source: null, gps: true };
    memoryUsers.set(userId, { ...cur, gps: enabled });
  } else {
    await pool.query('UPDATE users SET home_town_gps = $2 WHERE id = $1', [userId, enabled]);
  }
  if (enabled) {
    const state = await getHomeTownState(userId);
    if (state.days_progress.current_days >= REQUIRED_DAYS && state.days_progress.leading_town) {
      await setHomeTown(userId, state.days_progress.leading_town, 'gps');
    }
  }
  return getHomeTownState(userId);
}

export async function recordHomeTownSighting(userId: string, input: SightingInput): Promise<SightingResult> {
  const now = input.now ?? new Date();
  const stateBefore = await getHomeTownState(userId, now);

  if (!stateBefore.home_town_gps) {
    return { accepted: false, ignored_reason: 'gps_disabled', state: stateBefore };
  }
  if (input.is_mocked) {
    return { accepted: false, ignored_reason: 'mocked_location', state: stateBefore };
  }
  if (!Number.isFinite(input.accuracy) || input.accuracy < 0 || input.accuracy > MAX_ACCURACY_METERS) {
    return { accepted: false, ignored_reason: 'low_accuracy', state: stateBefore };
  }

  const pool = getPool();
  if (pool) {
    await ensureAreaCache(pool);
  }
  const match = matchSpotToAreas(input.lat, input.lng);
  if (!match.townAreaId) {
    return { accepted: false, ignored_reason: 'outside_pangasinan', state: stateBefore };
  }
  const area = getCachedAreas()?.find((a) => a.id === match.townAreaId);
  const resolvedTown = area?.name ? (canonicalTown(area.name) ?? area.name) : null;
  if (!resolvedTown) {
    return { accepted: false, ignored_reason: 'outside_pangasinan', state: stateBefore };
  }

  const day = dayKey(now);

  if (!pool) {
    const list = memorySightings.get(userId) ?? [];
    const latest = list[list.length - 1];
    if (latest) {
      const distKm = distanceMeters(latest.lat, latest.lng, input.lat, input.lng) / 1000;
      const hours = (now.getTime() - latest.createdAt.getTime()) / 3_600_000;
      if ((hours > 0 && distKm / hours > MAX_SPEED_KMH) || (hours <= 0 && distKm > 1)) {
        return { accepted: false, ignored_reason: 'teleport_detected', state: stateBefore };
      }
    }
    if (list.some((s) => s.townAreaId === match.townAreaId && s.day === day)) {
      return { accepted: false, ignored_reason: 'already_recorded_today', state: stateBefore };
    }
    list.push({
      townAreaId: match.townAreaId,
      townName: resolvedTown,
      lat: input.lat,
      lng: input.lng,
      day,
      createdAt: now,
    });
    memorySightings.set(userId, list);
    const after = await getHomeTownState(userId, now);
    if (after.days_progress.current_days >= REQUIRED_DAYS && after.days_progress.leading_town) {
      await setHomeTown(userId, after.days_progress.leading_town, 'gps');
    }
    return { accepted: true, state: await getHomeTownState(userId, now) };
  }

  // Teleport guard against most recent accepted sighting
  const prevRes = await pool.query<{ lat: number; lng: number; created_at: Date }>(
    `SELECT lat, lng, created_at
       FROM home_town_sightings
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT 1`,
    [userId],
  );
  const prev = prevRes.rows[0];
  if (prev) {
    const distKm = distanceMeters(prev.lat, prev.lng, input.lat, input.lng) / 1000;
    const hours = (now.getTime() - new Date(prev.created_at).getTime()) / 3_600_000;
    if ((hours > 0 && distKm / hours > MAX_SPEED_KMH) || (hours <= 0 && distKm > 1)) {
      return { accepted: false, ignored_reason: 'teleport_detected', state: stateBefore };
    }
  }

  const insertRes = await pool.query(
    `INSERT INTO home_town_sightings
       (user_id, town_area_id, town_name, lat, lng, accuracy_m, day, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::date, $8)
     ON CONFLICT (user_id, town_area_id, day) DO NOTHING`,
    [userId, match.townAreaId, resolvedTown, input.lat, input.lng, input.accuracy, day, now],
  );
  if ((insertRes.rowCount ?? 0) === 0) {
    return { accepted: false, ignored_reason: 'already_recorded_today', state: stateBefore };
  }

  const after = await getHomeTownState(userId, now);
  if (after.days_progress.current_days >= REQUIRED_DAYS && after.days_progress.leading_town) {
    await setHomeTown(userId, after.days_progress.leading_town, 'gps');
  }
  return { accepted: true, state: await getHomeTownState(userId, now) };
}
