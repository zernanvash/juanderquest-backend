#!/usr/bin/env node
// Beta world Phase 2: fill municipality/province/region from OpenStreetMap Nominatim for items whose
// location is missing or was borrowed from a neighbour. 1 request per 1.1 s (Nominatim usage policy),
// results cached on disk so reruns never repeat a request.
//
//   node scripts/beta/geocode-locations.cjs --file destinations.json --cache nominatim-cache.json
'use strict';
const fs = require('node:fs');

const UA = 'JuanderQuestBeta/0.1 (thesis research prototype; zernanvasharive16@gmail.com)';
const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : fallback; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function reverse(lat, lng, attempt = 1) {
  const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=12&accept-language=en&lat=${lat}&lon=${lng}`;
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (res.status === 429 || res.status >= 500) { if (attempt > 4) throw new Error(`nominatim ${res.status}`); await sleep(10000 * attempt); return reverse(lat, lng, attempt + 1); }
  if (!res.ok) throw new Error(`nominatim ${res.status}`);
  return (await res.json()).address || {};
}

async function main() {
  const FILE = arg('--file'), CACHE = arg('--cache');
  if (!FILE || !CACHE) throw new Error('--file and --cache are required');
  const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  const cache = fs.existsSync(CACHE) ? JSON.parse(fs.readFileSync(CACHE, 'utf8')) : {};
  const todo = data.items.filter((it) => !it.municipality || it.location_from);
  let fetched = 0, fixed = 0;
  for (const it of todo) {
    const k = `${it.lat.toFixed(4)},${it.lng.toFixed(4)}`;
    if (!cache[k]) { cache[k] = await reverse(it.lat, it.lng); fetched++; await sleep(1100); if (fetched % 50 === 0) { fs.writeFileSync(CACHE, JSON.stringify(cache)); console.log(`fetched ${fetched}/${todo.length}`); } }
    const a = cache[k];
    if (a.country_code && a.country_code !== 'ph') continue;
    const town = a.city || a.town || a.municipality || a.village;
    const province = a.state || (a.region === 'Metro Manila' ? 'Metro Manila' : undefined);
    if (town || province) {
      it.municipality = town || it.municipality; it.province = province || it.province; it.region = a.region || it.region;
      it.location_source = 'nominatim'; delete it.location_from; fixed++;
    }
  }
  fs.writeFileSync(CACHE, JSON.stringify(cache));
  fs.writeFileSync(FILE, JSON.stringify(data, null, 1));
  console.log(`checked ${todo.length}; new requests ${fetched}; locations set ${fixed}; still no municipality ${data.items.filter((it) => !it.municipality).length}`);
}
main().catch((e) => { console.error(e.message); process.exitCode = 1; });
