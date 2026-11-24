import { db } from '../db/index.js';
import { getPool } from '../db/pool.js';

export interface PeopleSearchItem {
  id: string;
  display_name: string;
  handle: string | null;
  avatar_url: string | null;
  bio: string | null;
  status_text: string | null;
  score: number;
  is_following: boolean;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

function stripDiacritics(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

const TIER_SCORE: Record<number, number> = {
  1: 1.0,
  2: 0.95,
  3: 0.9,
  4: 0.85,
  5: 0.75,
  6: 0.7,
  7: 0.5,
};

export async function searchPeopleDiscovery(opts: {
  query: string;
  viewerId: string | null;
  allowTest: boolean;
  limit?: number;
}): Promise<PeopleSearchItem[]> {
  const cleanQuery = opts.query.replace(/^@+/, '').trim();
  const alnumCount = (cleanQuery.match(/[A-Za-z0-9]/g) ?? []).length;
  if (alnumCount < 2) {
    return [];
  }

  const qLower = cleanQuery.toLowerCase();
  const qFolded = stripDiacritics(qLower);
  const limit = Math.min(50, Math.max(1, opts.limit ?? 50));
  const pool = getPool();

  if (!pool) {
    const followingSet = opts.viewerId
      ? new Set(db.follows.filter((f) => f.follower_id === opts.viewerId).map((f) => f.following_id))
      : new Set<string>();

    const ranked: Array<{ item: PeopleSearchItem; tier: number }> = [];
    for (const user of db.users) {
      if (!user.is_public) continue;
      if (user.suspended_at) continue;
      if (opts.viewerId && user.id === opts.viewerId) continue;
      if (!opts.allowTest && user.is_test) continue;

      const handleLower = (user.handle || '').toLowerCase();
      const nameLower = stripDiacritics((user.display_name || '').toLowerCase());

      let tier = 0;
      if (handleLower && handleLower === qLower) tier = 1;
      else if (handleLower && handleLower.startsWith(qLower)) tier = 2;
      else if (nameLower === qFolded) tier = 3;
      else if (nameLower.startsWith(qFolded)) tier = 4;
      else if (handleLower && handleLower.includes(qLower)) tier = 5;
      else if (nameLower.includes(qFolded)) tier = 6;

      if (tier > 0) {
        ranked.push({
          tier,
          item: {
            id: user.id,
            display_name: user.display_name,
            handle: user.handle || null,
            avatar_url: user.avatar_url || null,
            bio: user.bio || null,
            status_text: user.status_text || null,
            score: TIER_SCORE[tier] ?? 0.5,
            is_following: followingSet.has(user.id),
          },
        });
      }
    }

    ranked.sort((a, b) => a.tier - b.tier || a.item.display_name.localeCompare(b.item.display_name));
    return ranked.slice(0, limit).map((r) => r.item);
  }

  const qLike = escapeLike(qLower);
  const qFoldedLike = escapeLike(qFolded);

  const sql = `
    SELECT
      u.id,
      u.display_name,
      u.handle,
      u.avatar_url,
      u.bio,
      u.status_text,
      CASE
        WHEN u.handle IS NOT NULL AND lower(u.handle) = $1 THEN 1
        WHEN u.handle IS NOT NULL AND lower(u.handle) LIKE $2 || '%' ESCAPE '\\' THEN 2
        WHEN f_unaccent(lower(u.display_name)) = f_unaccent($1) THEN 3
        WHEN f_unaccent(lower(u.display_name)) LIKE $3 || '%' ESCAPE '\\' THEN 4
        WHEN u.handle IS NOT NULL AND lower(u.handle) LIKE '%' || $2 || '%' ESCAPE '\\' THEN 5
        WHEN f_unaccent(lower(u.display_name)) LIKE '%' || $3 || '%' ESCAPE '\\' THEN 6
        ELSE 7
      END AS match_tier,
      GREATEST(
        COALESCE(extensions.similarity(lower(u.handle), $1), 0),
        COALESCE(extensions.similarity(f_unaccent(lower(u.display_name)), f_unaccent($1)), 0)
      ) AS sim_score
    FROM users u
    WHERE u.is_public = TRUE
      AND u.suspended_at IS NULL
      AND ($4::text IS NULL OR u.id <> $4::text)
      AND ($5::boolean = TRUE OR COALESCE(u.is_test, FALSE) = FALSE)
      AND (
        (u.handle IS NOT NULL AND (
          lower(u.handle) LIKE '%' || $2 || '%' ESCAPE '\\'
          OR lower(u.handle) OPERATOR(extensions.%) $1
        ))
        OR f_unaccent(lower(u.display_name)) LIKE '%' || $3 || '%' ESCAPE '\\'
        OR f_unaccent(lower(u.display_name)) OPERATOR(extensions.%) f_unaccent($1)
      )
    ORDER BY match_tier ASC, sim_score DESC, u.display_name ASC, u.id ASC
    LIMIT $6
  `;

  const { rows } = await pool.query<{
    id: string;
    display_name: string;
    handle: string | null;
    avatar_url: string | null;
    bio: string | null;
    status_text: string | null;
    match_tier: number;
  }>(sql, [qLower, qLike, qFoldedLike, opts.viewerId, opts.allowTest, limit]);

  let followingSet = new Set<string>();
  if (opts.viewerId && rows.length > 0) {
    const ids = rows.map((r) => r.id);
    const followRes = await pool.query<{ following_id: string }>(
      `SELECT following_id
       FROM user_follows
       WHERE follower_id = $1 AND following_id = ANY($2::text[])`,
      [opts.viewerId, ids],
    );
    followingSet = new Set(followRes.rows.map((r) => r.following_id));
  }

  return rows.map((r) => ({
    id: r.id,
    display_name: r.display_name,
    handle: r.handle || null,
    avatar_url: r.avatar_url || null,
    bio: r.bio || null,
    status_text: r.status_text || null,
    score: TIER_SCORE[Number(r.match_tier)] ?? 0.5,
    is_following: followingSet.has(r.id),
  }));
}
