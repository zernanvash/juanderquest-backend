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
export interface TrailSignalScope {
  areaId?: string;
  center?: { lat: number; lng: number };
  radiusKm?: number;
  municipalities?: string[];
  spotIds?: string[];
}

export async function loadTrailSignalInputs(
  pool: Pool | PoolClient,
  userId?: string,
  scope: TrailSignalScope = {},
): Promise<SpotSignalInput[]> {
  const center = scope.center;
  const radiusKm = scope.radiusKm ?? 60;
  const latDelta = center ? radiusKm / 111.32 : null;
  const longitudeScale = center ? Math.max(0.01, Math.abs(Math.cos(center.lat * Math.PI / 180))) : null;
  const lngDelta = center ? radiusKm / (111.32 * longitudeScale!) : null;
  const normalizedMunicipalities = scope.municipalities?.map(value => value.trim().toLocaleLowerCase()).filter(Boolean) ?? [];
  const municipalities = normalizedMunicipalities.length ? normalizedMunicipalities : null;
  const spotIds = scope.spotIds?.map(value => value.trim()).filter(Boolean) ?? null;
  const result = await pool.query(`
    WITH RECURSIVE area_scope(id,name,level,path) AS (
      SELECT id,name,level,ARRAY[id]::text[] FROM admin_areas WHERE id=$2::text
      UNION ALL
      SELECT child.id,child.name,child.level,parent.path||child.id
      FROM admin_areas child JOIN area_scope parent ON child.parent_id=parent.id
      WHERE NOT child.id=ANY(parent.path)
    ), photo_counts AS (
      SELECT spot_id,COUNT(*)::int AS photo_count FROM spot_assets WHERE status='approved' GROUP BY spot_id
    ), interaction_counts AS (
      SELECT si.spot_id,
        COUNT(*) FILTER (WHERE si.interaction_type='save')::int AS saves_30d,
        COUNT(*) FILTER (WHERE si.interaction_type<>'save')::int AS interactions_30d
      FROM spot_interactions si JOIN users iu ON iu.id=si.user_id JOIN spots interaction_spot ON interaction_spot.id=si.spot_id
      WHERE si.created_at >= NOW()-INTERVAL '30 days'
        AND COALESCE(iu.is_test,FALSE)=COALESCE(interaction_spot.is_test,FALSE)
      GROUP BY si.spot_id
    ), completion_events AS (
      SELECT q.gps_lat,q.gps_lng,COALESCE(u.is_test,FALSE) AS is_test,COUNT(*)::int AS event_count
      FROM submissions sub JOIN quests q ON q.id=sub.quest_id JOIN users u ON u.id=sub.user_id
      WHERE sub.status='approved' AND sub.reviewed_at >= NOW()-INTERVAL '30 days' AND sub.is_test=FALSE
        AND COALESCE(u.is_test,FALSE)=COALESCE(q.is_test,FALSE)
      GROUP BY q.gps_lat,q.gps_lng,COALESCE(u.is_test,FALSE)
      UNION ALL
      SELECT q.gps_lat,q.gps_lng,COALESCE(u.is_test,FALSE) AS is_test,COUNT(*)::int AS event_count
      FROM quest_attempts qa JOIN quests q ON q.id=qa.quest_id JOIN users u ON u.id=qa.user_id
      WHERE qa.status='completed' AND qa.completed_at >= NOW()-INTERVAL '30 days'
        AND COALESCE(u.is_test,FALSE)=COALESCE(q.is_test,FALSE)
      GROUP BY q.gps_lat,q.gps_lng,COALESCE(u.is_test,FALSE)
    ), completion_counts AS (
      SELECT s.id AS spot_id,SUM(e.event_count)::int AS completions_30d
      FROM spots s JOIN completion_events e ON e.is_test=COALESCE(s.is_test,FALSE)
        AND abs(e.gps_lat-s.gps_lat)<=0.001 AND abs(e.gps_lng-s.gps_lng)<=0.001
      GROUP BY s.id
    ), checkin_counts AS (
      SELECT ts.spot_id,COUNT(*)::int AS checkins_30d
      FROM trail_checkins tc JOIN trail_stops ts ON ts.trail_id=tc.trail_id AND ts.position=tc.position
      JOIN trails t ON t.id=tc.trail_id
      WHERE tc.verified_at >= NOW()-INTERVAL '30 days' AND t.status='published' AND t.is_test=FALSE
      GROUP BY ts.spot_id
    ), social_events AS (
      SELECT a.subject_id AS spot_id,COUNT(*)::int AS event_count
      FROM social_activities a JOIN social_cheers c ON c.activity_id=a.id
      WHERE a.subject_type='spot' AND a.hidden_at IS NULL AND a.is_test=FALSE AND c.created_at>=NOW()-INTERVAL '30 days' AND c.is_test=FALSE
      GROUP BY a.subject_id
      UNION ALL
      SELECT a.subject_id AS spot_id,COUNT(*)::int AS event_count
      FROM social_activities a JOIN social_comments c ON c.activity_id=a.id
      WHERE a.subject_type='spot' AND a.hidden_at IS NULL AND a.is_test=FALSE AND c.created_at>=NOW()-INTERVAL '30 days'
        AND c.deleted_at IS NULL AND c.hidden_at IS NULL AND c.is_test=FALSE
      GROUP BY a.subject_id
    ), social_counts AS (
      SELECT spot_id,SUM(event_count)::int AS social_count FROM social_events GROUP BY spot_id
    ), prior_visits AS (
      SELECT DISTINCT ts.spot_id
      FROM trail_checkins tc JOIN trail_stops ts ON ts.trail_id=tc.trail_id AND ts.position=tc.position
      WHERE $1::text IS NOT NULL AND tc.user_id=$1
    )
    SELECT s.id AS spot_id, s.name, s.category, COALESCE(s.good_for, '[]'::jsonb) AS good_for,
      COALESCE(s.best_time, '[]'::jsonb) AS best_time, s.description, s.source_type,
      s.gps_lat, s.gps_lng, s.municipality,
      COALESCE(pc.photo_count,0) AS approved_photo_count,
      COALESCE(ic.saves_30d,0) AS saves_30d,
      COALESCE(ic.interactions_30d,0) AS interactions_30d,
      COALESCE(cc.completions_30d,0)+COALESCE(ch.checkins_30d,0)+COALESCE(sc.social_count,0) AS completions_30d,
      (pv.spot_id IS NOT NULL) AS prior_visit
    FROM spots s
      LEFT JOIN photo_counts pc ON pc.spot_id=s.id
      LEFT JOIN interaction_counts ic ON ic.spot_id=s.id
      LEFT JOIN completion_counts cc ON cc.spot_id=s.id
      LEFT JOIN checkin_counts ch ON ch.spot_id=s.id
      LEFT JOIN social_counts sc ON sc.spot_id=s.id
      LEFT JOIN prior_visits pv ON pv.spot_id=s.id
    WHERE s.status='published' AND COALESCE(s.is_test,FALSE)=FALSE
      AND s.gps_lat IS NOT NULL AND s.gps_lng IS NOT NULL
      AND ($2::text IS NULL OR s.town_area_id IN (SELECT id FROM area_scope)
        OR (s.town_area_id IS NULL AND lower(s.municipality) IN (SELECT lower(name) FROM area_scope WHERE level='town')))
      AND ($3::double precision IS NULL OR s.gps_lat BETWEEN $3-$5 AND $3+$5)
      AND ($4::double precision IS NULL OR s.gps_lng BETWEEN $4-$6 AND $4+$6)
      AND ($7::text[] IS NULL OR lower(s.municipality)=ANY($7::text[]))
      AND ($8::text[] IS NULL OR s.id=ANY($8::text[]))
    ORDER BY s.id
  `, [userId ?? null, scope.areaId ?? null, center?.lat ?? null, center?.lng ?? null, latDelta, lngDelta, municipalities, spotIds]);
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
