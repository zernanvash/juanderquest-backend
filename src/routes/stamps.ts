import { Router, Response } from 'express';
import { z } from 'zod';
import { authenticateToken, optionalAuthenticateToken, requireAdmin, AuthRequest } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { getPool } from '../db/pool.js';
import {
  StampsError,
  answerQuestionOfTheDay,
  claimDaily,
  getDailyState,
  getQuestionOfTheDay,
  getStampHistory,
  listDailyMissions,
  listQotdCandidates,
  scheduleQuestionOfTheDay,
  setDailyMissionActive,
  spendStamps,
  stampAdminStats,
  upsertDailyMission,
} from '../stamps/service.js';
import { handleQotdAnswered } from '../stamps/hooks.js';
import { manilaDateString } from '../stamps/time.js';

export const stampsRouter = Router();

function fail(res: Response, error: unknown) {
  if (error instanceof StampsError) {
    return res.status(error.status).json({ success: false, error: { code: error.code, message: error.message } });
  }
  console.error('[stamps] route failed', error);
  return res.status(503).json({
    success: false,
    error: { code: 'STORAGE_UNAVAILABLE', message: 'Stamp storage is unavailable. Please try again later.' },
  });
}

const claimLimiter = rateLimit({ policyId: 'stamps:claim', windowMs: 60_000, max: 12, keyStrategy: 'actor' });
const spendLimiter = rateLimit({ policyId: 'stamps:spend', windowMs: 60_000, max: 10, keyStrategy: 'actor' });
const qotdLimiter = rateLimit({ policyId: 'stamps:qotd', windowMs: 60_000, max: 20, keyStrategy: 'actor' });

const idempotencyKey = (req: AuthRequest): string | null => {
  const key = req.header('Idempotency-Key') ?? req.header('x-idempotency-key') ?? null;
  if (!key) return null;
  return key.trim();
};

stampsRouter.get('/me/daily', authenticateToken, async (req: AuthRequest, res: Response) => {
  const pool = getPool();
  if (!pool) return fail(res, new Error('STORAGE_UNAVAILABLE'));
  try {
    const data = await getDailyState(pool, req.user!.id);
    res.setHeader('Cache-Control', 'private, no-store');
    return res.json({ success: true, data });
  } catch (error) {
    return fail(res, error);
  }
});

stampsRouter.post('/me/daily/claim', authenticateToken, claimLimiter, async (req: AuthRequest, res: Response) => {
  const pool = getPool();
  if (!pool) return fail(res, new Error('STORAGE_UNAVAILABLE'));
  const key = idempotencyKey(req);
  if (key !== null && (key.length < 8 || key.length > 100)) {
    return res.status(400).json({ success: false, error: { code: 'INVALID_REQUEST', message: 'Idempotency-Key must be 8-100 characters.' } });
  }
  try {
    const data = await claimDaily(pool, req.user!.id, { idempotencyKey: key });
    return res.json({ success: true, data });
  } catch (error) {
    return fail(res, error);
  }
});

stampsRouter.get('/me/stamps', authenticateToken, async (req: AuthRequest, res: Response) => {
  const pool = getPool();
  if (!pool) return fail(res, new Error('STORAGE_UNAVAILABLE'));
  const cursorRaw = req.query.cursor;
  const cursor = cursorRaw === undefined ? null : Number(cursorRaw);
  if (cursor !== null && (!Number.isInteger(cursor) || cursor < 1)) {
    return res.status(400).json({ success: false, error: { code: 'INVALID_REQUEST', message: 'cursor must be a positive integer.' } });
  }
  const limit = req.query.limit === undefined ? 20 : Number(req.query.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    return res.status(400).json({ success: false, error: { code: 'INVALID_REQUEST', message: 'limit must be 1-50.' } });
  }
  try {
    const data = await getStampHistory(pool, req.user!.id, { cursor, limit });
    return res.json({ success: true, data });
  } catch (error) {
    return fail(res, error);
  }
});

const spendSchema = z.object({ item: z.enum(['streak_shield']) }).strict();

stampsRouter.post('/me/stamps/spend', authenticateToken, spendLimiter, async (req: AuthRequest, res: Response) => {
  const pool = getPool();
  if (!pool) return fail(res, new Error('STORAGE_UNAVAILABLE'));
  const parsed = spendSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ success: false, error: { code: 'INVALID_REQUEST', message: 'Provide item: streak_shield.' } });
  }
  const key = idempotencyKey(req);
  if (!key || key.length < 8 || key.length > 100) {
    return res.status(400).json({ success: false, error: { code: 'INVALID_REQUEST', message: 'A valid Idempotency-Key (8-100 characters) is required.' } });
  }
  try {
    const data = await spendStamps(pool, req.user!.id, parsed.data.item, key);
    return res.status(201).json({ success: true, data });
  } catch (error) {
    return fail(res, error);
  }
});

stampsRouter.get('/qotd', optionalAuthenticateToken, async (req: AuthRequest, res: Response) => {
  const pool = getPool();
  if (!pool) return fail(res, new Error('STORAGE_UNAVAILABLE'));
  try {
    const data = await getQuestionOfTheDay(pool, req.user?.id ?? null);
    return res.json({ success: true, data });
  } catch (error) {
    return fail(res, error);
  }
});

const answerSchema = z.object({ option_id: z.string().min(1).max(120) }).strict();

stampsRouter.post('/qotd/answer', authenticateToken, qotdLimiter, async (req: AuthRequest, res: Response) => {
  const pool = getPool();
  if (!pool) return fail(res, new Error('STORAGE_UNAVAILABLE'));
  const parsed = answerSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ success: false, error: { code: 'INVALID_REQUEST', message: 'Provide option_id.' } });
  }
  try {
    const data = await answerQuestionOfTheDay(pool, req.user!.id, parsed.data.option_id);
    await handleQotdAnswered(pool, { userId: req.user!.id, date: manilaDateString() });
    return res.status(201).json({ success: true, data });
  } catch (error) {
    return fail(res, error);
  }
});

stampsRouter.get('/admin/stamps/missions', authenticateToken, requireAdmin, async (_req: AuthRequest, res: Response) => {
  const pool = getPool();
  if (!pool) return fail(res, new Error('STORAGE_UNAVAILABLE'));
  try {
    return res.json({ success: true, data: await listDailyMissions(pool) });
  } catch (error) {
    return fail(res, error);
  }
});

const missionSchema = z.object({
  id: z.string().min(3).max(80).regex(/^[a-z0-9-]+$/).optional(),
  kind: z.string().min(2).max(50).regex(/^[a-z0-9_]+$/),
  title: z.string().min(3).max(120),
  stamps: z.number().int().min(1).max(100),
  on_site: z.boolean(),
  active: z.boolean().optional(),
}).strict();

stampsRouter.post('/admin/stamps/missions', authenticateToken, requireAdmin, async (req: AuthRequest, res: Response) => {
  const pool = getPool();
  if (!pool) return fail(res, new Error('STORAGE_UNAVAILABLE'));
  const parsed = missionSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ success: false, error: { code: 'INVALID_REQUEST', message: 'Invalid mission payload.' } });
  }
  try {
    return res.status(201).json({ success: true, data: await upsertDailyMission(pool, parsed.data) });
  } catch (error) {
    return fail(res, error);
  }
});

const missionPatchSchema = z.object({ active: z.boolean() }).strict();

stampsRouter.patch('/admin/stamps/missions/:id', authenticateToken, requireAdmin, async (req: AuthRequest, res: Response) => {
  const pool = getPool();
  if (!pool) return fail(res, new Error('STORAGE_UNAVAILABLE'));
  const parsed = missionPatchSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ success: false, error: { code: 'INVALID_REQUEST', message: 'Provide active: true|false.' } });
  }
  try {
    await setDailyMissionActive(pool, req.params.id, parsed.data.active);
    return res.json({ success: true, data: { id: req.params.id, active: parsed.data.active } });
  } catch (error) {
    return fail(res, error);
  }
});

stampsRouter.get('/admin/stamps/qotd/candidates', authenticateToken, requireAdmin, async (req: AuthRequest, res: Response) => {
  const pool = getPool();
  if (!pool) return fail(res, new Error('STORAGE_UNAVAILABLE'));
  const limit = req.query.limit === undefined ? 50 : Number(req.query.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    return res.status(400).json({ success: false, error: { code: 'INVALID_REQUEST', message: 'limit must be 1-100.' } });
  }
  try {
    return res.json({ success: true, data: await listQotdCandidates(pool, limit) });
  } catch (error) {
    return fail(res, error);
  }
});

const scheduleSchema = z.object({
  manila_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  question_id: z.string().min(1).max(120),
}).strict();

stampsRouter.put('/admin/stamps/qotd', authenticateToken, requireAdmin, async (req: AuthRequest, res: Response) => {
  const pool = getPool();
  if (!pool) return fail(res, new Error('STORAGE_UNAVAILABLE'));
  const parsed = scheduleSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ success: false, error: { code: 'INVALID_REQUEST', message: 'Provide manila_date (YYYY-MM-DD) and question_id.' } });
  }
  try {
    await scheduleQuestionOfTheDay(pool, parsed.data.manila_date, parsed.data.question_id);
    return res.json({ success: true, data: parsed.data });
  } catch (error) {
    return fail(res, error);
  }
});

stampsRouter.get('/admin/stamps/stats', authenticateToken, requireAdmin, async (_req: AuthRequest, res: Response) => {
  const pool = getPool();
  if (!pool) return fail(res, new Error('STORAGE_UNAVAILABLE'));
  try {
    return res.json({ success: true, data: await stampAdminStats(pool) });
  } catch (error) {
    return fail(res, error);
  }
});
