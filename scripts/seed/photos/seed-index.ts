// Photo hints already on disk, keyed by Wikidata QID / OSM ref:
//  - beta-national/destinations.json (Wikidata items with P18 = image_file)
//  - beta-national/osm-destinations.json (OSM items with a nearby Commons file, Plan 63)
//  - osm-candidates.jsonl (OSM tags: wikimedia_commons=File:/Category:, image=…)
import fs from 'fs';
import { normaliseCategory, normaliseFileTitle } from './sources/commons.js';
import type { SpotRef, Via } from './types.js';

export interface SeedHint {
  image_file?: string;
  image_dist_m?: number;
  commons_tag?: string;
  image_tag?: string;
  municipality?: string;
  province?: string;
}

export interface SeedIndex {
  byQid: Map<string, SeedHint>;
  byOsm: Map<string, SeedHint>;
}

/** 'osm-n25767747' → 'node/25767747' (w → way, r → relation). */
export function osmKeyToRef(key: string): string | null {
  const m = /^osm-([nwr])(\d+)$/.exec(key);
  if (!m) return null;
  return `${{ n: 'node', w: 'way', r: 'relation' }[m[1] as 'n' | 'w' | 'r']}/${m[2]}`;
}

function merge(map: Map<string, SeedHint>, key: string, hint: SeedHint): void {
  const cur: Record<string, unknown> = { ...(map.get(key) ?? {}) };
  for (const [k, v] of Object.entries(hint)) if (v !== undefined && v !== '' && cur[k] === undefined) cur[k] = v;
  map.set(key, cur as SeedHint);
}

export function loadSeedIndex(files: {
  destinations?: string;
  osmDestinations?: string;
  osmCandidates?: string;
}): SeedIndex {
  const idx: SeedIndex = { byQid: new Map(), byOsm: new Map() };
  if (files.destinations && fs.existsSync(files.destinations)) {
    const d = JSON.parse(fs.readFileSync(files.destinations, 'utf8')) as {
      items: Array<{ qid: string; image_file?: string; municipality?: string; province?: string }>;
    };
    for (const it of d.items)
      merge(idx.byQid, it.qid, { image_file: it.image_file, municipality: it.municipality, province: it.province });
  }
  if (files.osmDestinations && fs.existsSync(files.osmDestinations)) {
    const d = JSON.parse(fs.readFileSync(files.osmDestinations, 'utf8')) as {
      items: Array<{
        key: string;
        image_file?: string;
        photo_dist_m?: number;
        municipality?: string;
        province?: string;
      }>;
    };
    for (const it of d.items) {
      const ref = osmKeyToRef(it.key);
      if (ref)
        merge(idx.byOsm, ref, {
          image_file: it.image_file,
          image_dist_m: it.photo_dist_m,
          municipality: it.municipality,
          province: it.province,
        });
    }
  }
  if (files.osmCandidates && fs.existsSync(files.osmCandidates)) {
    for (const line of fs.readFileSync(files.osmCandidates, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const o = JSON.parse(line) as {
        external_refs: { osm?: string; wikidata?: string };
        municipality?: string;
        field_sources?: { osm_tags?: Record<string, string> };
      };
      const t = o.field_sources?.osm_tags ?? {};
      const hint: SeedHint = { commons_tag: t.wikimedia_commons, image_tag: t.image, municipality: o.municipality };
      if (!hint.commons_tag && !hint.image_tag) continue;
      if (o.external_refs.osm) merge(idx.byOsm, o.external_refs.osm, hint);
      if (o.external_refs.wikidata) merge(idx.byQid, o.external_refs.wikidata, hint);
    }
  }
  return idx;
}

export interface SeedLinks {
  files: Array<{ title: string; via: Via }>;
  categories: Array<{ category: string; via: Via }>;
  /** Files Plan 63 found by proximity: still need the distinctive-name check. */
  geoFiles: Array<{ title: string; distance_m: number | null }>;
  context: string[];
}

/** Links for one spot from the on-disk hints (Wikidata P18/P373 from the API are added by discover). */
export function seedLinks(spot: SpotRef, idx: SeedIndex): SeedLinks {
  const out: SeedLinks = { files: [], categories: [], geoFiles: [], context: [] };
  const hints: Array<[SeedHint, 'qid' | 'osm']> = [];
  if (spot.wikidata && idx.byQid.has(spot.wikidata)) hints.push([idx.byQid.get(spot.wikidata)!, 'qid']);
  if (spot.osm && idx.byOsm.has(spot.osm)) hints.push([idx.byOsm.get(spot.osm)!, 'osm']);
  const addFile = (title: string | null, via: Via) => {
    if (title && !out.files.some((f) => f.title === title)) out.files.push({ title, via });
  };
  for (const [h, kind] of hints) {
    if (h.image_file) {
      const t = normaliseFileTitle(h.image_file);
      if (t && kind === 'qid') addFile(t, 'wikidata_p18');
      else if (t) out.geoFiles.push({ title: t, distance_m: h.image_dist_m ?? null });
    }
    for (const tag of [h.commons_tag, h.image_tag]) {
      if (!tag) continue;
      for (const part of tag.split(';')) {
        const p = part.trim();
        if (/^category:/i.test(p)) {
          const c = normaliseCategory(p);
          if (c && !out.categories.some((x) => x.category === c))
            out.categories.push({ category: c, via: 'osm_category_tag' });
        } else addFile(normaliseFileTitle(p), 'osm_file_tag');
      }
    }
    for (const c of [h.municipality, h.province]) if (c && !out.context.includes(c)) out.context.push(c);
  }
  return out;
}
