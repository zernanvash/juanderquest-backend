// Combines the Commons hits for one spot into a de-duplicated, screened candidate list.
import { distinctiveTokens, fold, nameMatches } from './names.js';
import { screenCandidates, viaRank } from './quality.js';
import { haversineM } from './select.js';
import { pageToCandidate, type CommonsPage } from './sources/commons.js';
import type { PhotoCandidate, SpotRef, Via } from './types.js';

export interface CommonsHits {
  /** Files linked by name: Wikidata P18, OSM file tags. */
  named: Array<{ page: CommonsPage; via: Via }>;
  /** Members of the item's Commons category (P373) or OSM Category: tag. */
  category: Array<{ page: CommonsPage; via: Via }>;
  /** Proximity hits (Commons geosearch, Plan 63 nearby files): need the distinctive name. */
  geo: CommonsPage[];
}

function distanceTo(spot: SpotRef, page: CommonsPage): number | null {
  const c = page.coordinates?.[0];
  return c ? Math.round(haversineM(spot.lat, spot.lng, c.lat, c.lon)) : null;
}

export function geoHaystack(c: Pick<PhotoCandidate, 'title' | 'description' | 'categories'>): string {
  return `${c.title.replace(/^File:/, '')} ${c.description} ${c.categories.join(' ')}`;
}

/**
 * Distinctive-name test for a proximity hit. The file name may carry the name alone; a caption
 * or category only counts when it also carries the spot's type word ("Tapuac Viewpoint" must not
 * match every file in the barangay category "Tapuac, Dagupan"; "Hundred Islands National Park"
 * still matches its own category). Names without a type word match categories as before.
 */
export function geoNameMatches(
  spot: Pick<SpotRef, 'name'>,
  c: Pick<PhotoCandidate, 'title' | 'description' | 'categories'>,
  context: string[] = [],
): boolean {
  if (nameMatches(spot.name, c.title.replace(/^File:/, ''), context)) return true;
  const distinct = new Set(distinctiveTokens(spot.name, context));
  if (distinct.size === 0) return false;
  const typeWords = fold(spot.name)
    .split(' ')
    .filter((w) => w.length >= 3 && !distinct.has(w) && !STOP.has(w));
  return [c.description, ...c.categories].some((text) => {
    if (!nameMatches(spot.name, text, context)) return false;
    if (typeWords.length === 0) return true;
    const words = new Set(fold(text).split(' '));
    return typeWords.some((w) => words.has(w));
  });
}

const STOP = new Set(['the', 'and', 'of', 'de', 'del', 'ng', 'sa']);

/** `context`: the spot's town/province names, which never count as its distinctive name. */
export function buildCommonsCandidates(spot: SpotRef, hits: CommonsHits, context: string[] = []): PhotoCandidate[] {
  const byId = new Map<string, PhotoCandidate>();
  const put = (c: PhotoCandidate | null) => {
    if (!c) return;
    const prev = byId.get(c.source_id);
    if (!prev || viaRank(c.via) > viaRank(prev.via)) byId.set(c.source_id, c);
  };
  for (const h of hits.named) put(pageToCandidate(h.page, h.via, distanceTo(spot, h.page)));
  for (const h of hits.category) put(pageToCandidate(h.page, h.via, distanceTo(spot, h.page)));
  for (const page of hits.geo) {
    const c = pageToCandidate(page, 'geosearch', distanceTo(spot, page));
    if (!c) continue;
    if (!byId.has(c.source_id) && !geoNameMatches(spot, c, context)) c.rejected = c.rejected ?? 'geo_name_mismatch';
    put(c);
  }
  return screenCandidates([...byId.values()]);
}
