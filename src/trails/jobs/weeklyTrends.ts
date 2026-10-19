import type { Pool } from 'pg';
import { getPool } from '../../db/pool.js';
import { manilaDayOfWeek, manilaHour, weekId } from '../../social/time.js';
import { TrailGenerationError, generateTrail } from '../generate.js';
import { createTrendDigest, type WeeklyTrendFacts } from '../ai/service.js';

export const TRAIL_WEEKLY_TRENDS_LOCK_KEY = 440055;
const TICK_MS = 5 * 60 * 1000;

export interface WeeklyTrailJobSummary {
  weekId: string;
  skippedReason?: 'not_due' | 'already_run' | 'locked';
  digestAiUsed: boolean;
  generated: number;
  alreadyGenerated: number;
  infeasible: number;
}

export function isTrailTrendWindow(now: Date): boolean {
  return manilaDayOfWeek(now) === 1 && manilaHour(now) >= 1;
}

export async function runWeeklyTrailTrends(pool: Pool, now = new Date()): Promise<WeeklyTrailJobSummary> {
  const currentWeekId = weekId(now);
  const summary: WeeklyTrailJobSummary = { weekId: currentWeekId, digestAiUsed: false, generated: 0, alreadyGenerated: 0, infeasible: 0 };
  if (!isTrailTrendWindow(now)) return { ...summary, skippedReason: 'not_due' };

  const client = await pool.connect();
  let locked = false;
  try {
    const lock = await client.query('SELECT pg_try_advisory_lock($1) AS acquired', [TRAIL_WEEKLY_TRENDS_LOCK_KEY]);
    locked = Boolean(lock.rows[0]?.acquired);
    if (!locked) return { ...summary, skippedReason: 'locked' };
    const jobKey = `trail-trends:${currentWeekId}`;
    const ran = await client.query('SELECT 1 FROM plaza_job_runs WHERE job_key=$1', [jobKey]);
    if (ran.rowCount) return { ...summary, skippedReason: 'already_run' };

    const facts = await loadWeeklyTrendFacts(pool, currentWeekId, now);
    const result = await createTrendDigest(pool, facts);
    summary.digestAiUsed = result.aiUsed;
    const digestId = `${currentWeekId}`;
    await pool.query(`INSERT INTO trend_digests (week_id,signals,digest,ai_model,ai_used,created_at)
      VALUES ($1,$2::jsonb,$3::jsonb,$4,$5,$6)
      ON CONFLICT (week_id) DO UPDATE SET signals=EXCLUDED.signals,digest=EXCLUDED.digest,
        ai_model=EXCLUDED.ai_model,ai_used=EXCLUDED.ai_used,created_at=EXCLUDED.created_at`,
    [digestId, JSON.stringify(facts), JSON.stringify(result.value), result.model, result.aiUsed, now]);

    const candidates = [
      ...result.value.themes.slice(0, 4).map((theme, index) => ({ key: `signature:${index}:${theme.label}`, theme: theme.label, tier: 'signature' as const, until: null as Date | null })),
      { key: 'legendary:weekly', theme: result.value.themes[0]?.label ?? 'seasonal discovery', tier: 'legendary' as const, until: new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000) },
    ];

    for (const candidate of candidates) {
      const existing = await pool.query(`SELECT 1 FROM trail_generations WHERE kind='weekly_batch'
        AND input->>'week_id'=$1 AND input->>'candidate_key'=$2 LIMIT 1`, [currentWeekId, candidate.key]);
      if (existing.rowCount) { summary.alreadyGenerated++; continue; }
      try {
        await generateTrail(pool, {
          kind: 'weekly_batch', theme: candidate.theme, tier: candidate.tier, status: 'pending_review',
          budgetMin: 480, minStops: 3, maxStops: 8, weekId: currentWeekId, candidateKey: candidate.key,
          availableFrom: candidate.tier === 'legendary' ? now : null,
          availableUntil: candidate.until,
        });
        summary.generated++;
      } catch (error) {
        if (error instanceof TrailGenerationError) { summary.infeasible++; continue; }
        throw error;
      }
    }

    await client.query(`INSERT INTO plaza_job_runs (job_key,finished_at) VALUES ($1,$2) ON CONFLICT (job_key) DO NOTHING`, [jobKey, now]);
    return summary;
  } finally {
    if (locked) await client.query('SELECT pg_advisory_unlock($1)', [TRAIL_WEEKLY_TRENDS_LOCK_KEY]).catch(() => {});
    client.release();
  }
}

export async function loadWeeklyTrendFacts(pool: Pool, id: string, now: Date): Promise<WeeklyTrendFacts> {
  const periodEnd = now;
  const periodStart = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
  const { rows } = await pool.query(`SELECT s.id,s.name,s.municipality,s.category,COALESCE(s.good_for,'[]'::jsonb) AS good_for,
      ((SELECT count(*)::int FROM spot_interactions si
        JOIN users iu ON iu.id=si.user_id
        WHERE si.spot_id=s.id AND si.interaction_type='save' AND si.created_at >= $1 AND si.created_at < $2
          AND COALESCE(iu.is_test,FALSE)=FALSE)
       + (SELECT count(*)::int FROM trail_checkins tc
          JOIN trail_stops ts ON ts.trail_id=tc.trail_id AND ts.position=tc.position
          JOIN trails t ON t.id=tc.trail_id
          WHERE ts.spot_id=s.id AND tc.verified_at >= $1 AND tc.verified_at < $2 AND t.status='published' AND t.is_test=FALSE)
       + (SELECT count(*)::int FROM social_activities a JOIN social_cheers c ON c.activity_id=a.id
          WHERE a.subject_type='spot' AND a.subject_id=s.id AND a.hidden_at IS NULL AND a.is_test=FALSE
            AND c.created_at >= $1 AND c.created_at < $2 AND c.is_test=FALSE)
       + (SELECT count(*)::int FROM social_activities a JOIN social_comments c ON c.activity_id=a.id
          WHERE a.subject_type='spot' AND a.subject_id=s.id AND a.hidden_at IS NULL AND a.is_test=FALSE
            AND c.created_at >= $1 AND c.created_at < $2 AND c.deleted_at IS NULL AND c.hidden_at IS NULL AND c.is_test=FALSE)
      ) AS activity_count
    FROM spots s WHERE s.status='published' AND COALESCE(s.is_test,FALSE)=FALSE`, [periodStart, periodEnd]);

  const categories = new Map<string, number>();
  const goodFor = new Map<string, number>();
  const spots = rows.map(row => {
    const count = Number(row.activity_count ?? 0);
    if (count > 0) {
      const category = String(row.category);
      categories.set(category, (categories.get(category) ?? 0) + count);
      for (const item of asStringArray(row.good_for)) goodFor.set(item, (goodFor.get(item) ?? 0) + count);
    }
    return { name: String(row.name), municipality: String(row.municipality), category: String(row.category), count };
  }).filter(row => row.count > 0).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)).slice(0, 20);

  const categoryRows = [...categories].map(([category, count]) => ({ category, count })).sort((a, b) => b.count - a.count || a.category.localeCompare(b.category)).slice(0, 20);
  const goodForRows = [...goodFor].map(([good_for, count]) => ({ good_for, count })).sort((a, b) => b.count - a.count || a.good_for.localeCompare(b.good_for)).slice(0, 20);
  const manila = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const calendarHint = `${manila.getUTCFullYear()}-${String(manila.getUTCMonth() + 1).padStart(2, '0')} (month context only; no specific holiday assumed)`;
  return {
    week_id: id,
    period_start: periodStart.toISOString(),
    period_end: periodEnd.toISOString(),
    calendar_hint: calendarHint,
    top_categories: categoryRows,
    top_good_for: goodForRows,
    top_spots: spots,
  };
}

let timer: NodeJS.Timeout | null = null;
let running = false;

export function runWeeklyTrailTrendTick(): void {
  if (running) return;
  const pool = getPool();
  if (!pool) return;
  running = true;
  void runWeeklyTrailTrends(pool)
    .catch(() => {}) // Never log upstream payloads, credentials or user-derived text.
    .finally(() => { running = false; });
}

export function startWeeklyTrailTrendJob(): void {
  if (timer) return;
  timer = setInterval(runWeeklyTrailTrendTick, TICK_MS);
  timer.unref?.();
  runWeeklyTrailTrendTick();
}

export function stopWeeklyTrailTrendJob(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string') {
    try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed.map(String) : []; } catch { return []; }
  }
  return [];
}
