import { getPool } from '../db/pool.js';
import type { ActivityVerb, Queryable } from './activity.js';

export { Queryable };

export class PlazaError extends Error {
  constructor(
    public readonly code: string,
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'PlazaError';
  }
}

export interface ActivityItem {
  id: string;
  verb: ActivityVerb;
  actor: {
    user_id: string;
    display_name: string;
    handle: string | null;
    avatar_url: string | null;
    is_following: boolean;
  };
  subject: {
    type: string;
    id: string;
    title: string;
    href: string;
  };
  municipality: string | null;
  payload: Record<string, unknown>;
  reason: 'you' | 'following' | 'nearby';
  cheer_count: number;
  cheered_by_me: boolean;
  comment_count: number;
  can_hide: boolean;
  created_at: string;
}

export interface GetFeedInput {
  viewerId?: string | null;
  isTest: boolean;
  cursor?: string | null;
  limit?: number;
  scope?: 'mixed' | 'following';
}

export interface GetFeedResult {
  items: ActivityItem[];
  next_cursor: string | null;
}

function parseCursor(cursor?: string | null): { createdAt: Date; id: string } | null {
  if (!cursor) return null;
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    const delimiterIndex = decoded.indexOf('|');
    if (delimiterIndex === -1) {
      throw new Error('Missing delimiter');
    }
    const timeStr = decoded.slice(0, delimiterIndex);
    const id = decoded.slice(delimiterIndex + 1);
    if (!timeStr || !id) {
      throw new Error('Empty cursor field');
    }
    const createdAt = new Date(timeStr);
    if (isNaN(createdAt.getTime())) {
      throw new Error('Invalid cursor timestamp');
    }
    return { createdAt, id };
  } catch {
    throw new PlazaError('INVALID_CURSOR', 400, 'Invalid pagination cursor.');
  }
}

function mapActivityRow(row: any, viewerId: string | null): ActivityItem {
  const isSelf = Boolean(viewerId && viewerId === row.actor_id);
  const viaFollow = Boolean(row.via_follow);

  let reason: 'you' | 'following' | 'nearby';
  if (isSelf) {
    reason = 'you';
  } else if (viaFollow) {
    reason = 'following';
  } else {
    reason = 'nearby';
  }

  let parsedPayload: Record<string, unknown> = {};
  if (row.payload) {
    if (typeof row.payload === 'string') {
      try {
        parsedPayload = JSON.parse(row.payload);
      } catch {
        parsedPayload = {};
      }
    } else if (typeof row.payload === 'object') {
      parsedPayload = row.payload as Record<string, unknown>;
    }
  }

  return {
    id: row.id,
    verb: row.verb as ActivityVerb,
    actor: {
      user_id: row.actor_id,
      display_name: row.display_name,
      handle: row.handle ?? null,
      avatar_url: row.avatar_url ?? null,
      is_following: viaFollow,
    },
    subject: {
      type: row.subject_type,
      id: row.subject_id,
      title: row.subject_title,
      href: row.subject_href,
    },
    municipality: row.municipality ?? null,
    payload: parsedPayload,
    reason,
    cheer_count: Number(row.cheer_count || 0),
    cheered_by_me: Boolean(row.cheered_by_me),
    comment_count: Number(row.comment_count || 0),
    can_hide: isSelf,
    created_at: new Date(row.created_at).toISOString(),
  };
}

export async function getFeed(
  client: Queryable | null | undefined,
  input: GetFeedInput,
): Promise<GetFeedResult> {
  const queryable = client ?? getPool();
  if (!queryable) {
    return { items: [], next_cursor: null };
  }

  const viewerId = input.viewerId ?? null;
  const isTest = Boolean(input.isTest);
  const limit = Math.min(50, Math.max(1, input.limit ?? 20));
  const requestedScope = input.scope ?? 'mixed';
  const effectiveScope = viewerId ? requestedScope : 'mixed';

  const cursorData = parseCursor(input.cursor);

  // Compute viewer's relevant area (home town + saved spots) if viewing mixed feed
  const areaSet = new Set<string>();
  if (viewerId && effectiveScope === 'mixed') {
    try {
      const homeRes = await queryable.query(
        `SELECT COALESCE(s.municipality, q.location_name) AS municipality,
                COUNT(*)::int AS count
           FROM submissions sub
           JOIN quests q ON q.id = sub.quest_id
           LEFT JOIN reviewed_quest_spot_bindings b ON b.quest_id = q.id AND b.status = 'active'
           LEFT JOIN spots s ON s.id = b.spot_id
          WHERE sub.user_id = $1
            AND sub.status = 'approved'
          GROUP BY COALESCE(s.municipality, q.location_name)
          ORDER BY count DESC, municipality ASC
          LIMIT 1`,
        [viewerId],
      );
      if (homeRes.rows[0]?.municipality) {
        areaSet.add(homeRes.rows[0].municipality);
      }

      const saveRes = await queryable.query(
        `SELECT s.municipality
           FROM spot_interactions si
           JOIN spots s ON s.id = si.spot_id
          WHERE si.user_id = $1
            AND si.interaction_type = 'save'
            AND s.municipality IS NOT NULL
          ORDER BY si.created_at DESC
          LIMIT 10`,
        [viewerId],
      );
      for (const row of saveRes.rows) {
        if (row.municipality) areaSet.add(row.municipality);
      }
    } catch {
      // Graceful fallback if tables are empty
    }
  }

  const area = Array.from(areaSet);

  const params: unknown[] = [isTest, viewerId];
  let pIdx = 3;

  let scopeCondition: string;
  if (effectiveScope === 'following') {
    scopeCondition = `(f.follower_id IS NOT NULL OR a.actor_id = $2)`;
  } else {
    if (area.length > 0) {
      const areaPlaceholders = area.map(m => {
        params.push(m);
        return `$${pIdx++}`;
      }).join(', ');
      scopeCondition = `(f.follower_id IS NOT NULL OR a.actor_id = $2 OR a.municipality IN (${areaPlaceholders}))`;
    } else {
      // Empty area or anonymous: any public activity is eligible
      scopeCondition = `TRUE`;
    }
  }

  let cursorCondition = '';
  if (cursorData) {
    params.push(cursorData.createdAt);
    const cDateParam = `$${pIdx++}`;
    params.push(cursorData.id);
    const cIdParam = `$${pIdx++}`;
    cursorCondition = `WHERE (feed.created_at < ${cDateParam} OR (feed.created_at = ${cDateParam} AND feed.id < ${cIdParam}))`;
  }

  params.push(limit + 1);
  const limitParam = `$${pIdx++}`;

  const sql = `
    SELECT * FROM (
      SELECT a.id, a.event_key, a.actor_id, a.verb, a.subject_type, a.subject_id,
             a.subject_title, a.subject_href, a.municipality, a.payload,
             a.cheer_count, a.comment_count, a.created_at,
             u.display_name, u.handle, u.avatar_url,
             (f.follower_id IS NOT NULL) AS via_follow,
             (c.user_id IS NOT NULL) AS cheered_by_me
        FROM social_activities a
        JOIN users u ON u.id = a.actor_id AND u.is_test = a.is_test
        LEFT JOIN user_follows f ON $2::text IS NOT NULL AND f.follower_id = $2 AND f.following_id = a.actor_id
        LEFT JOIN social_cheers c ON $2::text IS NOT NULL AND c.activity_id = a.id AND c.user_id = $2
       WHERE a.is_test = $1
         AND a.hidden_at IS NULL
         AND u.is_public = TRUE
         AND u.share_activity = TRUE
         AND ${scopeCondition}
    ) feed
    ${cursorCondition}
    ORDER BY feed.created_at DESC, feed.id DESC
    LIMIT ${limitParam}
  `;

  const res = await queryable.query(sql, params);
  const rows = res.rows;
  const hasMore = rows.length > limit;
  const returnedRows = hasMore ? rows.slice(0, limit) : rows;

  const items = returnedRows.map((row: any) => mapActivityRow(row, viewerId));

  let next_cursor: string | null = null;
  if (hasMore && items.length > 0) {
    const lastItem = items[items.length - 1];
    next_cursor = Buffer.from(`${lastItem.created_at}|${lastItem.id}`).toString('base64url');
  }

  return { items, next_cursor };
}

export async function getActivityById(
  client: Queryable | null | undefined,
  activityId: string,
  viewerId: string | null = null,
  isTest = false,
): Promise<ActivityItem | null> {
  const queryable = client ?? getPool();
  if (!queryable) return null;

  const res = await queryable.query(
    `SELECT a.id, a.event_key, a.actor_id, a.verb, a.subject_type, a.subject_id,
            a.subject_title, a.subject_href, a.municipality, a.payload,
            a.cheer_count, a.comment_count, a.created_at,
            u.display_name, u.handle, u.avatar_url,
            (f.follower_id IS NOT NULL) AS via_follow,
            (c.user_id IS NOT NULL) AS cheered_by_me
       FROM social_activities a
       JOIN users u ON u.id = a.actor_id AND u.is_test = a.is_test
       LEFT JOIN user_follows f ON $2::text IS NOT NULL AND f.follower_id = $2 AND f.following_id = a.actor_id
       LEFT JOIN social_cheers c ON $2::text IS NOT NULL AND c.activity_id = a.id AND c.user_id = $2
      WHERE a.id = $1
        AND a.is_test = $3
        AND a.hidden_at IS NULL
        AND u.is_public = TRUE
        AND u.share_activity = TRUE
      LIMIT 1`,
    [activityId, viewerId, isTest],
  );

  if (!res.rows.length) return null;
  return mapActivityRow(res.rows[0], viewerId);
}
