import type { Queryable } from './activity.js';
import { PANGASINAN_MUNICIPALITIES } from '../routes/affiliates.js';
import { pangasinanTown } from './showcase.js';

/**
 * Plan 62 Juander Recap (refreshed 2026-11-16): a season or year story,
 * computed on request from existing tables (no snapshot worker, no migration).
 * Only the owner reads it. Towns only, no coordinates or exact times, so the
 * phone can turn it into share images safely.
 */
export interface RecapPeriod {
  id: string;
  kind: 'season' | 'year';
  label: string;
  start: Date;
  end: Date;
}

const SEASON_NAMES = ['Jan – Mar', 'Apr – Jun', 'Jul – Sep', 'Oct – Dec'];
// Manila is UTC+8 all year, so period edges are fixed offsets.
const manila = (y: number, m: number) => new Date(Date.UTC(y, m, 1, -8));

function manilaNow(now: Date) {
  const shifted = new Date(now.getTime() + 8 * 3600_000);
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() };
}

/** `season:2026-S4` or `year:2026`; empty means the current season. Null when invalid or in the future. */
export function parseRecapPeriod(raw: string | undefined, now = new Date()): RecapPeriod | null {
  const { year: thisYear, month } = manilaNow(now);
  const value = raw?.trim() || `season:${thisYear}-S${Math.floor(month / 3) + 1}`;
  const season = /^season:(\d{4})-S([1-4])$/.exec(value);
  const year = /^year:(\d{4})$/.exec(value);
  let period: RecapPeriod | null = null;
  if (season) {
    const y = Number(season[1]);
    const q = Number(season[2]) - 1;
    period = {
      id: value,
      kind: 'season',
      label: `${SEASON_NAMES[q]} ${y}`,
      start: manila(y, q * 3),
      end: manila(q === 3 ? y + 1 : y, q === 3 ? 0 : q * 3 + 3),
    };
  } else if (year) {
    const y = Number(year[1]);
    period = { id: value, kind: 'year', label: String(y), start: manila(y, 0), end: manila(y + 1, 0) };
  }
  if (!period || period.start.getUTCFullYear() < 2025 || period.start > now) return null;
  return period;
}

const PERSONAS: Record<string, string> = {
  eco: 'Coastal Wanderer',
  cultural: 'Heritage Hunter',
  food_trade: 'Food Trailblazer',
  sports_adventure: 'Thrill Seeker',
};

export interface Recap {
  period: { id: string; kind: string; label: string };
  quests_completed: number;
  towns: string[];
  towns_total: number;
  spots_posted: number;
  quizzes_passed: number;
  stamps_earned: number;
  best_streak: number;
  top_category: string | null;
  persona: string | null;
  where_next: string | null;
}

export async function buildRecap(client: Queryable, userId: string, period: RecapPeriod): Promise<Recap> {
  const range = [userId, period.start.toISOString(), period.end.toISOString()];
  // Quests finished in the period: approved classic submissions and completed multi-task attempts.
  const done = await client.query(
    `SELECT c.quest_id, q.category, COALESCE(s.municipality, q.location_name) AS municipality
       FROM (
         SELECT quest_id FROM submissions
          WHERE user_id = $1 AND status = 'approved' AND created_at >= $2 AND created_at < $3
         UNION
         SELECT quest_id FROM quest_attempts
          WHERE user_id = $1 AND status = 'completed'
            AND COALESCE(completed_at, updated_at, created_at) >= $2
            AND COALESCE(completed_at, updated_at, created_at) < $3
       ) c
       JOIN quests q ON q.id = c.quest_id
       LEFT JOIN reviewed_quest_spot_bindings b ON b.quest_id = q.id AND b.status = 'active'
       LEFT JOIN spots s ON s.id = b.spot_id`,
    range,
  );
  const quests = new Map<string, { category: string | null; town: string | null }>();
  for (const r of done.rows) {
    if (!quests.has(r.quest_id))
      quests.set(r.quest_id, { category: r.category ?? null, town: pangasinanTown(r.municipality) });
  }
  const towns = new Set<string>();
  const categories = new Map<string, number>();
  for (const q of quests.values()) {
    if (q.town) towns.add(q.town);
    if (q.category) categories.set(q.category, (categories.get(q.category) ?? 0) + 1);
  }
  let topCategory: string | null = null;
  for (const [category, n] of categories) {
    if (topCategory === null || n > categories.get(topCategory)!) topCategory = category;
  }

  const counts = await client.query(
    `SELECT
       (SELECT COUNT(*)::int FROM spots
         WHERE created_by = $1 AND status = 'published' AND created_at >= $2 AND created_at < $3) AS spots_posted,
       (SELECT COUNT(*)::int FROM cultural_quiz_completions
         WHERE user_id = $1 AND completed_at >= $2 AND completed_at < $3) AS quizzes_passed,
       (SELECT COALESCE(SUM(delta), 0)::int FROM stamp_ledger
         WHERE user_id = $1 AND delta > 0 AND NOT is_test AND created_at >= $2 AND created_at < $3) AS stamps_earned,
       (SELECT best_streak FROM user_streaks WHERE user_id = $1) AS best_streak`,
    range,
  );
  const c = counts.rows[0] ?? {};

  // Where next: the unvisited town with the most published destinations.
  const busiest = await client.query(
    `SELECT municipality, COUNT(*)::int AS n FROM spots
      WHERE status = 'published' AND NOT is_test GROUP BY municipality ORDER BY n DESC, municipality`,
  );
  let whereNext: string | null = null;
  for (const r of busiest.rows) {
    const town = pangasinanTown(r.municipality);
    if (town && !towns.has(town)) {
      whereNext = town;
      break;
    }
  }

  return {
    period: { id: period.id, kind: period.kind, label: period.label },
    quests_completed: quests.size,
    towns: PANGASINAN_MUNICIPALITIES.filter((t) => towns.has(t)),
    towns_total: PANGASINAN_MUNICIPALITIES.length,
    spots_posted: Number(c.spots_posted ?? 0),
    quizzes_passed: Number(c.quizzes_passed ?? 0),
    stamps_earned: Number(c.stamps_earned ?? 0),
    best_streak: Number(c.best_streak ?? 0),
    top_category: topCategory,
    persona: topCategory ? (PERSONAS[topCategory] ?? 'Pangasinan Explorer') : null,
    where_next: whereNext,
  };
}
