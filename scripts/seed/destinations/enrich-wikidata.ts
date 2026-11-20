// Plan 116 §8.1 step 4: polite enrichment pass (cached; a re-run makes no requests).
//   - Wikidata SPARQL, ≤ 50 QIDs per request: en/tl label, en description, P18, P856, P373, P1435, P625,
//     enwiki sitelink, sitelink count, P31; and (second query) P131 municipality / province / region labels.
//   - English Wikipedia intro, first 2 sentences (≤ 20 titles per request).
//   - Commons imageinfo for every image reference (≤ 50 titles per request): size, mime, licence, author.
//     No photo is downloaded here (the photos agent does that).
// Usage (WSL): npx tsx scripts/seed/destinations/enrich-wikidata.ts [--offline]
// Output: ~/jdq-seed/national-116/destinations/enrichment.json

import { PoliteClient } from './lib/http.js';
import { flag, paths, readJson, writeJson } from './lib/io.js';
import { normaliseLicence } from './lib/licence.js';
import { loadSources } from './lib/sources.js';

const SPARQL = 'https://query.wikidata.org/sparql';
const WIKIPEDIA = 'https://en.wikipedia.org/w/api.php';
const COMMONS = 'https://commons.wikimedia.org/w/api.php';

export interface WikidataEntity {
  qid: string;
  label_en?: string;
  label_tl?: string;
  description_en?: string;
  images: string[]; // "File:…"
  websites: string[];
  commons_category?: string;
  heritage: string[]; // P1435 labels
  coord?: { lat: number; lng: number };
  enwiki_title?: string;
  sitelinks: number;
  instance_of: string[];
  municipality?: string;
  province?: string;
  region?: string;
  retrieved_at: string;
}

export interface WikipediaExtract {
  title: string;
  extract: string;
  url: string;
  retrieved_at: string;
}

export interface CommonsImage {
  title: string;
  missing: boolean;
  width?: number;
  height?: number;
  mime?: string;
  licence_raw?: string;
  licence?: string | null;
  licence_url?: string;
  author?: string;
  page_url?: string;
  retrieved_at: string;
}

export interface Enrichment {
  generated_at: string;
  entities: Record<string, WikidataEntity>;
  extracts: Record<string, WikipediaExtract>; // keyed by requested title
  extract_misses?: string[]; // titles with no article/intro (not re-requested)
  images: Record<string, CommonsImage>; // keyed by "File:…" title
  provinces: Array<{ qid: string; name: string; region?: string }>;
  stats: Record<string, number>;
}

const chunk = <T>(xs: T[], n: number): T[][] =>
  Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));
const strip = (s: unknown) =>
  String(s ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();

type Binding = Record<string, { value: string } | undefined>;

async function sparql(client: PoliteClient, query: string): Promise<{ rows: Binding[]; at: string }> {
  const res = await client.json(SPARQL, { query, format: 'json' });
  const body = res.body as { results: { bindings: Binding[] } };
  return { rows: body.results.bindings, at: res.fetched_at };
}

const qidOf = (uri: string | undefined) => (uri ? uri.replace(/^.*\/entity\//, '') : '');
const fileOf = (uri: string) =>
  `File:${decodeURIComponent(uri.replace(/^.*\/Special:FilePath\//, '')).replace(/_/g, ' ')}`;

async function fetchEntities(client: PoliteClient, qids: string[]): Promise<Record<string, WikidataEntity>> {
  const out: Record<string, WikidataEntity> = {};
  for (const batch of chunk(qids, 50)) {
    const values = batch.map((q) => `wd:${q}`).join(' ');
    const main = await sparql(
      client,
      `SELECT ?item ?labelEn ?labelTl ?descEn ?image ?website ?commonsCat ?heritageLabel ?coord ?article ?sitelinks ?inst WHERE {
  VALUES ?item { ${values} }
  OPTIONAL { ?item rdfs:label ?labelEn FILTER(LANG(?labelEn) = "en") }
  OPTIONAL { ?item rdfs:label ?labelTl FILTER(LANG(?labelTl) = "tl") }
  OPTIONAL { ?item schema:description ?descEn FILTER(LANG(?descEn) = "en") }
  OPTIONAL { ?item wdt:P18 ?image }
  OPTIONAL { ?item wdt:P856 ?website }
  OPTIONAL { ?item wdt:P373 ?commonsCat }
  OPTIONAL { ?item wdt:P1435 ?heritage . ?heritage rdfs:label ?heritageLabel FILTER(LANG(?heritageLabel) = "en") }
  OPTIONAL { ?item wdt:P625 ?coord }
  OPTIONAL { ?article schema:about ?item ; schema:isPartOf <https://en.wikipedia.org/> }
  OPTIONAL { ?item wikibase:sitelinks ?sitelinks }
  OPTIONAL { ?item wdt:P31 ?inst }
}`,
    );
    for (const b of main.rows) {
      const qid = qidOf(b.item?.value);
      if (!qid) continue;
      const e = (out[qid] ??= {
        qid,
        images: [],
        websites: [],
        heritage: [],
        sitelinks: 0,
        instance_of: [],
        retrieved_at: main.at,
      });
      if (b.labelEn) e.label_en = b.labelEn.value;
      if (b.labelTl) e.label_tl = b.labelTl.value;
      if (b.descEn) e.description_en = b.descEn.value;
      if (b.image) {
        const f = fileOf(b.image.value);
        if (!e.images.includes(f)) e.images.push(f);
      }
      if (b.website && !e.websites.includes(b.website.value)) e.websites.push(b.website.value);
      if (b.commonsCat) e.commons_category = `Category:${b.commonsCat.value}`;
      if (b.heritageLabel && !e.heritage.includes(b.heritageLabel.value)) e.heritage.push(b.heritageLabel.value);
      const m = b.coord && /Point\(([-\d.]+) ([-\d.]+)\)/.exec(b.coord.value);
      if (m && !e.coord) e.coord = { lng: Number(m[1]), lat: Number(m[2]) };
      if (b.article && !e.enwiki_title)
        e.enwiki_title = decodeURIComponent(b.article.value.replace(/^.*\/wiki\//, '')).replace(/_/g, ' ');
      if (b.sitelinks) e.sitelinks = Number(b.sitelinks.value);
      const inst = qidOf(b.inst?.value);
      if (inst && !e.instance_of.includes(inst)) e.instance_of.push(inst);
    }
    const admin = await sparql(
      client,
      `SELECT ?item ?muniLabel ?provLabel ?regLabel WHERE {
  VALUES ?item { ${values} }
  OPTIONAL { ?item wdt:P131 ?muni . ?muni rdfs:label ?muniLabel FILTER(LANG(?muniLabel) = "en") }
  OPTIONAL { ?item wdt:P131+ ?prov . ?prov wdt:P31 wd:Q24746 . ?prov rdfs:label ?provLabel FILTER(LANG(?provLabel) = "en") }
  OPTIONAL { ?item wdt:P131+ ?reg . ?reg wdt:P31 wd:Q24698 . ?reg rdfs:label ?regLabel FILTER(LANG(?regLabel) = "en") }
}`,
    );
    for (const b of admin.rows) {
      const e = out[qidOf(b.item?.value)];
      if (!e) continue;
      if (b.muniLabel && !e.municipality) e.municipality = b.muniLabel.value;
      if (b.provLabel && !e.province) e.province = b.provLabel.value;
      if (b.regLabel && !e.region) e.region = b.regLabel.value;
    }
    process.stdout.write(`\r[enrich] wikidata ${Object.keys(out).length}/${qids.length}`);
  }
  process.stdout.write('\n');
  return out;
}

async function fetchProvinces(client: PoliteClient): Promise<Enrichment['provinces']> {
  const { rows } = await sparql(
    client,
    `SELECT ?prov ?provLabel ?regLabel WHERE {
  ?prov wdt:P31 wd:Q24746 .
  FILTER NOT EXISTS { ?prov wdt:P576 ?dissolved }
  OPTIONAL { ?prov wdt:P131 ?reg . ?reg wdt:P31 wd:Q24698 . ?reg rdfs:label ?regLabel FILTER(LANG(?regLabel) = "en") }
  ?prov rdfs:label ?provLabel FILTER(LANG(?provLabel) = "en")
}`,
  );
  const map = new Map<string, { qid: string; name: string; region?: string }>();
  for (const b of rows) {
    const qid = qidOf(b.prov?.value);
    const cur = map.get(qid) ?? { qid, name: b.provLabel?.value ?? qid };
    if (b.regLabel) cur.region = b.regLabel.value;
    map.set(qid, cur);
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

async function fetchExtracts(client: PoliteClient, titles: string[]): Promise<Record<string, WikipediaExtract>> {
  const out: Record<string, WikipediaExtract> = {};
  for (const batch of chunk(titles, 20)) {
    const res = await client.json(
      `${WIKIPEDIA}?${new URLSearchParams({
        action: 'query',
        format: 'json',
        formatversion: '2',
        prop: 'extracts',
        exintro: '1',
        explaintext: '1',
        exsentences: '2',
        exlimit: '20',
        redirects: '1',
        titles: batch.join('|'),
      })}`,
    );
    const q = (res.body as { query?: Record<string, unknown> }).query ?? {};
    const alias = new Map<string, string>();
    for (const n of (q.normalized as Array<{ from: string; to: string }>) ?? []) alias.set(n.from, n.to);
    for (const r of (q.redirects as Array<{ from: string; to: string }>) ?? []) alias.set(r.from, r.to);
    const pages = new Map<string, { title: string; extract?: string; missing?: boolean }>();
    for (const p of (q.pages as Array<{ title: string; extract?: string; missing?: boolean }>) ?? [])
      pages.set(p.title, p);
    for (const t of batch) {
      let cur = t;
      for (let i = 0; i < 3 && alias.has(cur); i++) cur = alias.get(cur)!;
      const p = pages.get(cur);
      if (!p || p.missing || !p.extract?.trim()) continue;
      out[t] = {
        title: p.title,
        extract: p.extract.trim(),
        url: `https://en.wikipedia.org/wiki/${encodeURIComponent(p.title.replace(/ /g, '_'))}`,
        retrieved_at: res.fetched_at,
      };
    }
    process.stdout.write(`\r[enrich] wikipedia ${Object.keys(out).length}/${titles.length}`);
  }
  process.stdout.write('\n');
  return out;
}

async function fetchImages(client: PoliteClient, titles: string[]): Promise<Record<string, CommonsImage>> {
  const out: Record<string, CommonsImage> = {};
  for (const batch of chunk(titles, 50)) {
    const res = await client.json(
      `${COMMONS}?${new URLSearchParams({
        action: 'query',
        format: 'json',
        formatversion: '2',
        prop: 'imageinfo',
        iiprop: 'size|mime|extmetadata|url',
        iiextmetadatafilter: 'LicenseShortName|LicenseUrl|Artist|UsageTerms',
        redirects: '1',
        titles: batch.join('|'),
      })}`,
    );
    const q = (res.body as { query?: Record<string, unknown> }).query ?? {};
    const alias = new Map<string, string>();
    for (const n of (q.normalized as Array<{ from: string; to: string }>) ?? []) alias.set(n.from, n.to);
    for (const r of (q.redirects as Array<{ from: string; to: string }>) ?? []) alias.set(r.from, r.to);
    type Page = {
      title: string;
      missing?: boolean;
      imageinfo?: Array<{
        width: number;
        height: number;
        mime: string;
        descriptionurl: string;
        extmetadata?: Record<string, { value: string }>;
      }>;
    };
    const pages = new Map<string, Page>();
    for (const p of (q.pages as Page[]) ?? []) pages.set(p.title, p);
    for (const t of batch) {
      let cur = t;
      for (let i = 0; i < 3 && alias.has(cur); i++) cur = alias.get(cur)!;
      const p = pages.get(cur);
      const ii = p?.imageinfo?.[0];
      if (!p || p.missing || !ii) {
        out[t] = { title: t, missing: true, retrieved_at: res.fetched_at };
        continue;
      }
      const meta = ii.extmetadata ?? {};
      const raw = strip(meta.LicenseShortName?.value);
      out[t] = {
        title: p.title,
        missing: false,
        width: ii.width,
        height: ii.height,
        mime: ii.mime,
        licence_raw: raw,
        licence: normaliseLicence(raw),
        licence_url: meta.LicenseUrl?.value,
        author: strip(meta.Artist?.value) || undefined,
        page_url: ii.descriptionurl,
        retrieved_at: res.fetched_at,
      };
    }
    process.stdout.write(`\r[enrich] commons ${Object.keys(out).length}/${titles.length}`);
  }
  process.stdout.write('\n');
  return out;
}

async function main() {
  const started = Date.now();
  const client = new PoliteClient(paths.cache, flag('--offline'));
  const { records } = await loadSources();
  // Incremental: keep what an earlier run fetched (--refresh refetches everything).
  const prev = flag('--refresh')
    ? undefined
    : readJson<Enrichment | undefined>(paths.enrichment, undefined as unknown as Enrichment);
  const qids = [...new Set(records.map((r) => r.wikidata).filter((q): q is string => Boolean(q)))].sort();
  console.log(`[enrich] ${records.length} source records, ${qids.length} distinct QIDs`);
  const entities = { ...(prev?.entities ?? {}) };
  Object.assign(
    entities,
    await fetchEntities(
      client,
      qids.filter((q) => !entities[q]),
    ),
  );
  const provinces = await fetchProvinces(client);

  const titles = new Set<string>();
  for (const r of records) if (r.wikipediaTitle) titles.add(r.wikipediaTitle);
  for (const q of qids) if (entities[q]?.enwiki_title) titles.add(entities[q].enwiki_title!);
  const extracts = { ...(prev?.extracts ?? {}) };
  const prevTitles = new Set(Object.keys(prev?.extracts ?? {}).concat(prev?.extract_misses ?? []));
  Object.assign(extracts, await fetchExtracts(client, [...titles].filter((t) => !prevTitles.has(t)).sort()));

  const files = new Set<string>();
  for (const r of records) for (const p of r.photos) files.add(p.title);
  for (const q of qids) for (const f of entities[q]?.images ?? []) files.add(f);
  const images = { ...(prev?.images ?? {}) };
  Object.assign(images, await fetchImages(client, [...files].filter((f) => !images[f]).sort()));

  const enrichment: Enrichment = {
    generated_at: new Date().toISOString(),
    entities,
    extracts,
    extract_misses: [...titles].filter((t) => !extracts[t]).sort(),
    images,
    provinces,
    stats: {
      qids: qids.length,
      entities: Object.keys(entities).length,
      wikipedia_titles: titles.size,
      extracts: Object.keys(extracts).length,
      image_titles: files.size,
      images_found: Object.values(images).filter((i) => !i.missing).length,
      images_allowed_licence: Object.values(images).filter((i) => i.licence).length,
      provinces: provinces.length,
      http_requests: client.requests,
      cache_hits: client.cacheHits,
      seconds: Math.round((Date.now() - started) / 1000),
    },
  };
  writeJson(paths.enrichment, enrichment);
  console.log('[enrich] done', enrichment.stats);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(`[enrich] failed: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
}
