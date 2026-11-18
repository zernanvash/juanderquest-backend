import { Router, Response } from 'express';
import { z } from 'zod';
import { getPool } from '../db/pool.js';
import { authenticateToken, requireAdmin, AuthRequest } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { validateRequest } from '../middleware/validate.js';
import { GRANT_DAILY_CAP, GRANT_MAX_POINTS, PointGrantError, PointGrantService } from '../admin/pointGrants.js';

/** Owner 2026-11-18: admin Give mJDQ (simulated beta points, anchored on Polygon Amoy). */
export const adminPointGrantsRouter = Router();

// requireAdmin = role 'admin' = platform admin (area admins have role 'area_admin').
const service = (res: Response) => {
  const pool = getPool();
  if (!pool) {
    res.status(503).json({
      success: false,
      error: { code: 'DATABASE_REQUIRED', message: 'Durable storage is required to give mJDQ.' },
    });
    return null;
  }
  return new PointGrantService(pool);
};

const grantSchema = z.object({
  body: z.object({
    user_id: z.string().min(1).max(100),
    points: z.number().int().min(1).max(GRANT_MAX_POINTS),
    reason: z.string().trim().min(3).max(200),
    idempotency_key: z.string().regex(/^[A-Za-z0-9:_-]{8,100}$/),
  }),
});

const guards = [authenticateToken, requireAdmin];

adminPointGrantsRouter.get('/admin/point-grants/lookup', ...guards, async (req: AuthRequest, res: Response) => {
  const s = service(res);
  if (!s) return;
  const q = typeof req.query.q === 'string' ? req.query.q : '';
  try {
    res.setHeader('Cache-Control', 'private, no-store');
    return res.json({ success: true, data: { users: await s.lookup(q) } });
  } catch {
    return res
      .status(503)
      .json({ success: false, error: { code: 'DATABASE_OUTAGE', message: 'Lookup is unavailable.' } });
  }
});

adminPointGrantsRouter.get('/admin/point-grants', ...guards, async (req: AuthRequest, res: Response) => {
  const s = service(res);
  if (!s) return;
  const limit = Number.parseInt(String(req.query.limit ?? 50), 10) || 50;
  try {
    res.setHeader('Cache-Control', 'private, no-store');
    return res.json({
      success: true,
      data: { items: await s.list(limit), max_points: GRANT_MAX_POINTS, daily_cap: GRANT_DAILY_CAP },
    });
  } catch {
    return res
      .status(503)
      .json({ success: false, error: { code: 'DATABASE_OUTAGE', message: 'Grants are unavailable.' } });
  }
});

adminPointGrantsRouter.post(
  '/admin/point-grants',
  ...guards,
  rateLimit({ policyId: 'admin:point-grants', windowMs: 60_000, max: 10, keyStrategy: 'actor' }),
  validateRequest(grantSchema),
  async (req: AuthRequest, res: Response) => {
    const s = service(res);
    if (!s) return;
    try {
      const result = await s.grant({
        adminId: req.user!.id,
        userId: req.body.user_id,
        points: req.body.points,
        reason: req.body.reason,
        idempotencyKey: req.body.idempotency_key,
      });
      return res.status(result.replayed ? 200 : 201).json({ success: true, data: result });
    } catch (error) {
      if (error instanceof PointGrantError)
        return res.status(error.status).json({
          success: false,
          error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) },
        });
      return res
        .status(503)
        .json({ success: false, error: { code: 'ACCOUNTING_UNAVAILABLE', message: 'The grant could not be saved.' } });
    }
  },
);
