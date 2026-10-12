import { Router, Request, Response, NextFunction } from 'express';
import { authenticateToken, requireAdmin, AuthRequest } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { getPool, getEconomyBenchmarkTelemetry } from '../db/pool.js';
import { EconomyReadError, EconomyReadModel } from '../economy/readModel.js';
import { isLocalEconomyProfile } from '../economy/profile.js';

export const economyReadsRouter = Router();

// The profile check precedes authentication and every database query. A normal
// release must not disclose whether this internal simulation API exists.
economyReadsRouter.use('/economy', (req, res, next) => {
  if (!isLocalEconomyProfile()) {
    return res.status(404).json({ success: false, error: { code: 'NOT_AVAILABLE', message: 'Not found.' } });
  }
  res.setHeader('Cache-Control', 'private, no-store');
  next();
});
economyReadsRouter.use('/admin/economy', (req, res, next) => {
  if (!isLocalEconomyProfile()) {
    return res.status(404).json({ success: false, error: { code: 'NOT_AVAILABLE', message: 'Not found.' } });
  }
  res.setHeader('Cache-Control', 'private, no-store');
  next();
});

async function requireDurableEconomyActor(req: AuthRequest, res: Response, next: NextFunction) {
  const pool = getPool();
  if (!pool) return res.status(503).json({ success: false, error: { code: 'DATABASE_REQUIRED', message: 'Durable database required.' } });
  try {
    const actor = await pool.query('SELECT id FROM users WHERE id = $1', [req.user!.id]);
    if (!actor.rows.length) return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Account is no longer available.' } });
    next();
  } catch { return res.status(503).json({ success: false, error: { code: 'DATABASE_OUTAGE', message: 'Account temporarily unavailable.' } }); }
}

const travelerRead = [authenticateToken, requireDurableEconomyActor,
  rateLimit({ policyId: 'economy:read', windowMs: 60_000, max: 120, keyStrategy: 'actor' })];
const adminRead = [authenticateToken, requireAdmin,
  rateLimit({ policyId: 'economy:admin-read', windowMs: 60_000, max: 120, keyStrategy: 'actor' })];

function model(res: Response): EconomyReadModel | null {
  const pool = getPool();
  if (!pool) {
    res.status(503).json({ success: false, error: { code: 'DATABASE_REQUIRED', message: 'Durable database required.' } });
    return null;
  }
  return new EconomyReadModel(pool);
}

async function respond(res: Response, read: EconomyReadModel, action: () => Promise<unknown>) {
  try {
    await read.capabilities();
    return res.json({ success: true, data: await action() });
  }
  catch (error) {
    if (error instanceof EconomyReadError) {
      return res.status(400).json({ success: false, error: { code: error.code, message: 'Invalid pagination parameters.' } });
    }
    return res.status(503).json({ success: false, error: {
      code: 'ECONOMY_READ_UNAVAILABLE', message: 'Simulation data temporarily unavailable.',
    } });
  }
}

economyReadsRouter.get('/economy/capabilities', travelerRead, async (_req: Request, res: Response) => {
  const read = model(res); if (!read) return;
  return respond(res, read, () => read.capabilities());
});
economyReadsRouter.get('/economy/me', travelerRead, async (req: AuthRequest, res: Response) => {
  const read = model(res); if (!read) return;
  return respond(res, read, () => read.me(req.user!.id));
});
economyReadsRouter.get('/economy/me/activity', travelerRead, async (req: AuthRequest, res: Response) => {
  const read = model(res); if (!read) return;
  return respond(res, read, () => read.activity(req.user!.id, req.query.limit, req.query.cursor));
});
economyReadsRouter.get('/economy/me/reservations', travelerRead, async (req: AuthRequest, res: Response) => {
  const read = model(res); if (!read) return;
  return respond(res, read, () => read.reservations(req.user!.id, req.query.limit, req.query.cursor));
});
economyReadsRouter.get('/economy/reservations/:id', travelerRead, async (req: AuthRequest, res: Response) => {
  const read = model(res); if (!read) return;
  try {
    await read.capabilities();
    const item = await read.reservation(req.user!.id, req.params.id);
    if (!item) return res.status(404).json({ success: false, error: { code: 'RESERVATION_NOT_FOUND', message: 'Reservation not found.' } });
    return res.json({ success: true, data: item });
  } catch { return res.status(503).json({ success: false, error: { code: 'ECONOMY_READ_UNAVAILABLE', message: 'Simulation data temporarily unavailable.' } }); }
});
economyReadsRouter.get('/economy/me/entitlements', travelerRead, async (req: AuthRequest, res: Response) => {
  const read = model(res); if (!read) return;
  return respond(res, read, () => read.entitlements(req.user!.id, req.query.limit, req.query.cursor));
});
economyReadsRouter.get('/admin/economy/pools/:id/summary', adminRead, async (req: Request, res: Response) => {
  const read = model(res); if (!read) return;
  try {
    await read.capabilities();
    const item = await read.poolSummary(req.params.id);
    if (!item) return res.status(404).json({ success: false, error: { code: 'POOL_NOT_FOUND', message: 'Pool not found.' } });
    return res.json({ success: true, data: item });
  } catch { return res.status(503).json({ success: false, error: { code: 'ECONOMY_READ_UNAVAILABLE', message: 'Simulation data temporarily unavailable.' } }); }
});
economyReadsRouter.get('/admin/economy/queue', adminRead, async (_req: Request, res: Response) => {
  const read = model(res); if (!read) return;
  return respond(res, read, () => read.queue());
});

economyReadsRouter.get('/admin/economy/appeals', adminRead, async (_req: Request, res: Response) => {
  const read = model(res); if (!read) return;
  return respond(res, read, () => read.pendingAppeals());
});

economyReadsRouter.get('/admin/economy/cosmetic-purchases', adminRead, async (_req: Request, res: Response) => {
  const read = model(res); if (!read) return;
  return respond(res, read, () => read.recentCosmeticPurchases());
});

// Exists only in an explicitly marked, disposable local benchmark process.
economyReadsRouter.get('/admin/economy/telemetry', adminRead, (_req: Request, res: Response) => {
  const snapshot = getEconomyBenchmarkTelemetry();
  if (!snapshot) return res.status(404).json({ success: false, error: { code: 'NOT_AVAILABLE', message: 'Not found.' } });
  return res.json({ success: true, data: snapshot });
});
