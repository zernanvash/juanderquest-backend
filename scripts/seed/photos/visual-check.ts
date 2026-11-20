// Owner visual-check sheet: N random accepted catalog photos (seeded, reproducible) as an HTML
// page with thumbnails + a CSV. Thumbnails are relative paths into <PHOTO_ROOT>/media (local
// storage), so open reports/visual-check.html from the photo root (e.g. \\wsl$\…\photos\reports).
//
//   DATABASE_URL=… npx tsx scripts/seed/photos/visual-check.ts [--n 50] [--seed 116]
import fs from 'fs';
import path from 'path';
import { argValue, REPORTS_DIR } from './config.js';
import { CATALOG_SOURCES, pool } from './db.js';
import { scopeFromArgs } from './scope.js';
import { LOCAL_URL_PREFIX } from './storage.js';

const args = process.argv.slice(2);
const N = Number(argValue(args, '--n', '50'));
const SEED = Number(argValue(args, '--seed', '116'));

/** Deterministic shuffle (mulberry32) so the sheet can be regenerated identically. */
export function seededSample<T>(items: T[], n: number, seed: number): T[] {
  let a = seed >>> 0;
  const rnd = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.slice(0, n);
}

const esc = (s: unknown) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
const csvCell = (v: unknown) => {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

async function main() {
  const db = pool();
  const rows = (
    await db.query(
      `SELECT a.id, a.spot_id, s.name AS spot_name, s.municipality, a.source, a.source_id, a.license, a.license_url,
              a.author, a.attribution_url, a.width, a.height, a.quality_score, a.is_primary, a.sort_order, a.variants,
              a.dominant_color, a.blurhash, s.gps_lat AS lat, s.gps_lng AS lng,
              s.external_refs->>'wikidata' AS wikidata, s.external_refs->>'osm' AS osm
         FROM spot_assets a JOIN spots s ON s.id = a.spot_id
        WHERE a.source = ANY($1) AND a.status = 'approved'
        ORDER BY a.id`,
      [CATALOG_SOURCES],
    )
  ).rows;
  await db.end();
  const scope = scopeFromArgs(args);
  const inScope = scope ? rows.filter((r) => scope.test({ ...r, lat: Number(r.lat), lng: Number(r.lng) })) : rows;
  const pick = seededSample(inScope, N, SEED);
  const rel = (u: string | undefined) =>
    u?.startsWith(LOCAL_URL_PREFIX) ? `../media/${u.slice(LOCAL_URL_PREFIX.length)}` : u;
  const thumb = (v: Record<string, string>) => rel(v.w640 ?? v.w320 ?? Object.values(v)[0]) ?? '';
  const large = (v: Record<string, string>) => rel(v.w1280 ?? v.w640 ?? v.w320) ?? '';
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const cards = pick
    .map(
      (r) => `<figure style="border-top:6px solid ${esc(r.dominant_color)}">
  <a href="${esc(large(r.variants))}"><img src="${esc(thumb(r.variants))}" loading="lazy" alt=""></a>
  <figcaption><b>${esc(r.spot_name)}</b> <small>${esc(r.municipality)}${r.is_primary ? ' · PRIMARY' : ''}</small><br>
  Photo: ${esc(r.author)} · <a href="${esc(r.license_url)}">${esc(r.license)}</a><br>
  <a href="${esc(r.attribution_url)}">${esc(r.source)}: ${esc(r.source_id)}</a><br>
  <small>${r.width}×${r.height} · score ${r.quality_score} · ${esc(r.spot_id)}</small>
  <div>OK? ☐ yes ☐ wrong place ☐ poor photo</div></figcaption></figure>`,
    )
    .join('\n');
  fs.writeFileSync(
    path.join(REPORTS_DIR, 'visual-check.html'),
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Photo visual check</title>
<style>body{font:14px system-ui,sans-serif;margin:16px;background:#fafafa;color:#222}
main{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:16px}
figure{margin:0;background:#fff;border-radius:6px;overflow:hidden;box-shadow:0 1px 3px #0002}
img{width:100%;height:200px;object-fit:cover;display:block;background:#ddd}figcaption{padding:8px;line-height:1.4}
small{color:#666}</style>
<h1>Plan 116 — catalog photo visual check (${pick.length} random of ${inScope.length}${scope ? ` in ${esc(scope.label)}` : ''}, seed ${SEED})</h1>
<p>For each photo: is it the named place, and is it a decent photo? Licence and author link to the file page.</p>
<main>${cards}</main>`,
  );
  const cols = [
    'spot_id',
    'spot_name',
    'municipality',
    'is_primary',
    'source',
    'source_id',
    'license',
    'author',
    'attribution_url',
    'width',
    'height',
    'quality_score',
    'thumb',
  ];
  fs.writeFileSync(
    path.join(REPORTS_DIR, 'visual-check.csv'),
    [
      cols.join(','),
      ...pick.map((r) => cols.map((c) => csvCell(c === 'thumb' ? thumb(r.variants) : r[c])).join(',')),
    ].join('\n') + '\n',
  );
  console.log(`visual check: ${pick.length} of ${inScope.length} photos → ${REPORTS_DIR}/visual-check.{html,csv}`);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
