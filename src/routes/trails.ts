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

trailsRouter.get('/admin/trails/review', async (_req: AuthRequest, res: Response) => {
  const pool = getPool();
  if (!pool) return res.status(503).json({ success: false, error: { code: 'DATABASE_UNAVAILABLE', message: 'Trail storage is unavailable.' } });
  try {
    const { rows } = await pool.query(`SELECT t.*, g.solver_ms, g.objective, g.solver, g.ai_model, g.ai_used, g.ai_fallback_reason
      FROM trails t LEFT JOIN trail_generations g ON g.id=t.generation_id
      WHERE t.source='engine' AND t.status='pending_review' ORDER BY t.created_at ASC LIMIT 100`);
    return res.json({ success: true, data: rows });
  } catch { return res.status(503).json({ success: false, error: { code: 'TRAIL_REVIEW_UNAVAILABLE', message: 'Trail review queue is unavailable.' } }); }
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

const trailPatchSchema = z.object({
  title: z.string().trim().min(3).max(80).optional(),
  tagline: z.string().trim().max(160).optional(),
  tier: z.enum(['starter','explorer','signature','legendary']).optional(),
  price_points: z.number().int().min(1).max(100_000).optional(),
  available_from: z.string().datetime({ offset: true }).nullable().optional(),
  available_until: z.string().datetime({ offset: true }).nullable().optional(),
  narration: z.array(z.object({ position: z.number().int().min(1).max(12), text: z.string().trim().max(400) }).strict()).min(1).max(12).optional(),
}).strict().refine(value => Object.keys(value).length > 0, { message: 'Provide at least one editable trail field.' });

trailsRouter.patch('/admin/trails/:id', async (req: AuthRequest, res: Response) => {
  const parsed = trailPatchSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.issues[0]?.message ?? 'Invalid trail update.' } });
  const pool = getPool();
  if (!pool) return res.status(503).json({ success: false, error: { code: 'DATABASE_UNAVAILABLE', message: 'Trail storage is unavailable.' } });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const selected = await client.query('SELECT * FROM trails WHERE id=$1 AND source=\'engine\' FOR UPDATE', [req.params.id]);
    const trail = selected.rows[0];
    if (!trail) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, error: { code: 'TRAIL_NOT_FOUND', message: 'Editable engine trail was not found.' } });
    }

    const body = parsed.data;
    const currentFrom = trail.available_from ? new Date(trail.available_from) : null;
    const currentUntil = trail.available_until ? new Date(trail.available_until) : null;
    const nextFrom = body.available_from === undefined ? currentFrom : body.available_from === null ? null : new Date(body.available_from);
    const nextUntil = body.available_until === undefined ? currentUntil : body.available_until === null ? null : new Date(body.available_until);
    if (nextFrom && nextUntil && nextFrom.getTime() >= nextUntil.getTime()) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, error: { code: 'INVALID_AVAILABILITY', message: 'available_from must be earlier than available_until.' } });
    }

    const tier = body.tier ?? trail.tier;
    const oldRule = typeof trail.unlock_rule === 'string' ? JSON.parse(trail.unlock_rule) : trail.unlock_rule ?? {};
    let unlockRule = oldRule;
    if (body.price_points !== undefined && !['signature', 'legendary'].includes(tier)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, error: { code: 'PRICE_NOT_ALLOWED', message: 'Only Signature and Legendary trails have a points price.' } });
    }
    if (body.tier !== undefined || body.price_points !== undefined) {
      if (tier === 'starter') unlockRule = { type: 'free' };
      else if (tier === 'explorer') unlockRule = { type: 'level', min_level: 5 };
      else {
        const changedTier = body.tier !== undefined && body.tier !== trail.tier;
        const existingPrice = changedTier ? undefined : oldRule.price_points;
        unlockRule = { type: 'points', price_points: body.price_points ?? existingPrice ?? (tier === 'legendary' ? 500 : 300) };
      }
    }

    const story = typeof trail.story === 'string' ? JSON.parse(trail.story) : { ...(trail.story ?? {}) };
    if (body.title !== undefined) story.title = body.title;
    if (body.tagline !== undefined) story.tagline = body.tagline;
    const updates: string[] = ['version=version+1'];
    const values: unknown[] = [];
    const add = (column: string, value: unknown) => { values.push(value); updates.push(`${column}=$${values.length}`); };
    if (body.title !== undefined) add('title', body.title);
    if (body.tagline !== undefined) add('tagline', body.tagline);
    if (body.tier !== undefined) add('tier', tier);
    if (body.tier !== undefined || body.price_points !== undefined) add('unlock_rule', JSON.stringify(unlockRule));
    if (body.available_from !== undefined) add('available_from', nextFrom);
    if (body.available_until !== undefined) add('available_until', nextUntil);
    add('story', JSON.stringify(story));
    values.push(req.params.id);
    const updated = await client.query(`UPDATE trails SET ${updates.join(',')} WHERE id=$${values.length} RETURNING *`, values);

    if (body.narration) {
      const positions = body.narration.map(item => item.position);
      if (new Set(positions).size !== positions.length) {
        await client.query('ROLLBACK');
        return res.status(400).json({ success: false, error: { code: 'DUPLICATE_STOP_POSITION', message: 'Each stop position may be edited once per request.' } });
      }
      const existingStops = await client.query('SELECT position,spot_id FROM trail_stops WHERE trail_id=$1', [req.params.id]);
      const stopsByPosition = new Map(existingStops.rows.map(row => [Number(row.position), String(row.spot_id)]));
      const storyStops = Array.isArray(story.stops) ? story.stops : [];
      for (const item of body.narration) {
        const spotId = stopsByPosition.get(item.position);
        if (!spotId) {
          await client.query('ROLLBACK');
          return res.status(400).json({ success: false, error: { code: 'STOP_NOT_FOUND', message: `Stop position ${item.position} does not exist.` } });
        }
        await client.query('UPDATE trail_stops SET narration=$1 WHERE trail_id=$2 AND position=$3', [item.text, req.params.id, item.position]);
        const storyStop = storyStops.find((stop: any) => stop.spot_id === spotId);
        if (storyStop) storyStop.narration = item.text;
      }
      await client.query('UPDATE trails SET story=$1::jsonb WHERE id=$2', [JSON.stringify(story), req.params.id]);
    }

    const stops = await client.query('SELECT position,spot_id,arrive_offset_min,dwell_min,leg_minutes,leg_km,narration FROM trail_stops WHERE trail_id=$1 ORDER BY position', [req.params.id]);
    await client.query('COMMIT');
    return res.json({ success: true, data: { ...updated.rows[0], stops: stops.rows } });
  } catch {
    await client.query('ROLLBACK').catch(() => {});
    return res.status(503).json({ success: false, error: { code: 'TRAIL_UPDATE_FAILED', message: 'Trail update failed; no partial change was saved.' } });
  } finally { client.release(); }
});

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
