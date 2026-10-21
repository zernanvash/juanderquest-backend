import { randomUUID } from 'crypto';
import type { Pool } from 'pg';
import { computeSpotSignals, loadTrailSignalInputs } from './signals.js';
import { loadTravelTimeLookup } from './matrix.js';
import { solveLocal } from './solver/local.js';
import { writeTrailStory } from './ai/service.js';
import { loadTrailEconomy } from './economy.js';
import type { TrailCosting, TrailProblem, TrailSignalRequest } from './types.js';

export interface GenerateTrailInput {
  kind?: 'admin' | 'weekly_batch' | 'benchmark'; theme?: string; constraints?: TrailSignalRequest; tier?: 'starter'|'explorer'|'signature'|'legendary';
  startNode?: string; budgetMin?: number; seed?: number; solver?: 'local'; minStops?: number; maxStops?: number;
  maxLegMin?: number; maxPerCategory?: number; mustInclude?: string[]; exclude?: string[]; costing?: TrailCosting;
  isTest?: boolean; requestedBy?: string; status?: 'draft'|'pending_review'|'published';
  availableFrom?: Date | null; availableUntil?: Date | null; weekId?: string; candidateKey?: string;
}

export class TrailGenerationError extends Error {
  readonly code = 'NO_FEASIBLE_TRAIL';
  constructor() { super('No feasible trail meets the requested stop, time-window, travel, and diversity constraints.'); }
}

export async function generateTrail(pool: Pool, input: GenerateTrailInput) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const inputs = await loadTrailSignalInputs(client);
    const trendResult = await client.query(`SELECT digest FROM trend_digests ORDER BY created_at DESC LIMIT 1`);
    const trendDigest = trendResult.rows[0]?.digest as { themes?: TrailSignalRequest['trendThemes'] } | undefined;
    const signalRequest = { ...(input.constraints ?? {}), themes: input.constraints?.themes ?? (input.theme ? [input.theme] : []), trendThemes: trendDigest?.themes ?? [] };
    const signals = new Map(computeSpotSignals(inputs, signalRequest).map(s => [s.spotId, s]));
    const costing = input.costing ?? 'auto';
    const matrix = await loadTravelTimeLookup(client, costing);
    const nodes = inputs.map(spot => {
      const timeWindows = windowsFromBestTime(spot.bestTime ?? []);
      return {
        spotId: spot.spotId, value: signals.get(spot.spotId)?.value ?? 0, dwellMin: 45,
        windows: timeWindows, crowdByHour: spot.crowdByHour ?? Array(24).fill(0), category: spot.category,
        lat: spot.lat, lng: spot.lng, municipality: spot.municipality, title: spot.title, description: spot.description,
      };
    });
    const base: TrailProblem = {
      nodes, startNode: input.startNode, dayStartMin: 8 * 60, budgetMin: input.budgetMin ?? 240,
      minStops: input.minStops ?? 3, maxStops: Math.min(12, input.maxStops ?? 6), maxLegMin: input.maxLegMin ?? 60,
      maxPerCategory: input.maxPerCategory ?? 2, mustInclude: input.mustInclude ?? [], exclude: input.exclude ?? [],
      weights: { crowdPenalty: 0.15, travelPenalty: 0.003 }, seed: input.seed ?? 44, costing,
    };
    let problem = base;
    let solution = solveLocal(problem, matrix);
    // Relax only in the documented order, once per relaxation, up to three.
    for (const relax of [
      (p: TrailProblem): TrailProblem => ({ ...p, maxPerCategory: p.maxPerCategory + 1 }),
      (p: TrailProblem): TrailProblem => ({ ...p, maxLegMin: p.maxLegMin + 15 }),
      (p: TrailProblem): TrailProblem => ({ ...p, budgetMin: p.budgetMin + 60 }),
    ]) {
      if (solution.feasible && solution.stops.length >= problem.minStops) break;
      problem = relax(problem);
      solution = solveLocal(problem, matrix);
    }
    if (!solution.feasible || solution.stops.length < problem.minStops) throw new TrailGenerationError();
    const municipalities = [...new Set(solution.stops.map(s => nodes.find(n => n.spotId === s.spotId)?.municipality).filter((v): v is string => Boolean(v)))];
    const selectedStops = solution.stops.map(stop => {
      const node = nodes.find(item => item.spotId === stop.spotId)!;
      return { spot_id: node.spotId, name: node.title ?? node.spotId, municipality: node.municipality ?? 'Pangasinan', category: node.category, description: node.description };
    });
    const storyResult = await writeTrailStory(client, {
      theme: input.theme ?? signalRequest.themes?.[0] ?? 'Pangasinan discoveries',
      municipalities,
      total_minutes: solution.totalMin,
      stops: selectedStops,
      known_catalog_places: nodes.map(node => node.title ?? node.spotId),
    }, { nodes, solution });
    const story = storyResult.value;
    const trailId = `trl_${randomUUID()}`;
    const slugBase = (input.theme ?? 'pangasinan-trail').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'pangasinan-trail';
    const slug = `${slugBase}-${randomUUID().slice(0, 8)}`;
    const duration = Math.max(1, solution.totalMin);
    const economy = await loadTrailEconomy(client);
    const tier = input.tier ?? 'starter';
    const unlockRule = tier === 'starter' ? { type: 'free' }
      : tier === 'explorer' ? { type: 'level', min_level: economy.explorerMinLevel }
        : tier === 'signature' ? { type: 'points', price_points: economy.signatureUnlockPoints }
          : { type: 'points', price_points: economy.legendaryUnlockPoints };
    const trailResult = await client.query(`INSERT INTO trails
      (id,slug,title,tagline,tier,theme,municipalities,unlock_rule,costing,total_minutes,total_km,story,status,source,owner_user_id,generation_id,is_test,available_from,available_until)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12::jsonb,$13,'engine',NULL,NULL,$14,$15,$16)
      RETURNING *`, [trailId, slug, story.title, story.tagline, tier, input.theme ?? 'mixed', municipalities, JSON.stringify(unlockRule), costing, duration, solution.totalKm,
      JSON.stringify(story), input.status ?? 'draft', Boolean(input.isTest), input.availableFrom ?? null, input.availableUntil ?? null]);
    for (let i = 0; i < solution.stops.length; i++) {
      const stop = solution.stops[i];
      const leg = i === 0 ? { minutes: 0, km: 0 } : matrix(solution.stops[i - 1].spotId, stop.spotId) ?? { minutes: 0, km: 0 };
      await client.query(`INSERT INTO trail_stops (trail_id,position,spot_id,arrive_offset_min,dwell_min,leg_minutes,leg_km,narration)
        VALUES ($1,$2,$3,$4,45,$5,$6,$7)`, [trailId, i + 1, stop.spotId, Math.max(0, stop.arriveMin - base.dayStartMin), Math.round(leg.minutes), leg.km, story.stops[i]?.narration ?? '']);
    }
    const generationId = randomUUID();
    await client.query(`INSERT INTO trail_generations (id,kind,requested_by,input,constraints,solver,solver_ms,objective,result,ai_model,ai_used,ai_fallback_reason)
      VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,'local',$6,$7,$8::jsonb,$9,$10,$11)`, [generationId, input.kind ?? 'admin', input.requestedBy ?? null,
      JSON.stringify({ theme: input.theme ?? null, costing, seed: problem.seed, ...(input.weekId ? { week_id: input.weekId } : {}), ...(input.candidateKey ? { candidate_key: input.candidateKey } : {}) }), JSON.stringify(problemConstraints(problem)), Math.max(0, Math.round(solution.ms)), solution.objective,
      JSON.stringify({ trail_id: trailId, stops: solution.stops, total_minutes: duration, total_km: solution.totalKm }), storyResult.model, storyResult.aiUsed, storyResult.fallbackReason]);
    await client.query('UPDATE trails SET generation_id=$1 WHERE id=$2', [generationId, trailId]);
    await client.query('COMMIT');
    return { trail: { ...trailResult.rows[0], generation_id: generationId }, generation: { id: generationId, solver_ms: Math.max(0, Math.round(solution.ms)), objective: solution.objective, solver: 'local', ai_used: storyResult.aiUsed, ai_model: storyResult.model, ai_fallback_reason: storyResult.fallbackReason }, solution };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

export function windowsFromBestTime(tags: string[]): Array<[number, number]> {
  // Values verified in migrations/050 and the spot contribution form. Tags that
  // describe weekdays/seasons are metadata, not arrival-hour windows.
  const map: Record<string, [number, number]> = {
    early_morning: [5 * 60, 10 * 60],
    daytime: [10 * 60, 17 * 60],
    sunset: [16 * 60 + 30, 18 * 60 + 45],
    night: [18 * 60, 24 * 60],
  };
  return tags.flatMap(tag => map[tag] ? [map[tag]] : []);
}

function problemConstraints(p: TrailProblem) { return { dayStartMin:p.dayStartMin,budgetMin:p.budgetMin,minStops:p.minStops,maxStops:p.maxStops,maxLegMin:p.maxLegMin,maxPerCategory:p.maxPerCategory,mustInclude:p.mustInclude,exclude:p.exclude,seed:p.seed }; }
