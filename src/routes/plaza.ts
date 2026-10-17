import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import { getPool } from '../db/pool.js';
import { optionalAuthenticateToken, checkQAAuthorization, isAuthorizedQA, AuthRequest } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { validateRequest } from '../middleware/validate.js';
import { getFeed, getActivityById, PlazaError } from '../social/feed.js';
import { getBoard, getTownBoard, computeHomeTowns } from '../social/standings.js';
import { weekStartUtc, nextWeekStartUtc, weekStartDate, weekId } from '../social/time.js';

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

