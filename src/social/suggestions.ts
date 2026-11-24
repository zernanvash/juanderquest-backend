import { db } from '../db/index.js';
import { getPool } from '../db/pool.js';

export interface SuggestionItem {
  id: string;
  display_name: string;
  handle: string | null;
  avatar_url: string | null;
  is_following: false;
}

export interface SuggestionsResult {
  items: SuggestionItem[];
  has_more: boolean;
}

const inMemoryDismissals = new Map<string, Set<string>>();

export function resetInMemorySuggestionDismissals(): void {
  inMemoryDismissals.clear();
}

export async function getFollowSuggestions(
  viewerId: string,
  opts: { limit?: number; offset?: number } = {},
): Promise<SuggestionsResult> {
  const limit = Math.min(30, Math.max(1, Math.trunc(opts.limit ?? 20)));
  const offset = Math.min(100, Math.max(0, Math.trunc(opts.offset ?? 0)));
  const pool = getPool();

  if (!pool) {
    const viewer = db.findUserById(viewerId);
    if (!viewer) return { items: [], has_more: false };

    const followingSet = new Set(db.follows.filter((f) => f.follower_id === viewerId).map((f) => f.following_id));
    const dismissedSet = inMemoryDismissals.get(viewerId) ?? new Set<string>();
    const viewerHometown = viewer.home_municipality?.trim().toLowerCase() || null;

    const candidates = db.users
      .filter(
        (u) =>
          u.id !== viewerId &&
          u.is_public &&
          !u.suspended_at &&
          Boolean(u.is_test) === Boolean(viewer.is_test) &&
          u.display_name.trim().length > 0 &&
          u.role === 'user' &&
          !followingSet.has(u.id) &&
          !dismissedSet.has(u.id),
      )
      .slice(0, 200)
      .map((u) => {
        const followsBack = db.follows.some((f) => f.follower_id === u.id && f.following_id === viewerId) ? 45 : 0;
        const mutualCount = db.follows.filter((f) => followingSet.has(f.follower_id) && f.following_id === u.id).length;
        const mutualScore = Math.min(55, 20 * Math.log(1 + mutualCount));
        const sameHometown = viewerHometown && u.home_municipality?.trim().toLowerCase() === viewerHometown ? 35 : 0;
        const score = followsBack + mutualScore + sameHometown;
        return { user: u, score };
      })
      .sort((a, b) => b.score - a.score || a.user.id.localeCompare(b.user.id));

    const page = candidates.slice(offset, offset + limit + 1);
    const has_more = page.length > limit;
    return {
      items: page.slice(0, limit).map(({ user }) => ({
        id: user.id,
        display_name: user.display_name,
        handle: user.handle || null,
        avatar_url: user.avatar_url || null,
        is_following: false as const,
      })),
      has_more,
    };
  }

  const viewerRes = await pool.query<{
    id: string;
    is_test: boolean;
    home_municipality: string | null;
  }>(
    `SELECT id, COALESCE(is_test, FALSE) AS is_test, home_municipality
     FROM users
     WHERE id = $1`,
    [viewerId],
  );
  if (!viewerRes.rows.length) {
    return { items: [], has_more: false };
  }

  const viewer = viewerRes.rows[0];
  const viewerHometown = viewer.home_municipality?.trim() || null;

  const sql = `
    WITH candidate_pool AS (
      SELECT u.id, u.display_name, u.handle, u.avatar_url, u.home_municipality
      FROM users u
      WHERE u.id <> $1
        AND u.is_public = TRUE
        AND u.suspended_at IS NULL
        AND COALESCE(u.is_test, FALSE) = $2
        AND COALESCE(TRIM(u.display_name), '') <> ''
        AND u.role = 'user'
        AND NOT EXISTS (
          SELECT 1 FROM user_follows f
          WHERE f.follower_id = $1 AND f.following_id = u.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM user_suggestion_dismissals d
          WHERE d.user_id = $1 AND d.dismissed_user_id = u.id
        )
      ORDER BY u.created_at DESC, u.id ASC
      LIMIT 200
    ),
    scored AS (
      SELECT
        c.id,
        c.display_name,
        c.handle,
        c.avatar_url,
        (
          CASE WHEN EXISTS (
            SELECT 1 FROM user_follows fb
            WHERE fb.follower_id = c.id AND fb.following_id = $1
          ) THEN 45.0 ELSE 0.0 END
          + LEAST(
            55.0,
            20.0 * LN(
              1.0 + COALESCE((
                SELECT COUNT(*)::float
                FROM user_follows f1
                JOIN user_follows f2 ON f2.follower_id = f1.following_id
                WHERE f1.follower_id = $1 AND f2.following_id = c.id
              ), 0.0)
            )
          )
          + CASE WHEN $3::text IS NOT NULL
            AND c.home_municipality IS NOT NULL
            AND lower(c.home_municipality) = lower($3::text)
            THEN 35.0 ELSE 0.0 END
          + LEAST(
            35.0,
            15.0 * LN(
              1.0 + COALESCE((
                SELECT COUNT(DISTINCT vv1.spot_id)::float
                FROM verified_visits vv1
                JOIN verified_visits vv2 ON vv2.spot_id = vv1.spot_id
                WHERE vv1.user_id = $1
                  AND vv2.user_id = c.id
                  AND vv1.revoked_at IS NULL
                  AND vv2.revoked_at IS NULL
                  AND vv1.occurred_at >= NOW() - INTERVAL '90 days'
                  AND vv2.occurred_at >= NOW() - INTERVAL '90 days'
              ), 0.0)
            )
          )
          + CASE WHEN EXISTS (
              SELECT 1 FROM social_activities sa
              WHERE sa.actor_id = c.id
                AND sa.hidden_at IS NULL
                AND sa.created_at >= NOW() - INTERVAL '14 days'
            ) OR EXISTS (
              SELECT 1 FROM plaza_weekly_scores pws
              WHERE pws.user_id = c.id
                AND pws.updated_at >= NOW() - INTERVAL '14 days'
            ) THEN 15.0 ELSE 0.0 END
          + CASE WHEN EXISTS (
              SELECT 1 FROM verified_visits vv
              WHERE vv.user_id = c.id AND vv.revoked_at IS NULL
            ) THEN 8.0 ELSE 0.0 END
          + MOD(
              ABS(hashtext($1 || ':' || c.id || ':' || TO_CHAR(NOW() AT TIME ZONE 'Asia/Manila', 'YYYY-MM-DD'))),
              6
            )::float
        ) AS total_score
      FROM candidate_pool c
    )
    SELECT id, display_name, handle, avatar_url
    FROM scored
    ORDER BY total_score DESC, id ASC
    LIMIT $4 OFFSET $5
  `;

  const { rows } = await pool.query<{
    id: string;
    display_name: string;
    handle: string | null;
    avatar_url: string | null;
  }>(sql, [viewerId, Boolean(viewer.is_test), viewerHometown, limit + 1, offset]);

  const has_more = rows.length > limit;
  return {
    items: rows.slice(0, limit).map((r) => ({
      id: r.id,
      display_name: r.display_name,
      handle: r.handle || null,
      avatar_url: r.avatar_url || null,
      is_following: false as const,
    })),
    has_more,
  };
}

export async function dismissFollowSuggestion(
  viewerId: string,
  targetUserId: string,
): Promise<'ok' | 'self' | 'not_found'> {
  if (viewerId === targetUserId) {
    return 'self';
  }

  const pool = getPool();
  if (!pool) {
    const target = db.findUserById(targetUserId);
    if (!target) return 'not_found';
    let set = inMemoryDismissals.get(viewerId);
    if (!set) {
      set = new Set<string>();
      inMemoryDismissals.set(viewerId, set);
    }
    set.add(targetUserId);
    return 'ok';
  }

  const targetRes = await pool.query<{ id: string }>('SELECT id FROM users WHERE id = $1', [targetUserId]);
  if (!targetRes.rows.length) {
    return 'not_found';
  }

  await pool.query(
    `INSERT INTO user_suggestion_dismissals (user_id, dismissed_user_id)
     VALUES ($1, $2)
     ON CONFLICT (user_id, dismissed_user_id) DO NOTHING`,
    [viewerId, targetUserId],
  );
  return 'ok';
}
