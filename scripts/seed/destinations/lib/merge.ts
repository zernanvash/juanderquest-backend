// Plan 116 destinations: within-import dedupe (Plan 46 §5.5).
//   - same OSM element or same Wikidata item → one place;
//   - near-identical names (normalised equal or trigram ≥ 0.8) within 150 m → one place;
//   - a Wikidata-only item and an OSM feature without a wikidata tag, trigram ≥ 0.6 within 300 m → one place
//     (Wikidata coordinates are often a few hundred metres off the OSM geometry);
//   - never merge two different Wikidata items.

import { distanceMeters } from './geo.js';
import { normaliseName, trigramSimilarity } from './text.js';

export interface MergeInput {
  osm?: string;
  wikidata?: string;
  source: 'osm' | 'wikidata';
  name: string;
  lat: number;
  lng: number;
}

export type MergeReason = 'same_osm' | 'same_wikidata' | 'near_identical_name' | 'wikidata_to_osm';

export const NEAR_IDENTICAL = { similarity: 0.8, meters: 150 };
export const WIKIDATA_TO_OSM = { similarity: 0.6, meters: 300 };
const CELL = 0.003; // degrees, ≈ 330 m

export function dedupe(records: MergeInput[]): { groups: number[][]; merges: Record<MergeReason, number> } {
  const parent = records.map((_, i) => i);
  const qid = records.map((r) => r.wikidata ?? null);
  const merges: Record<MergeReason, number> = {
    same_osm: 0,
    same_wikidata: 0,
    near_identical_name: 0,
    wikidata_to_osm: 0,
  };
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const union = (a: number, b: number, reason: MergeReason): boolean => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return false;
    if (qid[ra] && qid[rb] && qid[ra] !== qid[rb]) return false;
    parent[rb] = ra;
    qid[ra] = qid[ra] ?? qid[rb];
    merges[reason]++;
    return true;
  };

  const byKey = (key: 'osm' | 'wikidata', reason: MergeReason) => {
    const first = new Map<string, number>();
    records.forEach((r, i) => {
      const k = r[key];
      if (!k) return;
      const f = first.get(k);
      if (f === undefined) first.set(k, i);
      else union(f, i, reason);
    });
  };
  byKey('osm', 'same_osm');
  byKey('wikidata', 'same_wikidata');

  const norm = records.map((r) => normaliseName(r.name));
  const cells = new Map<string, number[]>();
  const cellOf = (lat: number, lng: number) => `${Math.floor(lat / CELL)}:${Math.floor(lng / CELL)}`;
  records.forEach((r, i) => {
    const k = cellOf(r.lat, r.lng);
    const list = cells.get(k);
    if (list) list.push(i);
    else cells.set(k, [i]);
  });
  records.forEach((r, i) => {
    const cy = Math.floor(r.lat / CELL);
    const cx = Math.floor(r.lng / CELL);
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        for (const j of cells.get(`${cy + dy}:${cx + dx}`) ?? []) {
          if (j <= i || find(i) === find(j)) continue;
          const o = records[j];
          const d = distanceMeters(r, o);
          if (d > WIKIDATA_TO_OSM.meters) continue;
          const sim = norm[i] === norm[j] ? 1 : trigramSimilarity(norm[i], norm[j]);
          if (sim >= NEAR_IDENTICAL.similarity && d <= NEAR_IDENTICAL.meters) {
            union(i, j, 'near_identical_name');
            continue;
          }
          const wdOnly = (x: MergeInput) => x.source === 'wikidata' && !x.osm;
          const osmNoWd = (x: MergeInput) => x.source === 'osm' && !x.wikidata;
          if (sim >= WIKIDATA_TO_OSM.similarity && ((wdOnly(r) && osmNoWd(o)) || (wdOnly(o) && osmNoWd(r))))
            union(i, j, 'wikidata_to_osm');
        }
      }
  });

  const groups = new Map<number, number[]>();
  records.forEach((_, i) => {
    const root = find(i);
    const g = groups.get(root);
    if (g) g.push(i);
    else groups.set(root, [i]);
  });
  return { groups: [...groups.values()], merges };
}
