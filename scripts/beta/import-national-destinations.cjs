#!/usr/bin/env node
// Beta world Phase 2: import the fetched national destinations into the BETA database only.
// Idempotent (ids are spot-wd-<qid>; conflicts are skipped). Skips anything within 200 m of an existing spot.
//
//   DATABASE_URL=... node scripts/beta/import-national-destinations.cjs --in destinations.json [--dry-run]
'use strict';
const fs = require('node:fs');
const { Client } = require('pg');

const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : fallback; };
const DRY = process.argv.includes('--dry-run');
const IN = arg('--in');

// Deterministic RNG so reruns produce the same timestamps.
function mulberry32(a) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const rand = mulberry32(Number(process.env.BETA_SEED || 20261027) + 46);

const slugify = (s) => String(s).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const cut = (s, n) => (s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`);
const metres = (a, b) => { const R = 6371000, r = Math.PI / 180; const dLat = (b.lat - a.lat) * r, dLng = (b.lng - a.lng) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLng / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); };
const SUB_LABEL = { waterfall: 'waterfall', beach: 'beach', cave: 'cave', hot_spring: 'hot spring', spring: 'spring', viewpoint: 'viewpoint', trailhead: 'mountain', lake: 'lake', island: 'island',
  park: 'park', recreation: 'attraction', museum: 'museum', church: 'church', heritage_site: 'heritage site', market: 'market' };

function sentenceCut(text, max) {
  if (text.length <= max) return text;
  const s = text.slice(0, max); const end = s.lastIndexOf('. ');
  return end > 80 ? s.slice(0, end + 1) : cut(text, max);
}

function toSpot(it, n, areaByTown) {
  const municipality = cut(it.municipality || it.province || it.region || 'Philippines', 100);
  const where = [it.municipality, it.province || it.region].filter(Boolean);
  const place = where.length ? where.join(', ') : 'the Philippines';
  let description = it.extract ? sentenceCut(it.extract, 420) : '';
  if (!description) {
    const d = (it.wd_description || '').trim();
    description = d && !/^(wikimedia|philippine historical marker)/i.test(d)
      ? `${d.charAt(0).toUpperCase()}${d.slice(1)}${/[.!?]$/.test(d) ? '' : '.'}`
      : `A ${SUB_LABEL[it.subcategory] || 'destination'} in ${place}.`;
  }
  const credit = `Photo: ${it.photo.author} · ${it.photo.license}${it.extract ? ' · Text: Wikipedia' : ''}${it.key ? ' · Map: OpenStreetMap' : ''}`;
  const created = new Date(Date.now() - (5 + rand() * 115) * 86400000);
  const isPangasinan = /pangasinan/i.test(it.province || '');
  const town = isPangasinan && it.municipality ? areaByTown.get(it.municipality.toLowerCase().replace(/^city of | city$/g, '')) : undefined;
  return {
    id: it.key ? `spot-${it.key}` : `spot-wd-${it.qid.toLowerCase()}`, slug: '', name: cut(it.name, 200), description, category: it.category, subcategory: it.subcategory,
    tags: JSON.stringify([it.subcategory, slugify(it.province || it.region || 'philippines')].filter(Boolean)),
    municipality, address: place, gps_lat: it.lat, gps_lng: it.lng, image_url: it.photo.thumb_url,
    source_type: 'open_data', source_name: cut(credit, 150), source_url: it.photo.page_url, trust_level: 'open_data', status: 'published',
    created_by: 'beta-admin', reviewed_by: 'beta-admin', reviewed_at: created.toISOString(), created_at: created.toISOString(), updated_at: created.toISOString(),
    town_area_id: town || null, _n: n,
  };
}

async function main() {
  if (!IN) throw new Error('--in <destinations.json> is required');
  const { items } = JSON.parse(fs.readFileSync(IN, 'utf8'));
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const { rows: [{ name }] } = await db.query('SELECT current_database() AS name');
  if (!/^jdq_beta/.test(name)) throw new Error(`refusing: ${name} is not a beta database`);
  const { rowCount: admin } = await db.query("SELECT 1 FROM users WHERE id = 'beta-admin'");
  if (!admin) throw new Error('beta-admin user missing; run the scrub first');

  const existing = (await db.query('SELECT id, slug, gps_lat AS lat, gps_lng AS lng FROM spots')).rows;
  const areaByTown = new Map((await db.query("SELECT id, lower(name) AS n FROM admin_areas WHERE level = 'town'")).rows.map((r) => [r.n.replace(/^city of | city$/g, ''), r.id]));
  const slugs = new Set(existing.map((s) => s.slug));
  const existingIds = new Set(existing.map((s) => s.id));
  // Spots from this same source are matched by id, everything else by distance.
  const prefix = items[0]?.key ? 'spot-osm-' : 'spot-wd-';
  const anchors = existing.filter((s) => !s.id.startsWith(prefix));

  const spots = []; let near = 0, already = 0;
  items.forEach((it, n) => {
    const s = toSpot(it, n, areaByTown);
    if (existingIds.has(s.id)) { already++; return; }
    if (anchors.some((a) => metres(a, { lat: it.lat, lng: it.lng }) < 200)) { near++; return; }
    const ref = (it.key || it.qid).toLowerCase();
    let slug = slugify(`${it.name} ${it.municipality || it.province || ''}`).slice(0, 170) || ref;
    if (slugs.has(slug)) slug = `${slug}-${ref}`.slice(0, 180);
    slugs.add(slug); s.slug = slug; spots.push(s);
  });
  const count = (k) => Object.entries(spots.reduce((a, s) => ((a[s[k]] = (a[s[k]] || 0) + 1), a), {})).sort((a, b) => b[1] - a[1]);
  console.log(`input ${items.length}; new ${spots.length}; already imported ${already}; skipped near an existing spot ${near}`);
  console.log('categories:', count('category').map(([k, v]) => `${k}:${v}`).join(' '));
  console.log('top places:', count('municipality').slice(0, 12).map(([k, v]) => `${k}:${v}`).join(' '));
  console.log('linked to Pangasinan town areas:', spots.filter((s) => s.town_area_id).length);
  if (DRY) { console.log('dry run: nothing written'); await db.end(); return; }

  const cols = ['id', 'slug', 'name', 'description', 'category', 'subcategory', 'tags', 'municipality', 'address', 'gps_lat', 'gps_lng', 'image_url',
    'source_type', 'source_name', 'source_url', 'trust_level', 'status', 'created_by', 'reviewed_by', 'reviewed_at', 'created_at', 'updated_at', 'town_area_id'];
  await db.query('BEGIN');
  try {
    let inserted = 0;
    for (let i = 0; i < spots.length; i += 300) {
      const part = spots.slice(i, i + 300); const values = [];
      const sql = part.map((s, r) => `(${cols.map((c, j) => { values.push(s[c]); return `$${r * cols.length + j + 1}`; }).join(',')})`).join(',');
      const res = await db.query(`INSERT INTO spots (${cols.join(',')}) VALUES ${sql} ON CONFLICT DO NOTHING`, values);
      inserted += res.rowCount;
    }
    await db.query('COMMIT');
    const { rows: [t] } = await db.query("SELECT count(*)::int AS all, count(*) FILTER (WHERE id LIKE 'spot-wd-%')::int AS national FROM spots");
    console.log(`inserted ${inserted}; spots now ${t.all} (${t.national} national)`);
  } catch (e) { await db.query('ROLLBACK'); throw e; } finally { await db.end(); }
}
main().catch((e) => { console.error(e.message); process.exitCode = 1; });
