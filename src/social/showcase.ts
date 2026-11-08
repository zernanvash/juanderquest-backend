import type { Queryable } from './activity.js';
import { PANGASINAN_MUNICIPALITIES } from '../routes/affiliates.js';

// Profile showcase (owner 2026-11-08): bio, up to 3 equipped server badges,
// home town, the Pasaporte (Pangasinan towns visited), explorer stats, the
// latest journey and one favourite spot.

export const MAX_FEATURED_BADGES = 3;

export interface ShowcaseBadge {
  id: string;
  title: string;
  description: string;
  badge_icon: string | null;
  awarded_at: string;
}

export interface ShowcaseJourneyStop {
  quest_id: string;
  title: string;
  municipality: string | null;
  at: string;
}

export interface Showcase {
  bio: string | null;
  home_municipality: string | null;
  featured_badges: ShowcaseBadge[];
  favorite_spot: { id: string; slug: string; name: string; municipality: string; image_url: string | null } | null;
  stats: {
    quests_completed: number;
    spots_posted: number;
    trails_completed: number;
    best_weekly_rank: number | null;
    badges_earned: number;
  };
  pasaporte: { visited: string[]; total: number };
  latest_journey: ShowcaseJourneyStop[];
}

/** Earned (not revoked) badges of a user, newest first. */
export async function earnedBadges(client: Queryable, userId: string): Promise<ShowcaseBadge[]> {
  const { rows } = await client.query(
    `SELECT d.id, d.title, d.description, d.badge_icon, MAX(a.awarded_at) AS awarded_at
       FROM achievement_awards a
       JOIN achievement_definitions d ON d.id = a.achievement_id
      WHERE a.user_id = $1 AND a.revoked_at IS NULL
      GROUP BY d.id, d.title, d.description, d.badge_icon
      ORDER BY MAX(a.awarded_at) DESC, d.id ASC`,
    [userId],
  );
  return rows.map((r: any) => ({
    id: r.id,
    title: r.title,
    description: r.description ?? '',
    badge_icon: r.badge_icon ?? null,
    awarded_at: new Date(r.awarded_at).toISOString(),
  }));
}

/** Canonical town name for a quest/spot municipality, or null when not a Pangasinan town. */
function pangasinanTown(name: string | null | undefined): string | null {
  if (!name) return null;
  const key = name.trim().toLowerCase();
  return PANGASINAN_MUNICIPALITIES.find((t) => t.toLowerCase() === key) ?? null;
}

/**
 * Everything the profile shows beyond name and avatar. [includeActivity] is
 * false when someone else views a profile whose owner turned off activity
 * sharing: then the latest journey stays empty.
 */
export async function buildShowcase(
  client: Queryable,
  userId: string,
  opts: { includeActivity: boolean },
): Promise<Showcase | null> {
  const u = await client.query(
    'SELECT bio, home_municipality, featured_badges, favorite_spot_id FROM users WHERE id = $1',
    [userId],
  );
  const user = u.rows[0];
  if (!user) return null;

  const earned = await earnedBadges(client, userId);
  const byId = new Map(earned.map((b) => [b.id, b]));
  // Keep the chosen order; drop anything no longer earned.
  const featured = ((user.featured_badges as string[] | null) ?? [])
    .map((id) => byId.get(id))
    .filter((b): b is ShowcaseBadge => Boolean(b))
    .slice(0, MAX_FEATURED_BADGES);

  let favorite: Showcase['favorite_spot'] = null;
  if (user.favorite_spot_id) {
    const s = await client.query(
      `SELECT id, slug, name, municipality, image_url FROM spots WHERE id = $1 AND status = 'published'`,
      [user.favorite_spot_id],
    );
    if (s.rows[0]) {
      const r = s.rows[0];
      favorite = { id: r.id, slug: r.slug, name: r.name, municipality: r.municipality, image_url: r.image_url ?? null };
    }
  }

  // Completed quests: approved submissions (classic) and completed attempts (multi-task).
  const done = await client.query(
    `SELECT c.quest_id, q.title, COALESCE(s.municipality, q.location_name) AS municipality, c.at
       FROM (
         SELECT quest_id, MAX(created_at) AS at FROM submissions WHERE user_id = $1 AND status = 'approved' GROUP BY quest_id
         UNION ALL
         SELECT quest_id, MAX(COALESCE(completed_at, updated_at, created_at)) AS at FROM quest_attempts
          WHERE user_id = $1 AND status = 'completed' GROUP BY quest_id
       ) c
       JOIN quests q ON q.id = c.quest_id
       LEFT JOIN reviewed_quest_spot_bindings b ON b.quest_id = q.id AND b.status = 'active'
       LEFT JOIN spots s ON s.id = b.spot_id
      ORDER BY c.at DESC`,
    [userId],
  );
  const latestByQuest = new Map<string, ShowcaseJourneyStop>();
  for (const r of done.rows) {
    if (!latestByQuest.has(r.quest_id)) {
      latestByQuest.set(r.quest_id, {
        quest_id: r.quest_id,
        title: r.title,
        municipality: r.municipality ?? null,
        at: new Date(r.at).toISOString(),
      });
    }
  }
  const visited = new Set<string>();
  for (const stop of latestByQuest.values()) {
    const town = pangasinanTown(stop.municipality);
    if (town) visited.add(town);
  }

  const counts = await client.query(
    `SELECT
       (SELECT COUNT(*)::int FROM spots WHERE created_by = $1 AND status = 'published') AS spots_posted,
       (SELECT COUNT(*)::int FROM trail_completions WHERE user_id = $1) AS trails_completed,
       (SELECT MIN(rank)::int FROM plaza_weekly_scores WHERE user_id = $1 AND NOT is_test) AS best_weekly_rank`,
    [userId],
  );
  const c = counts.rows[0] ?? {};

  return {
    bio: user.bio ?? null,
    home_municipality: user.home_municipality ?? null,
    featured_badges: featured,
    favorite_spot: favorite,
    stats: {
      quests_completed: latestByQuest.size,
      spots_posted: Number(c.spots_posted ?? 0),
      trails_completed: Number(c.trails_completed ?? 0),
      best_weekly_rank: c.best_weekly_rank == null ? null : Number(c.best_weekly_rank),
      badges_earned: earned.length,
    },
    pasaporte: {
      visited: PANGASINAN_MUNICIPALITIES.filter((t) => visited.has(t)),
      total: PANGASINAN_MUNICIPALITIES.length,
    },
    latest_journey: opts.includeActivity ? [...latestByQuest.values()].slice(0, 3) : [],
  };
}
