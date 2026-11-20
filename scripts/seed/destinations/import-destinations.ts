// Plan 116 §8 / Plan 46 §5.5–5.8: import the national destination catalogue into spots + spot_provenance.
//
// Usage (WSL; dry-run is the default):
//   DATABASE_URL=… npx tsx scripts/seed/destinations/import-destinations.ts --wave <name> [--region <psgc>]
//       [--dry-run | --apply] [--reassign-areas] [--areas-complete] [--catalogue <file>]
//
//  * One transaction per run. --dry-run executes exactly the same SQL and rolls back, then records a
//    'dry-run' seed_runs row. --apply commits and records an 'apply' seed_runs row.
//  * Upsert by external_refs (osm, then wikidata). Existing non-imported spots (editorial / community / LGU /
//    the 90 carried spots) win every conflict: a candidate whose normalised name has trigram similarity
//    ≥ 0.6 within 300 m merges into such a spot, and only its external_refs (missing keys) and
//    spot_provenance (external_refs / photo_candidates / import_meta keys) change. Never name, text, status…
//  * Imported spots (spot_provenance.field_sources.import_meta.origin = 'national-import') are updated on
//    re-import only while reviewed_at IS NULL; reviewed ones only get external_refs/provenance merges.
//  * Every write is guarded with IS DISTINCT FROM, so a second --apply reports 0 changes.
//  * --region <psgc>: only catalogue rows whose town (by area assignment) has that PSGC region prefix.
//  * --reassign-areas: skip the catalogue; recompute areas and tiers for every imported spot (run again after
//    the national admin areas are loaded, with --areas-complete).
//  * Areas + tiers always run for every imported spot (featured quota is per province, top 40 by
//    launch_score; featured also needs a town; see lib/areas-sql.ts for the area rules).
//  * New ids/slugs: see lib/ids.ts (osm-n123 / wd-q123; slug = name[-town], -2/-3 on collision).

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Client, type ClientBase } from 'pg';
import { areaAssignSql, PSGC_REGION_PREFIX_SQL, psgcRegionPrefix } from './lib/areas-sql.js';
import type { CatalogueRow } from './lib/catalogue.js';
import { assignSlugs } from './lib/ids.js';
import { arg, flag, paths, readJson, readJsonl, writeJson } from './lib/io.js';
import { confidenceBucket } from './lib/score.js';

export const FEATURED_QUOTA_PER_PROVINCE = 40;
const ORIGIN = 'national-import';
const IMPORTED = `p.field_sources->'import_meta'->>'origin' = '${ORIGIN}'`;

export interface ImportOptions {
  wave: string;
  region?: string;
  apply: boolean;
  reassignOnly: boolean;
  areasComplete: boolean;
  rows: CatalogueRow[];
  log?: (msg: string) => void;
}

export interface ImportStats {
  run_id: string;
  mode: 'dry-run' | 'apply';
  wave: string;
  region: string | null;
  catalogue_rows: number;
  staged: number;
  region_excluded: number;
  matched_by_ref: { osm: number; wikidata: number };
  merged_into_existing: Array<{
    spot_id: string;
    spot_name: string;
    candidate: string;
    similarity: number;
    meters: number;
  }>;
  near_existing_to_review: number;
  id_conflicts: string[];
  inserted: number;
  updated_imported: number;
  existing_refs_merged: number;
  provenance_changed: number;
  area_changes: number;
  tier_changes: number;
  by_category: Record<string, number>;
  confidence_histogram: Record<string, number>;
  computed_tiers: Record<string, number>;
  final_tiers: Record<string, number>;
  area_status: Record<string, number>;
  samples: Record<string, Array<Record<string, unknown>>>;
  seconds: number;
}

const countBy = <T>(xs: T[], f: (x: T) => string) =>
  xs.reduce<Record<string, number>>((a, x) => ((a[f(x)] = (a[f(x)] ?? 0) + 1), a), {});

async function stage(client: ClientBase, rows: CatalogueRow[]) {
  await client.query(`CREATE TEMP TABLE dest_stage (
    id text PRIMARY KEY, osm text, wikidata text, osm_alt jsonb, slug_base text, name text, description text,
    category text, subcategory text, tags jsonb, lat float8, lng float8, source_name text, source_url text,
    municipality_hint text, computed_tier text, launch_score real, confidence real, field_sources jsonb,
    osm_tags jsonb, geog geography(Point, 4326), match_id text, match_kind text, near_existing boolean DEFAULT false
  ) ON COMMIT DROP`);
  for (let i = 0; i < rows.length; i += 500) {
    const batch = rows.slice(i, i + 500).map((r) => ({
      id: r.id,
      osm: r.refs.osm ?? null,
      wikidata: r.refs.wikidata ?? null,
      osm_alt: r.refs.osm_alt ?? null,
      slug_base: r.slug_base,
      name: r.name,
      description: r.description,
      category: r.category,
      subcategory: r.subcategory,
      tags: r.tags,
      lat: r.lat,
      lng: r.lng,
      source_name: r.source_name,
      source_url: r.source_url,
      municipality_hint: r.hints.municipality ?? null,
      computed_tier: r.computed_tier,
      launch_score: r.launch_score,
      confidence: r.confidence,
      field_sources: r.field_sources,
      osm_tags: r.osm_tags,
    }));
    await client.query(
      `INSERT INTO dest_stage (id, osm, wikidata, osm_alt, slug_base, name, description, category, subcategory, tags,
         lat, lng, source_name, source_url, municipality_hint, computed_tier, launch_score, confidence, field_sources,
         osm_tags, geog)
       SELECT id, osm, wikidata, osm_alt, slug_base, name, description, category, subcategory, tags, lat, lng,
              source_name, source_url, municipality_hint, computed_tier, launch_score, confidence, field_sources,
              osm_tags, ST_SetSRID(ST_MakePoint(lng, lat), 4326)::geography
         FROM jsonb_to_recordset($1::jsonb) AS x(id text, osm text, wikidata text, osm_alt jsonb, slug_base text,
              name text, description text, category text, subcategory text, tags jsonb, lat float8, lng float8,
              source_name text, source_url text, municipality_hint text, computed_tier text, launch_score real,
              confidence real, field_sources jsonb, osm_tags jsonb)`,
      [JSON.stringify(batch)],
    );
  }
}

async function upsertCatalogue(client: ClientBase, opts: ImportOptions, runId: string, stats: ImportStats) {
  const log = opts.log ?? (() => undefined);
  await stage(client, opts.rows);
  if (opts.region) {
    const prefix = psgcRegionPrefix(opts.region);
    for (const sql of areaAssignSql('dest_stage', 'stage_areas', opts.areasComplete)) await client.query(sql);
    const del = await client.query(
      `DELETE FROM dest_stage s WHERE NOT EXISTS (
         SELECT 1 FROM stage_areas x JOIN admin_areas t ON t.id = x.town_id
          WHERE x.id = s.id AND ${PSGC_REGION_PREFIX_SQL('t.psgc_code')} = $1)`,
      [prefix],
    );
    stats.region_excluded = del.rowCount ?? 0;
  }
  stats.staged = Number((await client.query('SELECT count(*) FROM dest_stage')).rows[0].count);
  log(`staged ${stats.staged} (region excluded ${stats.region_excluded})`);

  // 1. Match by external refs.
  const byOsm = await client.query(
    `UPDATE dest_stage s SET match_id = sp.id, match_kind = 'osm' FROM spots sp
      WHERE s.osm IS NOT NULL AND sp.external_refs->>'osm' = s.osm`,
  );
  const byWd = await client.query(
    `UPDATE dest_stage s SET match_id = sp.id, match_kind = 'wikidata' FROM spots sp
      WHERE s.match_id IS NULL AND s.wikidata IS NOT NULL AND sp.external_refs->>'wikidata' = s.wikidata`,
  );
  stats.matched_by_ref = { osm: byOsm.rowCount ?? 0, wikidata: byWd.rowCount ?? 0 };

  // 2. Fuzzy match against existing non-imported spots (they win): trigram ≥ 0.6 and ≤ 300 m, one-to-one.
  const pairs = await client.query(
    `SELECT s.id AS stage_id, s.name AS stage_name, sp.id AS spot_id, sp.name AS spot_name,
            similarity(f_unaccent(lower(s.name)), f_unaccent(lower(sp.name))) AS sim,
            ST_Distance(s.geog, sp.geog) AS meters,
            (sp.external_refs ? 'osm' OR sp.external_refs ? 'wikidata') AS has_refs
       FROM dest_stage s
       JOIN spots sp ON ST_DWithin(s.geog, sp.geog, 300)
       LEFT JOIN spot_provenance p ON p.spot_id = sp.id
      WHERE s.match_id IS NULL AND NOT sp.is_test AND sp.geog IS NOT NULL
        AND COALESCE(p.field_sources->'import_meta'->>'origin', '') <> '${ORIGIN}'
        AND similarity(f_unaccent(lower(s.name)), f_unaccent(lower(sp.name))) >= 0.6
      ORDER BY sim DESC, meters ASC, s.id, sp.id`,
  );
  const refMatched = new Set(
    (await client.query('SELECT DISTINCT match_id FROM dest_stage WHERE match_id IS NOT NULL')).rows.map(
      (r) => r.match_id as string,
    ),
  );
  const takenSpot = new Set<string>(refMatched);
  const takenStage = new Set<string>();
  const merges: Array<{ stage_id: string; spot_id: string }> = [];
  const near = new Set<string>();
  for (const p of pairs.rows) {
    if (takenStage.has(p.stage_id)) continue;
    if (takenSpot.has(p.spot_id) || p.has_refs) {
      near.add(p.stage_id);
      continue;
    }
    takenSpot.add(p.spot_id);
    takenStage.add(p.stage_id);
    merges.push({ stage_id: p.stage_id, spot_id: p.spot_id });
    stats.merged_into_existing.push({
      spot_id: p.spot_id,
      spot_name: p.spot_name,
      candidate: `${p.stage_id} (${p.stage_name})`,
      similarity: Math.round(Number(p.sim) * 100) / 100,
      meters: Math.round(Number(p.meters)),
    });
  }
  for (const id of takenStage) near.delete(id);
  if (merges.length)
    await client.query(
      `UPDATE dest_stage s SET match_id = m.spot_id, match_kind = 'fuzzy'
         FROM jsonb_to_recordset($1::jsonb) AS m(stage_id text, spot_id text) WHERE s.id = m.stage_id`,
      [JSON.stringify(merges)],
    );
  if (near.size)
    await client.query(`UPDATE dest_stage SET near_existing = true WHERE id = ANY($1::text[])`, [[...near]]);
  stats.near_existing_to_review = near.size;

  // Which matched spots are imported (ours) vs existing (protected)?
  await client.query(`ALTER TABLE dest_stage ADD COLUMN target_imported boolean, ADD COLUMN target_reviewed boolean`);
  await client.query(
    `UPDATE dest_stage s SET target_imported = COALESCE(p.field_sources->'import_meta'->>'origin', '') = '${ORIGIN}',
            target_reviewed = sp.reviewed_at IS NOT NULL
       FROM spots sp LEFT JOIN spot_provenance p ON p.spot_id = sp.id
      WHERE sp.id = s.match_id`,
  );

  // Refs a candidate may add: only keys the spot lacks and no other spot holds (unique indexes).
  const refsToAdd = `jsonb_strip_nulls(jsonb_build_object(
      'osm', CASE WHEN s.osm IS NOT NULL AND NOT (sp.external_refs ? 'osm')
                   AND NOT EXISTS (SELECT 1 FROM spots o WHERE o.external_refs->>'osm' = s.osm AND o.id <> sp.id)
                  THEN s.osm END,
      'wikidata', CASE WHEN s.wikidata IS NOT NULL AND NOT (sp.external_refs ? 'wikidata')
                   AND NOT EXISTS (SELECT 1 FROM spots o WHERE o.external_refs->>'wikidata' = s.wikidata AND o.id <> sp.id)
                  THEN s.wikidata END))`;

  // 3. Existing (protected) spots: merge missing refs only.
  const ex = await client.query(
    `UPDATE spots sp SET external_refs = sp.external_refs || ${refsToAdd}
       FROM dest_stage s
      WHERE s.match_id = sp.id AND NOT s.target_imported
        AND (sp.external_refs || ${refsToAdd}) IS DISTINCT FROM sp.external_refs`,
  );
  stats.existing_refs_merged = ex.rowCount ?? 0;

  // 4. Imported spots: refresh open-data fields while nobody has reviewed them.
  const up = await client.query(
    `UPDATE spots sp SET name = s.name, description = s.description, category = s.category,
            subcategory = s.subcategory, tags = s.tags, gps_lat = s.lat, gps_lng = s.lng,
            source_name = s.source_name, source_url = s.source_url,
            external_refs = (sp.external_refs - 'osm_alt') || ${refsToAdd}
                            || CASE WHEN s.osm_alt IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('osm_alt', s.osm_alt) END,
            updated_at = now()
       FROM dest_stage s
      WHERE s.match_id = sp.id AND s.target_imported AND NOT s.target_reviewed
        AND (sp.name, sp.description, sp.category, sp.subcategory, sp.tags, sp.gps_lat, sp.gps_lng,
             sp.source_name, sp.source_url,
             (sp.external_refs - 'osm_alt') || ${refsToAdd}
               || CASE WHEN s.osm_alt IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('osm_alt', s.osm_alt) END)
            IS DISTINCT FROM
            (s.name::varchar, s.description, s.category::varchar, s.subcategory::varchar, s.tags, s.lat, s.lng,
             s.source_name::varchar, s.source_url, sp.external_refs)`,
  );
  const upReviewed = await client.query(
    `UPDATE spots sp SET external_refs = sp.external_refs || ${refsToAdd}
       FROM dest_stage s
      WHERE s.match_id = sp.id AND s.target_imported AND s.target_reviewed
        AND (sp.external_refs || ${refsToAdd}) IS DISTINCT FROM sp.external_refs`,
  );
  stats.updated_imported = (up.rowCount ?? 0) + (upReviewed.rowCount ?? 0);

  // 5. New spots.
  const fresh = (
    await client.query(`SELECT id, slug_base FROM dest_stage WHERE match_id IS NULL ORDER BY id`)
  ).rows.map((r) => ({ id: r.id as string, base: r.slug_base as string }));
  const idTaken = new Set(
    (await client.query('SELECT id FROM spots WHERE id = ANY($1::text[])', [fresh.map((f) => f.id)])).rows.map(
      (r) => r.id as string,
    ),
  );
  stats.id_conflicts = [...idTaken];
  const toInsert = fresh.filter((f) => !idTaken.has(f.id));
  const taken = new Set((await client.query('SELECT slug FROM spots')).rows.map((r) => r.slug as string));
  const slugs = assignSlugs(toInsert, taken);
  if (toInsert.length) {
    const ins = await client.query(
      `INSERT INTO spots (id, slug, name, description, category, subcategory, tags, municipality, address,
              gps_lat, gps_lng, hours, amenities, image_url, source_type, source_name, source_url, trust_level,
              status, launch_tier, external_refs)
       SELECT s.id, m.slug, s.name, s.description, s.category, s.subcategory, s.tags, COALESCE(s.municipality_hint, ''),
              '', s.lat, s.lng, '{}'::jsonb, '[]'::jsonb, '', 'open_data', s.source_name, s.source_url, 'open_data',
              CASE WHEN s.near_existing OR s.computed_tier = 'review' THEN 'needs_review' ELSE 'published' END,
              CASE WHEN s.near_existing THEN 'review' WHEN s.computed_tier = 'featured' THEN 'standard' ELSE s.computed_tier END,
              jsonb_strip_nulls(jsonb_build_object('osm', s.osm,
                'wikidata', CASE WHEN NOT EXISTS (SELECT 1 FROM spots o WHERE o.external_refs->>'wikidata' = s.wikidata)
                                 THEN s.wikidata END, 'osm_alt', s.osm_alt))
         FROM dest_stage s JOIN jsonb_to_recordset($1::jsonb) AS m(id text, slug text) ON m.id = s.id`,
      [JSON.stringify([...slugs].map(([id, slug]) => ({ id, slug })))],
    );
    stats.inserted = ins.rowCount ?? 0;
  }
  await client.query(
    `UPDATE dest_stage s SET match_id = s.id, target_imported = true, target_reviewed = false
      WHERE s.match_id IS NULL AND s.id <> ALL($1::text[])`,
    [stats.id_conflicts],
  );

  // 6. Provenance. Imported spots: full record. Existing spots: only our keys merged in.
  const meta = `jsonb_build_object('origin', CASE WHEN s.target_imported THEN '${ORIGIN}' ELSE 'merged_existing' END,
      'candidate_id', s.id,
      'match_kind', COALESCE(p.field_sources->'import_meta'->>'match_kind', s.match_kind, 'new'),
      'computed_tier', s.computed_tier,
      'launch_score', s.launch_score, 'near_existing', s.near_existing)`;
  const fs = `CASE WHEN s.target_imported THEN s.field_sources || jsonb_build_object('import_meta',
                   COALESCE(p.field_sources->'import_meta', '{}'::jsonb) || ${meta})
              ELSE COALESCE(p.field_sources, '{}'::jsonb) || jsonb_build_object(
                   'external_refs', s.field_sources->'external_refs',
                   'photo_candidates', s.field_sources->'photo_candidates',
                   'import_meta', COALESCE(p.field_sources->'import_meta', '{}'::jsonb) || ${meta}) END`;
  const prov = await client.query(
    `WITH src AS (
       SELECT s.match_id AS spot_id, ${fs} AS field_sources,
              CASE WHEN s.target_imported THEN s.osm_tags ELSE COALESCE(p.osm_tags, s.osm_tags) END AS osm_tags,
              s.confidence AS import_confidence,
              CASE WHEN s.target_imported THEN $1 ELSE COALESCE(p.import_wave, $1) END AS import_wave
         FROM dest_stage s LEFT JOIN spot_provenance p ON p.spot_id = s.match_id
        WHERE s.match_id IS NOT NULL)
     INSERT INTO spot_provenance AS t (spot_id, field_sources, osm_tags, import_confidence, import_wave, seed_run_id)
     SELECT spot_id, field_sources, osm_tags, import_confidence, import_wave, $2 FROM src
     ON CONFLICT (spot_id) DO UPDATE SET field_sources = EXCLUDED.field_sources, osm_tags = EXCLUDED.osm_tags,
            import_confidence = EXCLUDED.import_confidence, import_wave = EXCLUDED.import_wave,
            seed_run_id = EXCLUDED.seed_run_id, updated_at = now()
      WHERE (t.field_sources, t.osm_tags, t.import_confidence, t.import_wave) IS DISTINCT FROM
            (EXCLUDED.field_sources, EXCLUDED.osm_tags, EXCLUDED.import_confidence, EXCLUDED.import_wave)`,
    [opts.wave, runId],
  );
  stats.provenance_changed = prov.rowCount ?? 0;
}

/** Areas + final tiers for every imported spot (idempotent; also the --reassign-areas path). */
async function assignAreasAndTiers(client: ClientBase, opts: ImportOptions, runId: string, stats: ImportStats) {
  await client.query(`CREATE TEMP TABLE imported_pts ON COMMIT DROP AS
    SELECT sp.id, sp.geog FROM spots sp JOIN spot_provenance p ON p.spot_id = sp.id WHERE ${IMPORTED}`);
  for (const sql of areaAssignSql('imported_pts', 'imported_areas', opts.areasComplete)) await client.query(sql);
  stats.area_status = Object.fromEntries(
    (await client.query('SELECT area_status, count(*)::int n FROM imported_areas GROUP BY 1 ORDER BY 1')).rows.map(
      (r) => [r.area_status, r.n],
    ),
  );
  const areas = await client.query(
    `UPDATE spots sp SET town_area_id = a.town_id, barangay_area_id = a.barangay_id,
            province_area_id = a.province_id, region_area_id = a.region_id, updated_at = now()
       FROM imported_areas a
      WHERE a.id = sp.id
        AND (sp.town_area_id, sp.barangay_area_id, sp.province_area_id, sp.region_area_id)
            IS DISTINCT FROM (a.town_id, a.barangay_id, a.province_id, a.region_id)`,
  );
  stats.area_changes = areas.rowCount ?? 0;
  const tiers = await client.query(
    `WITH base AS (
       SELECT sp.id, a.area_status, COALESCE(a.province_id, a.town_id) AS quota_area, t.display_name AS town_name,
              t.name AS town_plain, p.field_sources->'import_meta'->>'computed_tier' AS ct,
              COALESCE((p.field_sources->'import_meta'->>'near_existing')::boolean, false) AS near,
              COALESCE((p.field_sources->'import_meta'->>'launch_score')::real, 0) AS score
         FROM spots sp JOIN spot_provenance p ON p.spot_id = sp.id
         JOIN imported_areas a ON a.id = sp.id
         LEFT JOIN admin_areas t ON t.id = a.town_id
        WHERE ${IMPORTED} AND sp.reviewed_at IS NULL),
     ranked AS (
       SELECT b.*, CASE WHEN b.ct = 'featured' AND NOT b.near AND b.area_status IN ('covered', 'nearest_2km')
                   THEN row_number() OVER (PARTITION BY b.quota_area,
                        (b.ct = 'featured' AND NOT b.near AND b.area_status IN ('covered', 'nearest_2km'))
                        ORDER BY b.score DESC, b.id) END AS rk
         FROM base b),
     final AS (
       SELECT id, town_name, town_plain, area_status,
              CASE WHEN near OR area_status = 'unmatched' OR ct = 'review' OR ct IS NULL THEN 'review'
                   WHEN ct = 'featured' AND rk <= ${FEATURED_QUOTA_PER_PROVINCE} THEN 'featured'
                   ELSE 'standard' END AS tier
         FROM ranked)
     UPDATE spots sp SET launch_tier = f.tier,
            status = CASE WHEN f.tier = 'review' THEN 'needs_review' ELSE 'published' END,
            municipality = CASE WHEN f.area_status IN ('covered', 'nearest_2km')
                                THEN COALESCE(f.town_plain, sp.municipality) ELSE sp.municipality END,
            updated_at = now()
       FROM final f
      WHERE f.id = sp.id
        AND (sp.launch_tier, sp.status, sp.municipality) IS DISTINCT FROM
            (f.tier, CASE WHEN f.tier = 'review' THEN 'needs_review' ELSE 'published' END,
             CASE WHEN f.area_status IN ('covered', 'nearest_2km') THEN COALESCE(f.town_plain, sp.municipality)
                  ELSE sp.municipality END)`,
  );
  stats.tier_changes = tiers.rowCount ?? 0;
  const meta = await client.query(
    `UPDATE spot_provenance p SET field_sources = jsonb_set(p.field_sources, '{import_meta,area_status}', to_jsonb(a.area_status)),
            seed_run_id = $1, updated_at = now()
       FROM imported_areas a
      WHERE a.id = p.spot_id AND ${IMPORTED}
        AND p.field_sources->'import_meta'->>'area_status' IS DISTINCT FROM a.area_status`,
    [runId],
  );
  stats.provenance_changed += meta.rowCount ?? 0;
}

async function summarise(client: ClientBase, runId: string, stats: ImportStats) {
  const rows = (
    await client.query(
      `SELECT sp.id, sp.name, sp.category, sp.subcategory, sp.launch_tier, sp.municipality, sp.town_area_id,
              sp.province_area_id, sp.external_refs, p.import_confidence,
              p.field_sources->'import_meta'->>'computed_tier' AS computed_tier,
              p.field_sources->'import_meta'->>'area_status' AS area_status,
              md5(sp.id || $1) AS shuffle
         FROM spots sp JOIN spot_provenance p ON p.spot_id = sp.id WHERE ${IMPORTED}`,
      [runId],
    )
  ).rows;
  stats.by_category = countBy(rows, (r) => `${r.category}/${r.subcategory}`);
  stats.confidence_histogram = countBy(rows, (r) => confidenceBucket(Number(r.import_confidence)));
  stats.computed_tiers = countBy(rows, (r) => String(r.computed_tier));
  stats.final_tiers = countBy(rows, (r) => String(r.launch_tier));
  const shuffled = [...rows].sort((a, b) => (a.shuffle < b.shuffle ? -1 : 1));
  for (const tier of ['featured', 'standard', 'review'])
    stats.samples[tier] = shuffled
      .filter((r) => r.launch_tier === tier)
      .slice(0, 20)
      .map((r) => ({
        id: r.id,
        name: r.name,
        category: `${r.category}/${r.subcategory}`,
        confidence: Number(r.import_confidence),
        town: r.town_area_id ?? r.municipality ?? '',
        refs: r.external_refs,
      }));
}

export async function runImport(client: ClientBase, opts: ImportOptions): Promise<ImportStats> {
  const started = Date.now();
  const runId = `dest-${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}-${randomUUID().slice(0, 8)}`;
  const stats: ImportStats = {
    run_id: runId,
    mode: opts.apply ? 'apply' : 'dry-run',
    wave: opts.wave,
    region: opts.region ?? null,
    catalogue_rows: opts.reassignOnly ? 0 : opts.rows.length,
    staged: 0,
    region_excluded: 0,
    matched_by_ref: { osm: 0, wikidata: 0 },
    merged_into_existing: [],
    near_existing_to_review: 0,
    id_conflicts: [],
    inserted: 0,
    updated_imported: 0,
    existing_refs_merged: 0,
    provenance_changed: 0,
    area_changes: 0,
    tier_changes: 0,
    by_category: {},
    confidence_histogram: {},
    computed_tiers: {},
    final_tiers: {},
    area_status: {},
    samples: {},
    seconds: 0,
  };
  const startedAt = new Date();
  await client.query('BEGIN');
  try {
    if (!opts.reassignOnly) await upsertCatalogue(client, opts, runId, stats);
    await assignAreasAndTiers(client, opts, runId, stats);
    await summarise(client, runId, stats);
    stats.seconds = Math.round((Date.now() - started) / 100) / 10;
    const record = `INSERT INTO seed_runs (id, wave, region_psgc, mode, stats, started_at, finished_at)
                    VALUES ($1, $2, $3, $4, $5::jsonb, $6, now())`;
    const { samples: _samples, ...compact } = stats;
    const params = [runId, opts.wave, opts.region ?? null, stats.mode, JSON.stringify(compact), startedAt];
    if (opts.apply) {
      await client.query(record, params);
      await client.query('COMMIT');
    } else {
      await client.query('ROLLBACK');
      await client.query(record, params);
    }
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  }
  return stats;
}

async function main() {
  const wave = arg('--wave');
  if (!wave || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(wave)) throw new Error('--wave <name> is required ([a-z0-9._-])');
  const apply = flag('--apply');
  if (apply && flag('--dry-run')) throw new Error('choose --dry-run or --apply');
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('set DATABASE_URL (owner URL of the target work DB)');
  const db = new URL(url);
  if (!['127.0.0.1', 'localhost'].includes(db.hostname)) throw new Error('loopback hosts only');
  if (db.port === '55433') throw new Error('refusing the live production container (55433)');
  const reassignOnly = flag('--reassign-areas');
  const cataloguePath = arg('--catalogue') ?? paths.catalogue;
  if (!reassignOnly && !existsSync(cataloguePath)) throw new Error(`missing catalogue ${cataloguePath}`);
  const rows = reassignOnly ? [] : await readJsonl<CatalogueRow>(cataloguePath);

  const client = new Client({ connectionString: url, application_name: 'jdq-import-destinations' });
  await client.connect();
  try {
    const stats = await runImport(client, {
      wave,
      region: arg('--region'),
      apply,
      reassignOnly,
      areasComplete: flag('--areas-complete'),
      rows,
      log: (m) => console.log(`[import] ${m}`),
    });
    const catStats = readJson<Record<string, unknown>>(paths.catalogueStats, {});
    const report = { db: db.pathname.slice(1), within_import_merges: catStats.merges ?? null, ...stats };
    const out = join(paths.reports, `import-${stats.mode}-${wave}${stats.region ? `-${stats.region}` : ''}.json`);
    writeJson(out, report);
    const { samples, merged_into_existing, ...head } = report;
    console.log(JSON.stringify(head, null, 1));
    console.log(`[import] merged into existing spots: ${merged_into_existing.length}`);
    for (const m of merged_into_existing)
      console.log(`  ${m.spot_id} <= ${m.candidate} sim=${m.similarity} ${m.meters}m`);
    for (const [tier, list] of Object.entries(samples)) {
      console.log(`[import] samples ${tier}:`);
      for (const s of list) console.log(`  ${s.id} | ${s.name} | ${s.category} | ${s.confidence} | ${s.town}`);
    }
    console.log(`[import] report: ${out}`);
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error(`[import] failed: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
}
