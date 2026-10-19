import { Router, type Response } from 'express';
import { z } from 'zod';
import { authenticateToken, requireAdmin, type AuthRequest } from '../middleware/auth.js';
import { getPool } from '../db/pool.js';
import { refreshTravelTimeMatrix, readTravelTimeMatrixStatus } from '../trails/matrix.js';
import { generateTrail, TrailGenerationError, windowsFromBestTime } from '../trails/generate.js';
import { computeSpotSignals, loadTrailSignalInputs } from '../trails/signals.js';
import { loadTravelTimeLookup } from '../trails/matrix.js';
import { solveLocal } from '../trails/solver/local.js';
import { createCuoptSolver, cuoptEnabledWithKey, CuoptError } from '../trails/solver/cuopt.js';
import { randomUUID } from 'node:crypto';
import type { TrailCosting, TrailProblem } from '../trails/types.js';

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

const compareSolversSchema = z.object({
  spot_ids: z.array(z.string().min(1).max(120)).min(3).max(60),
  budget_min: z.number().int().min(60).max(600),
  min_stops: z.number().int().min(2).max(12).default(3),
  max_stops: z.number().int().min(2).max(12).default(6),
  max_leg_min: z.number().int().min(15).max(180).default(60),
  max_per_category: z.number().int().min(1).max(12).default(2),
  must_include: z.array(z.string().max(120)).max(12).default([]),
  exclude: z.array(z.string().max(120)).max(60).default([]),
  start_node: z.string().max(120).optional(),
  seed: z.number().int().default(44),
  costing: z.enum(['auto','pedestrian','bicycle','motorcycle']).default('auto'),
  with_windows: z.boolean().default(true),
}).strict().refine(body => body.min_stops <= body.max_stops, { message: 'min_stops must not exceed max_stops.' })
  .refine(body => new Set(body.spot_ids).size === body.spot_ids.length, { message: 'spot_ids must be unique.' });

// cuOpt is deliberately isolated to this administrator-only benchmark path.
// Traveler generation always remains on the deterministic local solver.
trailsRouter.post('/admin/trails/compare-solvers', async (req: AuthRequest, res: Response) => {
  const parsed = compareSolversSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.issues[0]?.message ?? 'Invalid solver comparison request.' } });
  if (!await cuoptEnabledWithKey()) return res.status(503).json({ success: false, error: { code: 'CUOPT_DISABLED', message: 'cuOpt comparison requires explicit local enablement and the private owner key file.' } });
  const pool = getPool();
  if (!pool) return res.status(503).json({ success: false, error: { code: 'DATABASE_UNAVAILABLE', message: 'Trail storage is unavailable.' } });
  try {
    const allSpots = await loadTrailSignalInputs(pool);
    const byId = new Map(allSpots.map(spot => [spot.spotId, spot]));
    const selected = parsed.data.spot_ids.map(id => byId.get(id));
    if (selected.some(spot => !spot)) return res.status(400).json({ success: false, error: { code: 'SPOT_SET_INVALID', message: 'Every spot must be published, public, and non-test.' } });
    if (parsed.data.start_node && !byId.has(parsed.data.start_node)) return res.status(400).json({ success: false, error: { code: 'START_SPOT_INVALID', message: 'Start spot must be a published catalog spot.' } });
    const spots = selected.filter((spot): spot is NonNullable<typeof spot> => spot !== undefined);
    const values = new Map(computeSpotSignals(spots).map(signal => [signal.spotId, signal.value]));
    const problem: TrailProblem = {
      nodes: spots.map(spot => ({ spotId: spot.spotId, title: spot.title, municipality: spot.municipality, description: spot.description,
        lat: spot.lat, lng: spot.lng, value: values.get(spot.spotId) ?? 0, dwellMin: 45,
        windows: parsed.data.with_windows ? windowsFromBestTime(spot.bestTime ?? []) : [], crowdByHour: Array(24).fill(0), category: spot.category })),
      startNode: parsed.data.start_node, dayStartMin: 8 * 60, budgetMin: parsed.data.budget_min,
      minStops: parsed.data.min_stops, maxStops: parsed.data.max_stops, maxLegMin: parsed.data.max_leg_min,
      maxPerCategory: parsed.data.max_per_category, mustInclude: parsed.data.must_include, exclude: parsed.data.exclude,
      weights: { crowdPenalty: 0.15, travelPenalty: 0.003 }, seed: parsed.data.seed, costing: parsed.data.costing,
    };
    const matrix = await loadTravelTimeLookup(pool, problem.costing ?? 'auto');
    const local = solveLocal(problem, matrix);
    const cuopt = await createCuoptSolver().solve(problem, matrix);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const [solver, result] of [['local', local], ['cuopt', cuopt]] as const) {
        const generationId = randomUUID();
        await client.query(`INSERT INTO trail_generations
          (id,kind,requested_by,input,constraints,solver,solver_ms,objective,result,ai_used)
          VALUES ($1,'benchmark',$2,$3::jsonb,$4::jsonb,$5,$6,$7,$8::jsonb,FALSE)`, [generationId, req.user!.id,
          JSON.stringify({ compare_solvers: true, candidate_count: problem.nodes.length, seed: problem.seed, costing: problem.costing }),
          JSON.stringify({ budget_min: problem.budgetMin, min_stops: problem.minStops, max_stops: problem.maxStops, max_leg_min: problem.maxLegMin, with_windows: parsed.data.with_windows }),
          solver, Math.max(0, Math.round(result.ms)), Number.isFinite(result.objective) ? result.objective : -1,
          JSON.stringify({ feasible: result.feasible, objective: Number.isFinite(result.objective) ? result.objective : null, stops: result.stops.map(stop => stop.spotId), stop_count: result.stops.length, total_min: result.totalMin, total_km: result.totalKm })]);
      }
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
    return res.json({ success: true, data: { local, cuopt } });
  } catch (error) {
    if (error instanceof CuoptError) return res.status(error.code === 'CUOPT_INFEASIBLE' ? 422 : 503).json({ success: false, error: { code: error.code, message: error.code === 'CUOPT_INFEASIBLE' ? 'cuOpt found no route satisfying the submitted constraints.' : 'cuOpt comparison is unavailable.' } });
    return res.status(503).json({ success: false, error: { code: 'SOLVER_COMPARISON_FAILED', message: 'Solver comparison failed; no benchmark rows were saved.' } });
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
