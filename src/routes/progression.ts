import { Router, Response } from 'express';
import { z } from 'zod';
import {
  authenticateToken,
  optionalAuthenticateToken,
  requireAdmin,
  checkQAAuthorization,
  isAuthorizedQA,
  AuthRequest,
} from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { env } from '../config/env.js';
import { progressionService } from '../progression/service.js';
import { progressionRepo } from '../progression/repository.js';
import {
  evaluateCommunityGoals,
  getAchievementSharing,
  getEngagementSummary,
  listCommunityGoals,
  setAchievementSharing,
} from '../progression/retention.js';

export const progressionRouter = Router();

const adminOutboxLimiter = rateLimit({
  policyId: 'progression:admin-outbox',
  windowMs: 60 * 1000,
  max: 30,
  keyStrategy: 'actor',
});

// Guard middleware for progression feature flag
const requireProgressionEnabled = (_req: AuthRequest, res: Response, next: () => void) => {
  if (!env.PROGRESSION_ENABLED) {
    return res.status(503).json({
      success: false,
      error: { code: 'FEATURE_DISABLED', message: 'Progression feature is currently disabled.' },
    });
  }
  next();
};

progressionRouter.use(requireProgressionEnabled);

// ==========================================
// 1. Owner Passport & Travel Activity
// ==========================================

// GET /me/progression — Full traveler passport for authenticated account
progressionRouter.get(
  '/me/progression',
  authenticateToken,
  checkQAAuthorization,
  async (req: AuthRequest, res: Response) => {
    res.set('Cache-Control', 'private, no-store');
    const userId = req.user!.id;
    const allowTest = isAuthorizedQA(req);
    const passport = await progressionService.getTravelerPassport(userId, userId, allowTest);

    if (!passport) {
      return res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Traveler profile not found.' },
      });
    }

    return res.status(200).json({
      success: true,
      data: passport,
    });
  }
);

progressionRouter.get('/me/engagement', authenticateToken, checkQAAuthorization, async (req: AuthRequest, res: Response) => {
  res.set('Cache-Control', 'private, no-store');
  const summary = await getEngagementSummary(req.user!.id, isAuthorizedQA(req));
  if (!summary) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND' } });
  return res.json({ success: true, data: summary });
});

const engagementPreferenceSchema = z.object({ share_achievements: z.boolean() }).strict();
progressionRouter.put('/me/engagement/preferences', authenticateToken, async (req: AuthRequest, res: Response) => {
  const parsed = engagementPreferenceSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR' } });
  res.set('Cache-Control', 'private, no-store');
  return res.json({ success: true, data: await setAchievementSharing(req.user!.id, parsed.data.share_achievements) });
});

// GET /me/visits — Verified destination visits history
progressionRouter.get(
  '/me/visits',
  authenticateToken,
  checkQAAuthorization,
  async (req: AuthRequest, res: Response) => {
    res.set('Cache-Control', 'private, no-store');
    const userId = req.user!.id;
    const allowTest = isAuthorizedQA(req);
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 20;
    const offset = req.query.offset ? parseInt(req.query.offset as string, 10) : 0;

    const visits = await progressionRepo.getVerifiedVisitsForUser(userId, {
      limit,
      offset,
      allowTest,
    });

    return res.status(200).json({
      success: true,
      data: {
        items: visits,
        total: visits.length,
      },
    });
  }
);

progressionRouter.get('/community-goals', optionalAuthenticateToken, checkQAAuthorization,
  async (req: AuthRequest, res: Response) => {
    const allowTest = isAuthorizedQA(req);
    res.set('Cache-Control', allowTest ? 'private, no-store' : 'public, max-age=60');
    const items = await listCommunityGoals(allowTest && req.query.include_test === 'true');
    return res.json({ success: true, data: { items, total: items.length } });
  });

// GET /me/achievements — Earned badges and honors for authenticated account
progressionRouter.get(
  '/me/achievements',
  authenticateToken,
  checkQAAuthorization,
  async (req: AuthRequest, res: Response) => {
    res.set('Cache-Control', 'private, no-store');
    const userId = req.user!.id;
    const allowTest = isAuthorizedQA(req);
    const awards = await progressionRepo.getAwardsForUser(userId, allowTest);
    const catalog = await progressionRepo.getAllAchievementDefinitions();

    return res.status(200).json({
      success: true,
      data: {
        earned: awards,
        catalog,
      },
    });
  }
);

// ==========================================
// 2. Curated Collections & Trails
// ==========================================

// GET /collections — Curated trails and exploration collections
progressionRouter.get(
  '/collections',
  optionalAuthenticateToken,
  checkQAAuthorization,
  async (req: AuthRequest, res: Response) => {
    const allowTest = isAuthorizedQA(req);
    if (req.user || allowTest) {
      res.set('Cache-Control', 'private, no-store');
    } else {
      res.set('Cache-Control', 'public, max-age=60');
    }
    const userId = req.user?.id;
    const collections = await progressionRepo.getCuratedCollections(userId, allowTest);

    return res.status(200).json({
      success: true,
      data: {
        items: collections,
        total: collections.length,
      },
    });
  }
);

// ==========================================
// 3. Opt-in Public Achievements
// ==========================================

// GET /users/:id/achievements — Public badges projection (respects is_public and synthetic test quarantine)
progressionRouter.get(
  '/users/:id/achievements',
  optionalAuthenticateToken,
  checkQAAuthorization,
  async (req: AuthRequest, res: Response) => {
    res.set('Cache-Control', 'no-store');
    const allowTest = isAuthorizedQA(req);
    const userId = req.params.id;

    if (!(await getAchievementSharing(userId))) {
      return res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'User not found or achievement sharing is disabled.' },
      });
    }

    const publicProjection = await progressionService.getPublicAchievements(userId, allowTest);

    if (!publicProjection) {
      return res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'User not found or profile is private.' },
      });
    }

    return res.status(200).json({
      success: true,
      data: publicProjection,
    });
  }
);

// ==========================================
// 4. Admin / Worker Maintenance
// ==========================================

const processOutboxSchema = z.object({
  batch_size: z.number().int().min(1).max(100).optional(),
});

// POST /admin/progression/process-outbox — Manually or scheduler triggered outbox processing
progressionRouter.post(
  '/admin/progression/process-outbox',
  authenticateToken,
  requireAdmin,
  adminOutboxLimiter,
  async (req: AuthRequest, res: Response) => {
    const parseResult = processOutboxSchema.safeParse(req.body);
    if (!parseResult.success) {
      return res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'batch_size must be an integer between 1 and 100.' },
      });
    }

    const batchSize = parseResult.data.batch_size ?? 20;
    const result = await progressionService.processOutboxBatch(batchSize, `admin-${req.user!.id}`);

    return res.status(200).json({
      success: true,
      data: result,
    });
  }
);

progressionRouter.post('/admin/progression/evaluate-community-goals', authenticateToken, requireAdmin,
  adminOutboxLimiter, async (req: AuthRequest, res: Response) => {
    const parsed = z.object({ limit: z.number().int().min(1).max(100).optional() }).strict().safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR' } });
    return res.json({ success: true, data: await evaluateCommunityGoals(parsed.data.limit ?? 20) });
  });

const catchUpSchema = z.object({
  limit: z.number().int().min(1).max(500).optional(),
  since: z.string().datetime().optional(),
});

// POST /admin/progression/catch-up — Manually or scheduler triggered catch-up for approved submissions
progressionRouter.post(
  '/admin/progression/catch-up',
  authenticateToken,
  requireAdmin,
  adminOutboxLimiter,
  async (req: AuthRequest, res: Response) => {
    const parseResult = catchUpSchema.safeParse(req.body);
    if (!parseResult.success) {
      return res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'Invalid catch-up parameters. limit must be 1..500 and since must be an ISO datetime string.' },
      });
    }

    const result = await progressionService.catchUpApprovedSubmissions(parseResult.data);
    return res.status(200).json({
      success: true,
      data: result,
    });
  }
);
