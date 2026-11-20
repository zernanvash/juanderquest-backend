// Plan 116 §7: import every Philippine admin area (region, province, city/municipality,
// barangay) into admin_areas with boundaries in geom.
//
//   npx tsx scripts/seed/areas/import-areas.ts --region <psgc|all> [--dry-run|--apply]
//       [--bundle <codab-bundle.ndjson>] [--psgc <psgc.csv>] [--pangasinan <pangasinan-old.ndjson>]
//       [--report <gap-report.json>]
//
// Inputs default to ~/jdq-seed/national-116/areas/. DATABASE_URL names the target (never printed).
// --dry-run (default) runs the same per-region transaction and rolls it back, so the counts are real.
// Each region is one transaction; a second --apply changes 0 rows. Every run writes seed_runs rows.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { Pool, PoolClient } from 'pg';
import {
  AreaRow,
  LEVEL_ORDER,
  Level,
  OldArea,
  SourceFeature,
  buildPlan,
  countsByRegion,
  parsePsgcCsv,
  regionFilter,
} from './lib.js';

const DATA_VERSION = 'psgc-2026q3+codab-phl-v03';
const WAVE = 'areas-116';
const BATCH = 250;

interface Args {
  apply: boolean;
  region: string;
  bundle: string;
  psgc: string;
  pangasinan: string;
  report: string;
}

function parseArgs(argv: string[]): Args {
  const dir = path.join(os.homedir(), 'jdq-seed/national-116/areas');
  const get = (flag: string, def: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
  };
  if (argv.includes('--apply') && argv.includes('--dry-run')) throw new Error('Pass --apply or --dry-run, not both');
  return {
    apply: argv.includes('--apply'),
    region: get('--region', ''),
    bundle: get('--bundle', path.join(dir, 'codab-bundle.ndjson')),
    psgc: get('--psgc', path.join(dir, 'psgc-Q3_2026.csv')),
    pangasinan: get('--pangasinan', path.join(dir, 'pangasinan-old.ndjson')),
    report: get('--report', path.join(dir, 'gap-report.json')),
  };
}

function readNdjson<T>(file: string): T[] {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as T);
}

const TMP_DDL = `
  CREATE TEMP TABLE tmp_areas (
    ord int NOT NULL, id text PRIMARY KEY, psgc_code bigint, level text NOT NULL, name text NOT NULL,
    display_name text NOT NULL, parent_id text, has_boundary boolean, label_lat float8, label_lng float8,
    bbox float8[], min_zoom smallint NOT NULL, shape_file text, data_version text NOT NULL,
    boundary jsonb, geom geometry(MultiPolygon, 4326)
  ) ON COMMIT DROP`;

const TMP_INSERT = `
  INSERT INTO tmp_areas (ord, id, psgc_code, level, name, display_name, parent_id, has_boundary, label_lat, label_lng,
                         bbox, min_zoom, shape_file, data_version, boundary, geom)
  SELECT r.ord, r.id, r.psgc_code, r.level, r.name, r.display_name, r.parent_id, r.has_boundary, r.label_lat, r.label_lng,
         CASE WHEN r.bbox IS NULL THEN NULL ELSE ARRAY(SELECT jsonb_array_elements_text(r.bbox)::float8) END,
         r.min_zoom, r.shape_file, r.data_version, r.boundary,
         CASE WHEN r.geom IS NULL THEN NULL
              ELSE ST_Multi(ST_CollectionExtract(ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON(r.geom), 4326)), 3)) END
    FROM jsonb_to_recordset($1::jsonb) AS r(ord int, id text, psgc_code bigint, level text, name text, display_name text,
         parent_id text, has_boundary boolean, label_lat float8, label_lng float8, bbox jsonb, min_zoom smallint,
         shape_file text, data_version text, boundary jsonb, geom text)`;

// Region geometry = union of its province-level units, tiny coverage-gap holes (< ~0.01 km²) removed.
const TMP_REGION_GEOM = `
  UPDATE tmp_areas r SET geom = u.g
    FROM (SELECT ST_Multi(ST_Collect(ST_MakePolygon(ST_ExteriorRing(d.geom),
                   ARRAY(SELECT ST_ExteriorRing(h.geom) FROM ST_DumpRings(d.geom) h
                          WHERE h.path[1] > 0 AND ST_Area(h.geom) > 1e-6)))) AS g
            FROM ST_Dump((SELECT ST_Union(geom, 1e-7) FROM tmp_areas WHERE level = 'province' AND geom IS NOT NULL)) d) u
   WHERE r.level = 'region' AND u.g IS NOT NULL`;

// Derived columns for new rows (preserved Pangasinan rows already carry theirs).
const TMP_DERIVE = `
  UPDATE tmp_areas SET
    has_boundary = geom IS NOT NULL,
    label_lat = ST_Y(ST_PointOnSurface(geom)), label_lng = ST_X(ST_PointOnSurface(geom)),
    bbox = ARRAY[ST_XMin(geom), ST_YMin(geom), ST_XMax(geom), ST_YMax(geom)],
    boundary = COALESCE(boundary, ST_AsGeoJSON(ST_SimplifyPreserveTopology(geom, 0.005), 5)::jsonb)
   WHERE label_lat IS NULL AND geom IS NOT NULL`;

const UPSERT = `
  INSERT INTO admin_areas AS a (id, psgc_code, level, name, display_name, parent_id, has_boundary, label_lat, label_lng,
                                bbox, min_zoom, shape_file, data_version, boundary, geom, updated_at)
  SELECT id, psgc_code, level, name, display_name, parent_id, has_boundary, label_lat, label_lng,
         bbox, min_zoom, shape_file, data_version, boundary, geom, NOW()
    FROM tmp_areas WHERE level = $1 ORDER BY ord
  ON CONFLICT (id) DO UPDATE SET
    psgc_code = EXCLUDED.psgc_code, level = EXCLUDED.level, name = EXCLUDED.name, display_name = EXCLUDED.display_name,
    parent_id = EXCLUDED.parent_id, has_boundary = EXCLUDED.has_boundary, label_lat = EXCLUDED.label_lat,
    label_lng = EXCLUDED.label_lng, bbox = EXCLUDED.bbox, min_zoom = EXCLUDED.min_zoom, shape_file = EXCLUDED.shape_file,
    data_version = EXCLUDED.data_version, boundary = EXCLUDED.boundary, geom = EXCLUDED.geom, updated_at = NOW()
  WHERE (a.psgc_code, a.level, a.name, a.display_name, a.parent_id, a.has_boundary, a.label_lat, a.label_lng, a.bbox,
         a.min_zoom, a.shape_file, a.data_version, a.boundary, ST_AsEWKB(a.geom))
        IS DISTINCT FROM
        (EXCLUDED.psgc_code, EXCLUDED.level, EXCLUDED.name, EXCLUDED.display_name, EXCLUDED.parent_id,
         EXCLUDED.has_boundary, EXCLUDED.label_lat, EXCLUDED.label_lng, EXCLUDED.bbox, EXCLUDED.min_zoom,
         EXCLUDED.shape_file, EXCLUDED.data_version, EXCLUDED.boundary, ST_AsEWKB(EXCLUDED.geom))
  RETURNING (xmax = 0) AS inserted`;

function toTmpRecord(r: AreaRow, ord: number) {
  return {
    ord,
    id: r.id,
    psgc_code: r.psgc_code === null ? null : Number(r.psgc_code),
    level: r.level,
    name: r.name,
    display_name: r.display_name,
    parent_id: r.parent_id,
    has_boundary: r.preserved ? r.preserved.has_boundary : null,
    label_lat: r.preserved ? r.preserved.label_lat : null,
    label_lng: r.preserved ? r.preserved.label_lng : null,
    bbox: r.preserved ? r.preserved.bbox : null,
    min_zoom: r.min_zoom,
    shape_file: r.shape_file,
    data_version: r.data_version,
    boundary: r.boundary === null ? null : JSON.parse(r.boundary),
    geom: r.geom,
  };
}

type LevelStats = Record<Level, { planned: number; inserted: number; updated: number; unchanged: number }>;

async function importRegion(client: PoolClient, regionCode: string, rows: AreaRow[], apply: boolean) {
  const stats = Object.fromEntries(
    LEVEL_ORDER.map((l) => [l, { planned: 0, inserted: 0, updated: 0, unchanged: 0 }]),
  ) as LevelStats;
  await client.query('BEGIN');
  try {
    await client.query(TMP_DDL);
    const ordered = [...rows].sort((a, b) => LEVEL_ORDER.indexOf(a.level) - LEVEL_ORDER.indexOf(b.level));
    for (let i = 0; i < ordered.length; i += BATCH) {
      const chunk = ordered.slice(i, i + BATCH).map((r, j) => toTmpRecord(r, i + j));
      await client.query(TMP_INSERT, [JSON.stringify(chunk)]);
    }
    await client.query(TMP_REGION_GEOM);
    await client.query(TMP_DERIVE);
    const missing = await client.query(`SELECT id FROM tmp_areas WHERE label_lat IS NULL LIMIT 5`);
    if (missing.rowCount) throw new Error(`Rows without geometry/label: ${missing.rows.map((r) => r.id).join(', ')}`);
    for (const level of LEVEL_ORDER) {
      const res = await client.query(UPSERT, [level]);
      const planned = rows.filter((r) => r.level === level).length;
      const inserted = res.rows.filter((r) => r.inserted).length;
      const updated = res.rows.length - inserted;
      stats[level] = { planned, inserted, updated, unchanged: planned - res.rows.length };
    }
    if (apply) await client.query('COMMIT');
    else await client.query('ROLLBACK');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
  return stats;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.region) throw new Error('Pass --region <psgc|all>');
  const mode = args.apply ? 'apply' : 'dry-run';
  console.log(`=== National admin areas import (${mode.toUpperCase()}) ===`);

  const psgc = parsePsgcCsv(fs.readFileSync(args.psgc, 'utf8'));
  const features = readNdjson<SourceFeature>(args.bundle);
  const old = readNdjson<OldArea>(args.pangasinan);
  console.log(`inputs: ${psgc.length} PSGC rows, ${features.length} COD-AB features, ${old.length} preserved rows`);

  const plan = buildPlan({ psgc, features, old, dataVersion: DATA_VERSION });
  const regionRows = plan.rows.filter((r) => r.level === 'region');
  const selected = new Set(regionFilter(args.region, regionRows));
  const counts = countsByRegion(plan.rows);

  console.log('\nregion        id                              region province   town barangay');
  const total = { region: 0, province: 0, town: 0, barangay: 0 };
  for (const r of regionRows) {
    if (!selected.has(r.region)) continue;
    const c = counts.get(r.region)!;
    for (const l of LEVEL_ORDER) total[l] += c[l];
    console.log(
      `${r.region}  ${r.id.padEnd(30)} ${String(c.region).padStart(7)} ${String(c.province).padStart(8)} ${String(c.town).padStart(6)} ${String(c.barangay).padStart(8)}`,
    );
  }
  console.log(
    `${'total'.padEnd(43)} ${String(total.region).padStart(7)} ${String(total.province).padStart(8)} ${String(total.town).padStart(6)} ${String(total.barangay).padStart(8)}`,
  );
  console.log('\nmatched by:', JSON.stringify(plan.matchedBy));

  const inSel = (code: string) => selected.has(`${code.slice(0, 2)}00000000`);
  const gapsP = plan.psgcWithoutBoundary.filter((g) => inSel(g.code));
  const gapsB = plan.boundariesWithoutPsgc.filter((g) => inSel(g.code));
  const byLevel = (gs: { level: string }[]) =>
    JSON.stringify(gs.reduce<Record<string, number>>((m, g) => ((m[g.level] = (m[g.level] ?? 0) + 1), m), {}));
  console.log(`gap: PSGC entries without a boundary: ${gapsP.length} ${byLevel(gapsP)}`);
  console.log(`gap: boundaries without a PSGC entry: ${gapsB.length} ${byLevel(gapsB)}`);
  for (const g of [...gapsP, ...gapsB].filter((g) => g.level !== 'barangay').slice(0, 40)) {
    console.log(`  ${g.level} ${g.code} ${g.name} (${g.reason})`);
  }
  fs.writeFileSync(
    args.report,
    JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        data_version: DATA_VERSION,
        matched_by: plan.matchedBy,
        notes: plan.notes,
        psgc_without_boundary: gapsP,
        boundaries_without_psgc: gapsB,
      },
      null,
      1,
    ),
  );
  console.log(`gap report: ${args.report}  (${plan.notes.length} notes)`);

  if (!process.env.DATABASE_URL) {
    console.log('No DATABASE_URL; plan only.');
    return;
  }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, statement_timeout: 600_000 });
  const client = await pool.connect();
  const runId = `${WAVE}-${new Date().toISOString().replace(/[:.]/g, '')}-${randomUUID().slice(0, 8)}`;
  try {
    for (const r of regionRows) {
      if (!selected.has(r.region)) continue;
      const started = new Date();
      const rows = plan.rows.filter((x) => x.region === r.region);
      const stats = await importRegion(client, r.region, rows, args.apply);
      const changed = LEVEL_ORDER.reduce((n, l) => n + stats[l].inserted + stats[l].updated, 0);
      await client.query(
        `INSERT INTO seed_runs (id, wave, region_psgc, mode, stats, started_at, finished_at) VALUES ($1,$2,$3,$4,$5,$6,NOW())`,
        [
          `${runId}-${r.region}`,
          WAVE,
          r.region,
          mode,
          JSON.stringify({
            data_version: DATA_VERSION,
            region_id: r.id,
            levels: stats,
            changed,
            gaps: { psgc_without_boundary: gapsP.filter((g) => g.code.startsWith(r.region.slice(0, 2))).length },
          }),
          started,
        ],
      );
      const fmt = (l: Level) => `${l} +${stats[l].inserted} ~${stats[l].updated} =${stats[l].unchanged}`;
      console.log(
        `${mode} ${r.region} ${r.id}: ${LEVEL_ORDER.map(fmt).join(' | ')} (${((Date.now() - started.getTime()) / 1000).toFixed(1)} s)`,
      );
    }
    if (args.apply) await client.query('ANALYZE admin_areas');
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error('import failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
