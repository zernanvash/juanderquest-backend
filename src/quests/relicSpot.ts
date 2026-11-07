import { createHash } from 'crypto';

/**
 * Hidden relic spot for an AR task (owner 2026-11-07: "just an area where the users can
 * find the relic, but spawn it randomly around that area, not where the player is ...
 * users should be 2-3 m near the object before it's visible").
 *
 * The creator only sets the area (fence). Each attempt gets its own spot inside it,
 * derived from the attempt and task, so it needs no storage, is the same every time it
 * is asked for, and differs between players. It keeps 20-80% of the radius from the
 * centre so it is never on the edge.
 */
export interface RelicFence {
  lat: number;
  lng: number;
  radius_meters: number;
}

/** How close (metres, plus GPS accuracy up to 10 m) a collect must be to the spot. */
export const RELIC_REACH_M = 12;

const METERS_PER_DEG_LAT = 111_320;

export function relicSpot(attemptId: string, taskKey: string, fence: RelicFence): { lat: number; lng: number } {
  const h = createHash('sha256').update(`relic:${attemptId}:${taskKey}`).digest();
  const u1 = h.readUInt32BE(0) / 0xffffffff;
  const u2 = h.readUInt32BE(4) / 0xffffffff;
  const r = fence.radius_meters * (0.2 + 0.6 * Math.sqrt(u1));
  const a = 2 * Math.PI * u2;
  const north = r * Math.cos(a);
  const east = r * Math.sin(a);
  const lat = fence.lat + north / METERS_PER_DEG_LAT;
  const lng = fence.lng + east / (METERS_PER_DEG_LAT * Math.cos((fence.lat * Math.PI) / 180));
  return { lat: Number(lat.toFixed(7)), lng: Number(lng.toFixed(7)) };
}
