// Choosing a spot's photos: cross-spot file ownership, perceptual-hash dedupe, the 5-photo cap,
// exactly one primary and a stable sort order. Pure logic (tested).
import { DUPLICATE_HAMMING, hamming } from './pixels.js';
import { heroEligible, MAX_PHOTOS_PER_SPOT, viaRank } from './quality.js';
import type { SpotCandidates } from './types.js';

export function haversineM(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

export const NEIGHBOUR_RADIUS_M = 1000;

/**
 * A file can belong to one spot only (unique (source, source_id)). When several spots found the
 * same file, the strongest link wins (P18 > OSM file tag > category > geosearch), then the
 * nearest spot, then the lowest spot id. Returns `source:source_id` → winning spot_id.
 */
export function assignOwnership(all: SpotCandidates[]): Map<string, string> {
  const best = new Map<string, { spot: string; rank: number; dist: number }>();
  for (const sc of all) {
    for (const c of sc.candidates) {
      if (c.rejected) continue;
      const key = `${c.source}:${c.source_id}`;
      const cur = { spot: sc.spot.spot_id, rank: viaRank(c.via), dist: c.distance_m ?? 0 };
      const prev = best.get(key);
      if (
        !prev ||
        cur.rank > prev.rank ||
        (cur.rank === prev.rank && cur.dist < prev.dist) ||
        (cur.rank === prev.rank && cur.dist === prev.dist && cur.spot < prev.spot)
      )
        best.set(key, cur);
    }
  }
  return new Map([...best].map(([k, v]) => [k, v.spot]));
}

export interface HashedPhoto {
  source_id: string;
  quality_score: number;
  width: number;
  height: number;
  phash: bigint;
}

export interface Choice<T extends HashedPhoto> {
  accepted: Array<T & { is_primary: boolean; sort_order: number }>;
  rejected: Array<{ photo: T; reason: 'phash_dup_spot' | 'phash_dup_neighbour' | 'over_limit' }>;
}

/**
 * Picks up to 5 photos, best score first, skipping near-duplicates of an already accepted photo
 * of this spot or of a photo of a spot within 1 km (`neighbourHashes`). The primary is the best
 * hero-sized (long side ≥ 1000 px) photo, else the best photo; it gets sort_order 0.
 */
export function choosePhotos<T extends HashedPhoto>(photos: T[], neighbourHashes: bigint[] = []): Choice<T> {
  const ordered = [...photos].sort(
    (a, b) => b.quality_score - a.quality_score || a.source_id.localeCompare(b.source_id),
  );
  const kept: T[] = [];
  const rejected: Choice<T>['rejected'] = [];
  for (const p of ordered) {
    if (kept.some((k) => hamming(k.phash, p.phash) <= DUPLICATE_HAMMING)) {
      rejected.push({ photo: p, reason: 'phash_dup_spot' });
    } else if (neighbourHashes.some((h) => hamming(h, p.phash) <= DUPLICATE_HAMMING)) {
      rejected.push({ photo: p, reason: 'phash_dup_neighbour' });
    } else if (kept.length >= MAX_PHOTOS_PER_SPOT) {
      rejected.push({ photo: p, reason: 'over_limit' });
    } else {
      kept.push(p);
    }
  }
  const primary = kept.find((p) => heroEligible(p)) ?? kept[0];
  const rest = kept.filter((p) => p !== primary);
  const accepted = primary
    ? [primary, ...rest].map((p, i) => ({ ...p, is_primary: p === primary, sort_order: i }))
    : [];
  return { accepted, rejected };
}
