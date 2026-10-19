import { Router, type Response } from 'express';
import { z } from 'zod';
import { authenticateToken, requireAdmin, type AuthRequest } from '../middleware/auth.js';
import { getPool } from '../db/pool.js';
import { refreshTravelTimeMatrix, readTravelTimeMatrixStatus } from '../trails/matrix.js';
import { generateTrail, TrailGenerationError } from '../trails/generate.js';
import type { TrailCosting } from '../trails/types.js';

export const trailsRouter = Router();
// Every endpoint in this router is operational/admin-only, including reads.
trailsRouter.use('/admin/trails', authenticateToken, requireAdmin);

trailsRouter.get('/admin/trails/matrix/status', async (_req: AuthRequest, res: Response) => {
  const pool = getPool();
  if (!pool) return res.status(503).json({ success: false, error: { code: 'DATABASE_UNAVAILABLE', message: 'Trail storage is unavailable.' } });
  try { return res.json({ success: true, data: await readTravelTimeMatrixStatus(pool) }); }
  catch { return res.status(503).json({ success: false, error: { code: 'MATRIX_UNAVAILABLE', message: 'Travel matrix status is unavailable.' } }); }
});

trailsRouter.post('/admin/trails/matrix/refresh', async (req: AuthRequest, res: Response) => {
  const costing = String(req.body?.costing ?? 'auto');
  if (!['auto','pedestrian','bicycle','motorcycle'].includes(costing)) return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Unsupported routing costing.' } });
  const pool = getPool();
  if (!pool) return res.status(503).json({ success: false, error: { code: 'DATABASE_UNAVAILABLE', message: 'Trail storage is unavailable.' } });
  try { return res.json({ success: true, data: await refreshTravelTimeMatrix(pool, costing as TrailCosting) }); }
  catch { return res.status(503).json({ success: false, error: { code: 'MATRIX_REFRESH_FAILED', message: 'Travel matrix refresh did not complete.' } }); }
});

trailsRouter.get('/admin/trails', async (req: AuthRequest, res: Response) => {
  const pool = getPool();
  if (!pool) return res.status(503).json({ success: false, error: { code: 'DATABASE_UNAVAILABLE', message: 'Trail storage is unavailable.' } });
  const status = typeof req.query.status === 'string' ? req.query.status : undefined;
  try {
    const { rows } = await pool.query(`SELECT t.*, g.solver_ms, g.objective, g.solver FROM trails t LEFT JOIN trail_generations g ON g.id=t.generation_id
      WHERE ($1::text IS NULL OR t.status=$1) AND t.source='engine' ORDER BY t.created_at DESC LIMIT 100`, [status ?? null]);
    return res.json({ success: true, data: rows });
  } catch { return res.status(503).json({ success: false, error: { code: 'TRAILS_UNAVAILABLE', message: 'Trails are unavailable.' } }); }
});

const generationSchema = z.object({
  theme: z.string().trim().min(1).max(80).optional(), tier: z.enum(['starter','explorer','signature','legendary']).optional(),
  budgetMin: z.number().int().min(60).max(600).optional(), seed: z.number().int().optional(),
  minStops: z.number().int().min(2).max(12).optional(), maxStops: z.number().int().min(2).max(12).optional(),
  maxLegMin: z.number().int().min(15).max(180).optional(), maxPerCategory: z.number().int().min(1).max(12).optional(),
  mustInclude: z.array(z.string().max(120)).max(12).optional(), exclude: z.array(z.string().max(120)).max(100).optional(),
  startNode: z.string().max(120).optional(), costing: z.enum(['auto','pedestrian','bicycle','motorcycle']).optional(),
  constraints: z.object({ themes: z.array(z.string().max(80)).optional(), goodFor: z.array(z.string().max(80)).optional() }).optional(),
}).refine(v => !v.minStops || !v.maxStops || v.minStops <= v.maxStops, { message: 'minStops must not exceed maxStops.' });

trailsRouter.post('/admin/trails/generate', async (req: AuthRequest, res: Response) => {
  const parsed = generationSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.issues[0]?.message ?? 'Invalid trail generation request.' } });
  const pool = getPool();
  if (!pool) return res.status(503).json({ success: false, error: { code: 'DATABASE_UNAVAILABLE', message: 'Trail storage is unavailable.' } });
  try {
    const result = await generateTrail(pool, { ...parsed.data, kind: 'admin', requestedBy: req.user!.id });
    return res.status(201).json({ success: true, data: result });
  } catch (error) {
    if (error instanceof TrailGenerationError) return res.status(422).json({ success: false, error: { code: error.code, message: error.message } });
    return res.status(503).json({ success: false, error: { code: 'GENERATION_FAILED', message: 'Trail generation failed; no partial trail was saved.' } });
  }
});

trailsRouter.post('/admin/trails/:id/review', async (req: AuthRequest, res: Response) => {
  const decision = req.body?.decision;
  if (decision !== 'submit') return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: "Review decision must be 'submit'." } });
  return updateTrailStatus(req.params.id, 'pending_review', req.user!.id, res);
});
trailsRouter.post('/admin/trails/:id/publish', async (req: AuthRequest, res: Response) => updateTrailStatus(req.params.id, 'published', req.user!.id, res, true));
trailsRouter.post('/admin/trails/:id/reject', async (req: AuthRequest, res: Response) => updateTrailStatus(req.params.id, 'rejected', req.user!.id, res));
trailsRouter.post('/admin/trails/:id/retire', async (req: AuthRequest, res: Response) => updateTrailStatus(req.params.id, 'retired', req.user!.id, res));

async function updateTrailStatus(id: string, status: string, adminId: string, res: Response, publish = false) {
  const pool = getPool();
  if (!pool) return res.status(503).json({ success: false, error: { code: 'DATABASE_UNAVAILABLE', message: 'Trail storage is unavailable.' } });
  try {
    const result = await pool.query(`UPDATE trails SET status=$1, reviewed_by=$2, published_at=CASE WHEN $3 THEN clock_timestamp() ELSE published_at END
      WHERE id=$4 AND source='engine' AND ($1 <> 'published' OR status='pending_review') RETURNING *`, [status, adminId, publish, id]);
    if (!result.rowCount) return res.status(404).json({ success: false, error: { code: 'TRAIL_NOT_REVIEWABLE', message: 'Engine trail was not found or is not ready for this action.' } });
    return res.json({ success: true, data: result.rows[0] });
  } catch { return res.status(503).json({ success: false, error: { code: 'TRAIL_UPDATE_FAILED', message: 'Trail status could not be updated.' } }); }
}
