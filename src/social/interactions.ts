import { randomUUID } from 'crypto';
import type { Queryable } from './activity.js';
import { PlazaError } from './feed.js';
import { isCommentBlocked } from './blocklist.js';
import { notify } from './notify.js';
import { manilaHour } from './time.js';
import { getPool } from '../db/pool.js';
import { handlePlazaCheer } from '../stamps/hooks.js';

export interface CommentAuthor {
  user_id: string;
  display_name: string;
  handle: string | null;
  avatar_url: string | null;
}

export interface CommentItem {
  id: string;
  activity_id: string;
  author: CommentAuthor;
  body: string;
  created_at: string;
  can_delete: boolean;
  can_report: boolean;
  hidden_pending_review?: boolean;
}

export interface CheerResult {
  cheered: boolean;
  cheer_count: number;
}

export interface AddCommentResult {
  comment: CommentItem;
  replayed: boolean;
}

function cleanCommentBody(raw: string): string {
  const normalized = raw.trim().replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const collapsed = normalized.replace(/\n{3,}/g, '\n\n');
  const stripped = collapsed.replace(/[\x00-\x09\x0B-\x1F\x7F]/g, '');
  return stripped.trim();
}

/**
 * Cheers an activity. Private viewers may cheer and are counted in cheer_count.
 */
export async function cheer(
  client: Queryable,
  viewerId: string,
  activityId: string,
  isTest: boolean,
): Promise<CheerResult> {
  const actRes = await client.query(
    `SELECT id, actor_id, subject_title, cheer_count, is_test, hidden_at
       FROM social_activities
      WHERE id = $1 AND is_test = $2 AND hidden_at IS NULL`,
    [activityId, isTest],
  );

  if (!actRes.rows.length) {
    throw new PlazaError('PLAZA_NOT_FOUND', 404, 'Activity not found.');
  }

  const act = actRes.rows[0];

  // Check if already cheered
  const existingCheer = await client.query(
    'SELECT 1 FROM social_cheers WHERE activity_id = $1 AND user_id = $2',
    [activityId, viewerId],
  );

  if (existingCheer.rows.length > 0) {
    return {
      cheered: true,
      cheer_count: Number(act.cheer_count || 0),
    };
  }

  await client.query(
    `INSERT INTO social_cheers (activity_id, user_id, is_test)
     VALUES ($1, $2, $3)
     ON CONFLICT (activity_id, user_id) DO NOTHING`,
    [activityId, viewerId, isTest],
  );

  const updateRes = await client.query(
    `UPDATE social_activities
        SET cheer_count = cheer_count + 1
      WHERE id = $1
      RETURNING cheer_count`,
    [activityId],
  );

  const updatedCount = Number(updateRes.rows[0]?.cheer_count ?? (Number(act.cheer_count) + 1));

  // Notify activity owner if not self
  if (viewerId !== act.actor_id) {
    const viewerRes = await client.query(
      'SELECT display_name, is_public FROM users WHERE id = $1',
      [viewerId],
    );
    const viewer = viewerRes.rows[0];
    const actorName = viewer && viewer.is_public ? viewer.display_name : 'Someone';

    const now = new Date();
    const dStr = now.toISOString().slice(0, 10).replace(/-/g, '');
    const hourBucket = `${dStr}${String(manilaHour(now)).padStart(2, '0')}`;

    try {
      await notify(client, {
        userId: act.actor_id,
        kind: 'cheer',
        eventKey: `cheer:${activityId}:${viewerId}`,
        title: '👏 Cheers!',
        message: `${actorName} cheered your ${act.subject_title}.`,
        href: `/plaza?activity=${activityId}`,
        isTest,
        push: {
          category: 'social',
          collapseKey: `social:${act.actor_id}:${hourBucket}`,
          actorName,
        },
      });
    } catch (err) {
      console.error('[interactions:cheer] Failed to notify cheer:', err);
    }
  }

  await handlePlazaCheer(getPool(), {
    viewerId,
    activityOwnerId: act.actor_id,
    activityId,
  });

  return {
    cheered: true,
    cheer_count: updatedCount,
  };
}

/**
 * Removes a cheer from an activity. Never decrements below 0.
 */
export async function uncheer(
  client: Queryable,
  viewerId: string,
  activityId: string,
  isTest: boolean,
): Promise<CheerResult> {
  const actRes = await client.query(
    `SELECT id, cheer_count FROM social_activities WHERE id = $1 AND is_test = $2 AND hidden_at IS NULL`,
    [activityId, isTest],
  );

  if (!actRes.rows.length) {
    throw new PlazaError('PLAZA_NOT_FOUND', 404, 'Activity not found.');
  }

  const act = actRes.rows[0];

  const delRes = await client.query(
    'DELETE FROM social_cheers WHERE activity_id = $1 AND user_id = $2 RETURNING activity_id',
    [activityId, viewerId],
  );

  let newCount = Number(act.cheer_count || 0);
  if (delRes.rows.length > 0) {
    const updateRes = await client.query(
      `UPDATE social_activities
          SET cheer_count = GREATEST(0, cheer_count - 1)
        WHERE id = $1
        RETURNING cheer_count`,
      [activityId],
    );
    newCount = Number(updateRes.rows[0]?.cheer_count || 0);
  }

  return {
    cheered: false,
    cheer_count: newCount,
  };
}

/**
 * Allows the owner of an activity to hide it from the Plaza feed.
 */
export async function hideActivity(
  client: Queryable,
  viewerId: string,
  activityId: string,
  isTest: boolean,
): Promise<{ hidden: boolean }> {
  const actRes = await client.query(
    'SELECT id, actor_id FROM social_activities WHERE id = $1 AND is_test = $2',
    [activityId, isTest],
  );

  if (!actRes.rows.length) {
    throw new PlazaError('PLAZA_NOT_FOUND', 404, 'Activity not found.');
  }

  if (actRes.rows[0].actor_id !== viewerId) {
    throw new PlazaError('FORBIDDEN', 403, 'Only the author may hide this activity.');
  }

  await client.query(
    `UPDATE social_activities
        SET hidden_at = NOW(), hidden_reason = 'owner'
      WHERE id = $1`,
    [activityId],
  );

  return { hidden: true };
}

/**
 * Posts a comment to an activity. Requires public profile. Idempotent on (author_id, idempotency_key).
 */
export async function addComment(
  client: Queryable,
  viewerId: string,
  activityId: string,
  rawBody: string,
  idempotencyKey: string,
  isTest: boolean,
): Promise<AddCommentResult> {
  const userRes = await client.query(
    'SELECT id, display_name, handle, avatar_url, is_public FROM users WHERE id = $1',
    [viewerId],
  );

  if (!userRes.rows.length) {
    throw new PlazaError('USER_NOT_FOUND', 404, 'User not found.');
  }

  const viewer = userRes.rows[0];
  if (!viewer.is_public) {
    throw new PlazaError('PUBLIC_PROFILE_REQUIRED', 403, 'Make your profile public to comment.');
  }

  const actRes = await client.query(
    'SELECT id, actor_id, comment_count, is_test, hidden_at FROM social_activities WHERE id = $1 AND is_test = $2 AND hidden_at IS NULL',
    [activityId, isTest],
  );

  if (!actRes.rows.length) {
    throw new PlazaError('PLAZA_NOT_FOUND', 404, 'Activity not found.');
  }

  const act = actRes.rows[0];

  const body = cleanCommentBody(rawBody);
  if (body.length < 1 || body.length > 280) {
    throw new PlazaError('INVALID_COMMENT_LENGTH', 400, 'Comment must be between 1 and 280 characters.');
  }

  if (isCommentBlocked(body)) {
    throw new PlazaError('COMMENT_REJECTED', 422, 'Please keep comments friendly and link-free.');
  }

  // Idempotent replay check
  const existingRes = await client.query(
    `SELECT id, activity_id, author_id, body, created_at, deleted_at, hidden_at
       FROM social_comments
      WHERE author_id = $1 AND idempotency_key = $2`,
    [viewerId, idempotencyKey],
  );

  if (existingRes.rows.length > 0) {
    const row = existingRes.rows[0];
    return {
      comment: {
        id: row.id,
        activity_id: row.activity_id,
        author: {
          user_id: viewer.id,
          display_name: viewer.display_name,
          handle: viewer.handle ?? null,
          avatar_url: viewer.avatar_url ?? null,
        },
        body: row.body,
        created_at: new Date(row.created_at).toISOString(),
        can_delete: true,
        can_report: false,
        hidden_pending_review: Boolean(row.hidden_at),
      },
      replayed: true,
    };
  }

  const commentId = `cmt_${randomUUID()}`;
  await client.query(
    `INSERT INTO social_comments (
       id, activity_id, author_id, body, idempotency_key, is_test
     ) VALUES ($1, $2, $3, $4, $5, $6)`,
    [commentId, activityId, viewerId, body, idempotencyKey, isTest],
  );

  await client.query(
    'UPDATE social_activities SET comment_count = comment_count + 1 WHERE id = $1',
    [activityId],
  );

  // Notify activity owner if not self
  if (viewerId !== act.actor_id) {
    const now = new Date();
    const dStr = now.toISOString().slice(0, 10).replace(/-/g, '');
    const hourBucket = `${dStr}${String(manilaHour(now)).padStart(2, '0')}`;

    try {
      await notify(client, {
        userId: act.actor_id,
        kind: 'comment',
        eventKey: `comment:${commentId}`,
        title: 'New comment',
        message: `${viewer.display_name}: "${body.slice(0, 80)}"`,
        href: `/plaza?activity=${activityId}&comments=1`,
        isTest,
        push: {
          category: 'social',
          collapseKey: `social:${act.actor_id}:${hourBucket}`,
          actorName: viewer.display_name,
        },
      });
    } catch (err) {
      console.error('[interactions:comment] Failed to notify comment:', err);
    }
  }

  return {
    comment: {
      id: commentId,
      activity_id: activityId,
      author: {
        user_id: viewer.id,
        display_name: viewer.display_name,
        handle: viewer.handle ?? null,
        avatar_url: viewer.avatar_url ?? null,
      },
      body,
      created_at: new Date().toISOString(),
      can_delete: true,
      can_report: false,
      hidden_pending_review: false,
    },
    replayed: false,
  };
}

/**
 * Deletes a comment. Allowed for the comment author OR the activity owner.
 */
export async function deleteComment(
  client: Queryable,
  viewerId: string,
  commentId: string,
  isTest: boolean,
): Promise<{ deleted: boolean }> {
  const comRes = await client.query(
    `SELECT c.id, c.activity_id, c.author_id, c.deleted_at, a.actor_id AS activity_owner_id
       FROM social_comments c
       JOIN social_activities a ON a.id = c.activity_id
      WHERE c.id = $1 AND c.is_test = $2`,
    [commentId, isTest],
  );

  if (!comRes.rows.length) {
    throw new PlazaError('PLAZA_NOT_FOUND', 404, 'Comment not found.');
  }

  const com = comRes.rows[0];
  if (com.author_id !== viewerId && com.activity_owner_id !== viewerId) {
    throw new PlazaError('FORBIDDEN', 403, 'Permission denied.');
  }

  if (!com.deleted_at) {
    await client.query('UPDATE social_comments SET deleted_at = NOW() WHERE id = $1', [commentId]);
    await client.query(
      'UPDATE social_activities SET comment_count = GREATEST(0, comment_count - 1) WHERE id = $1',
      [com.activity_id],
    );
  }

  return { deleted: true };
}

/**
 * Reports a comment. Automatically hides comment when report_count reaches 3.
 */
export async function reportComment(
  client: Queryable,
  viewerId: string,
  commentId: string,
  reason: 'spam' | 'harassment' | 'hate' | 'sexual' | 'misinformation' | 'other',
  note: string | null | undefined,
  isTest: boolean,
): Promise<{ reported: boolean }> {
  const comRes = await client.query(
    'SELECT id, report_count, hidden_at FROM social_comments WHERE id = $1 AND is_test = $2 AND deleted_at IS NULL',
    [commentId, isTest],
  );

  if (!comRes.rows.length) {
    throw new PlazaError('PLAZA_NOT_FOUND', 404, 'Comment not found.');
  }

  const com = comRes.rows[0];

  const repRes = await client.query(
    `INSERT INTO social_comment_reports (comment_id, reporter_id, reason, note)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (comment_id, reporter_id) DO NOTHING
     RETURNING comment_id`,
    [commentId, viewerId, reason, note ? note.slice(0, 300) : null],
  );

  // If newly reported, increment report_count and auto-hide if >= 3
  if (repRes.rows.length > 0) {
    const upRes = await client.query(
      `UPDATE social_comments
          SET report_count = report_count + 1
        WHERE id = $1
        RETURNING report_count, hidden_at`,
      [commentId],
    );

    const updated = upRes.rows[0];
    if (updated && Number(updated.report_count) >= 3 && !updated.hidden_at) {
      await client.query(
        `UPDATE social_comments
            SET hidden_at = NOW(), hidden_by = 'auto'
          WHERE id = $1`,
        [commentId],
      );
    }
  }

  return { reported: true };
}

export interface ListCommentsInput {
  viewerId?: string | null;
  activityId: string;
  cursor?: string | null;
  limit?: number;
  isTest: boolean;
}

export interface ListCommentsResult {
  items: CommentItem[];
  next_cursor: string | null;
}

/**
 * Lists visible comments for an activity, in ascending chronological order.
 */
export async function listComments(
  client: Queryable,
  input: ListCommentsInput,
): Promise<ListCommentsResult> {
  const viewerId = input.viewerId ?? null;
  const isTest = Boolean(input.isTest);
  const limit = Math.min(50, Math.max(1, input.limit ?? 20));

  let cursorCreatedAt: Date | null = null;
  let cursorId: string | null = null;

  if (input.cursor) {
    try {
      const decoded = Buffer.from(input.cursor, 'base64url').toString('utf8');
      const idx = decoded.indexOf('|');
      if (idx !== -1) {
        cursorCreatedAt = new Date(decoded.slice(0, idx));
        cursorId = decoded.slice(idx + 1);
      }
    } catch {
      throw new PlazaError('INVALID_CURSOR', 400, 'Invalid pagination cursor.');
    }
  }

  const params: unknown[] = [input.activityId, isTest, viewerId];
  let pIdx = 4;

  let cursorCond = '';
  if (cursorCreatedAt && cursorId) {
    params.push(cursorCreatedAt);
    const dParam = `$${pIdx++}`;
    params.push(cursorId);
    const idParam = `$${pIdx++}`;
    cursorCond = `AND (c.created_at > ${dParam} OR (c.created_at = ${dParam} AND c.id > ${idParam}))`;
  }

  params.push(limit + 1);
  const limitParam = `$${pIdx++}`;

  const sql = `
    SELECT c.id, c.activity_id, c.author_id, c.body, c.hidden_at, c.created_at,
           u.display_name, u.handle, u.avatar_url,
           a.actor_id AS activity_owner_id
      FROM social_comments c
      JOIN users u ON u.id = c.author_id AND u.is_test = c.is_test
      JOIN social_activities a ON a.id = c.activity_id AND a.is_test = c.is_test
     WHERE c.activity_id = $1
       AND c.is_test = $2
       AND c.deleted_at IS NULL
       AND (c.hidden_at IS NULL OR ($3::text IS NOT NULL AND c.author_id = $3))
       ${cursorCond}
     ORDER BY c.created_at ASC, c.id ASC
     LIMIT ${limitParam}
  `;

  const res = await client.query(sql, params);
  const rows = res.rows;
  const hasMore = rows.length > limit;
  const returned = hasMore ? rows.slice(0, limit) : rows;

  const items: CommentItem[] = returned.map((r: any) => {
    const isAuthor = Boolean(viewerId && viewerId === r.author_id);
    const isActOwner = Boolean(viewerId && viewerId === r.activity_owner_id);
    const isHidden = Boolean(r.hidden_at);

    return {
      id: r.id,
      activity_id: r.activity_id,
      author: {
        user_id: r.author_id,
        display_name: r.display_name,
        handle: r.handle ?? null,
        avatar_url: r.avatar_url ?? null,
      },
      body: isHidden ? 'Hidden pending review' : r.body,
      created_at: new Date(r.created_at).toISOString(),
      can_delete: isAuthor || isActOwner,
      can_report: Boolean(viewerId && !isAuthor),
      hidden_pending_review: isHidden,
    };
  });

  let next_cursor: string | null = null;
  if (hasMore && items.length > 0) {
    const last = items[items.length - 1];
    next_cursor = Buffer.from(`${last.created_at}|${last.id}`).toString('base64url');
  }

  return { items, next_cursor };
}

export interface AdminReportGroup {
  comment: {
    id: string;
    body: string;
    author_id: string;
    author_display_name: string;
    created_at: string;
    hidden_at: string | null;
    hidden_by: string | null;
    report_count: number;
  };
  activity: {
    id: string;
    verb: string;
    subject_title: string;
    subject_href: string;
  };
  reports: Array<{
    reporter_id: string;
    reporter_display_name: string;
    reason: string;
    note: string | null;
    created_at: string;
    resolved_at: string | null;
    resolved_by: string | null;
    resolution: string | null;
  }>;
}

export async function listAdminReports(
  client: Queryable,
  status: 'open' | 'resolved' = 'open',
): Promise<AdminReportGroup[]> {
  const statusCond = status === 'open' ? 'r.resolved_at IS NULL' : 'r.resolved_at IS NOT NULL';
  const sql = `
    SELECT r.comment_id, r.reporter_id, r.reason, r.note, r.created_at AS report_created_at,
           r.resolved_at, r.resolved_by, r.resolution,
           ru.display_name AS reporter_name,
           c.body AS comment_body, c.author_id AS comment_author_id, c.created_at AS comment_created_at,
           c.hidden_at AS comment_hidden_at, c.hidden_by AS comment_hidden_by, c.report_count AS comment_report_count,
           cu.display_name AS author_name,
           a.id AS activity_id, a.verb AS activity_verb, a.subject_title, a.subject_href
      FROM social_comment_reports r
      JOIN users ru ON ru.id = r.reporter_id
      JOIN social_comments c ON c.id = r.comment_id
      JOIN users cu ON cu.id = c.author_id
      JOIN social_activities a ON a.id = c.activity_id
     WHERE ${statusCond}
     ORDER BY r.created_at DESC
  `;
  const res = await client.query(sql);
  const map = new Map<string, AdminReportGroup>();
  for (const row of res.rows) {
    let group = map.get(row.comment_id);
    if (!group) {
      group = {
        comment: {
          id: row.comment_id,
          body: row.comment_body,
          author_id: row.comment_author_id,
          author_display_name: row.author_name,
          created_at: new Date(row.comment_created_at).toISOString(),
          hidden_at: row.comment_hidden_at ? new Date(row.comment_hidden_at).toISOString() : null,
          hidden_by: row.comment_hidden_by ?? null,
          report_count: Number(row.comment_report_count || 0),
        },
        activity: {
          id: row.activity_id,
          verb: row.activity_verb,
          subject_title: row.subject_title,
          subject_href: row.subject_href,
        },
        reports: [],
      };
      map.set(row.comment_id, group);
    }
    group.reports.push({
      reporter_id: row.reporter_id,
      reporter_display_name: row.reporter_name,
      reason: row.reason,
      note: row.note ?? null,
      created_at: new Date(row.report_created_at).toISOString(),
      resolved_at: row.resolved_at ? new Date(row.resolved_at).toISOString() : null,
      resolved_by: row.resolved_by ?? null,
      resolution: row.resolution ?? null,
    });
  }
  return Array.from(map.values());
}

export async function adminModerateComment(
  client: Queryable,
  adminId: string,
  commentId: string,
  action: 'hide' | 'restore',
  _note?: string,
): Promise<any> {
  const exists = await client.query('SELECT id FROM social_comments WHERE id = $1', [commentId]);
  if (!exists.rows.length) {
    throw new PlazaError('PLAZA_NOT_FOUND', 404, 'Comment not found.');
  }

  if (action === 'hide') {
    const res = await client.query(
      `UPDATE social_comments
          SET hidden_at = NOW(), hidden_by = $2
        WHERE id = $1
        RETURNING *`,
      [commentId, adminId],
    );
    await client.query(
      `UPDATE social_comment_reports
          SET resolved_at = NOW(), resolved_by = $2, resolution = 'hidden'
        WHERE comment_id = $1 AND resolved_at IS NULL`,
      [commentId, adminId],
    );
    return res.rows[0];
  } else {
    const res = await client.query(
      `UPDATE social_comments
          SET hidden_at = NULL, hidden_by = NULL
        WHERE id = $1
        RETURNING *`,
      [commentId],
    );
    await client.query(
      `UPDATE social_comment_reports
          SET resolved_at = NOW(), resolved_by = $2, resolution = 'restored'
        WHERE comment_id = $1 AND resolved_at IS NULL`,
      [commentId, adminId],
    );
    return res.rows[0];
  }
}

export async function adminModerateActivity(
  client: Queryable,
  _adminId: string,
  activityId: string,
  action: 'hide' | 'restore',
  reason?: string,
): Promise<any> {
  const exists = await client.query('SELECT id FROM social_activities WHERE id = $1', [activityId]);
  if (!exists.rows.length) {
    throw new PlazaError('PLAZA_NOT_FOUND', 404, 'Activity not found.');
  }

  if (action === 'hide') {
    const res = await client.query(
      `UPDATE social_activities
          SET hidden_at = NOW(), hidden_reason = $2
        WHERE id = $1
        RETURNING *`,
      [activityId, reason ?? 'admin'],
    );
    return res.rows[0];
  } else {
    const res = await client.query(
      `UPDATE social_activities
          SET hidden_at = NULL, hidden_reason = NULL
        WHERE id = $1
        RETURNING *`,
      [activityId],
    );
    return res.rows[0];
  }
}

