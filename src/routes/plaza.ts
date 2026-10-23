import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { getPool } from '../db/pool.js';
import {
  authenticateToken,
  optionalAuthenticateToken,
  requireAdmin,
  checkQAAuthorization,
  isAuthorizedQA,
  AuthRequest,
} from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { validateRequest } from '../middleware/validate.js';
import { getFeed, getActivityById, PlazaError } from '../social/feed.js';
import { getBoard, getTownBoard, computeHomeTowns } from '../social/standings.js';
import { weekStartUtc, nextWeekStartUtc, weekStartDate, weekId } from '../social/time.js';
import {
  cheer,
  uncheer,
  hideActivity,
  addComment,
  deleteComment,
  reportComment,
  listComments,
  listAdminReports,
  adminModerateComment,
  adminModerateActivity,
} from '../social/interactions.js';
import { cosmeticsFor } from '../shop/render.js';

export const plazaRouter = Router();

const feedRateLimiter = rateLimit({
  policyId: 'plaza:feed',
  windowMs: 60 * 1000,
  max: 120,
  keyStrategy: 'actor_or_ip',
});

const activityRateLimiter = rateLimit({
  policyId: 'plaza:activity',
  windowMs: 60 * 1000,
  max: 120,
  keyStrategy: 'actor_or_ip',
});

const standingsRateLimiter = rateLimit({
  policyId: 'plaza:standings',
  windowMs: 60 * 1000,
  max: 120,
  keyStrategy: 'ip',
});

const townsRateLimiter = rateLimit({
  policyId: 'plaza:towns',
  windowMs: 60 * 1000,
  max: 120,
  keyStrategy: 'ip',
});

const cheerRateLimiter = rateLimit({
  policyId: 'plaza:cheer',
  windowMs: 60 * 1000,
  max: 60,
  keyStrategy: 'actor',
});

const hideActivityLimiter = rateLimit({
  policyId: 'plaza:hide-activity',
  windowMs: 60 * 1000,
  max: 20,
  keyStrategy: 'actor',
});

const commentsListLimiter = rateLimit({
  policyId: 'plaza:comments-list',
  windowMs: 60 * 1000,
  max: 120,
  keyStrategy: 'actor_or_ip',
});

const addCommentLimiter = rateLimit({
  policyId: 'plaza:add-comment',
  windowMs: 60 * 1000,
  max: 10,
  keyStrategy: 'actor',
});

const deleteCommentLimiter = rateLimit({
  policyId: 'plaza:delete-comment',
  windowMs: 60 * 1000,
  max: 30,
  keyStrategy: 'actor',
});

const reportCommentLimiter = rateLimit({
  policyId: 'plaza:report-comment',
  windowMs: 60 * 1000,
  max: 20,
  keyStrategy: 'actor',
});

const deviceRateLimiter = rateLimit({
  policyId: 'plaza:devices',
  windowMs: 60 * 1000,
  max: 20,
  keyStrategy: 'actor',
});

const prefGetLimiter = rateLimit({
  policyId: 'plaza:pref-get',
  windowMs: 60 * 1000,
  max: 60,
  keyStrategy: 'actor',
});

const prefPutLimiter = rateLimit({
  policyId: 'plaza:pref-put',
  windowMs: 60 * 1000,
  max: 30,
  keyStrategy: 'actor',
});

const privacyLimiter = rateLimit({
  policyId: 'plaza:privacy',
  windowMs: 60 * 1000,
  max: 30,
  keyStrategy: 'actor',
});

const feedQuerySchema = z.object({
  query: z.object({
    scope: z.enum(['mixed', 'following']).default('mixed'),
    cursor: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  }),
});

const standingsQuerySchema = z.object({
  query: z.object({
    board: z.enum(['everyone', 'following', 'town']).default('everyone'),
    period: z.enum(['weekly', 'all_time']).default('weekly'),
    metric: z.enum(['scout_reputation', 'quests_completed', 'points']).default('scout_reputation'),
    limit: z.coerce.number().int().min(1).max(50).default(20),
    after_rank: z.coerce.number().int().min(0).optional(),
  }),
});

const townsQuerySchema = z.object({
  query: z.object({
    period: z.enum(['weekly']).default('weekly'),
  }),
});

const activityParamSchema = z.object({
  params: z.object({
    id: z.string().min(1),
  }),
});

const commentListQuerySchema = z.object({
  params: z.object({
    id: z.string().min(1),
  }),
  query: z.object({
    cursor: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  }),
});

const addCommentSchema = z.object({
  params: z.object({
    id: z.string().min(1),
  }),
  body: z.object({
    body: z.string().min(1).max(280),
    idempotency_key: z.string().min(8).max(100),
  }),
});

const commentParamSchema = z.object({
  params: z.object({
    id: z.string().min(1),
  }),
});

const reportCommentSchema = z.object({
  params: z.object({
    id: z.string().min(1),
  }),
  body: z.object({
    reason: z.enum(['spam', 'harassment', 'hate', 'sexual', 'misinformation', 'other']),
    note: z.string().max(300).optional(),
  }),
});

const adminReportsQuerySchema = z.object({
  query: z.object({
    status: z.enum(['open', 'resolved']).default('open'),
  }),
});

const adminCommentPatchSchema = z.object({
  params: z.object({
    id: z.string().min(1),
  }),
  body: z.object({
    action: z.enum(['hide', 'restore']),
    note: z.string().max(300).optional(),
  }),
});

const adminActivityPatchSchema = z.object({
  params: z.object({
    id: z.string().min(1),
  }),
  body: z.object({
    action: z.enum(['hide', 'restore']),
    reason: z.string().max(200).optional(),
  }),
});

const privacySchema = z.object({
  body: z.object({
    share_activity: z.boolean(),
  }),
});

const notificationPrefSchema = z.object({
  body: z.object({
    push_overtaken: z.boolean().optional(),
    push_friend_activity: z.boolean().optional(),
    push_social: z.boolean().optional(),
    push_weekly_recap: z.boolean().optional(),
    quiet_hours: z.boolean().optional(),
  }),
});

const devicePutSchema = z.object({
  body: z.object({
    token: z.string().min(20).max(4096),
    platform: z.enum(['android']),
    app_build: z.number().int().optional(),
  }),
});

const deviceDeleteSchema = z.object({
  body: z.object({
    token: z.string().min(20).max(4096),
  }),
});

// GET /plaza/feed
plazaRouter.get(
  '/plaza/feed',
  optionalAuthenticateToken,
  checkQAAuthorization,
  feedRateLimiter,
  validateRequest(feedQuerySchema),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    res.set('Cache-Control', 'no-store');
    const isTest = isAuthorizedQA(req);
    if (isTest) res.set('X-Robots-Tag', 'noindex, nofollow');

    const pool = getPool();
    if (!pool) {
      return res.status(200).json({
        success: true,
        data: { items: [], next_cursor: null, degraded: true },
      });
    }

    try {
      const validatedQuery = res.locals.validatedRequest?.query ?? req.query;
      const scope = (validatedQuery.scope as 'mixed' | 'following') || 'mixed';
      const cursor = typeof validatedQuery.cursor === 'string' ? validatedQuery.cursor : undefined;
      const rawLimit = validatedQuery.limit ?? req.query.limit;
      const limit = rawLimit !== undefined ? Number(rawLimit) : 20;

      const result = await getFeed(pool, {
        viewerId: req.user?.id ?? null,
        isTest,
        scope,
        cursor,
        limit,
      });
      const cosmetics=await cosmeticsFor(result.items.map(item=>item.actor.user_id),pool);
      result.items=result.items.map(item=>({...item,actor:{...item.actor,cosmetics:cosmetics.get(item.actor.user_id)??{banner:null,frame:null,title:null,nameColor:null}}}));

      return res.status(200).json({
        success: true,
        data: result,
      });
    } catch (err: any) {
      if (err instanceof PlazaError) {
        return res.status(err.statusCode).json({
          success: false,
          error: { code: err.code, message: err.message },
        });
      }
      return next(err);
    }
  },
);

// GET /plaza/activities/:id
plazaRouter.get(
  '/plaza/activities/:id',
  optionalAuthenticateToken,
  checkQAAuthorization,
  activityRateLimiter,
  validateRequest(activityParamSchema),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    res.set('Cache-Control', 'no-store');
    const isTest = isAuthorizedQA(req);
    if (isTest) res.set('X-Robots-Tag', 'noindex, nofollow');

    const pool = getPool();
    if (!pool) {
      return res.status(200).json({
        success: true,
        data: null,
        degraded: true,
      });
    }

    try {
      const item = await getActivityById(
        pool,
        req.params.id,
        req.user?.id ?? null,
        isTest,
      );

      if (!item) {
        return res.status(404).json({
          success: false,
          error: { code: 'PLAZA_NOT_FOUND', message: 'Activity not found.' },
        });
      }

      return res.status(200).json({
        success: true,
        data: item,
      });
    } catch (err: any) {
      if (err instanceof PlazaError) {
        return res.status(err.statusCode).json({
          success: false,
          error: { code: err.code, message: err.message },
        });
      }
      return next(err);
    }
  },
);

// GET /plaza/standings
plazaRouter.get(
  '/plaza/standings',
  optionalAuthenticateToken,
  checkQAAuthorization,
  standingsRateLimiter,
  validateRequest(standingsQuerySchema),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    res.set('Cache-Control', 'no-store');
    const isTest = isAuthorizedQA(req);
    if (isTest) res.set('X-Robots-Tag', 'noindex, nofollow');

    const pool = getPool();
    if (!pool) {
      const now = new Date();
      const ws = weekStartUtc(now);
      const we = nextWeekStartUtc(now);
      return res.status(200).json({
        success: true,
        data: {
          board: 'everyone',
          period: 'weekly',
          week: {
            id: weekId(now),
            starts_at: ws.toISOString(),
            ends_at: we.toISOString(),
            resets_in_seconds: Math.max(0, Math.floor((we.getTime() - now.getTime()) / 1000)),
          },
          me: null,
          podium: [],
          entries: [],
          rivals: { above: [], below: [] },
          town: null,
          total: 0,
          next_after_rank: null,
          degraded: true,
        },
      });
    }

    try {
      const validatedQuery = res.locals.validatedRequest?.query ?? req.query;
      const board = validatedQuery.board as 'everyone' | 'following' | 'town';
      const period = validatedQuery.period as 'weekly' | 'all_time';
      const metric = validatedQuery.metric as 'scout_reputation' | 'quests_completed' | 'points';
      const limit = Number(validatedQuery.limit ?? 20);
      const afterRank = validatedQuery.after_rank != null ? Number(validatedQuery.after_rank) : null;

      const result = await getBoard({
        client: pool,
        viewerId: req.user?.id ?? null,
        isTest,
        board,
        period,
        metric,
        limit,
        afterRank,
      });
      const actors=[...result.entries,...result.podium,...result.rivals.above,...result.rivals.below];
      const cosmetics=await cosmeticsFor(actors.map(item=>item.user_id||'').filter(Boolean),pool);
      const addCosmetics=(item:any)=>({...item,cosmetics:item.user_id?cosmetics.get(item.user_id)??{banner:null,frame:null,title:null,nameColor:null}:undefined});
      result.entries=result.entries.map(addCosmetics); result.podium=result.podium.map(addCosmetics);
      result.rivals.above=result.rivals.above.map(addCosmetics); result.rivals.below=result.rivals.below.map(addCosmetics);

      return res.status(200).json({
        success: true,
        data: result,
      });
    } catch (err: any) {
      if (err instanceof PlazaError) {
        return res.status(err.statusCode).json({
          success: false,
          error: { code: err.code, message: err.message },
        });
      }
      return next(err);
    }
  },
);

// GET /plaza/towns
plazaRouter.get(
  '/plaza/towns',
  optionalAuthenticateToken,
  checkQAAuthorization,
  townsRateLimiter,
  validateRequest(townsQuerySchema),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    res.set('Cache-Control', 'no-store');
    const isTest = isAuthorizedQA(req);
    if (isTest) res.set('X-Robots-Tag', 'noindex, nofollow');

    const pool = getPool();
    if (!pool) {
      const now = new Date();
      const ws = weekStartUtc(now);
      const we = nextWeekStartUtc(now);
      return res.status(200).json({
        success: true,
        data: {
          week: {
            id: weekId(now),
            starts_at: ws.toISOString(),
            ends_at: we.toISOString(),
            resets_in_seconds: Math.max(0, Math.floor((we.getTime() - now.getTime()) / 1000)),
          },
          towns: [],
          degraded: true,
        },
      });
    }

    try {
      let viewerTown: string | null = null;
      if (req.user?.id) {
        const townsMap = await computeHomeTowns(pool, isTest);
        viewerTown = townsMap.get(req.user.id) ?? null;
      }

      const result = await getTownBoard({
        client: pool,
        isTest,
        viewerHomeTown: viewerTown,
      });

      return res.status(200).json({
        success: true,
        data: result,
      });
    } catch (err: any) {
      if (err instanceof PlazaError) {
        return res.status(err.statusCode).json({
          success: false,
          error: { code: err.code, message: err.message },
        });
      }
      return next(err);
    }
  },
);

// PUT /plaza/activities/:id/cheer
plazaRouter.put(
  '/plaza/activities/:id/cheer',
  authenticateToken,
  checkQAAuthorization,
  cheerRateLimiter,
  validateRequest(activityParamSchema),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    const isTest = isAuthorizedQA(req);
    const pool = getPool();
    if (!pool) {
      return res.status(503).json({
        success: false,
        error: { code: 'DATABASE_REQUIRED', message: 'Durable storage required for Plaza operations.' },
      });
    }

    try {
      const result = await cheer(pool, req.user!.id, req.params.id, isTest);
      return res.status(200).json({
        success: true,
        data: result,
      });
    } catch (err: any) {
      if (err instanceof PlazaError) {
        return res.status(err.statusCode).json({
          success: false,
          error: { code: err.code, message: err.message },
        });
      }
      return next(err);
    }
  },
);

// DELETE /plaza/activities/:id/cheer
plazaRouter.delete(
  '/plaza/activities/:id/cheer',
  authenticateToken,
  checkQAAuthorization,
  cheerRateLimiter,
  validateRequest(activityParamSchema),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    const isTest = isAuthorizedQA(req);
    const pool = getPool();
    if (!pool) {
      return res.status(503).json({
        success: false,
        error: { code: 'DATABASE_REQUIRED', message: 'Durable storage required for Plaza operations.' },
      });
    }

    try {
      const result = await uncheer(pool, req.user!.id, req.params.id, isTest);
      return res.status(200).json({
        success: true,
        data: result,
      });
    } catch (err: any) {
      if (err instanceof PlazaError) {
        return res.status(err.statusCode).json({
          success: false,
          error: { code: err.code, message: err.message },
        });
      }
      return next(err);
    }
  },
);

// DELETE /plaza/activities/:id
plazaRouter.delete(
  '/plaza/activities/:id',
  authenticateToken,
  checkQAAuthorization,
  hideActivityLimiter,
  validateRequest(activityParamSchema),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    const isTest = isAuthorizedQA(req);
    const pool = getPool();
    if (!pool) {
      return res.status(503).json({
        success: false,
        error: { code: 'DATABASE_REQUIRED', message: 'Durable storage required for Plaza operations.' },
      });
    }

    try {
      const result = await hideActivity(pool, req.user!.id, req.params.id, isTest);
      return res.status(200).json({
        success: true,
        data: result,
      });
    } catch (err: any) {
      if (err instanceof PlazaError) {
        return res.status(err.statusCode).json({
          success: false,
          error: { code: err.code, message: err.message },
        });
      }
      return next(err);
    }
  },
);

// GET /plaza/activities/:id/comments
plazaRouter.get(
  '/plaza/activities/:id/comments',
  optionalAuthenticateToken,
  checkQAAuthorization,
  commentsListLimiter,
  validateRequest(commentListQuerySchema),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    res.set('Cache-Control', 'no-store');
    const isTest = isAuthorizedQA(req);
    const pool = getPool();
    if (!pool) {
      return res.status(200).json({
        success: true,
        data: { items: [], next_cursor: null, degraded: true },
      });
    }

    try {
      const validatedQuery = res.locals.validatedRequest?.query ?? req.query;
      const cursor = typeof validatedQuery.cursor === 'string' ? validatedQuery.cursor : undefined;
      const limit = validatedQuery.limit != null ? Number(validatedQuery.limit) : 20;

      const result = await listComments(pool, {
        viewerId: req.user?.id ?? null,
        activityId: req.params.id,
        cursor,
        limit,
        isTest,
      });
      const cosmetics=await cosmeticsFor(result.items.map(item=>item.author.user_id),pool);
      result.items=result.items.map(item=>({...item,author:{...item.author,cosmetics:cosmetics.get(item.author.user_id)??{banner:null,frame:null,title:null,nameColor:null}}}));

      return res.status(200).json({
        success: true,
        data: result,
      });
    } catch (err: any) {
      if (err instanceof PlazaError) {
        return res.status(err.statusCode).json({
          success: false,
          error: { code: err.code, message: err.message },
        });
      }
      return next(err);
    }
  },
);

// POST /plaza/activities/:id/comments
plazaRouter.post(
  '/plaza/activities/:id/comments',
  authenticateToken,
  checkQAAuthorization,
  addCommentLimiter,
  validateRequest(addCommentSchema),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    const isTest = isAuthorizedQA(req);
    const pool = getPool();
    if (!pool) {
      return res.status(503).json({
        success: false,
        error: { code: 'DATABASE_REQUIRED', message: 'Durable storage required for Plaza operations.' },
      });
    }

    try {
      const validatedBody = res.locals.validatedRequest?.body ?? req.body;
      const result = await addComment(
        pool,
        req.user!.id,
        req.params.id,
        validatedBody.body,
        validatedBody.idempotency_key,
        isTest,
      );

      return res.status(result.replayed ? 200 : 201).json({
        success: true,
        data: result.comment,
      });
    } catch (err: any) {
      if (err instanceof PlazaError) {
        return res.status(err.statusCode).json({
          success: false,
          error: { code: err.code, message: err.message },
        });
      }
      return next(err);
    }
  },
);

// DELETE /plaza/comments/:id
plazaRouter.delete(
  '/plaza/comments/:id',
  authenticateToken,
  checkQAAuthorization,
  deleteCommentLimiter,
  validateRequest(commentParamSchema),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    const isTest = isAuthorizedQA(req);
    const pool = getPool();
    if (!pool) {
      return res.status(503).json({
        success: false,
        error: { code: 'DATABASE_REQUIRED', message: 'Durable storage required for Plaza operations.' },
      });
    }

    try {
      const result = await deleteComment(pool, req.user!.id, req.params.id, isTest);
      return res.status(200).json({
        success: true,
        data: result,
      });
    } catch (err: any) {
      if (err instanceof PlazaError) {
        return res.status(err.statusCode).json({
          success: false,
          error: { code: err.code, message: err.message },
        });
      }
      return next(err);
    }
  },
);

// POST /plaza/comments/:id/report
plazaRouter.post(
  '/plaza/comments/:id/report',
  authenticateToken,
  checkQAAuthorization,
  reportCommentLimiter,
  validateRequest(reportCommentSchema),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    const isTest = isAuthorizedQA(req);
    const pool = getPool();
    if (!pool) {
      return res.status(503).json({
        success: false,
        error: { code: 'DATABASE_REQUIRED', message: 'Durable storage required for Plaza operations.' },
      });
    }

    try {
      const validatedBody = res.locals.validatedRequest?.body ?? req.body;
      const result = await reportComment(
        pool,
        req.user!.id,
        req.params.id,
        validatedBody.reason,
        validatedBody.note,
        isTest,
      );
      return res.status(200).json({
        success: true,
        data: result,
      });
    } catch (err: any) {
      if (err instanceof PlazaError) {
        return res.status(err.statusCode).json({
          success: false,
          error: { code: err.code, message: err.message },
        });
      }
      return next(err);
    }
  },
);

// GET /admin/plaza/reports
plazaRouter.get(
  '/admin/plaza/reports',
  authenticateToken,
  requireAdmin,
  validateRequest(adminReportsQuerySchema),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    res.set('Cache-Control', 'no-store');
    const pool = getPool();
    if (!pool) {
      return res.status(200).json({ success: true, data: [], degraded: true });
    }

    try {
      const validatedQuery = res.locals.validatedRequest?.query ?? req.query;
      const status = (validatedQuery.status as 'open' | 'resolved') || 'open';
      const data = await listAdminReports(pool, status);
      return res.status(200).json({ success: true, data });
    } catch (err) {
      return next(err);
    }
  },
);

// PATCH /admin/plaza/comments/:id
plazaRouter.patch(
  '/admin/plaza/comments/:id',
  authenticateToken,
  requireAdmin,
  validateRequest(adminCommentPatchSchema),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    const pool = getPool();
    if (!pool) {
      return res.status(503).json({
        success: false,
        error: { code: 'DATABASE_REQUIRED', message: 'Durable storage required for Plaza operations.' },
      });
    }

    try {
      const validatedBody = res.locals.validatedRequest?.body ?? req.body;
      const data = await adminModerateComment(
        pool,
        req.user!.id,
        req.params.id,
        validatedBody.action,
        validatedBody.note,
      );
      return res.status(200).json({ success: true, data });
    } catch (err: any) {
      if (err instanceof PlazaError) {
        return res.status(err.statusCode).json({
          success: false,
          error: { code: err.code, message: err.message },
        });
      }
      return next(err);
    }
  },
);

// PATCH /admin/plaza/activities/:id
plazaRouter.patch(
  '/admin/plaza/activities/:id',
  authenticateToken,
  requireAdmin,
  validateRequest(adminActivityPatchSchema),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    const pool = getPool();
    if (!pool) {
      return res.status(503).json({
        success: false,
        error: { code: 'DATABASE_REQUIRED', message: 'Durable storage required for Plaza operations.' },
      });
    }

    try {
      const validatedBody = res.locals.validatedRequest?.body ?? req.body;
      const data = await adminModerateActivity(
        pool,
        req.user!.id,
        req.params.id,
        validatedBody.action,
        validatedBody.reason,
      );
      return res.status(200).json({ success: true, data });
    } catch (err: any) {
      if (err instanceof PlazaError) {
        return res.status(err.statusCode).json({
          success: false,
          error: { code: err.code, message: err.message },
        });
      }
      return next(err);
    }
  },
);

// PUT /me/privacy
plazaRouter.put(
  '/me/privacy',
  authenticateToken,
  privacyLimiter,
  validateRequest(privacySchema),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    const pool = getPool();
    if (!pool) {
      return res.status(503).json({
        success: false,
        error: { code: 'DATABASE_REQUIRED', message: 'Durable storage required.' },
      });
    }

    try {
      const share = Boolean(req.body.share_activity);
      const updateRes = await pool.query(
        'UPDATE users SET share_activity = $1, updated_at = NOW() WHERE id = $2 RETURNING share_activity',
        [share, req.user!.id],
      );
      return res.status(200).json({
        success: true,
        data: { share_activity: Boolean(updateRes.rows[0]?.share_activity) },
      });
    } catch (err) {
      return next(err);
    }
  },
);

// GET /me/notification-preferences
plazaRouter.get(
  '/me/notification-preferences',
  authenticateToken,
  prefGetLimiter,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    res.set('Cache-Control', 'no-store');
    const pool = getPool();
    if (!pool) {
      return res.status(200).json({
        success: true,
        data: {
          push_overtaken: true,
          push_friend_activity: true,
          push_social: true,
          push_weekly_recap: true,
          quiet_hours: true,
        },
      });
    }

    try {
      const r = await pool.query(
        `SELECT push_overtaken, push_friend_activity, push_social, push_weekly_recap, quiet_hours
           FROM user_notification_preferences
          WHERE user_id = $1`,
        [req.user!.id],
      );
      if (!r.rows.length) {
        return res.status(200).json({
          success: true,
          data: {
            push_overtaken: true,
            push_friend_activity: true,
            push_social: true,
            push_weekly_recap: true,
            quiet_hours: true,
          },
        });
      }
      const row = r.rows[0];
      return res.status(200).json({
        success: true,
        data: {
          push_overtaken: Boolean(row.push_overtaken),
          push_friend_activity: Boolean(row.push_friend_activity),
          push_social: Boolean(row.push_social),
          push_weekly_recap: Boolean(row.push_weekly_recap),
          quiet_hours: Boolean(row.quiet_hours),
        },
      });
    } catch (err) {
      return next(err);
    }
  },
);

// PUT /me/notification-preferences
plazaRouter.put(
  '/me/notification-preferences',
  authenticateToken,
  prefPutLimiter,
  validateRequest(notificationPrefSchema),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    const pool = getPool();
    if (!pool) {
      return res.status(503).json({
        success: false,
        error: { code: 'DATABASE_REQUIRED', message: 'Durable storage required.' },
      });
    }

    try {
      const body = req.body;
      const r = await pool.query(
        `INSERT INTO user_notification_preferences (
           user_id, push_overtaken, push_friend_activity, push_social, push_weekly_recap, quiet_hours, updated_at
         ) VALUES (
           $1,
           COALESCE($2, TRUE),
           COALESCE($3, TRUE),
           COALESCE($4, TRUE),
           COALESCE($5, TRUE),
           COALESCE($6, TRUE),
           NOW()
         )
         ON CONFLICT (user_id) DO UPDATE SET
           push_overtaken = COALESCE($2, user_notification_preferences.push_overtaken),
           push_friend_activity = COALESCE($3, user_notification_preferences.push_friend_activity),
           push_social = COALESCE($4, user_notification_preferences.push_social),
           push_weekly_recap = COALESCE($5, user_notification_preferences.push_weekly_recap),
           quiet_hours = COALESCE($6, user_notification_preferences.quiet_hours),
           updated_at = NOW()
         RETURNING push_overtaken, push_friend_activity, push_social, push_weekly_recap, quiet_hours`,
        [
          req.user!.id,
          body.push_overtaken ?? null,
          body.push_friend_activity ?? null,
          body.push_social ?? null,
          body.push_weekly_recap ?? null,
          body.quiet_hours ?? null,
        ],
      );
      const row = r.rows[0];
      return res.status(200).json({
        success: true,
        data: {
          push_overtaken: Boolean(row.push_overtaken),
          push_friend_activity: Boolean(row.push_friend_activity),
          push_social: Boolean(row.push_social),
          push_weekly_recap: Boolean(row.push_weekly_recap),
          quiet_hours: Boolean(row.quiet_hours),
        },
      });
    } catch (err) {
      return next(err);
    }
  },
);

// PUT /me/devices
plazaRouter.put(
  '/me/devices',
  authenticateToken,
  deviceRateLimiter,
  validateRequest(devicePutSchema),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    const pool = getPool();
    if (!pool) {
      return res.status(503).json({
        success: false,
        error: { code: 'DATABASE_REQUIRED', message: 'Durable storage required.' },
      });
    }

    try {
      const { token, platform, app_build } = req.body;
      const devId = `dev_${randomUUID()}`;
      await pool.query(
        `INSERT INTO user_devices (
           id, user_id, token, platform, app_build, created_at, last_seen_at
         ) VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
         ON CONFLICT (token) DO UPDATE SET
           user_id = EXCLUDED.user_id,
           platform = EXCLUDED.platform,
           app_build = COALESCE(EXCLUDED.app_build, user_devices.app_build),
           last_seen_at = NOW(),
           disabled_at = NULL,
           disabled_reason = NULL`,
        [devId, req.user!.id, token, platform, app_build ?? null],
      );
      return res.status(200).json({ success: true, data: { registered: true } });
    } catch (err) {
      return next(err);
    }
  },
);

// DELETE /me/devices
plazaRouter.delete(
  '/me/devices',
  authenticateToken,
  deviceRateLimiter,
  validateRequest(deviceDeleteSchema),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    const pool = getPool();
    if (!pool) {
      return res.status(503).json({
        success: false,
        error: { code: 'DATABASE_REQUIRED', message: 'Durable storage required.' },
      });
    }

    try {
      const { token } = req.body;
      await pool.query(
        'DELETE FROM user_devices WHERE user_id = $1 AND token = $2',
        [req.user!.id, token],
      );
      return res.status(200).json({ success: true, data: { removed: true } });
    } catch (err) {
      return next(err);
    }
  },
);


