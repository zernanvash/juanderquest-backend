import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import { getPool } from '../db/pool.js';
import { optionalAuthenticateToken, checkQAAuthorization, isAuthorizedQA, AuthRequest } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { validateRequest } from '../middleware/validate.js';
import { getFeed, getActivityById, PlazaError } from '../social/feed.js';

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

const feedQuerySchema = z.object({
  query: z.object({
    scope: z.enum(['mixed', 'following']).default('mixed'),
    cursor: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
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
