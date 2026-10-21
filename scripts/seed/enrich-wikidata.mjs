import fs from 'node:fs';
import readline from 'node:readline';

const USER_AGENT = process.env.JDQ_SPARQL_USER_AGENT;
if (!USER_AGENT || USER_AGENT.length < 12 || /example|placeholder/i.test(USER_AGENT)) {
  throw new Error('Set JDQ_SPARQL_USER_AGENT to an identified application name and operator contact.');
}
const arg = (name) => {
  const index = process.argv.indexOf(name);
  if (index >= 0) return process.argv[index + 1];
  const inline = process.argv.find((value) => value.startsWith(`${name}=`));
  return inline?.slice(name.length + 1);
};
const input = arg('--input'), output = arg('--output');
if (!input || !output) throw new Error('Usage: node enrich-wikidata.mjs --input <jsonl> --output <jsonl>');
const candidates = [];
for await (const line of readline.createInterface({ input: fs.createReadStream(input), crlfDelay: Infinity })) {
  if (line.trim()) candidates.push(JSON.parse(line));
}
const qids = [...new Set(candidates.map((item) => item.external_refs?.wikidata).filter((value) => /^Q\d+$/.test(value || '')))];
const entities = new Map();
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

for (let offset = 0; offset < qids.length; offset += 50) {
  const batch = qids.slice(offset, offset + 50);
  const values = batch.map((id) => `wd:${id}`).join(' ');
  const query = `SELECT ?item ?itemLabel ?itemDescription ?image ?website ?coord WHERE { VALUES ?item { ${values} } OPTIONAL { ?item wdt:P18 ?image } OPTIONAL { ?item wdt:P856 ?website } OPTIONAL { ?item wdt:P625 ?coord } SERVICE wikibase:label { bd:serviceParam wikibase:language "en,tl". } }`;
  const url = new URL('https://query.wikidata.org/sparql');
  url.searchParams.set('query', query); url.searchParams.set('format', 'json');
  const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/sparql-results+json' }, signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`Wikidata SPARQL returned HTTP ${response.status}; stop and retry later.`);
  const body = await response.json();
  for (const row of body.results?.bindings || []) {
    const qid = row.item.value.split('/').at(-1);
    entities.set(qid, { label: row.itemLabel?.value, description: row.itemDescription?.value, image: row.image?.value, website: row.website?.value, coord: row.coord?.value });
  }
  if (offset + 50 < qids.length) await wait(1000);
}

async function commonsPhoto(fileRef) {
  if (typeof fileRef !== 'string' || !fileRef.trim()) return undefined;
  let fileName = fileRef.trim();
  if (/^https?:\/\//i.test(fileName)) {
    if (!/^https?:\/\/commons\.wikimedia\.org\//i.test(fileName)) return undefined;
    const parsed = new URL(fileName);
    const specialFile = parsed.pathname.match(/\/Special:FilePath\/(.+)$/i)?.[1];
    const wikiFile = parsed.pathname.match(/\/wiki\/(File:.+)$/i)?.[1];
    fileName = decodeURIComponent(specialFile || wikiFile || '');
  }
  if (fileName.startsWith('File:')) fileName = fileName.slice(5);
  if (!fileName || fileName.length > 240 || fileName.includes('..') || /^Category:/i.test(fileName)) return undefined;
  const api = new URL('https://commons.wikimedia.org/w/api.php');
  api.searchParams.set('action', 'query'); api.searchParams.set('format', 'json');
  api.searchParams.set('prop', 'imageinfo'); api.searchParams.set('iiprop', 'extmetadata');
  api.searchParams.set('iiurlwidth', '1280'); api.searchParams.set('titles', `File:${fileName}`);
  const response = await fetch(api, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(15000) });
  if (!response.ok) return undefined;
  const body = await response.json();
  const page = Object.values(body.query?.pages || {})[0];
  const info = page?.imageinfo?.[0];
  const meta = info?.extmetadata || {};
  const license = meta.LicenseShortName?.value?.replace(/<[^>]*>/g, '').trim() || '';
  if (!/^(CC0|Public domain|PD|CC BY(?:-SA)?(?:\s+[0-9.]+)?)$/i.test(license)) return undefined;
  const author = (meta.Artist?.value || '').replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').trim();
  if (!author || !info.thumburl || !/^https:\/\/upload\.wikimedia\.org\//.test(info.thumburl)) return undefined;
  return {
    title: fileName,
    thumbnail_url: info.thumburl,
    author,
    license,
    attribution_url: info.descriptionurl || `https://commons.wikimedia.org/wiki/File:${encodeURIComponent(fileName.replaceAll(' ', '_'))}`,
  };
}

const outputStream = fs.createWriteStream(output, { flags: 'w' });
let enriched = 0, acceptedPhotos = 0;
for (const candidate of candidates) {
  const qid = candidate.external_refs?.wikidata;
  const facts = entities.get(qid);
  if (facts) {
    let coordinatesMatch = true;
    if (facts.coord) {
      const point = facts.coord.match(/Point\(([-\d.]+) ([-\d.]+)\)/);
      if (point) {
        const lon = Number(point[1]), lat = Number(point[2]), radians = Math.PI / 180;
        const dLat = (lat - candidate.gps_lat) * radians, dLon = (lon - candidate.gps_lng) * radians;
        const h = Math.sin(dLat / 2) ** 2 + Math.cos(candidate.gps_lat * radians) * Math.cos(lat * radians) * Math.sin(dLon / 2) ** 2;
        coordinatesMatch = 6371000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h)) <= 2000;
      }
    }
    const qidUrl = `https://www.wikidata.org/wiki/${qid}`;
    if (!coordinatesMatch) {
      candidate.external_refs.wikidata = undefined;
      candidate.field_sources.wikidata_coordinate_mismatch = { source: 'wikidata', url: qidUrl, review_required: true };
      enriched++;
    } else {
    candidate.field_sources.wikidata = { source: 'wikidata', url: qidUrl, license: 'CC0', retrieved_at: new Date().toISOString() };
    if (facts.description && !candidate.description) {
      candidate.description = facts.description;
      candidate.field_sources.description = { source: 'wikidata', url: qidUrl, license: 'CC0', retrieved_at: new Date().toISOString() };
    }
    if (facts.website && !candidate.official_website && /^https?:\/\//.test(facts.website)) {
      candidate.official_website = facts.website;
      candidate.field_sources.official_website = { source: 'wikidata', url: qidUrl, retrieved_at: new Date().toISOString() };
    }
    const osmCommonsFile = candidate.field_sources?.osm_tags?.wikimedia_commons;
    if (facts.image || osmCommonsFile) {
      candidate.photo = await commonsPhoto(facts.image || osmCommonsFile);
      if (candidate.photo) { acceptedPhotos++; candidate.field_sources.photo = { source: 'wikimedia_commons', url: candidate.photo.attribution_url, license: candidate.photo.license, author: candidate.photo.author }; }
    }
    enriched++;
    }
  }
  const tags = candidate.field_sources?.osm_tags || {};
  const strong = (tags.tourism && ['attraction', 'viewpoint', 'museum', 'theme_park', 'zoo', 'aquarium', 'gallery'].includes(tags.tourism)) ||
    (tags.natural && ['beach', 'waterfall', 'peak', 'hot_spring', 'cave_entrance', 'spring', 'volcano'].includes(tags.natural)) ||
    (tags.historic && ['monument', 'memorial', 'ruins', 'castle', 'fort', 'archaeological_site', 'heritage'].includes(tags.historic)) ||
    (tags.leisure && ['park', 'nature_reserve', 'garden', 'beach_resort'].includes(tags.leisure));
  const generic = candidate.review_only ? 0.3 : 0;
  // Plan 46 counts a linked Wikipedia article as an independent corroborating
  // source, even when its text is not imported into the destination description.
  candidate.import_confidence = Math.max(0, Math.min(1,
    (candidate.external_refs.wikidata ? 0.4 : 0) + (candidate.photo ? 0.2 : 0) + (candidate.wikipedia ? 0.15 : 0) +
    (strong ? 0.1 : 0) + (candidate.hours && Object.keys(candidate.hours).length || candidate.official_website ? 0.1 : 0) - generic));
  outputStream.write(`${JSON.stringify(candidate)}\n`);
  if (candidate.external_refs.wikidata) await wait(1000);
}
await new Promise((resolve, reject) => outputStream.end(resolve).on('error', reject));
process.stdout.write(`WIKIDATA_MATCHED=${enriched} COMMONS_LICENSE_ACCEPTED=${acceptedPhotos} CANDIDATES=${candidates.length}\n`);
