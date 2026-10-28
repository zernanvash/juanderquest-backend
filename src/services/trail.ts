import { spotStore, Spot } from '../spots/store.js';
import { CrowdStatus } from '../spots/crowd.js';
import { calculateRoute, computeHaversineDistanceKm, RouteResponse, TravelCosting } from './routing.js';

export type { TravelCosting } from './routing.js';

export interface ServiceAreaMetadata {
  id: string;
  name: string;
  bbox: {
    min_lat: number;
    max_lat: number;
    min_lng: number;
    max_lng: number;
  };
  supported_modes: TravelCosting[];
  road_graph_engine: 'valhalla' | 'fallback_straight_line';
  license: string;
  data_sources: string[];
}

export const PANGASINAN_SERVICE_AREA: ServiceAreaMetadata = {
  id: 'pangasinan-pilot',
  name: 'Pangasinan Tourism Corridor Pilot',
  bbox: {
    min_lat: 15.5,
    max_lat: 16.5,
    min_lng: 119.5,
    max_lng: 121.0,
  },
  supported_modes: ['auto', 'motorcycle', 'bicycle', 'pedestrian'],
  road_graph_engine: 'valhalla',
  license: 'OpenStreetMap Contributors (ODbL 1.0)',
  data_sources: ['OpenStreetMap Road Network', 'Pangasinan Tourism Catalog'],
};

export interface TrailPlanRequest {
  start: { lat: number; lng: number; name?: string };
  end: { lat: number; lng: number; name?: string };
  costing?: TravelCosting;
  max_stops?: number;
  max_detour_km?: number;
  preferred_categories?: string[];
  avoid_congested?: boolean;
  /** Detour areas the traveler added, routed through in this order. */
  via?: { lat: number; lng: number }[];
}

export interface CandidateStop {
  spot_id: string;
  name: string;
  category: string;
  municipality?: string;
  gps_lat: number;
  gps_lng: number;
  detour_km: number;
  distance_from_start_km: number;
  crowd_status: CrowdStatus;
  score: number;
  reason_codes: string[];
  recommendation_label: 'Curated' | 'Suggested';
}

/** Spots near the route grouped by town: the free trip suggests areas, not a fixed itinerary. */
export interface DetourArea {
  municipality: string;
  detour_km: number;
  extra_minutes: number;
  score: number;
  center: { lat: number; lng: number };
  spot_count: number;
  highlights: { spot_id: string; name: string; category: string }[];
}

export interface TrailPlanResponse {
  service_area: ServiceAreaMetadata;
  is_within_primary_service_area: boolean;
  baseline_route: RouteResponse;
  suggested_stops: CandidateStop[];
  detour_areas: DetourArea[];
  total_candidates_evaluated: number;
  disclaimer: string;
}

export function isLocationWithinBbox(lat: number, lng: number, bbox: ServiceAreaMetadata['bbox']): boolean {
  return (
    lat >= bbox.min_lat &&
    lat <= bbox.max_lat &&
    lng >= bbox.min_lng &&
    lng <= bbox.max_lng
  );
}

export async function planTrailCorridor(req: TrailPlanRequest): Promise<TrailPlanResponse> {
  const costing = req.costing || 'auto';
  const maxStops = Math.min(Math.max(req.max_stops ?? 3, 1), 5);
  const straightKm = computeHaversineDistanceKm(req.start.lat, req.start.lng, req.end.lat, req.end.lng);
  // Long trips tolerate longer detours (Manila to Baguio can swing through Pangasinan).
  const maxDetourKm = Math.min(Math.max(req.max_detour_km ?? Math.min(80, Math.max(15, straightKm * 0.25)), 1), 120);
  const via = (req.via ?? []).slice(0, 3);
  const avoidCongested = req.avoid_congested !== false;
  const preferredCategories = new Set(req.preferred_categories || []);

  const serviceArea = PANGASINAN_SERVICE_AREA;
  const isStartInArea = isLocationWithinBbox(req.start.lat, req.start.lng, serviceArea.bbox);
  const isEndInArea = isLocationWithinBbox(req.end.lat, req.end.lng, serviceArea.bbox);
  const isWithinPrimary = isStartInArea && isEndInArea;

  // 1. Calculate baseline route between origin and destination
  const baselineRoute = await calculateRoute({
    startLat: req.start.lat,
    startLng: req.start.lng,
    endLat: req.end.lat,
    endLng: req.end.lng,
    costing,
    avoidCongested,
    via,
  });

  const baselineDistKm = straightKm;

  // 2. Evaluate all published spots as detour candidates along corridor
  const candidates: CandidateStop[] = [];
  const publishedSpots = spotStore.spots.filter((spot) => spot.status === 'published' && !spot.is_test);

  for (const spot of publishedSpots) {
    // Distance from start to spot and spot to end
    const distFromStart = computeHaversineDistanceKm(
      req.start.lat,
      req.start.lng,
      spot.gps_lat,
      spot.gps_lng
    );
    const distToEnd = computeHaversineDistanceKm(
      spot.gps_lat,
      spot.gps_lng,
      req.end.lat,
      req.end.lng
    );

    // Skip if spot is effectively identical to start or end (< 300m)
    if (distFromStart < 0.3 || distToEnd < 0.3) {
      continue;
    }

    // Detour math: distance going through spot minus direct baseline
    let detourKm = Number((distFromStart + distToEnd - baselineDistKm).toFixed(2));
    if (detourKm < 0) detourKm = 0;

    // Filter by max detour budget
    if (detourKm > maxDetourKm) {
      continue;
    }

    // Explainable scoring and reason codes
    const reasonCodes: string[] = [];
    let score = 100 - detourKm * 4;

    if (detourKm <= 2.5) {
      reasonCodes.push('MINIMAL_DETOUR');
      score += 15;
    } else if (detourKm <= 8.0) {
      reasonCodes.push('LOW_DETOUR');
      score += 5;
    }

    const crowdInfo = spotStore.crowd(spot);
    const crowdStatus = crowdInfo.crowd_status;

    if (crowdStatus === 'quiet') {
      reasonCodes.push('CALM_CROWD');
      score += 15;
    } else if (crowdStatus === 'estimated_busy') {
      if (avoidCongested) {
        reasonCodes.push('CONGESTION_PENALTY');
        score -= 25;
      }
    }

    if (preferredCategories.size > 0 && preferredCategories.has(spot.category)) {
      reasonCodes.push('CATEGORY_MATCH');
      score += 20;
    }

    if (spot.category === 'culture_heritage') {
      reasonCodes.push('CULTURAL_HERITAGE');
      score += 8;
    } else if (spot.category === 'nature_outdoors') {
      reasonCodes.push('ECO_TOURISM');
      score += 5;
    }

    candidates.push({
      spot_id: spot.id,
      name: spot.name,
      category: spot.category,
      municipality: spot.municipality,
      gps_lat: spot.gps_lat,
      gps_lng: spot.gps_lng,
      detour_km: detourKm,
      distance_from_start_km: distFromStart,
      crowd_status: crowdStatus,
      score: Math.round(score),
      reason_codes: reasonCodes,
      recommendation_label: score >= 95 ? 'Curated' : 'Suggested',
    });
  }

  // Sort candidates by score descending (and lower detour as tie-breaker)
  candidates.sort((a, b) => b.score - a.score || a.detour_km - b.detour_km);

  const selectedStops = candidates.slice(0, maxStops);
  const detourAreas = groupDetourAreas(candidates, req.end);

  return {
    service_area: {
      ...serviceArea,
      road_graph_engine: baselineRoute.summary.engine,
    },
    is_within_primary_service_area: isWithinPrimary,
    baseline_route: baselineRoute,
    suggested_stops: selectedStops,
    detour_areas: detourAreas,
    total_candidates_evaluated: candidates.length,
    disclaimer:
      'Deterministic corridor route and stop suggestions based on published destination coordinates and sovereign routing geometry. No synthetic AI stops, hallucinated opening hours, or unverified merchant inventories.',
  };
}

// Groups ranked candidates by municipality; the destination's own town is left out
// (the traveler is already going there). Minutes assume ~45 km/h plus an hour on site.
export function groupDetourAreas(candidates: CandidateStop[], end: { lat: number; lng: number }, limit = 3): DetourArea[] {
  const groups = new Map<string, CandidateStop[]>();
  for (const candidate of candidates) {
    const town = candidate.municipality || 'Nearby';
    if (!groups.has(town)) groups.set(town, []);
    groups.get(town)!.push(candidate);
  }
  const areas: DetourArea[] = [];
  for (const [municipality, stops] of groups) {
    const nearDestination = stops.some((stop) => computeHaversineDistanceKm(stop.gps_lat, stop.gps_lng, end.lat, end.lng) < 3);
    if (nearDestination) continue;
    const top = [...stops].sort((a, b) => b.score - a.score || a.detour_km - b.detour_km);
    const highlights = top.slice(0, 3);
    const detourKm = Math.min(...stops.map((stop) => stop.detour_km));
    areas.push({
      municipality,
      detour_km: Number(detourKm.toFixed(1)),
      extra_minutes: Math.round((detourKm / 45) * 60) + 60,
      score: top[0].score + Math.min(stops.length - 1, 4) * 3,
      center: {
        lat: Number((highlights.reduce((sum, stop) => sum + stop.gps_lat, 0) / highlights.length).toFixed(5)),
        lng: Number((highlights.reduce((sum, stop) => sum + stop.gps_lng, 0) / highlights.length).toFixed(5)),
      },
      spot_count: stops.length,
      highlights: highlights.map((stop) => ({ spot_id: stop.spot_id, name: stop.name, category: stop.category })),
    });
  }
  return areas.sort((a, b) => b.score - a.score || a.detour_km - b.detour_km).slice(0, limit);
}
