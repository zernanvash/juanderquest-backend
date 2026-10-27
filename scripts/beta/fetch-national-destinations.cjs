#!/usr/bin/env node
// Beta world Phase 2: fetch Philippine destinations that have a real, freely licensed photo.
// Sources: Wikidata (items, coordinates, admin location), Wikimedia Commons (photo, author, licence),
// English Wikipedia (intro text). No other sites are scraped (Plan 46 N4).
// Output: one JSON file; the DB import is a separate script (import-national-destinations.cjs).
//
//   node scripts/beta/fetch-national-destinations.cjs --out ~/jdq-seed/beta-national/destinations.json
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const UA = 'JuanderQuestBeta/0.1 (thesis research prototype; zernanvasharive16@gmail.com)';
const SPARQL = 'https://query.wikidata.org/sparql';
const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : fallback; };
const OUT = arg('--out', path.join(process.env.HOME || '.', 'jdq-seed/beta-national/destinations.json'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Wikidata class -> app category/subcategory. Earlier rows win when an item matches several.
const CLASSES = [
  ['Q34038', 'nature_outdoors', 'waterfall'], ['Q40080', 'nature_outdoors', 'beach'], ['Q35509', 'nature_outdoors', 'cave'],
  ['Q177380', 'nature_outdoors', 'hot_spring'], ['Q8072', 'nature_outdoors', 'trailhead'], ['Q8502', 'nature_outdoors', 'trailhead'],
  ['Q54050', 'nature_outdoors', 'trailhead'], ['Q23397', 'nature_outdoors', 'lake'], ['Q187223', 'nature_outdoors', 'lake'],
  ['Q23442', 'nature_outdoors', 'island'], ['Q46169', 'nature_outdoors', 'park'], ['Q179049', 'nature_outdoors', 'park'],
  ['Q473972', 'nature_outdoors', 'park'], ['Q167346', 'nature_outdoors', 'park'], ['Q1107656', 'nature_outdoors', 'park'],
  ['Q22698', 'nature_outdoors', 'park'],
  ['Q43501', 'activities_wellness', 'recreation'], ['Q2281788', 'activities_wellness', 'recreation'], ['Q194195', 'activities_wellness', 'recreation'],
  ['Q33506', 'culture_heritage', 'museum'], ['Q16970', 'culture_heritage', 'church'], ['Q32815', 'culture_heritage', 'heritage_site'],
  ['Q44539', 'culture_heritage', 'heritage_site'], ['Q697295', 'culture_heritage', 'heritage_site'], ['Q57821', 'culture_heritage', 'heritage_site'],
  ['Q23413', 'culture_heritage', 'heritage_site'], ['Q39715', 'culture_heritage', 'heritage_site'], ['Q839954', 'culture_heritage', 'heritage_site'],
  ['Q1081138', 'culture_heritage', 'heritage_site'], ['Q4989906', 'culture_heritage', 'heritage_site'], ['Q174782', 'culture_heritage', 'heritage_site'],
  ['Q570116', 'culture_heritage', 'heritage_site'],
  ['Q132510', 'shopping_local', 'market'],
];
// Historical markers and plaques are signs, not destinations.
const EXCLUDE = ['Q21562164', 'Q91783923', 'Q721747', 'Q91786784', 'Q91785391', 'Q127974541'];
const MUNICIPALITY_TYPES = new Set(['Q24764', 'Q104157', 'Q29946056', 'Q106078286', 'Q106079704', 'Q15634883']);
const PROVINCE_TYPE = 'Q24746';
const REGION_TYPE = 'Q24698';

async function sparql(query, attempt = 1) {
  const res = await fetch(`${SPARQL}?query=${encodeURIComponent(query)}`, { headers: { 'User-Agent': UA, Accept: 'application/sparql-results+json' } });
  if (res.status === 429 || res.status >= 500) {
    if (attempt > 4) throw new Error(`SPARQL ${res.status}`);
    await sleep(5000 * attempt); return sparql(query, attempt + 1);
  }
  if (!res.ok) throw new Error(`SPARQL ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()).results.bindings;
}
async function api(base, params, attempt = 1) {
  const url = `${base}?${new URLSearchParams({ format: 'json', formatversion: '2', maxlag: '5', ...params })}`;
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (res.status === 429 || res.status >= 500) {
    if (attempt > 4) throw new Error(`${base} ${res.status}`);
    await sleep(5000 * attempt); return api(base, params, attempt + 1);
  }
  const body = await res.json();
  if (body.error?.code === 'maxlag' && attempt <= 4) { await sleep(5000 * attempt); return api(base, params, attempt + 1); }
  return body;
}
const qid = (uri) => uri.slice(uri.lastIndexOf('/') + 1);
const v = (b, k) => b[k]?.value;
const stripHtml = (s) => String(s || '').replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/\s+/g, ' ').trim();
const chunk = (xs, n) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

const BASE = `?item wdt:P17 wd:Q928; wdt:P625 ?coord; wdt:P18 ?img .
  FILTER NOT EXISTS { ?item wdt:P31 ?x . VALUES ?x { ${EXCLUDE.map((q) => `wd:${q}`).join(' ')} } }
  FILTER NOT EXISTS { ?item wdt:P576 ?gone }
  OPTIONAL { ?article schema:about ?item; schema:isPartOf <https://en.wikipedia.org/> }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en,tl,ceb". }`;
const SELECT = 'SELECT ?item ?itemLabel ?itemDescription ?coord ?img ?article WHERE {';

// Admin location: walk P131 upward and pick the municipality/city, province and region.
// Labels fall back through Tagalog/Cebuano/multilingual; a bare QID is never used as a name.
async function resolveAdmin(items) {
  for (const it of items.values()) { delete it.municipality; delete it.province; delete it.region; }
  const typeSeen = new Map();
  for (const ids of chunk([...items.keys()], 150)) {
    const rows = await sparql(`SELECT ?item ?a ?aLabel ?at WHERE { VALUES ?item { ${ids.map((q) => `wd:${q}`).join(' ')} }
      ?item wdt:P131+ ?a . ?a wdt:P31 ?at . SERVICE wikibase:label { bd:serviceParam wikibase:language "en,tl,ceb,mul". } }`);
    for (const b of rows) {
      const it = items.get(qid(v(b, 'item'))); const at = qid(v(b, 'at')); const name = v(b, 'aLabel');
      typeSeen.set(at, (typeSeen.get(at) || 0) + 1);
      if (!name || /^Q\d+$/.test(name)) continue;
      if (MUNICIPALITY_TYPES.has(at) && !it.municipality) it.municipality = name;
      if (at === PROVINCE_TYPE && !it.province) it.province = name;
      if (at === REGION_TYPE && !it.region) it.region = name;
    }
    await sleep(1000);
  }
  console.log('top admin types:', [...typeSeen.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, n]) => `${k}:${n}`).join(' '));
  // Items with no P131 chain borrow the location of the nearest located item within 25 km.
  const located = [...items.values()].filter((it) => it.province || it.region);
  let borrowed = 0;
  for (const it of items.values()) {
    if (it.province || it.region) continue;
    let best = null, bestKm = 25;
    for (const o of located) { const km = Math.hypot(o.lat - it.lat, (o.lng - it.lng) * Math.cos((it.lat * Math.PI) / 180)) * 111.32; if (km < bestKm) { bestKm = km; best = o; } }
    if (best) { it.municipality = best.municipality; it.province = best.province; it.region = best.region; it.location_from = best.qid; borrowed++; }
  }
  console.log(`location borrowed from a neighbour: ${borrowed}`);
}
const cleanThumb = (url) => { try { const u = new URL(url); for (const k of [...u.searchParams.keys()]) if (k.startsWith('utm_')) u.searchParams.delete(k); return u.toString(); } catch { return url; } };

async function main() {
  if (process.argv.includes('--refresh-admin')) {
    const data = JSON.parse(fs.readFileSync(OUT, 'utf8'));
    const items = new Map(data.items.map((it) => [it.qid, it]));
    await resolveAdmin(items);
    for (const it of items.values()) it.photo.thumb_url = cleanThumb(it.photo.thumb_url);
    fs.writeFileSync(OUT, JSON.stringify({ ...data, admin_refreshed_at: new Date().toISOString(), items: [...items.values()] }, null, 1));
    const out = [...items.values()];
    console.log('provinces:', new Set(out.map((it) => it.province).filter(Boolean)).size, 'regions:', new Set(out.map((it) => it.region).filter(Boolean)).size,
      'no location:', out.filter((it) => !it.province && !it.region).length, 'no municipality:', out.filter((it) => !it.municipality).length);
    return;
  }
  const items = new Map();
  const take = (rows, category, subcategory, via) => {
    for (const b of rows) {
      const id = qid(v(b, 'item'));
      if (items.has(id)) continue;
      const m = /Point\(([-\d.]+) ([-\d.]+)\)/.exec(v(b, 'coord') || '');
      if (!m) continue;
      const lng = Number(m[1]), lat = Number(m[2]);
      if (!(lat > 4.4 && lat < 21.3 && lng > 116 && lng < 127)) continue;
      const label = v(b, 'itemLabel');
      if (!label || /^Q\d+$/.test(label)) continue;
      items.set(id, { qid: id, name: label, wd_description: v(b, 'itemDescription') || '', lat, lng,
        image_file: decodeURIComponent(v(b, 'img').split('/Special:FilePath/')[1] || '').replace(/_/g, ' '),
        article: v(b, 'article') || null, category, subcategory, via });
    }
  };
  for (const [cls, category, subcategory] of CLASSES) {
    const rows = await sparql(`${SELECT} ?item wdt:P31/wdt:P279* wd:${cls} . ${BASE} }`);
    const before = items.size; take(rows, category, subcategory, cls);
    console.log(`class ${cls} ${subcategory}: ${rows.length} rows, +${items.size - before}`);
    await sleep(1500);
  }
  const heritage = await sparql(`${SELECT} ?item wdt:P1435 ?h . ${BASE} }`);
  { const before = items.size; take(heritage, 'culture_heritage', 'heritage_site', 'P1435'); console.log(`heritage designation: ${heritage.length} rows, +${items.size - before}`); }

  await resolveAdmin(items);

  // Commons: thumbnail URL, author, licence.
  const byFile = new Map([...items.values()].map((it) => [`File:${it.image_file}`, it]));
  for (const titles of chunk([...byFile.keys()], 50)) {
    const body = await api('https://commons.wikimedia.org/w/api.php', { action: 'query', prop: 'imageinfo', iiprop: 'url|extmetadata|mime', iiurlwidth: '1024', iiextmetadatafilter: 'Artist|LicenseShortName|LicenseUrl|UsageTerms', titles: titles.join('|') });
    const norm = new Map((body.query?.normalized || []).map((n) => [n.to, n.from]));
    for (const page of body.query?.pages || []) {
      const it = byFile.get(norm.get(page.title) || page.title); const ii = page.imageinfo?.[0];
      if (!it || !ii) continue;
      const md = ii.extmetadata || {};
      it.photo = { thumb_url: cleanThumb(ii.thumburl || ii.url), page_url: ii.descriptionurl, mime: ii.mime,
        author: stripHtml(md.Artist?.value).slice(0, 80) || 'Unknown author', license: stripHtml(md.LicenseShortName?.value || md.UsageTerms?.value), license_url: md.LicenseUrl?.value || null };
    }
    await sleep(500);
  }

  // English Wikipedia intro (CC BY-SA), two sentences.
  const withArticle = [...items.values()].filter((it) => it.article);
  for (const group of chunk(withArticle, 20)) {
    const byTitle = new Map(group.map((it) => [decodeURIComponent(it.article.split('/wiki/')[1]).replace(/_/g, ' '), it]));
    const body = await api('https://en.wikipedia.org/w/api.php', { action: 'query', prop: 'extracts', exintro: '1', explaintext: '1', exsentences: '2', redirects: '1', titles: [...byTitle.keys()].join('|') });
    const alias = new Map([...(body.query?.normalized || []), ...(body.query?.redirects || [])].map((n) => [n.to, n.from]));
    for (const page of body.query?.pages || []) {
      let t = page.title; while (!byTitle.has(t) && alias.has(t)) t = alias.get(t);
      const it = byTitle.get(t); if (it && page.extract) it.extract = page.extract.replace(/\s*\([^()]*\)/g, '').replace(/\s+/g, ' ').trim();
    }
    await sleep(500);
  }

  const out = [...items.values()].filter((it) => it.photo && it.photo.license && /^image\/(jpeg|png|webp)$/.test(it.photo.mime));
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ fetched_at: new Date().toISOString(), sources: ['wikidata', 'commons', 'enwiki'], items: out }, null, 1));
  const by = (k) => Object.entries(out.reduce((a, it) => ((a[it[k] || '?'] = (a[it[k] || '?'] || 0) + 1), a), {})).sort((a, b) => b[1] - a[1]);
  console.log(`kept ${out.length} of ${items.size} (photo + licence + jpeg/png/webp)`);
  console.log('by subcategory:', by('subcategory').map(([k, n]) => `${k}:${n}`).join(' '));
  console.log('regions:', by('region').length, 'provinces:', by('province').length, 'no municipality:', out.filter((it) => !it.municipality).length, 'with wiki text:', out.filter((it) => it.extract).length);
  console.log(`wrote ${OUT}`);
}
main().catch((e) => { console.error(e.message); process.exitCode = 1; });
