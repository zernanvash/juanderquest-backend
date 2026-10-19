import type { Pool, PoolClient } from 'pg';
import { DEFAULT_SIGNAL_WEIGHTS, type SpotSignalInput, type TrailSignal, type TrailSignalRequest } from './types.js';

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

export function computeSpotSignals(spots: SpotSignalInput[], request: TrailSignalRequest = {}, weights = DEFAULT_SIGNAL_WEIGHTS): TrailSignal[] {
  const maxPopularity = Math.max(1, ...spots.map(s => s.saves30d + s.interactions30d + s.questCompletions30d));
  const wanted = new Set([...(request.themes ?? []), ...(request.goodFor ?? [])].map(s => s.toLowerCase()));
  const trends = request.trendThemes ?? [];
  return spots.map(spot => {
    const quality = (spot.approvedPhotoCount > 0 ? 0.4 : 0) + (['editorial', 'lgu', 'lgu_verified'].includes(spot.sourceType) ? 0.3 : 0) + (spot.description.trim().length >= 120 ? 0.3 : 0);
    const popularity = Math.log1p(spot.saves30d + spot.interactions30d + spot.questCompletions30d) / Math.log1p(maxPopularity);
    const terms = new Set([spot.category, ...spot.goodFor].map(s => s.toLowerCase()));
    const trend = clamp01(trends.reduce((sum, t) => {
      const matches = [...(t.categories ?? []), ...(t.good_for ?? []), ...(t.label ? [t.label] : [])].some(v => terms.has(v.toLowerCase()));
      return sum + (matches ? clamp01(t.weight ?? 0) : 0);
    }, 0));
    const fit = wanted.size ? clamp01([...wanted].filter(v => terms.has(v)).length / wanted.size) : 0.5;
    const novelty = spot.priorVisit ? 0.2 : 1;
    const components = { quality: clamp01(quality), popularity: clamp01(popularity), trend, fit, novelty };
    return { spotId: spot.spotId, components, value: Object.entries(components).reduce((sum, [key, value]) => sum + value * (weights as Record<string, number>)[key], 0) };
  });
}

/** Reads public, published, non-test spots and aggregate signals; never returns actor identities. */
export async function loadTrailSignalInputs(pool: Pool | PoolClient, userId?: string): Promise<SpotSignalInput[]> {
  const result = await pool.query(`
    SELECT s.id AS spot_id, s.name, s.category, COALESCE(s.good_for, '[]'::jsonb) AS good_for,
      COALESCE(s.best_time, '[]'::jsonb) AS best_time, s.description, s.source_type,
      s.gps_lat, s.gps_lng, s.municipality,
      (SELECT count(*)::int FROM spot_assets a WHERE a.spot_id=s.id AND a.status='approved') AS approved_photo_count,
      (SELECT count(*)::int FROM spot_interactions i JOIN users iu ON iu.id=i.user_id WHERE i.spot_id=s.id AND i.interaction_type='save' AND i.created_at >= NOW()-INTERVAL '30 days' AND COALESCE(iu.is_test,FALSE)=COALESCE(s.is_test,FALSE)) AS saves_30d,
      (SELECT count(*)::int FROM spot_interactions i JOIN users iu ON iu.id=i.user_id WHERE i.spot_id=s.id AND i.interaction_type<>'save' AND i.created_at >= NOW()-INTERVAL '30 days' AND COALESCE(iu.is_test,FALSE)=COALESCE(s.is_test,FALSE)) AS interactions_30d,
      ((SELECT count(*)::int FROM submissions sub JOIN quests q ON q.id=sub.quest_id JOIN users u ON u.id=sub.user_id
        WHERE sub.status='approved' AND sub.reviewed_at >= NOW()-INTERVAL '30 days' AND sub.is_test=FALSE
          AND COALESCE(u.is_test,FALSE)=COALESCE(s.is_test,FALSE) AND COALESCE(q.is_test,FALSE)=COALESCE(s.is_test,FALSE)
          AND abs(q.gps_lat-s.gps_lat) <= 0.001 AND abs(q.gps_lng-s.gps_lng) <= 0.001)
       + (SELECT count(*)::int FROM quest_attempts qa JOIN quests q ON q.id=qa.quest_id JOIN users u ON u.id=qa.user_id
        WHERE qa.status='completed' AND qa.completed_at >= NOW()-INTERVAL '30 days'
          AND COALESCE(u.is_test,FALSE)=COALESCE(s.is_test,FALSE) AND COALESCE(q.is_test,FALSE)=COALESCE(s.is_test,FALSE)
          AND abs(q.gps_lat-s.gps_lat) <= 0.001 AND abs(q.gps_lng-s.gps_lng) <= 0.001)) AS completions_30d,
      CASE WHEN $1::text IS NULL THEN FALSE ELSE EXISTS (
        SELECT 1 FROM trail_checkins tc WHERE tc.user_id=$1 AND tc.trail_id IN
          (SELECT ts.trail_id FROM trail_stops ts WHERE ts.spot_id=s.id)
      ) END AS prior_visit
    FROM spots s WHERE s.status='published' AND COALESCE(s.is_test,FALSE)=FALSE
    ORDER BY s.id
  `, [userId ?? null]);
  return result.rows.map(r => ({
    spotId: String(r.spot_id), title: String(r.name), category: String(r.category), goodFor: asStringArray(r.good_for), bestTime: asStringArray(r.best_time),
    description: String(r.description ?? ''), sourceType: String(r.source_type ?? ''), approvedPhotoCount: Number(r.approved_photo_count),
    saves30d: Number(r.saves_30d), interactions30d: Number(r.interactions_30d), questCompletions30d: Number(r.completions_30d), priorVisit: Boolean(r.prior_visit),
    lat: Number(r.gps_lat), lng: Number(r.gps_lng), municipality: String(r.municipality),
  }));
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string') { try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed.map(String) : []; } catch { return []; } }
  return [];
}
