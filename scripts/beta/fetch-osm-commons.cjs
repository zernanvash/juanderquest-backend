#!/usr/bin/env node
// Beta world Phase 2b: named OpenStreetMap destinations (beaches, waterfalls, caves, springs, viewpoints, ...)
// matched to a real Wikimedia Commons photo. A photo is accepted only when it is geotagged near the place
// AND its file title contains the place's distinctive name. Location is OSM; photo + licence are Commons.
//
//   node scripts/beta/fetch-osm-commons.cjs --osm dest.geojsonseq --wikidata destinations.json --out osm-destinations.json
'use strict';
const fs = require('node:fs');
const readline = require('node:readline');

const UA = 'JuanderQuestBeta/0.1 (thesis research prototype; zernanvasharive16@gmail.com)';
const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : fallback; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chunk = (xs, n) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));
const stripHtml = (s) => String(s || '').replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/\s+/g, ' ').trim();
const norm = (s) => String(s).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const km = (a, b) => Math.hypot(a.lat - b.lat, (a.lng - b.lng) * Math.cos((a.lat * Math.PI) / 180)) * 111.32;

// OSM tag -> [category, subcategory, search radius m]
function classify(p) {
  const n = norm(p.name || '');
  if (p.tourism === 'attraction' && !p.historic) {
    if (/\bhot springs?\b/.test(n)) return ['nature_outdoors', 'hot_spring', 1500];
    if (/\b(falls|waterfalls?)\b/.test(n)) return ['nature_outdoors', 'waterfall', 2000];
    if (/\bbeach\b/.test(n)) return ['nature_outdoors', 'beach', 2000];
    if (/\bcaves?\b/.test(n)) return ['nature_outdoors', 'cave', 1500];
  }
  if (p.natural === 'beach') return ['nature_outdoors', 'beach', 2000];
  if (p.natural === 'waterfall' || p.waterway === 'waterfall') return ['nature_outdoors', 'waterfall', 2000];
  if (p.natural === 'cave_entrance') return ['nature_outdoors', 'cave', 1500];
  if (p.natural === 'hot_spring') return ['nature_outdoors', 'hot_spring', 1500];
  if (p.natural === 'spring') return ['nature_outdoors', 'spring', 1000];
  if (p.natural === 'volcano') return ['nature_outdoors', 'trailhead', 5000];
  if (p.tourism === 'viewpoint') return ['nature_outdoors', 'viewpoint', 1000];
  if (p.tourism === 'museum') return ['culture_heritage', 'museum', 500];
  if (p.tourism === 'zoo' || p.tourism === 'theme_park') return ['activities_wellness', 'recreation', 1000];
  if (p.tourism === 'attraction') return p.historic ? ['culture_heritage', 'heritage_site', 500] : ['activities_wellness', 'recreation', 800];
  return null;
}
// Words too generic to identify a place on their own.
const GENERIC = new Set(['beach', 'falls', 'fall', 'waterfall', 'waterfalls', 'cave', 'caves', 'spring', 'springs', 'hot', 'cold', 'park', 'resort', 'view', 'viewpoint', 'view deck', 'deck',
  'museum', 'the', 'of', 'and', 'de', 'del', 'la', 'ng', 'sa', 'mt', 'mount', 'volcano', 'island', 'national', 'white', 'sand', 'point', 'lookout', 'zoo', 'garden', 'gardens', 'philippines', 'city', 'old', 'new', 'san', 'santa', 'santo', 'sto']);
const distinctive = (name) => norm(name).split(' ').filter((w) => w.length >= 4 && !GENERIC.has(w));

async function api(params, attempt = 1) {
  const url = `https://commons.wikimedia.org/w/api.php?${new URLSearchParams({ format: 'json', formatversion: '2', maxlag: '5', ...params })}`;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA } });
    if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    if (body.error?.code === 'maxlag') throw new Error('maxlag');
    return body;
  } catch (e) {
    if (attempt > 5) throw e;
    await sleep(4000 * attempt); return api(params, attempt + 1);
  }
}

async function main() {
  const OSM = arg('--osm'), WD = arg('--wikidata'), OUT = arg('--out'), LIMIT = Number(arg('--limit', '0'));
  if (!OSM || !WD || !OUT) throw new Error('--osm, --wikidata and --out are required');
  const wd = JSON.parse(fs.readFileSync(WD, 'utf8')).items;
  const wdIds = new Set(wd.map((it) => it.qid));
  const located = wd.filter((it) => it.province || it.region);

  const candidates = [];
  for await (const line of readline.createInterface({ input: fs.createReadStream(OSM), crlfDelay: Infinity })) {
    const t = line.replace(/^\u001e/, '').trim(); if (!t) continue;
    const f = JSON.parse(t); const p = f.properties || {};
    if (!p.name || p.access === 'private') continue;
    const c = classify(p); if (!c) continue;
    if (p.wikidata && wdIds.has(p.wikidata)) continue;
    const g = f.geometry; let lat, lng;
    if (g.type === 'Point') [lng, lat] = g.coordinates;
    else { const pts = JSON.stringify(g.coordinates).match(/-?\d+\.\d+,-?\d+\.\d+/g).map((s) => s.split(',').map(Number)); lng = pts.reduce((a, q) => a + q[0], 0) / pts.length; lat = pts.reduce((a, q) => a + q[1], 0) / pts.length; }
    if (!(lat > 4.4 && lat < 21.3 && lng > 116 && lng < 127)) continue;
    const words = distinctive(p.name); if (!words.length) continue;
    candidates.push({ key: `osm-${f.id || p['@id'] || `${g.type}-${lat.toFixed(5)}-${lng.toFixed(5)}`}`.toLowerCase().replace(/[^a-z0-9-]/g, '-'),
      name: p['name:en'] || p.name, lat, lng, category: c[0], subcategory: c[1], radius: c[2], words, osm_tags: { addr_city: p['addr:city'], addr_province: p['addr:province'], description: p.description } });
  }
  // Drop OSM features that duplicate a Wikidata destination (same place, similar name).
  const fresh = candidates.filter((c) => !wd.some((w) => km(c, w) < 0.4 && c.words.some((x) => norm(w.name).includes(x))));
  // Drop OSM duplicates of each other (node + way of the same beach).
  const seen = []; const unique = [];
  for (const c of fresh) { if (seen.some((s) => s.subcategory === c.subcategory && km(s, c) < 0.5 && s.words.join() === c.words.join())) continue; seen.push(c); unique.push(c); }
  const work = LIMIT ? unique.slice(0, LIMIT) : unique;
  console.log(`osm candidates ${candidates.length}; not in wikidata ${fresh.length}; unique ${unique.length}; searching ${work.length}`);

  let matched = 0, done = 0; const usedFiles = new Set(wd.map((it) => `File:${it.image_file}`));
  for (const c of work) {
    const body = await api({ action: 'query', list: 'geosearch', gscoord: `${c.lat}|${c.lng}`, gsradius: String(c.radius), gsnamespace: '6', gslimit: '100' });
    const hits = (body.query?.geosearch || []).filter((h) => /\.(jpe?g|png|webp)$/i.test(h.title) && !usedFiles.has(h.title))
      .filter((h) => { const t = norm(h.title.replace(/^File:/, '')); return c.words.every((w) => t.includes(w)); })
      .sort((a, b) => a.dist - b.dist);
    if (hits.length) { c.image_file = hits[0].title.replace(/^File:/, ''); c.photo_dist_m = Math.round(hits[0].dist); usedFiles.add(hits[0].title); matched++; }
    if (++done % 250 === 0) console.log(`searched ${done}/${work.length}; matched ${matched}`);
    await sleep(450);
  }

  const withPhoto = work.filter((c) => c.image_file);
  for (const group of chunk(withPhoto, 50)) {
    const byTitle = new Map(group.map((c) => [`File:${c.image_file}`, c]));
    const body = await api({ action: 'query', prop: 'imageinfo', iiprop: 'url|extmetadata|mime', iiurlwidth: '1024', iiextmetadatafilter: 'Artist|LicenseShortName|UsageTerms', titles: [...byTitle.keys()].join('|') });
    const alias = new Map((body.query?.normalized || []).map((n) => [n.to, n.from]));
    for (const page of body.query?.pages || []) {
      const c = byTitle.get(alias.get(page.title) || page.title); const ii = page.imageinfo?.[0]; if (!c || !ii) continue;
      const md = ii.extmetadata || {}; const u = new URL(ii.thumburl || ii.url); for (const k of [...u.searchParams.keys()]) if (k.startsWith('utm_')) u.searchParams.delete(k);
      c.photo = { thumb_url: u.toString(), page_url: ii.descriptionurl, mime: ii.mime, author: stripHtml(md.Artist?.value).slice(0, 80) || 'Unknown author', license: stripHtml(md.LicenseShortName?.value || md.UsageTerms?.value) };
    }
    await sleep(500);
  }
  // Location: OSM address tags first, else the nearest located Wikidata destination within 30 km.
  const out = withPhoto.filter((c) => c.photo && c.photo.license && /^image\/(jpeg|png|webp)$/.test(c.photo.mime)).map((c) => {
    let best = null, bestKm = 30; for (const o of located) { const d = km(c, o); if (d < bestKm) { bestKm = d; best = o; } }
    const { words, radius, ...rest } = c;
    return { ...rest, municipality: c.osm_tags.addr_city || best?.municipality, province: c.osm_tags.addr_province || best?.province, region: best?.region, location_from: best?.qid };
  });
  fs.writeFileSync(OUT, JSON.stringify({ fetched_at: new Date().toISOString(), sources: ['openstreetmap', 'commons'], items: out }, null, 1));
  const by = Object.entries(out.reduce((a, it) => ((a[it.subcategory] = (a[it.subcategory] || 0) + 1), a), {})).sort((a, b) => b[1] - a[1]);
  console.log(`kept ${out.length} of ${work.length}; by subcategory: ${by.map(([k, n]) => `${k}:${n}`).join(' ')}; provinces: ${new Set(out.map((it) => it.province).filter(Boolean)).size}`);
  console.log(`wrote ${OUT}`);
}
main().catch((e) => { console.error(e.message); process.exitCode = 1; });
