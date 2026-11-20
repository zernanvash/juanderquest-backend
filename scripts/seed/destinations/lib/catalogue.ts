// Plan 116 destinations: turn merged source groups into catalogue rows (pure; no I/O).

import type { CommonsImage, Enrichment, WikidataEntity } from '../enrich-wikidata.js';
import { distanceMeters, islandGroupApprox, islandGroupForRegion, type IslandGroup } from './geo.js';
import { baseSlug, osmUrl, spotIdFor, wikidataUrl } from './ids.js';
import { dedupe, type MergeReason } from './merge.js';
import { computeTier, confidence, launchScore, type Tier } from './score.js';
import type { PhotoRef, SourceRecord } from './sources.js';
import { classifyOsm, classifyWikidata, type Classification } from './taxonomy.js';
import { firstSentences, isGenericName } from './text.js';

export const WIKIDATA_MAX_DISTANCE_M = 2000;
const WIKIPEDIA_LICENCE = { license: 'CC BY-SA 4.0', license_url: 'https://creativecommons.org/licenses/by-sa/4.0/' };
const NOT_A_PHOTO = /\b(map|maps|locator|location|logo|seal|flag|coat of arms|diagram|plan|sketch|icon|signature)\b/i;
const ORIGIN_RANK: Record<PhotoRef['origin'], number> = {
  wikidata_p18: 0,
  osm_wikimedia_commons: 1,
  osm_image: 2,
  commons_geosearch: 3,
};

export interface PhotoCandidate extends PhotoRef {
  usable: boolean;
  reject_reason?: string;
  width?: number;
  height?: number;
  mime?: string;
  licence?: string | null;
  licence_raw?: string;
  author?: string;
  page_url: string;
}

export interface CatalogueRow {
  id: string;
  slug_base: string;
  refs: { osm?: string; wikidata?: string; osm_alt?: string[] };
  name: string;
  description: string;
  category: Classification['category'];
  subcategory: string;
  tags: string[];
  lat: number;
  lng: number;
  source_name: string;
  source_url: string;
  hints: {
    municipality?: string;
    province?: string;
    region?: string;
    island_group: IslandGroup;
    island_group_source: string;
  };
  confidence: number;
  confidence_reasons: string[];
  computed_tier: Tier;
  tier_reasons: string[];
  launch_score: number;
  heritage: string[];
  photo_candidates: PhotoCandidate[];
  field_sources: Record<string, unknown>;
  osm_tags: Record<string, string> | null;
  inputs: string[];
}

export interface BuildStats {
  source_records: number;
  wikidata_dropped_far: number;
  wikidata_dropped_not_place: number;
  wikidata_missing_entity: number;
  groups: number;
  merges: Record<MergeReason, number>;
  excluded: Record<string, number>;
  rows: number;
}

function photoCandidate(ref: PhotoRef, img: CommonsImage | undefined): PhotoCandidate {
  const title = img?.title ?? ref.title;
  const page_url =
    img?.page_url ?? `https://commons.wikimedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`;
  const base: PhotoCandidate = { ...ref, title, usable: true, page_url };
  if (img && img.missing) return { ...base, usable: false, reject_reason: 'missing_on_commons' };
  if (img) {
    Object.assign(base, {
      width: img.width,
      height: img.height,
      mime: img.mime,
      licence: img.licence ?? null,
      licence_raw: img.licence_raw,
      author: img.author,
    });
    if (!img.licence) return { ...base, usable: false, reject_reason: `licence:${img.licence_raw || 'unknown'}` };
    if (img.mime && !/^image\/(jpeg|png|webp|tiff)$/.test(img.mime))
      return { ...base, usable: false, reject_reason: `mime:${img.mime}` };
    if (img.width && img.height && Math.max(img.width, img.height) / Math.min(img.width, img.height) > 3)
      return { ...base, usable: false, reject_reason: 'aspect>3' };
  }
  if (NOT_A_PHOTO.test(title.replace(/^File:/, ''))) return { ...base, usable: false, reject_reason: 'not_a_photo' };
  return base;
}

function longSide(p: PhotoCandidate | undefined): number | null {
  return p && p.width && p.height ? Math.max(p.width, p.height) : null;
}

function capitalise(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

function pickPrimaryOsm(records: SourceRecord[]): SourceRecord | undefined {
  const typeRank = (ref?: string) => (ref?.startsWith('node/') ? 0 : ref?.startsWith('way/') ? 1 : 2);
  return records
    .filter((r) => r.source === 'osm')
    .sort(
      (a, b) =>
        Number(b.fullTags) - Number(a.fullTags) ||
        Number(Boolean(b.wikidata)) - Number(Boolean(a.wikidata)) ||
        Object.keys(b.tags).length - Object.keys(a.tags).length ||
        typeRank(a.osm) - typeRank(b.osm) ||
        String(a.osm).localeCompare(String(b.osm)),
    )[0];
}

// Wikidata classes that are not places: OSM memorials/markers often point `wikidata` at the person or event
// they commemorate (that belongs in subject:wikidata). Such a link would import a biography as the description.
export const NOT_A_PLACE = new Set([
  'Q5', // human
  'Q178561', // battle
  'Q1190554', // occurrence
  'Q1656682', // event
  'Q13418847', // historical event
  'Q645883', // military operation
  'Q831663', // military campaign
  'Q198', // war
  'Q180684', // conflict
  'Q8065', // natural disaster
  'Q3839081', // disaster
  'Q43229', // organization
  'Q4830453', // business
  'Q16521', // taxon
  'Q2085381', // publisher
  'Q7278', // political party
]);

/** True when an OSM feature's wikidata link can be trusted as "this place" (has coordinates, is a place). */
export function entityIsPlace(e: WikidataEntity | undefined): boolean {
  return Boolean(e && e.coord && !e.instance_of.some((c) => NOT_A_PLACE.has(c)));
}

/**
 * Drops an OSM feature's wikidata tag when the item's coordinates are > 2 km away (Plan 46 §5.3), or when
 * the item has no coordinates or is not a place (a person, an event …).
 */
export function checkWikidataDistance(records: SourceRecord[], entities: Record<string, WikidataEntity>) {
  let far = 0;
  let notPlace = 0;
  const flags = new Map<SourceRecord, string>();
  for (const r of records) {
    if (r.source !== 'osm' || !r.wikidata) continue;
    const e = entities[r.wikidata];
    if (!entityIsPlace(e)) {
      r.wikidata = undefined;
      r.wikipediaTitle = undefined; // the OSM wikipedia tag names the same person/event
      notPlace++;
      continue;
    }
    const d = distanceMeters(r, e!.coord!);
    if (d > WIKIDATA_MAX_DISTANCE_M) {
      flags.set(r, `wikidata_far:${r.wikidata}:${Math.round(d)}m`);
      r.wikidata = undefined;
      r.wikipediaTitle = undefined;
      far++;
    }
  }
  return { far, notPlace, flags };
}

export function buildCatalogue(
  records: SourceRecord[],
  enrichment: Enrichment,
): { rows: CatalogueRow[]; stats: BuildStats } {
  const { far, notPlace, flags } = checkWikidataDistance(records, enrichment.entities);
  const { groups, merges } = dedupe(records);
  const excluded: Record<string, number> = {};
  const exclude = (why: string) => (excluded[why] = (excluded[why] ?? 0) + 1);
  let missingEntity = 0;
  const rows: CatalogueRow[] = [];

  for (const g of groups) {
    const recs = g.map((i) => records[i]);
    const primary = pickPrimaryOsm(recs);
    const wdRec = recs.find((r) => r.source === 'wikidata');
    const qid = recs.map((r) => r.wikidata).find(Boolean);
    const entity = qid ? enrichment.entities[qid] : undefined;
    if (qid && !entity) missingEntity++;
    const heritage = [...(entity?.heritage ?? [])];
    const osmHeritage = recs.map((r) => r.tags.heritage).find(Boolean);
    if (osmHeritage && !heritage.length) heritage.push(`OSM heritage=${osmHeritage}`);

    // Classification: OSM tags first, then the Plan 63 classification of the beta inputs.
    let cls: Classification | null = null;
    if (primary?.fullTags) cls = classifyOsm(primary.tags);
    const betaRec = recs.find((r) => r.category);
    if (!cls && betaRec) cls = classifyWikidata(betaRec.category!, betaRec.subcategory ?? '', heritage.length > 0);
    if (cls && betaRec?.input === 'beta-osm' && !primary?.fullTags)
      cls = { ...cls, strong: cls.category === 'nature_outdoors' };
    // D6: an otherwise excluded OSM feature stays only when Wikidata records a heritage designation.
    if (!cls && entity?.heritage.length)
      cls = { category: 'culture_heritage', subcategory: 'heritage_site', kind: 'heritage', strong: true };
    if (!cls) {
      exclude(primary?.fullTags ? 'osm_not_destination' : 'unclassified');
      continue;
    }

    const name = (primary?.name || entity?.label_en || wdRec?.name || '').trim();
    if (!name) {
      exclude('no_name');
      continue;
    }
    const point = primary ?? wdRec ?? recs[0];
    const osmRefs = [...new Set(recs.map((r) => r.osm).filter((x): x is string => Boolean(x)))];
    const refs: CatalogueRow['refs'] = {};
    if (primary?.osm) refs.osm = primary.osm;
    if (qid) refs.wikidata = qid;
    const alt = osmRefs.filter((r) => r !== refs.osm).sort();
    if (alt.length) refs.osm_alt = alt;
    const id = spotIdFor(refs);

    // Photos: Wikidata P18, OSM wikimedia_commons/image, Plan 63 name-matched geosearch.
    const refsSeen = new Map<string, PhotoRef>();
    const addRef = (p: PhotoRef) => {
      const cur = refsSeen.get(p.title);
      if (!cur || ORIGIN_RANK[p.origin] < ORIGIN_RANK[cur.origin]) refsSeen.set(p.title, p);
    };
    for (const f of entity?.images ?? []) addRef({ title: f, origin: 'wikidata_p18' });
    for (const r of recs) for (const p of r.photos) addRef(p);
    const photos = [...refsSeen.values()]
      .map((p) => photoCandidate(p, enrichment.images[p.title]))
      .sort(
        (a, b) =>
          Number(b.usable) - Number(a.usable) ||
          ORIGIN_RANK[a.origin] - ORIGIN_RANK[b.origin] ||
          (longSide(b) ?? 0) - (longSide(a) ?? 0) ||
          a.title.localeCompare(b.title),
      );
    const best = photos.find((p) => p.usable);

    // Description: Wikipedia intro (2 sentences, CC BY-SA) or Wikidata description (CC0). Never invented.
    const wpTitle = entity?.enwiki_title ?? recs.map((r) => r.wikipediaTitle).find(Boolean);
    const wp = wpTitle ? enrichment.extracts[wpTitle] : undefined;
    const fieldSources: Record<string, unknown> = {};
    let description = '';
    let descriptionSource: 'wikipedia' | 'wikidata' | null = null;
    const wpText = wp ? firstSentences(wp.extract, 2) : '';
    if (wp && wpText.length >= 40) {
      description = wpText;
      descriptionSource = 'wikipedia';
      fieldSources.description = {
        source: 'wikipedia',
        url: wp.url,
        title: wp.title,
        ...WIKIPEDIA_LICENCE,
        attribution: `Text from the Wikipedia article "${wp.title}" (${wp.url}), CC BY-SA 4.0.`,
        retrieved_at: wp.retrieved_at,
      };
    } else {
      const wdDesc = entity?.description_en || wdRec?.wdDescription;
      if (qid && wdDesc && wdDesc.trim().split(/\s+/).length >= 3) {
        description = capitalise(wdDesc.trim());
        descriptionSource = 'wikidata';
        fieldSources.description = {
          source: 'wikidata',
          url: wikidataUrl(qid),
          license: 'CC0',
          retrieved_at: entity?.retrieved_at,
        };
      }
    }

    const nameSource = primary
      ? { source: 'openstreetmap', url: osmUrl(primary.osm!) }
      : { source: 'wikidata', url: wikidataUrl(qid!), license: 'CC0' };
    fieldSources.name = entity?.label_tl ? { ...nameSource, alt: { tl: entity.label_tl } } : nameSource;
    fieldSources.coordinates = primary
      ? { source: 'openstreetmap', url: osmUrl(primary.osm!) }
      : { source: 'wikidata', url: wikidataUrl(qid!), license: 'CC0' };
    fieldSources.category = primary?.fullTags
      ? { source: 'openstreetmap', url: osmUrl(primary.osm!), kind: cls.kind }
      : { source: qid ? 'wikidata' : 'openstreetmap', url: qid ? wikidataUrl(qid) : osmUrl(refs.osm!), kind: cls.kind };
    fieldSources.external_refs = {
      ...(refs.osm ? { osm: osmUrl(refs.osm) } : {}),
      ...(qid ? { wikidata: wikidataUrl(qid) } : {}),
      ...(alt.length ? { osm_alt: alt.map(osmUrl) } : {}),
    };
    const website = primary?.website || entity?.websites[0];
    if (website)
      fieldSources.website = {
        value: website,
        source: primary?.website ? 'openstreetmap' : 'wikidata',
        url: primary?.website ? osmUrl(primary.osm!) : wikidataUrl(qid!),
      };
    if (primary?.hours)
      fieldSources.opening_hours_osm = { value: primary.hours, source: 'openstreetmap', reviewed: false };
    if (heritage.length)
      fieldSources.heritage_designation = {
        value: heritage,
        source: entity?.heritage.length ? 'wikidata' : 'openstreetmap',
        url: entity?.heritage.length ? wikidataUrl(qid!) : osmUrl(refs.osm!),
      };
    const commonsCategory = entity?.commons_category ?? recs.map((r) => r.commonsCategory).find(Boolean);
    if (commonsCategory) fieldSources.commons_category = commonsCategory;
    fieldSources.photo_candidates = photos;

    const forceReview: string[] = [];
    const flag = recs.map((r) => flags.get(r)).find(Boolean);
    if (flag) forceReview.push(flag);
    if (recs.some((r) => r.reviewOnly)) forceReview.push('source_review_only');
    if (['private', 'no'].includes(primary?.tags.access ?? '')) forceReview.push('access_private');
    const generic = isGenericName(name);

    const conf = confidence({
      hasWikidata: Boolean(qid && entity),
      hasCommonsPhoto: Boolean(best),
      hasWikipedia: Boolean(wp),
      strongTag: cls.strong,
      hasHoursOrWebsite: Boolean(primary?.hours || website),
      genericName: generic,
    });
    const tier = computeTier({
      confidence: conf.value,
      hasPhoto: Boolean(best),
      photoLongSide: longSide(best),
      photoLicenceOk: best ? (best.licence === undefined ? null : Boolean(best.licence)) : null,
      descriptionSource,
      forceReview,
    });

    const municipality = entity?.municipality || recs.map((r) => r.municipality).find(Boolean);
    const province = entity?.province || recs.map((r) => r.province).find(Boolean);
    const region = entity?.region || recs.map((r) => r.region).find(Boolean);
    const groupFromRegion = islandGroupForRegion(region);
    const tags = [...new Set([cls.kind, ...(heritage.length ? ['heritage'] : [])].filter(Boolean))].slice(0, 6);

    rows.push({
      id,
      slug_base: baseSlug(name, municipality),
      refs,
      name: name.slice(0, 200),
      description,
      category: cls.category,
      subcategory: cls.subcategory,
      tags,
      lat: point.lat,
      lng: point.lng,
      source_name: primary ? 'OpenStreetMap' : 'Wikidata',
      source_url: primary ? osmUrl(primary.osm!) : wikidataUrl(qid!),
      hints: {
        municipality,
        province,
        region,
        island_group: groupFromRegion ?? islandGroupApprox(point.lat, point.lng),
        island_group_source: groupFromRegion ? 'region' : 'coordinates',
      },
      confidence: conf.value,
      confidence_reasons: conf.reasons,
      computed_tier: tier.tier,
      tier_reasons: tier.reasons,
      launch_score: launchScore({
        confidence: conf.value,
        photoLongSide: longSide(best),
        hasWikipedia: Boolean(wp),
        heritage: heritage.length > 0,
        sitelinks: entity?.sitelinks ?? 0,
      }),
      heritage,
      photo_candidates: photos,
      field_sources: fieldSources,
      osm_tags: primary ? (primary.tags as Record<string, string>) : null,
      inputs: [...new Set(recs.map((r) => r.input))].sort(),
    });
  }

  rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  // Two groups can only share an id if they share a primary OSM element, which dedupe already merged.
  return {
    rows,
    stats: {
      source_records: records.length,
      wikidata_dropped_far: far,
      wikidata_dropped_not_place: notPlace,
      wikidata_missing_entity: missingEntity,
      groups: groups.length,
      merges,
      excluded,
      rows: rows.length,
    },
  };
}
