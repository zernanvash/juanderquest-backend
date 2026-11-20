// Plan 116 destinations: stable ids and slugs for imported spots.
//
// Id rule (new spots only; existing ids never change):
//   - primary OSM element present → `osm-<n|w|r><id>`   e.g. node/21717872 → osm-n21717872
//   - Wikidata only                → `wd-<qid lower>`    e.g. Q122958743   → wd-q122958743
//   The importer first looks a candidate up by external_refs (osm, then wikidata), so a spot keeps its id
//   even if a later run adds an OSM element to a Wikidata-only spot.
// Slug rule (new spots only; existing slugs never change):
//   base = slugify(name), plus `-<slugify(town)>` when a town hint is known and not already in the name;
//   on a collision with any slug in the DB or earlier in the same run (candidates ordered by id) append
//   `-2`, `-3`, … The importer assigns slugs in id order, so the same DB state gives the same slugs.

import { slugify } from './text.js';

const OSM_PREFIX: Record<string, string> = { node: 'n', way: 'w', relation: 'r' };

export function parseOsmRef(ref: string | null | undefined): { type: 'node' | 'way' | 'relation'; id: string } | null {
  const m = /^(node|way|relation)\/(\d+)$/.exec(String(ref ?? ''));
  return m ? { type: m[1] as 'node' | 'way' | 'relation', id: m[2] } : null;
}

/** osmium export keys: n123 / w123 / r123, or a123 for areas (even = way id×2, odd = relation id×2+1). */
export function osmRefFromOsmiumKey(key: string): string | null {
  const m = /^(?:osm-)?([nwra])(\d+)$/.exec(String(key ?? '').toLowerCase());
  if (!m) return null;
  if (m[1] === 'n') return `node/${m[2]}`;
  if (m[1] === 'w') return `way/${m[2]}`;
  if (m[1] === 'r') return `relation/${m[2]}`;
  const area = BigInt(m[2]);
  return area % 2n === 0n ? `way/${area / 2n}` : `relation/${(area - 1n) / 2n}`;
}

export function osmUrl(ref: string): string {
  return `https://www.openstreetmap.org/${ref}`;
}

export function wikidataUrl(qid: string): string {
  return `https://www.wikidata.org/wiki/${qid}`;
}

export function spotIdFor(refs: { osm?: string; wikidata?: string }): string {
  const osm = parseOsmRef(refs.osm);
  if (osm) return `osm-${OSM_PREFIX[osm.type]}${osm.id}`;
  if (refs.wikidata && /^Q\d+$/.test(refs.wikidata)) return `wd-${refs.wikidata.toLowerCase()}`;
  throw new Error('spotIdFor needs an osm or wikidata ref');
}

export function baseSlug(name: string, town: string | null | undefined): string {
  const n = slugify(name) || 'place';
  const t = slugify(town ?? '');
  if (!t || n.includes(t)) return n;
  return slugify(`${n}-${t}`) || n;
}

/** Assigns unique slugs in the given order; `taken` holds every slug already in the DB (mutated). */
export function assignSlugs(items: Array<{ id: string; base: string }>, taken: Set<string>): Map<string, string> {
  const out = new Map<string, string>();
  for (const item of [...items].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    let slug = item.base;
    for (let i = 2; taken.has(slug); i++) slug = `${item.base.slice(0, 76)}-${i}`;
    taken.add(slug);
    out.set(item.id, slug);
  }
  return out;
}
