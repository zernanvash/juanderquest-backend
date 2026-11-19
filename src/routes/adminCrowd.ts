import { Router, type Response } from 'express';
import { z } from 'zod';
import { requireAreaAdmin } from '../admin/scope.js';
import { getPool } from '../db/pool.js';
import { authenticateToken, type AuthRequest } from '../middleware/auth.js';
import {
  dismissCrowdSuggestion,
  getCrowdAreas,
  getCrowdHeatmap,
  getCrowdOverview,
  getCrowdSpotDetail,
  getCrowdSuggestions,
} from '../spots/crowdAnalytics.js';
import { log } from '../utils/logger.js';

export const adminCrowdRouter = Router();

const querySchema = z.object({
  from: z.string().trim().max(40).optional(),
  to: z.string().trim().max(40).optional(),
  granularity: z.enum(['day', 'week', 'month']).optional(),
  province: z.string().trim().max(120).optional(),
  municipality: z.string().trim().max(120).optional(),
  category: z.string().trim().max(60).optional(),
  q: z.string().trim().max(120).optional(),
  spot_id: z.string().trim().max(200).optional(),
  onsite_hours: z.coerce.number().int().min(1).max(6).optional(),
  include_test: z.enum(['true', 'false']).optional(),
  page: z.coerce.number().int().min(1).max(1000).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  sort: z
    .enum(['verified_visits', 'on_site_now', 'interactions', 'pressure_score', 'dwell_minutes', 'name', 'municipality'])
    .optional(),
  dir: z.enum(['asc', 'desc']).optional(),
  include_all: z.enum(['true', 'false']).optional(),
});

function parseQuery(req: AuthRequest) {
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) return null;
  const d = parsed.data;
  return {
    from: d.from,
    to: d.to,
    granularity: d.granularity,
    province: d.province,
    municipality: d.municipality,
    category: d.category,
    q: d.q,
    spotId: d.spot_id,
    onsiteHours: d.onsite_hours,
    includeTest: d.include_test === 'true',
    page: d.page,
    limit: d.limit,
    sort: d.sort,
    dir: d.dir,
    includeAll: d.include_all === 'true',
  };
}

adminCrowdRouter.get(
  '/admin/crowd/areas',
  authenticateToken,
  requireAreaAdmin('analytics'),
  async (req: AuthRequest, res: Response) => {
    const pool = getPool();
    if (!pool) {
      return res.status(503).json({
        success: false,
        error: { code: 'DATABASE_OUTAGE', message: 'Crowd analytics storage is unavailable.' },
      });
    }
    try {
      res.setHeader('Cache-Control', 'private, no-store');
      return res.json({
        success: true,
        data: await getCrowdAreas(pool, req.adminScope!, req.query.include_test === 'true'),
      });
    } catch (error) {
      log.error('[admin-crowd] areas failed:', { error });
      return res.status(503).json({
        success: false,
        error: { code: 'CROWD_AREAS_UNAVAILABLE', message: 'Unable to load authorized crowd areas.' },
      });
    }
  },
);

adminCrowdRouter.get(
  '/admin/crowd/overview',
  authenticateToken,
  requireAreaAdmin('analytics'),
  async (req: AuthRequest, res: Response) => {
    const pool = getPool();
    if (!pool) {
      return res.status(503).json({
        success: false,
        error: { code: 'DATABASE_OUTAGE', message: 'Crowd analytics storage is unavailable.' },
      });
    }
    const opts = parseQuery(req);
    if (!opts) {
      return res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'Invalid crowd filter parameters.' },
      });
    }
    try {
      res.setHeader('Cache-Control', 'private, no-store');
      return res.json({ success: true, data: await getCrowdOverview(pool, req.adminScope!, opts) });
    } catch (error) {
      log.error('[admin-crowd] overview failed:', { error });
      return res.status(503).json({
        success: false,
        error: { code: 'CROWD_ANALYTICS_UNAVAILABLE', message: 'Unable to load crowd overview.' },
      });
    }
  },
);

adminCrowdRouter.get(
  '/admin/crowd/heatmap',
  authenticateToken,
  requireAreaAdmin('analytics'),
  async (req: AuthRequest, res: Response) => {
    const pool = getPool();
    if (!pool) {
      return res.status(503).json({
        success: false,
        error: { code: 'DATABASE_OUTAGE', message: 'Crowd analytics storage is unavailable.' },
      });
    }
    const opts = parseQuery(req);
    if (!opts) {
      return res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'Invalid heatmap filter parameters.' },
      });
    }
    try {
      res.setHeader('Cache-Control', 'private, no-store');
      return res.json({ success: true, data: await getCrowdHeatmap(pool, req.adminScope!, opts) });
    } catch (error) {
      log.error('[admin-crowd] heatmap failed:', { error });
      return res.status(503).json({
        success: false,
        error: { code: 'CROWD_ANALYTICS_UNAVAILABLE', message: 'Unable to load crowd heatmap.' },
      });
    }
  },
);

adminCrowdRouter.get(
  '/admin/crowd/spots/:spotId',
  authenticateToken,
  requireAreaAdmin('analytics'),
  async (req: AuthRequest, res: Response) => {
    const pool = getPool();
    if (!pool) {
      return res.status(503).json({
        success: false,
        error: { code: 'DATABASE_OUTAGE', message: 'Crowd analytics storage is unavailable.' },
      });
    }
    const opts = parseQuery(req);
    if (!opts) {
      return res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'Invalid spot filter parameters.' },
      });
    }
    try {
      const detail = await getCrowdSpotDetail(pool, req.adminScope!, req.params.spotId, opts);
      if (!detail) {
        return res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Destination not found or outside your assigned area.' },
        });
      }
      res.setHeader('Cache-Control', 'private, no-store');
      return res.json({ success: true, data: detail });
    } catch (error) {
      log.error('[admin-crowd] spot detail failed:', { error });
      return res.status(503).json({
        success: false,
        error: { code: 'CROWD_ANALYTICS_UNAVAILABLE', message: 'Unable to load destination crowd detail.' },
      });
    }
  },
);

adminCrowdRouter.get(
  '/admin/crowd/suggestions',
  authenticateToken,
  requireAreaAdmin('analytics'),
  async (req: AuthRequest, res: Response) => {
    const pool = getPool();
    if (!pool) {
      return res.status(503).json({
        success: false,
        error: { code: 'DATABASE_OUTAGE', message: 'Crowd analytics storage is unavailable.' },
      });
    }
    const opts = parseQuery(req);
    if (!opts) {
      return res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'Invalid suggestion filter parameters.' },
      });
    }
    try {
      res.setHeader('Cache-Control', 'private, no-store');
      return res.json({ success: true, data: await getCrowdSuggestions(pool, req.adminScope!, opts) });
    } catch (error) {
      log.error('[admin-crowd] suggestions failed:', { error });
      return res.status(503).json({
        success: false,
        error: { code: 'CROWD_SUGGESTIONS_UNAVAILABLE', message: 'Unable to compute crowd control suggestions.' },
      });
    }
  },
);

const dismissSchema = z.object({
  spot_id: z.string().trim().min(1).max(200),
  suggestion_key: z.enum(['busy_now', 'recurring_peak', 'proof_anomaly']),
});

adminCrowdRouter.post(
  '/admin/crowd/suggestions/dismiss',
  authenticateToken,
  requireAreaAdmin('analytics'),
  async (req: AuthRequest, res: Response) => {
    const pool = getPool();
    if (!pool) {
      return res.status(503).json({
        success: false,
        error: { code: 'DATABASE_OUTAGE', message: 'Crowd analytics storage is unavailable.' },
      });
    }
    const parsed = dismissSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'spot_id and valid suggestion_key are required.' },
      });
    }
    try {
      const result = await dismissCrowdSuggestion(
        pool,
        req.adminScope!,
        req.user!.id,
        req.user!.role,
        parsed.data.spot_id,
        parsed.data.suggestion_key,
      );
      if (!result) {
        return res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Destination not found or outside your assigned area.' },
        });
      }
      return res.json({ success: true, data: result });
    } catch (error) {
      log.error('[admin-crowd] dismiss suggestion failed:', { error });
      return res.status(503).json({
        success: false,
        error: { code: 'CROWD_SUGGESTIONS_UNAVAILABLE', message: 'Unable to dismiss suggestion.' },
      });
    }
  },
);
