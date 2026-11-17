import { Router, Response } from 'express';
import { z } from 'zod';
import { getPool } from '../db/pool.js';
import { db } from '../db/index.js';
import {
  authenticateToken,
  optionalAuthenticateToken,
  AuthRequest,
  checkQAAuthorization,
  isAuthorizedQA,
} from '../middleware/auth.js';
import { validateRequest } from '../middleware/validate.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { forwardAsyncRouteErrors } from '../middleware/asyncRoutes.js';

const publicProfileLimiter = rateLimit({ windowMs: 60 * 1000, max: 60 });

export const profileHubRouter = Router();

const unavailable = (res: Response) =>
  res.status(503).json({
    success: false,
    error: { code: 'DATABASE_UNAVAILABLE', message: 'Profile hub is unavailable right now.' },
  });

async function resolveProfileTarget(
  rawHandle: string,
  req: AuthRequest,
): Promise<{
  user: { id: string; handle: string | null; is_public: boolean; is_test: boolean; progress_public: boolean };
  isOwner: boolean;
} | null> {
  const pool = getPool();
  if (!pool) return null;
  const trimmed = rawHandle.trim();
  if (!trimmed) return null;
  const clean = trimmed.replace(/^@/, '').toLowerCase();
  const allowTest = isAuthorizedQA(req);

  const { rows } = await pool.query(
    `SELECT id, handle, is_public, COALESCE(is_test, FALSE) AS is_test, COALESCE(progress_public, FALSE) AS progress_public
       FROM users
      WHERE LOWER(handle) = $1 OR id = $2
      LIMIT 1`,
    [clean, trimmed],
  );
  const row = rows[0];
  if (!row) return null;

  const isOwner = Boolean(req.user?.id && req.user.id === row.id);
  if (!isOwner) {
    if (!row.is_public) return null;
    if (Boolean(row.is_test) && !allowTest) return null;
  }
  return {
    user: {
      id: row.id,
      handle: row.handle ?? null,
      is_public: Boolean(row.is_public),
      is_test: Boolean(row.is_test),
      progress_public: Boolean(row.progress_public),
    },
    isOwner,
  };
}

export interface ProgressAttemptItem {
  attempt_id: string;
  quest_id: string;
  title: string;
  cover: string | null;
  verified_required: number;
  total_required: number;
  next_task_title: string | null;
  status: string;
  completed_at: string | null;
  reward_points: number;
}

async function fetchUserProgress(userId: string): Promise<ProgressAttemptItem[]> {
  const pool = getPool();
  if (!pool) return [];

  const { rows: attemptRows } = await pool.query(
    `WITH ranked AS (
       SELECT qa.id AS attempt_id,
              qa.quest_id,
              qa.status::text AS status,
              qa.steps_snapshot,
              qa.completed_at,
              qa.created_at,
              qa.updated_at,
              q.title,
              COALESCE(
                (SELECT NULLIF(s.image_url, '') FROM spots s WHERE s.quest_id = q.id ORDER BY s.created_at ASC LIMIT 1),
                NULLIF(q.marker_image_url, '')
              ) AS cover,
              q.reward_points,
              CASE WHEN qa.status IN ('in_progress', 'submitted') THEN 0 ELSE 1 END AS bucket
         FROM quest_attempts qa
         JOIN quests q ON q.id = qa.quest_id
        WHERE qa.user_id = $1
     ),
     active AS (
       SELECT * FROM ranked WHERE bucket = 0 ORDER BY COALESCE(updated_at, created_at) DESC
     ),
     completed AS (
       SELECT * FROM ranked WHERE bucket = 1 ORDER BY COALESCE(completed_at, updated_at, created_at) DESC LIMIT 20
     )
     SELECT * FROM active
     UNION ALL
     SELECT * FROM completed`,
    [userId],
  );

  if (attemptRows.length === 0) return [];

  const attemptIds = attemptRows.map((r: any) => r.attempt_id as string);
  const { rows: evidenceRows } = await pool.query(
    `SELECT attempt_id, step_order, title, status::text AS status, required
       FROM quest_step_evidence
      WHERE attempt_id = ANY($1::text[])
      ORDER BY step_order ASC`,
    [attemptIds],
  );

  const evidenceByAttempt = new Map<
    string,
    Array<{ step_order: number; title: string; status: string; required: boolean }>
  >();
  for (const r of evidenceRows) {
    const list = evidenceByAttempt.get(r.attempt_id) ?? [];
    list.push({
      step_order: Number(r.step_order),
      title: String(r.title ?? ''),
      status: String(r.status),
      required: r.required !== false,
    });
    evidenceByAttempt.set(r.attempt_id, list);
  }

  return attemptRows.map((r: any) => {
    const ev = evidenceByAttempt.get(r.attempt_id) ?? [];
    const snap = Array.isArray(r.steps_snapshot) ? (r.steps_snapshot as any[]) : [];

    // Prefer quest_step_evidence (authoritative per-task verification), fall back to snapshot if empty.
    let requiredSteps: Array<{ step_order: number; title: string; verified: boolean }> = [];
    if (ev.length > 0) {
      requiredSteps = ev
        .filter((s) => s.required)
        .map((s) => ({
          step_order: s.step_order,
          title: s.title,
          verified: s.status === 'verified',
        }));
    } else if (snap.length > 0) {
      requiredSteps = snap
        .filter((s) => s?.required !== false)
        .map((s, idx) => ({
          step_order: Number(s?.step_order ?? idx + 1),
          title: String(s?.title ?? `Step ${idx + 1}`),
          verified: s?.status === 'verified',
        }));
    }

    const totalRequired = requiredSteps.length;
    const verifiedRequired = requiredSteps.filter((s) => s.verified).length;
    const nextReq = requiredSteps
      .slice()
      .sort((a, b) => a.step_order - b.step_order)
      .find((s) => !s.verified);

    return {
      attempt_id: r.attempt_id,
      quest_id: r.quest_id,
      title: r.title,
      cover: r.cover ?? null,
      verified_required: verifiedRequired,
      total_required: totalRequired,
      next_task_title: nextReq ? nextReq.title : null,
      status: r.status,
      completed_at: r.completed_at ? new Date(r.completed_at).toISOString() : null,
      reward_points: Number(r.reward_points ?? 0),
    };
  });
}

// GET /me/progress — authenticated traveler's active + last 20 completed quests
profileHubRouter.get('/me/progress', authenticateToken, async (req: AuthRequest, res: Response) => {
  const pool = getPool();
  if (!pool) return unavailable(res);
  res.setHeader('Cache-Control', 'private, no-store');

  const uRes = await pool.query('SELECT COALESCE(progress_public, FALSE) AS progress_public FROM users WHERE id = $1', [
    req.user!.id,
  ]);
  const progressPublic = Boolean(uRes.rows[0]?.progress_public);
  const items = await fetchUserProgress(req.user!.id);
  return res.status(200).json({
    success: true,
    data: {
      progress_public: progressPublic,
      items,
    },
  });
});

// GET /users/:handle/progress — visible only if owner OR target.progress_public = true
profileHubRouter.get(
  '/users/:handle/progress',
  publicProfileLimiter,
  optionalAuthenticateToken,
  checkQAAuthorization,
  async (req: AuthRequest, res: Response) => {
    const pool = getPool();
    if (!pool) return unavailable(res);

    const resolved = await resolveProfileTarget(req.params.handle, req);
    if (!resolved) {
      return res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'User not found or profile is private.' },
      });
    }

    if (resolved.isOwner) {
      res.setHeader('Cache-Control', 'private, no-store');
    } else {
      res.setHeader('Cache-Control', 'no-store');
      if (!resolved.user.progress_public) {
        return res.status(403).json({
          success: false,
          error: { code: 'PROGRESS_PRIVATE', message: 'This traveler keeps their quest progress private.' },
        });
      }
    }

    const items = await fetchUserProgress(resolved.user.id);
    return res.status(200).json({
      success: true,
      data: {
        progress_public: resolved.user.progress_public,
        items,
      },
    });
  },
);

const privacySchema = z.object({
  body: z.object({
    progress_public: z.boolean(),
  }),
});

// PUT /me/profile-privacy { progress_public }
profileHubRouter.put(
  '/me/profile-privacy',
  authenticateToken,
  validateRequest(privacySchema),
  async (req: AuthRequest, res: Response) => {
    const pool = getPool();
    if (!pool) return unavailable(res);
    res.setHeader('Cache-Control', 'private, no-store');

    const progressPublic = Boolean(req.body.progress_public);
    await pool.query('UPDATE users SET progress_public = $2, updated_at = NOW() WHERE id = $1', [
      req.user!.id,
      progressPublic,
    ]);
    const memUser = db.users.find((u) => u.id === req.user!.id);
    if (memUser) (memUser as any).progress_public = progressPublic;

    return res.status(200).json({
      success: true,
      data: { progress_public: progressPublic },
    });
  },
);

// GET /users/:handle/quests — published quests for visitors; all statuses (draft, paused, published) for owner
profileHubRouter.get(
  '/users/:handle/quests',
  publicProfileLimiter,
  optionalAuthenticateToken,
  checkQAAuthorization,
  async (req: AuthRequest, res: Response) => {
    const pool = getPool();
    if (!pool) return unavailable(res);

    const resolved = await resolveProfileTarget(req.params.handle, req);
    if (!resolved) {
      return res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'User not found or profile is private.' },
      });
    }

    if (resolved.isOwner) {
      res.setHeader('Cache-Control', 'private, no-store');
    } else {
      res.setHeader('Cache-Control', 'no-store');
    }

    const statusFilter = resolved.isOwner ? '' : `AND q.status = 'published'`;
    const { rows } = await pool.query(
      `SELECT q.id,
              q.title,
              q.status::text AS status,
              q.reward_points,
              q.location_name,
              q.created_at,
              COALESCE(jsonb_array_length(q.steps), 0) AS step_count,
              (SELECT s.name FROM spots s WHERE s.quest_id = q.id ORDER BY s.created_at ASC LIMIT 1) AS spot_name
         FROM quests q
        WHERE q.author_id = $1
          ${statusFilter}
        ORDER BY q.created_at DESC, q.id DESC`,
      [resolved.user.id],
    );

    const quests = rows.map((r: any) => ({
      id: r.id,
      title: r.title,
      status: r.status,
      reward_points: Number(r.reward_points ?? 0),
      step_count: Number(r.step_count) > 0 ? Number(r.step_count) : 1,
      location_name: r.location_name,
      spot_name: r.spot_name ?? null,
      created_at: new Date(r.created_at).toISOString(),
    }));

    return res.status(200).json({
      success: true,
      data: {
        is_owner: resolved.isOwner,
        quests,
      },
    });
  },
);

interface TimelineCursor {
  ts: string;
  id: string;
}

function encodeTimelineCursor(c: TimelineCursor): string {
  return Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');
}

function decodeTimelineCursor(raw: string): TimelineCursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (!parsed || typeof parsed.ts !== 'string' || typeof parsed.id !== 'string') return null;
    if (Number.isNaN(Date.parse(parsed.ts))) return null;
    return { ts: parsed.ts, id: parsed.id };
  } catch {
    return null;
  }
}

const PAGE_SIZE = 20;

// GET /users/:handle/timeline?cursor= — 20/page, newest first, owner sees under_review items marked
profileHubRouter.get(
  '/users/:handle/timeline',
  publicProfileLimiter,
  optionalAuthenticateToken,
  checkQAAuthorization,
  async (req: AuthRequest, res: Response) => {
    const pool = getPool();
    if (!pool) return unavailable(res);

    const resolved = await resolveProfileTarget(req.params.handle, req);
    if (!resolved) {
      return res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'User not found or profile is private.' },
      });
    }

    if (resolved.isOwner) {
      res.setHeader('Cache-Control', 'private, no-store');
    } else {
      res.setHeader('Cache-Control', 'no-store');
    }

    let cursor: TimelineCursor | null = null;
    if (typeof req.query.cursor === 'string' && req.query.cursor.trim().length > 0) {
      cursor = decodeTimelineCursor(req.query.cursor.trim());
      if (!cursor) {
        return res.status(400).json({
          success: false,
          error: { code: 'INVALID_CURSOR', message: 'Invalid timeline cursor.' },
        });
      }
    }

    const params: any[] = [resolved.user.id, resolved.isOwner];
    let cursorClause = '';
    if (cursor) {
      params.push(cursor.ts, cursor.id);
      cursorClause = `WHERE (ts, sort_id) < ($3::timestamptz, $4::text)`;
    }

    const { rows } = await pool.query(
      `WITH raw_items AS (
         -- 1. Quest completions (or submitted awaiting review for owner)
         SELECT ('quest:' || qa.id) AS sort_id,
                'quest_completion'::text AS kind,
                qa.quest_id AS subject_id,
                q.title AS title,
                CASE WHEN qa.status = 'completed'
                  THEN ('+' || COALESCE(q.reward_points, 0) || ' pts')
                  ELSE 'Submitted for review'
                END AS subtitle,
                ('/quests/' || qa.quest_id) AS href,
                (qa.status <> 'completed') AS under_review,
                qa.status::text AS status,
                COALESCE(qa.completed_at, qa.updated_at, qa.created_at) AS ts
           FROM quest_attempts qa
           JOIN quests q ON q.id = qa.quest_id
          WHERE qa.user_id = $1
            AND (qa.status = 'completed' OR ($2 = TRUE AND qa.status = 'submitted'))

         UNION ALL

         -- 2. Destinations posted (published for visitors, pending/held for owner)
         SELECT ('spot:' || s.id) AS sort_id,
                'destination'::text AS kind,
                s.id AS subject_id,
                s.name AS title,
                s.municipality AS subtitle,
                ('/explore/' || s.slug) AS href,
                (s.status <> 'published') AS under_review,
                s.status::text AS status,
                s.created_at AS ts
           FROM spots s
          WHERE s.created_by = $1
            AND (s.status = 'published' OR ($2 = TRUE AND s.status IN ('pending', 'needs_review', 'held', 'hidden_pending_review')))

         UNION ALL

         -- 3. Spot photos (attached/approved for visitors, pending for owner)
         SELECT ('photo:' || sa.id) AS sort_id,
                'spot_photo'::text AS kind,
                sa.id AS subject_id,
                COALESCE(sp.name, 'Destination photo') AS title,
                COALESCE(sp.municipality, 'Pangasinan') AS subtitle,
                CASE WHEN sp.slug IS NOT NULL THEN ('/explore/' || sp.slug) ELSE '/explore' END AS href,
                (sa.status = 'pending') AS under_review,
                sa.status::text AS status,
                sa.created_at AS ts
           FROM spot_assets sa
           LEFT JOIN spots sp ON sp.id = sa.spot_id
          WHERE sa.user_id = $1
            AND sa.spot_id IS NOT NULL
            AND (sa.status IN ('attached', 'approved') OR ($2 = TRUE AND sa.status = 'pending'))

         UNION ALL

         -- 4. Cultural quiz passes
         SELECT ('quiz:' || cqa.id) AS sort_id,
                'quiz_pass'::text AS kind,
                cqa.quiz_id AS subject_id,
                COALESCE(cqv.title, 'Cultural quiz') AS title,
                COALESCE(sp.municipality, 'Quiz passed') AS subtitle,
                ('/quests') AS href,
                FALSE AS under_review,
                'passed'::text AS status,
                COALESCE(cqa.completed_at, cqa.started_at) AS ts
           FROM cultural_quiz_attempts cqa
           JOIN cultural_quiz_versions cqv ON cqv.id = cqa.version_id
           LEFT JOIN cultural_quizzes cq ON cq.id = cqa.quiz_id
           LEFT JOIN spots sp ON sp.id = cq.destination_id
          WHERE cqa.user_id = $1
            AND cqa.status = 'passed'
       )
       SELECT sort_id, kind, subject_id, title, subtitle, href, under_review, status, ts
         FROM raw_items
         ${cursorClause}
        ORDER BY ts DESC, sort_id DESC
        LIMIT ${PAGE_SIZE + 1}`,
      params,
    );

    const hasMore = rows.length > PAGE_SIZE;
    const page = hasMore ? rows.slice(0, PAGE_SIZE) : rows;
    const last = page[page.length - 1];
    const nextCursor =
      hasMore && last
        ? encodeTimelineCursor({
            ts: new Date(last.ts).toISOString(),
            id: String(last.sort_id),
          })
        : null;

    return res.status(200).json({
      success: true,
      data: {
        items: page.map((r: any) => ({
          id: String(r.sort_id),
          kind: String(r.kind),
          subject_id: String(r.subject_id),
          title: String(r.title ?? ''),
          subtitle: r.subtitle ? String(r.subtitle) : null,
          href: String(r.href ?? ''),
          under_review: Boolean(r.under_review),
          status: String(r.status),
          at: new Date(r.ts).toISOString(),
        })),
        next_cursor: nextCursor,
      },
    });
  },
);

forwardAsyncRouteErrors(profileHubRouter);
