import { randomUUID } from 'crypto';
import { Router, Response } from 'express';
import { z } from 'zod';
import { getPool } from '../db/pool.js';
import { authenticateToken, requireAdmin, AuthRequest } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { EconomyError, EconomyService, SIM_ASSET } from '../economy/service.js';
import { reconcileEconomy } from '../economy/reconcile.js';
import { submissionsService } from '../services/submissions.js';
import { isLocalEconomyProfile } from '../economy/profile.js';

export const economyAdminRouter = Router();

const amount = z.string().regex(/^[1-9][0-9]{0,18}$/);
const poolSchema = z.object({
  quest_id: z.string().min(1),
  scope_id: z.string().min(1).optional(),
  policy_id: z.string().min(1).optional(),
  scope_key: z.string().min(3).max(200),
  policy_version: z.string().min(1).max(100),
  reward_minor: amount,
  allocation_minor: amount,
  reservation_seconds: z.number().int().min(300).max(604800),
  appeal_seconds: z.number().int().min(0).max(2592000),
}).strict();

function pilotPool(res: Response) {
  if (!isLocalEconomyProfile()) {
    res.status(404).json({ success: false, error: { code: 'NOT_AVAILABLE', message: 'Economy pilot is unavailable.' } });
    return null;
  }
  const pool = getPool();
  if (!pool) {
    res.status(503).json({ success: false, error: { code: 'DATABASE_REQUIRED', message: 'Durable database required.' } });
    return null;
  }
  return pool;
}

economyAdminRouter.post('/admin/economy/pools', authenticateToken, requireAdmin, async (req: AuthRequest, res: Response) => {
  const pool = pilotPool(res);
  if (!pool) return;
  const parsed = poolSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ success: false, error: { code: 'INVALID_POOL', message: 'Invalid pool policy or amount.' } });
  const id = randomUUID();
  try {
    await new EconomyService(pool).createPilotPool({
      id, questId: parsed.data.quest_id, scopeKey: parsed.data.scope_key,
      scopeId: parsed.data.scope_id, policyId: parsed.data.policy_id,
      policyVersion: parsed.data.policy_version, rewardMinor: BigInt(parsed.data.reward_minor),
      allocationMinor: BigInt(parsed.data.allocation_minor),
      reservationSeconds: parsed.data.reservation_seconds, appealSeconds: parsed.data.appeal_seconds,
      adminId: req.user!.id,
    });
    return res.status(201).json({ success: true, data: { id, asset: SIM_ASSET, status: 'draft' } });
  } catch (error) {
    if (error instanceof EconomyError) {
      const status = ['INVALID_AMOUNT', 'INVALID_POOL_POLICY'].includes(error.code) ? 400 : 409;
      return res.status(status).json({ success: false, error: { code: error.code, message: error.message } });
    }
    return res.status(503).json({ success: false, error: { code: 'ECONOMY_UNAVAILABLE', message: 'Pool could not be created.' } });
  }
});

economyAdminRouter.post('/admin/economy/pools/:id/activate', authenticateToken, requireAdmin, async (req: AuthRequest, res: Response) => {
  const pool = pilotPool(res);
  if (!pool) return;
  try {
    await new EconomyService(pool).activatePilotPool(req.params.id, req.user!.id);
    return res.status(200).json({ success: true, data: { id: req.params.id, status: 'active' } });
  } catch (error) {
    if (error instanceof EconomyError) return res.status(409).json({ success: false, error: { code: error.code, message: error.message } });
    return res.status(503).json({ success: false, error: { code: 'ECONOMY_UNAVAILABLE', message: 'Pool could not be activated.' } });
  }
});

economyAdminRouter.post('/admin/economy/cosmetics', authenticateToken, requireAdmin, async (req: AuthRequest, res: Response) => {
  const pool = pilotPool(res);
  if (!pool) return;
  const parsed = z.object({ id: z.string().min(1).max(100), cost_minor: amount }).strict().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ success: false, error: { code: 'INVALID_COSMETIC', message: 'Invalid cosmetic or cost.' } });
  try {
    await pool.query(
      `INSERT INTO economic_cosmetics(id, asset_code, cost_minor, active)
       VALUES ($1, $2, ($3)::bigint, true)`,
      [parsed.data.id, SIM_ASSET, parsed.data.cost_minor]
    );
    return res.status(201).json({ success: true, data: { id: parsed.data.id, cost_minor: parsed.data.cost_minor, asset: SIM_ASSET } });
  } catch {
    return res.status(409).json({ success: false, error: { code: 'COSMETIC_CONFLICT', message: 'Cosmetic could not be created.' } });
  }
});

economyAdminRouter.get('/admin/economy/reconciliation', authenticateToken, requireAdmin, async (_req: AuthRequest, res: Response) => {
  const pool = pilotPool(res);
  if (!pool) return;
  try {
    const report = await reconcileEconomy(pool);
    res.setHeader('Cache-Control', 'private, no-store');
    return res.status(200).json({ success: true, data: report });
  } catch {
    return res.status(503).json({ success: false, error: { code: 'AUDIT_UNAVAILABLE', message: 'Reconciliation could not be completed.' } });
  }
});

economyAdminRouter.post('/economy/reservations/:id/appeal', authenticateToken,
  rateLimit({ policyId: 'economy:appeal', windowMs: 60_000, max: 10, keyStrategy: 'actor' }),
  async (req: AuthRequest, res: Response) => {
    const pool = pilotPool(res);
    if (!pool) return;
    const parsed = z.object({ reason: z.string().trim().min(10).max(2000) }).strict().safeParse(req.body);
    if (!parsed.success) return res.status(400).json({
      success: false, error: { code: 'INVALID_APPEAL_REASON', message: 'Explain why this proof should be reviewed again.' },
    });
    try {
      const receipt = await new EconomyService(pool).submitAppeal(req.params.id, req.user!.id, parsed.data.reason);
      res.setHeader('Cache-Control', 'private, no-store');
      return res.status(200).json({ success: true, data: receipt });
    } catch (error) {
      if (error instanceof EconomyError) {
        const status = error.code === 'RESERVATION_NOT_FOUND' ? 404 : 409;
        return res.status(status).json({ success: false, error: { code: error.code, message: error.message } });
      }
      return res.status(503).json({ success: false, error: { code: 'ECONOMY_UNAVAILABLE', message: 'Appeal unavailable.' } });
    }
  });

const appealDecisionSchema = z.object({ reason: z.string().trim().min(10).max(2000) }).strict();

economyAdminRouter.post('/admin/economy/appeals/:id/approve', authenticateToken, requireAdmin,
  async (req: AuthRequest, res: Response) => {
    const pool = pilotPool(res);
    if (!pool) return;
    const parsed = appealDecisionSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({
      success: false, error: { code: 'INVALID_APPEAL_DECISION', message: 'A decision reason is required.' },
    });
    try {
      const appeal = await pool.query('SELECT submission_id FROM reward_appeals WHERE id = $1', [req.params.id]);
      if (!appeal.rows[0]) return res.status(404).json({
        success: false, error: { code: 'APPEAL_NOT_FOUND', message: 'Appeal not found.' },
      });
      const result = await submissionsService.reviewSubmission(
        appeal.rows[0].submission_id, 'approve', req.user!.id, undefined,
        { appealId: req.params.id, reason: parsed.data.reason }
      );
      res.setHeader('Cache-Control', 'private, no-store');
      return res.status(result.statusCode ?? (result.success ? 200 : 409)).json(result.success
        ? { success: true, data: result.data }
        : { success: false, error: result.error });
    } catch {
      return res.status(503).json({ success: false,
        error: { code: 'APPEAL_REVIEW_UNAVAILABLE', message: 'Appeal review could not be committed.' } });
    }
  });

economyAdminRouter.post('/admin/economy/appeals/:id/reject', authenticateToken, requireAdmin,
  async (req: AuthRequest, res: Response) => {
    const pool = pilotPool(res);
    if (!pool) return;
    const parsed = appealDecisionSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({
      success: false, error: { code: 'INVALID_APPEAL_DECISION', message: 'A decision reason is required.' },
    });
    try {
      const receipt = await new EconomyService(pool).denyAppeal(req.params.id, req.user!.id, parsed.data.reason);
      res.setHeader('Cache-Control', 'private, no-store');
      return res.status(200).json({ success: true, data: receipt });
    } catch (error) {
      if (error instanceof EconomyError) return res.status(error.code === 'APPEAL_NOT_FOUND' ? 404 : 409).json({
        success: false, error: { code: error.code, message: error.message },
      });
      return res.status(503).json({ success: false,
        error: { code: 'APPEAL_REVIEW_UNAVAILABLE', message: 'Appeal review could not be committed.' } });
    }
  });

economyAdminRouter.post('/admin/economy/refunds', authenticateToken, requireAdmin,
  async (req: AuthRequest, res: Response) => {
    const pool = pilotPool(res);
    if (!pool) return;
    const parsed = z.object({ original_transaction_id: z.string().min(1),
      reason: z.string().trim().min(10).max(2000) }).strict().safeParse(req.body);
    const idempotencyKey = req.get('x-idempotency-key');
    if (!parsed.success || !idempotencyKey || idempotencyKey.length > 120) {
      return res.status(400).json({ success: false,
        error: { code: 'INVALID_SIMULATED_REFUND', message: 'A spend transaction, reason and idempotency key are required.' } });
    }
    try {
      const receipt = await new EconomyService(pool).refundSimulatedCosmetic(
        parsed.data.original_transaction_id, req.user!.id, parsed.data.reason, idempotencyKey
      );
      res.setHeader('Cache-Control', 'private, no-store');
      return res.status(200).json({ success: true, data: receipt });
    } catch (error) {
      if (error instanceof EconomyError) return res.status(409).json({ success: false,
        error: { code: error.code, message: error.message } });
      return res.status(503).json({ success: false,
        error: { code: 'REFUND_UNAVAILABLE', message: 'Simulated correction could not be committed.' } });
    }
  });

economyAdminRouter.get('/economy/cosmetics', authenticateToken, async (_req: AuthRequest, res: Response) => {
  const pool = pilotPool(res);
  if (!pool) return;
  try {
    const result = await pool.query(
      `SELECT id, cost_minor, asset_code FROM economic_cosmetics
       WHERE asset_code = $1 AND active = true ORDER BY id LIMIT 100`, [SIM_ASSET]
    );
    return res.status(200).json({ success: true, data: result.rows.map((row) => ({
      id: row.id, cost_minor: String(row.cost_minor), asset: row.asset_code,
    })) });
  } catch {
    return res.status(503).json({ success: false, error: { code: 'ECONOMY_UNAVAILABLE', message: 'Catalog unavailable.' } });
  }
});

economyAdminRouter.get('/economy/quests/:id/reward', async (req, res: Response) => {
  const pool = pilotPool(res);
  if (!pool) return;
  try {
    const result = await pool.query(
      `SELECT id, reward_minor, available_minor, policy_version, reservation_seconds
       FROM reward_pools WHERE quest_id = $1 AND asset_code = $2 AND status = 'active'`,
      [req.params.id, SIM_ASSET]
    );
    const row = result.rows[0];
    return res.status(200).json({ success: true, data: row ? {
      pool_id: row.id, asset: SIM_ASSET, reward_minor: String(row.reward_minor),
      funded_slots_available: BigInt(String(row.available_minor)) >= BigInt(String(row.reward_minor)),
      policy_version: row.policy_version, reservation_seconds: row.reservation_seconds,
    } : null });
  } catch {
    return res.status(503).json({ success: false, error: { code: 'ECONOMY_UNAVAILABLE', message: 'Reward terms unavailable.' } });
  }
});
