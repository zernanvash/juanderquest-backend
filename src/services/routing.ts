import { env } from '../config/env.js';
import { spotStore, Spot } from '../spots/store.js';

export type TravelCosting = 'auto' | 'pedestrian' | 'bicycle' | 'motorcycle';

export interface RouteRequest {
  startLat: number;
  startLng: number;
  endLat: number;
  endLng: number;
  costing?: TravelCosting;
  avoidCongested?: boolean;
  /** Optional pass-through points (detours), in travel order. */
  via?: { lat: number; lng: number }[];
}

export interface RouteManeuver {
  instruction: string;
  streetName?: string;
  distanceMeters: number;
  timeSeconds: number;
}

export interface RouteSummary {
  distanceKm: number;
  durationSeconds: number;
  durationFormatted: string;
  costing: TravelCosting;
  hasCrowdDiversion: boolean;
  engine: 'valhalla' | 'fallback_straight_line';
}

export interface RouteResponse {
  degraded: boolean;
  navigationMode: 'turn_by_turn' | 'straight_line_estimate';
  warning?: {
    code: 'STRAIGHT_LINE_FALLBACK' | 'OUTSIDE_ROUTING_COVERAGE';
    message: string;
    coverageLabel?: string;
  };
  summary: RouteSummary;
  coordinates: [number, number][]; // [lat, lng] pairs for GeoJSON / Leaflet
  maneuvers: RouteManeuver[];
}

export interface ValhallaCoverage {
  bbox: [number, number, number, number];
  region: string;
}

export function getValhallaCoverage(): ValhallaCoverage {
  const values = env.VALHALLA_COVERAGE_BBOX.split(',').map((value) => Number(value.trim()));
  if (
    values.length !== 4 ||
    values.some((value) => !Number.isFinite(value)) ||
    values[0] >= values[2] ||
    values[1] >= values[3]
  ) {
    throw new Error('VALHALLA_COVERAGE_BBOX must be minLng,minLat,maxLng,maxLat');
  }
  return {
    bbox: [values[0], values[1], values[2], values[3]],
    region: env.VALHALLA_COVERAGE_LABEL,
  };
}

/**
 * Decodes Valhalla 6-decimal encoded polyline into an array of [lat, lng] coordinates.
 * Valhalla uses 1e6 precision by default.
 */
export function decodePolyline6(encoded: string): [number, number][] {
  const coordinates: [number, number][] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;

  while (index < encoded.length) {
    let b: number;
    let shift = 0;
    let result = 0;

    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);

    const deltaLat = (result & 1) !== 0 ? ~(result >> 1) : result >> 1;
    lat += deltaLat;

    shift = 0;
    result = 0;

    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);

    const deltaLng = (result & 1) !== 0 ? ~(result >> 1) : result >> 1;
    lng += deltaLng;

    coordinates.push([lat / 1e6, lng / 1e6]);
  }

  return coordinates;
}

export function formatDuration(seconds: number): string {
  const mins = Math.round(seconds / 60);
  if (mins < 60) return `${mins} min${mins !== 1 ? 's' : ''}`;
  const hrs = Math.floor(mins / 60);
  const remainingMins = mins % 60;
  if (remainingMins === 0) return `${hrs} hr${hrs !== 1 ? 's' : ''}`;
  return `${hrs} hr${hrs !== 1 ? 's' : ''} ${remainingMins} min${remainingMins !== 1 ? 's' : ''}`;
}

export function computeHaversineDistanceKm(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const R = 6371; // Earth radius in km
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Number((R * c).toFixed(2));
}

/**
 * Calculates turn-by-turn route using the local Valhalla engine on Azure VM.
 * Supports algorithmic crowd diversion by injecting avoidance polygons around busy spots.
 */
export async function calculateRoute(req: RouteRequest): Promise<RouteResponse> {
  const costing = req.costing || 'auto';
  const avoidCongested = req.avoidCongested !== false;
  const coverage = getValhallaCoverage();
  const [minLng, minLat, maxLng, maxLat] = coverage.bbox;
  const startCovered = req.startLng >= minLng && req.startLng <= maxLng && req.startLat >= minLat && req.startLat <= maxLat;
  const endCovered = req.endLng >= minLng && req.endLng <= maxLng && req.endLat >= minLat && req.endLat <= maxLat;
  const via = req.via ?? [];
  const viaCovered = via.every((p) => p.lng >= minLng && p.lng <= maxLng && p.lat >= minLat && p.lat <= maxLat);
  if (!startCovered || !endCovered || !viaCovered) {
    return straightLineFallback(req, costing, {
      code: 'OUTSIDE_ROUTING_COVERAGE',
      coverageLabel: coverage.region,
      message: `Turn-by-turn directions currently cover ${coverage.region} only.`,
    });
  }

  // 1. Gather crowd avoidance polygons if requested
  const avoidPolygons: [number, number][][][] = [];
  let hasCrowdDiversion = false;

  if (avoidCongested) {
    try {
      const busySpots = spotStore.spots.filter((s: Spot) => {
        const status = spotStore.crowd(s).crowd_status;
        return status === 'estimated_busy';
      });

      for (const spot of busySpots) {
        // Create a 500m bounding box avoidance polygon around the congested spot
        // 0.0045 deg lat/lng ~ 500 meters
        const delta = 0.0045;
        const minLat = spot.gps_lat - delta;
        const maxLat = spot.gps_lat + delta;
        const minLng = spot.gps_lng - delta;
        const maxLng = spot.gps_lng + delta;

        // Skip if either origin or destination is inside this exact spot (so we don't block the destination itself)
        const isStartNear = Math.abs(req.startLat - spot.gps_lat) < delta && Math.abs(req.startLng - spot.gps_lng) < delta;
        const isEndNear = Math.abs(req.endLat - spot.gps_lat) < delta && Math.abs(req.endLng - spot.gps_lng) < delta;

        if (!isStartNear && !isEndNear) {
          avoidPolygons.push([
            [
              [minLng, minLat],
              [maxLng, minLat],
              [maxLng, maxLat],
              [minLng, maxLat],
              [minLng, minLat],
            ],
          ]);
          hasCrowdDiversion = true;
        }
      }
    } catch {
      // Non-fatal if spot store query fails
    }
  }

  // 2. Build Valhalla Request Payload
  const valhallaPayload: Record<string, unknown> = {
    locations: [
      { lat: req.startLat, lon: req.startLng, type: 'break' },
      ...via.map((p) => ({ lat: p.lat, lon: p.lng, type: 'through' })),
      { lat: req.endLat, lon: req.endLng, type: 'break' },
    ],
    costing: costing === 'motorcycle' ? 'motorcycle' : costing,
    directions_options: {
      units: 'kilometers',
      language: 'en-US',
    },
  };

  if (avoidPolygons.length > 0) {
    valhallaPayload.avoid_polygons = avoidPolygons;
  }

  // 3. Query Valhalla Daemon
  try {
    const response = await fetch(`${env.VALHALLA_URL}/route`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(valhallaPayload),
      signal: AbortSignal.timeout(4000),
    });

    if (!response.ok) {
      throw new Error(`Valhalla responded with HTTP ${response.status}`);
    }

    const data = await response.json() as any;
    const trip = data?.trip;
    if (!trip || !trip.legs || trip.legs.length === 0) {
      throw new Error('No valid trip leg returned by Valhalla');
    }

    // `through` points keep a single leg; join every leg anyway so any split stays one line.
    const legs: any[] = trip.legs;
    const decodedCoords = legs.flatMap((leg, i) => {
      const coords = decodePolyline6(leg.shape);
      return i === 0 ? coords : coords.slice(1);
    });

    const maneuvers: RouteManeuver[] = legs.flatMap((leg) => leg.maneuvers || []).map((m: any) => ({
      instruction: m.instruction || 'Continue on route',
      streetName: m.street_names ? m.street_names.join(', ') : undefined,
      distanceMeters: Math.round((m.length || 0) * 1000),
      timeSeconds: Math.round(m.time || 0),
    }));

    const distanceKm = Number((trip.summary?.length || 0).toFixed(2));
    const durationSeconds = Math.round(trip.summary?.time || 0);

    return {
      degraded: false,
      navigationMode: 'turn_by_turn',
      summary: {
        distanceKm,
        durationSeconds,
        durationFormatted: formatDuration(durationSeconds),
        costing,
        hasCrowdDiversion,
        engine: 'valhalla',
      },
      coordinates: decodedCoords,
      maneuvers,
    };
  } catch {
    // 4. Explicit degraded estimate if Valhalla is offline/indexing. This is
    // intentionally not represented as maneuver guidance or turn-by-turn navigation.
    return straightLineFallback(req, costing, {
      code: 'STRAIGHT_LINE_FALLBACK',
      message: 'Routing is degraded. This is a straight-line distance estimate only; turn-by-turn guidance is unavailable.',
    });
  }
}

function straightLineFallback(
  req: RouteRequest,
  costing: TravelCosting,
  warning: NonNullable<RouteResponse['warning']>,
): RouteResponse {
  const points: [number, number][] = [[req.startLat, req.startLng], ...(req.via ?? []).map((p): [number, number] => [p.lat, p.lng]), [req.endLat, req.endLng]];
  const directDistance = Number(points.slice(1).reduce((sum, p, i) => sum + computeHaversineDistanceKm(points[i][0], points[i][1], p[0], p[1]), 0).toFixed(2));
  // Retain the legacy estimate for API compatibility; clients must not present it as travel time.
  const speedKmh = costing === 'pedestrian' ? 4.5 : costing === 'bicycle' ? 15 : 45;
  const estimatedSeconds = Math.round((directDistance / speedKmh) * 3600);
  return {
    degraded: true,
    navigationMode: 'straight_line_estimate',
    warning,
    summary: {
      distanceKm: directDistance,
      durationSeconds: estimatedSeconds,
      durationFormatted: formatDuration(estimatedSeconds),
      costing,
      hasCrowdDiversion: false,
      engine: 'fallback_straight_line',
    },
    coordinates: points,
    maneuvers: [],
  };
}
