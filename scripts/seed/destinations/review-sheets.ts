// Plan 116 §8.2: owner review sheets + featured gap report + photo-candidate hand-off for the photos agent.
// Reads the catalogue and the imported rows of the work DB (read-only queries).
// Usage (WSL): DATABASE_URL=… npx tsx scripts/seed/destinations/review-sheets.ts [--psgc <psgc csv>] [--per-tier 30]
// Outputs under ~/jdq-seed/national-116/destinations/reports/:
//   review-<luzon|visayas|mindanao>.csv  (30 featured + 30 standard + 30 review samples each, seeded shuffle)
//   featured-by-province.csv, featured-gaps.csv (provinces with < 10 featured candidates)
// and ~/jdq-seed/national-116/destinations/photo-candidates.jsonl (spot id + external refs + Commons references).
// Province/island group use the DB areas when assigned, else the Wikidata P131 / Plan 63 hints.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Client } from 'pg';
import type { CatalogueRow } from './lib/catalogue.js';
import { islandGroupForPsgcRegion, type IslandGroup } from './lib/geo.js';
import { osmUrl, wikidataUrl } from './lib/ids.js';
import { arg, paths, readJsonl, writeCsv, writeJsonl } from './lib/io.js';
import { normaliseName } from './lib/text.js';

const FEATURED_TARGET = 10;
const ALIASES: Record<string, string> = {
  sugbo: 'cebu',
  'compostela valley': 'davao de oro',
  'western samar': 'samar',
  'metro manila': 'ncr',
  'national capital region': 'ncr',
};

interface Province {
  psgc: string;
  name: string;
  group: IslandGroup | null;
}

/** Minimal CSV line parser (quoted fields, no embedded newlines in the PSGC file). */
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

export function provinceKey(name: string | undefined | null): string {
  const n = normaliseName(String(name ?? '').replace(/\(.*?\)/g, ' '))
    .replace(/\bprovince( of)?\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return ALIASES[n] ?? n;
}

function loadProvinces(file: string): Province[] {
  if (!existsSync(file)) return [];
  const lines = readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
  const head = parseCsvLine(lines[0]);
  const idx = (k: string) => head.indexOf(k);
  const out: Province[] = [];
  for (const l of lines.slice(1)) {
    const c = parseCsvLine(l);
    const level = c[idx('geographic_level')];
    const code = c[idx('psgc_code')];
    if (level === 'Prov') out.push({ psgc: code, name: c[idx('area_name')], group: islandGroupForPsgcRegion(code) });
    if (level === 'Reg' && code.startsWith('13')) out.push({ psgc: code, name: 'NCR', group: 'luzon' }); // NCR has no provinces
  }
  return out;
}

async function main() {
  const perTier = Number(arg('--per-tier') ?? 30);
  const psgcFile = arg('--psgc') ?? join(homedir(), 'jdq-seed', 'national-116', 'areas', 'psgc-Q3_2026.csv');
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('set DATABASE_URL');
  const rows = await readJsonl<CatalogueRow>(paths.catalogue);
  const provinces = loadProvinces(psgcFile);
  const byKey = new Map(provinces.map((p) => [provinceKey(p.name), p]));

  const client = new Client({ connectionString: url });
  await client.connect();
  const db = new Map<string, Record<string, string | null>>();
  let photoRows: unknown[] = [];
  try {
    const res = await client.query(
      `SELECT sp.id, sp.launch_tier, sp.status, sp.external_refs, sp.municipality, t.name AS town, pr.name AS province,
              pr.psgc_code::text AS province_psgc, p.field_sources->'import_meta'->>'candidate_id' AS candidate_id,
              p.field_sources->'import_meta'->>'origin' AS origin, p.field_sources->'photo_candidates' AS photos
         FROM spots sp JOIN spot_provenance p ON p.spot_id = sp.id
         LEFT JOIN admin_areas t ON t.id = sp.town_area_id
         LEFT JOIN admin_areas pr ON pr.id = sp.province_area_id
        WHERE p.field_sources->'import_meta' ? 'origin'
        ORDER BY sp.id`,
    );
    for (const r of res.rows) db.set(r.candidate_id, { ...r, spot_id: r.id });
    photoRows = res.rows
      .filter((r) => Array.isArray(r.photos) && r.photos.length)
      .map((r) => ({
        spot_id: r.id,
        external_refs: r.external_refs,
        launch_tier: r.launch_tier,
        origin: r.origin,
        photo_candidates: r.photos,
      }));
  } finally {
    await client.end();
  }
  writeJsonl(paths.photoCandidates, photoRows);

  const enriched = rows.map((r) => {
    const d = db.get(r.id);
    const prov = d?.province ? byKey.get(provinceKey(d.province)) : undefined;
    const hintProv =
      byKey.get(provinceKey(r.hints.province)) ??
      (provinceKey(r.hints.region) === 'ncr' ? byKey.get('ncr') : undefined);
    const province = prov ?? hintProv;
    const best = r.photo_candidates.find((p) => p.usable);
    return {
      r,
      spotId: (d?.spot_id as string) ?? r.id,
      dbTier: d?.launch_tier ?? '',
      town: (d?.town as string) ?? r.hints.municipality ?? '',
      province: province?.name ?? r.hints.province ?? '',
      provinceKnown: Boolean(province),
      provinceSource: prov ? 'admin_areas' : hintProv ? 'wikidata/beta hint' : '',
      group: (province?.group ?? r.hints.island_group) as IslandGroup,
      best,
    };
  });

  const out = paths.reports;
  const shuffle = (id: string) => createHash('md5').update(`plan116:${id}`).digest('hex');
  const header = [
    'computed_tier',
    'db_tier',
    'spot_id',
    'name',
    'town',
    'province',
    'island_group',
    'category',
    'confidence',
    'launch_score',
    'description_source',
    'description',
    'osm_url',
    'wikidata_url',
    'image_title',
    'image_page',
    'image_licence',
    'image_author',
    'image_size',
    'tier_reasons',
  ];
  for (const group of ['luzon', 'visayas', 'mindanao'] as IslandGroup[]) {
    const sheet: unknown[][] = [];
    for (const tier of ['featured', 'standard', 'review']) {
      const pick = enriched
        .filter((e) => e.group === group && e.r.computed_tier === tier)
        .sort((a, b) => (shuffle(a.r.id) < shuffle(b.r.id) ? -1 : 1))
        .slice(0, perTier);
      for (const e of pick)
        sheet.push([
          tier,
          e.dbTier,
          e.spotId,
          e.r.name,
          e.town,
          e.province,
          group,
          `${e.r.category}/${e.r.subcategory}`,
          e.r.confidence,
          e.r.launch_score,
          (e.r.field_sources.description as { source?: string } | undefined)?.source ?? '',
          e.r.description,
          e.r.refs.osm ? osmUrl(e.r.refs.osm) : '',
          e.r.refs.wikidata ? wikidataUrl(e.r.refs.wikidata) : '',
          e.best?.title ?? '',
          e.best?.page_url ?? '',
          e.best?.licence ?? '',
          e.best?.author ?? '',
          e.best?.width ? `${e.best.width}x${e.best.height}` : '',
          e.r.tier_reasons.join('; '),
        ]);
    }
    writeCsv(join(out, `review-${group}.csv`), header, sheet);
  }

  // Featured candidates per province (computed tier, before the per-province quota of 40).
  const counts = new Map<string, { featured: number; standard: number; review: number }>();
  for (const p of provinces) counts.set(p.name, { featured: 0, standard: 0, review: 0 });
  let unknownFeatured = 0;
  for (const e of enriched) {
    if (!e.provinceKnown) {
      if (e.r.computed_tier === 'featured') unknownFeatured++;
      continue;
    }
    const c = counts.get(e.province)!;
    c[e.r.computed_tier]++;
  }
  const provRows = provinces
    .map((p) => {
      const c = counts.get(p.name)!;
      return [p.name, p.psgc, p.group ?? '', c.featured, Math.min(c.featured, 40), c.standard, c.review];
    })
    .sort((a, b) => Number(b[3]) - Number(a[3]) || String(a[0]).localeCompare(String(b[0])));
  const provHeader = [
    'province',
    'psgc',
    'island_group',
    'featured_candidates',
    'featured_after_quota',
    'standard',
    'review',
  ];
  writeCsv(join(out, 'featured-by-province.csv'), provHeader, provRows);
  const gaps = provRows.filter((r) => Number(r[3]) < FEATURED_TARGET);
  writeCsv(join(out, 'featured-gaps.csv'), provHeader, gaps);
  console.log(
    JSON.stringify(
      {
        provinces: provinces.length,
        featured_candidates: enriched.filter((e) => e.r.computed_tier === 'featured').length,
        featured_province_unknown: unknownFeatured,
        provinces_below_10_featured: gaps.length,
        provinces_with_0_featured: gaps.filter((r) => Number(r[3]) === 0).length,
        photo_candidate_rows: photoRows.length,
        reports: out,
        photo_candidates: paths.photoCandidates,
      },
      null,
      1,
    ),
  );
}

main().catch((e) => {
  console.error(`[review-sheets] failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
