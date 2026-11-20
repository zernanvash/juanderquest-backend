// Plan 116 destinations: load the reused inputs into one record shape.
//   1. ~/jdq-seed/osm-candidates.jsonl            (13,946 OSM features, Plan 46 §5.1 tag list, full tags)
//   2. ~/jdq-seed/beta-national/osm-destinations.json  (Plan 63: OSM features + name-matched Commons photo)
//   3. ~/jdq-seed/beta-national/destinations.json      (Plan 63: Wikidata items + P18 + Wikipedia + admin hints)

//   4. ~/jdq-seed/beta-national/osm/dest.geojsonseq   (Plan 63 pbf export; only §5.1 features missing from 1.)

import { createReadStream, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { insidePhilippines } from './geo.js';
import { representativePoint, type Geometry } from './geom.js';
import { osmRefFromOsmiumKey } from './ids.js';
import { readJson, readJsonl, paths } from './io.js';
import type { Tags } from './taxonomy.js';

export interface PhotoRef {
  title: string; // "File:…"
  origin: 'wikidata_p18' | 'osm_wikimedia_commons' | 'osm_image' | 'commons_geosearch';
  distance_m?: number;
}

export interface SourceRecord {
  source: 'osm' | 'wikidata';
  input: 'osm-candidates' | 'osm-supplement' | 'beta-osm' | 'beta-wikidata';
  osm?: string;
  wikidata?: string;
  name: string;
  lat: number;
  lng: number;
  tags: Tags; // OSM tags (partial for beta-osm, empty for Wikidata)
  fullTags: boolean;
  category?: string; // beta classification (beta inputs only)
  subcategory?: string;
  wdDescription?: string;
  wikipediaTitle?: string; // en article title when the input names one
  photos: PhotoRef[];
  commonsCategory?: string;
  website?: string;
  hours?: string;
  municipality?: string;
  province?: string;
  region?: string;
  reviewOnly?: boolean;
}

export function firstQid(value: string | undefined): string | undefined {
  const m = /\bQ\d+\b/.exec(String(value ?? ''));
  return m ? m[0] : undefined;
}

/** Commons file title from an OSM `image` / `wikimedia_commons` value, or null when it isn't on Commons. */
export function commonsFileTitle(value: string | undefined): string | null {
  const v = String(value ?? '').trim();
  if (!v) return null;
  if (/^file:/i.test(v)) return `File:${v.slice(5).replace(/_/g, ' ').trim()}`;
  let m = /commons\.wikimedia\.org\/wiki\/(?:File|Image):([^?#]+)/i.exec(v);
  if (m) return `File:${safeDecode(m[1]).replace(/_/g, ' ')}`;
  m = /upload\.wikimedia\.org\/wikipedia\/commons\/(?:thumb\/)?[0-9a-f]\/[0-9a-f]{2}\/([^/?#]+)/i.exec(v);
  if (m) return `File:${safeDecode(m[1]).replace(/_/g, ' ')}`;
  return null;
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function enTitle(value: string | undefined): string | undefined {
  const m = /^en:(.+)$/.exec(String(value ?? '').trim());
  return m ? m[1].replace(/_/g, ' ') : undefined;
}

function articleTitle(url: string | undefined): string | undefined {
  const m = /en\.wikipedia\.org\/wiki\/([^?#]+)/.exec(String(url ?? ''));
  return m ? safeDecode(m[1]).replace(/_/g, ' ') : undefined;
}

interface CandidateRow {
  external_refs: { osm: string; wikidata?: string };
  name: string;
  municipality?: string;
  gps_lat: number;
  gps_lng: number;
  official_website?: string;
  wikipedia?: string;
  review_only?: boolean;
  field_sources: { osm_tags?: Tags };
}

interface BetaOsmItem {
  key: string;
  name: string;
  lat: number;
  lng: number;
  category: string;
  subcategory: string;
  osm_tags?: Record<string, string>;
  image_file?: string;
  photo_dist_m?: number;
  municipality?: string;
  province?: string;
  region?: string;
}

interface BetaWikidataItem {
  qid: string;
  name: string;
  wd_description?: string;
  lat: number;
  lng: number;
  image_file?: string;
  article?: string;
  category: string;
  subcategory: string;
  municipality?: string;
  province?: string;
  region?: string;
}

export function fromCandidate(row: CandidateRow): SourceRecord | null {
  const tags = row.field_sources?.osm_tags ?? {};
  const name = (row.name || tags.name || '').trim();
  if (!name || !insidePhilippines(row.gps_lat, row.gps_lng)) return null;
  const photos: PhotoRef[] = [];
  const wc = tags.wikimedia_commons;
  const wcFile = wc && /^file:/i.test(wc) ? commonsFileTitle(wc) : null;
  if (wcFile) photos.push({ title: wcFile, origin: 'osm_wikimedia_commons' });
  const img = commonsFileTitle(tags.image);
  if (img) photos.push({ title: img, origin: 'osm_image' });
  return {
    source: 'osm',
    input: 'osm-candidates',
    osm: row.external_refs.osm,
    wikidata: firstQid(tags.wikidata ?? row.external_refs.wikidata),
    name,
    lat: row.gps_lat,
    lng: row.gps_lng,
    tags,
    fullTags: true,
    wikipediaTitle: enTitle(tags.wikipedia ?? row.wikipedia),
    photos,
    commonsCategory: wc && /^category:/i.test(wc) ? wc.replace(/^category:/i, 'Category:') : undefined,
    website: tags.website || tags['contact:website'] || row.official_website || undefined,
    hours: tags.opening_hours || undefined,
    municipality: tags['addr:city'] || tags['addr:town'] || tags['addr:municipality'] || row.municipality || undefined,
    province: tags['addr:province'] || tags['is_in:province'] || undefined,
    reviewOnly: Boolean(row.review_only),
  };
}

export function fromBetaOsm(item: BetaOsmItem): SourceRecord | null {
  const osm = osmRefFromOsmiumKey(item.key);
  if (!osm || !item.name || !insidePhilippines(item.lat, item.lng)) return null;
  const tags: Tags = {};
  for (const [k, v] of Object.entries(item.osm_tags ?? {})) if (v) tags[k] = v;
  return {
    source: 'osm',
    input: 'beta-osm',
    osm,
    name: item.name,
    lat: item.lat,
    lng: item.lng,
    tags,
    fullTags: false,
    category: item.category,
    subcategory: item.subcategory,
    photos: item.image_file
      ? [{ title: `File:${item.image_file}`, origin: 'commons_geosearch', distance_m: item.photo_dist_m }]
      : [],
    municipality: item.municipality,
    province: item.province,
    region: item.region,
  };
}

export function fromBetaWikidata(item: BetaWikidataItem): SourceRecord | null {
  if (!/^Q\d+$/.test(item.qid) || !item.name || !insidePhilippines(item.lat, item.lng)) return null;
  return {
    source: 'wikidata',
    input: 'beta-wikidata',
    wikidata: item.qid,
    name: item.name,
    lat: item.lat,
    lng: item.lng,
    tags: {},
    fullTags: false,
    category: item.category,
    subcategory: item.subcategory,
    wdDescription: item.wd_description,
    wikipediaTitle: articleTitle(item.article),
    photos: item.image_file ? [{ title: `File:${item.image_file}`, origin: 'wikidata_p18' }] : [],
    municipality: item.municipality,
    province: item.province,
    region: item.region,
  };
}

// Plan 46 §5.1 tags the 2026-10-21 candidate extract missed (OSM maps most waterfalls as waterway=waterfall).
const SUPPLEMENT_HISTORIC = new Set([
  'monument',
  'memorial',
  'ruins',
  'castle',
  'fort',
  'archaeological_site',
  'heritage',
]);
export function isSupplementFeature(tags: Tags): boolean {
  return (
    tags.waterway === 'waterfall' ||
    ['theme_park', 'zoo', 'aquarium'].includes(tags.tourism ?? '') ||
    SUPPLEMENT_HISTORIC.has(tags.historic ?? '') ||
    tags.boundary === 'national_park'
  );
}

interface GeoFeature {
  id: string;
  geometry: Geometry;
  properties?: Record<string, string>;
}

/** A feature from the Plan 63 pbf export (beta-national/osm/dest.geojsonseq) that is in scope but not a candidate. */
export function fromSupplementFeature(f: GeoFeature, known: Set<string>): SourceRecord | null {
  const tags: Tags = { ...(f.properties ?? {}) };
  const osm = osmRefFromOsmiumKey(f.id);
  if (!osm || known.has(osm) || !tags.name || !isSupplementFeature(tags)) return null;
  const pt = representativePoint(f.geometry);
  if (!pt || !insidePhilippines(pt[1], pt[0])) return null;
  const row = fromCandidate({
    external_refs: { osm },
    name: tags.name,
    gps_lat: pt[1],
    gps_lng: pt[0],
    field_sources: { osm_tags: tags },
  });
  return row ? { ...row, input: 'osm-supplement' } : null;
}

export async function loadSources(): Promise<{ records: SourceRecord[]; skipped: Record<string, number> }> {
  const skipped: Record<string, number> = {};
  const records: SourceRecord[] = [];
  const push = (r: SourceRecord | null, input: string) => {
    if (r) records.push(r);
    else skipped[input] = (skipped[input] ?? 0) + 1;
  };
  for (const row of await readJsonl<CandidateRow>(paths.osmCandidates)) push(fromCandidate(row), 'osm-candidates');
  if (existsSync(paths.osmExport)) {
    const known = new Set(records.map((r) => r.osm).filter((x): x is string => Boolean(x)));
    const rl = createInterface({ input: createReadStream(paths.osmExport), crlfDelay: Infinity });
    for await (const line of rl) {
      const t = line.replace(/^\u001e/, '').trim();
      if (!t) continue;
      const r = fromSupplementFeature(JSON.parse(t) as GeoFeature, known);
      if (r) {
        known.add(r.osm!);
        records.push(r);
      }
    }
  }
  for (const item of readJson<{ items: BetaOsmItem[] }>(paths.betaOsm).items) push(fromBetaOsm(item), 'beta-osm');
  for (const item of readJson<{ items: BetaWikidataItem[] }>(paths.betaWikidata).items)
    push(fromBetaWikidata(item), 'beta-wikidata');
  return { records, skipped };
}
