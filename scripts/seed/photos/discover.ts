// Plan 116 §8.4 photo discovery: metadata only (no image downloads, no DB writes).
// Resumable: one JSON per spot under <PHOTO_ROOT>/discovery/, skipped on rerun unless --refresh.
// Every HTTP response is cached under <PHOTO_ROOT>/cache/.
//
//   DATABASE_URL=… npx tsx scripts/seed/photos/discover.ts [--limit N] [--spot-ids a,b] [--refresh]
//        [--no-geosearch] [--radius 500] [--openverse] [--openverse-max 100] [--flickr]
//        [--region 0100000000|"Ilocos Region"] [--provinces "La Union,Pangasinan"] [--areas-bundle path]
// --region/--provinces limit the run to spots inside those COD-AB provinces (default: whole country).
//
// Sources (priority order): Commons via Wikidata P18 / OSM file tags / P373 + OSM category
// members / geosearch (ns 6, ≤ 500 m, distinctive-name match); then, only for spots with no
// usable Commons photo: Openverse (--openverse; anonymous unless OPENVERSE_CLIENT_ID/SECRET),
// Flickr (--flickr and FLICKR_API_KEY).
import fs from 'fs';
import path from 'path';
import { buildCommonsCandidates, type CommonsHits } from './candidates.js';
import {
  argValue,
  DISCOVERY_DIR,
  HTTP_CACHE,
  OSM_CANDIDATES,
  REPORTS_DIR,
  safeName,
  SEED_DESTINATIONS,
  SEED_OSM_DESTINATIONS,
} from './config.js';
import { loadSpots, pool, type SpotRow } from './db.js';
import { SourceBlockedError, stats } from './http.js';
import { screenCandidates } from './quality.js';
import { scopeFromArgs } from './scope.js';
import { loadSeedIndex, seedLinks } from './seed-index.js';
import { commonsClient, normaliseCategory, normaliseFileTitle, wikidataPhotoClaims } from './sources/commons.js';
import { flickrEnabled, flickrLicences, flickrSearch } from './sources/flickr.js';
import { openverseSearch, openverseToken } from './sources/openverse.js';
import type { SpotCandidates } from './types.js';

const args = process.argv.slice(2);
const LIMIT = Number(argValue(args, '--limit', '0'));
const IDS = argValue(args, '--spot-ids')?.split(',').filter(Boolean);
const REFRESH = args.includes('--refresh');
const GEO = !args.includes('--no-geosearch');
const RADIUS = Math.min(500, Number(argValue(args, '--radius', '500')));
const OPENVERSE = args.includes('--openverse');
const OPENVERSE_MAX = Number(argValue(args, '--openverse-max', '100'));
const FLICKR = args.includes('--flickr') && flickrEnabled();

export function discoveryFile(spotId: string): string {
  return path.join(DISCOVERY_DIR, `${safeName(spotId)}.json`);
}

export function readAllDiscovery(dir = DISCOVERY_DIR): SpotCandidates[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as SpotCandidates);
}

export function summarise(all: SpotCandidates[]) {
  const bySource: Record<string, number> = {};
  const byVia: Record<string, number> = {};
  const rejections: Record<string, number> = {};
  const licences: Record<string, number> = {};
  let accepted = 0;
  let spotsWithAccepted = 0;
  let spotsWithHero = 0;
  for (const s of all) {
    let any = false;
    let hero = false;
    for (const c of s.candidates) {
      bySource[c.source] = (bySource[c.source] ?? 0) + 1;
      byVia[c.via] = (byVia[c.via] ?? 0) + 1;
      if (c.rejected) rejections[c.rejected] = (rejections[c.rejected] ?? 0) + 1;
      else {
        accepted++;
        any = true;
        if (Math.max(c.width, c.height) >= 1000) hero = true;
        licences[c.license!] = (licences[c.license!] ?? 0) + 1;
      }
    }
    if (any) spotsWithAccepted++;
    if (hero) spotsWithHero++;
  }
  const sort = (o: Record<string, number>) => Object.fromEntries(Object.entries(o).sort((a, b) => b[1] - a[1]));
  return {
    spots: all.length,
    spots_with_accepted: spotsWithAccepted,
    spots_with_hero_candidate: spotsWithHero,
    candidates: Object.values(bySource).reduce((a, b) => a + b, 0),
    accepted_after_metadata_rules: accepted,
    candidates_by_source: sort(bySource),
    candidates_by_via: sort(byVia),
    rejections_by_reason: sort(rejections),
    accepted_licence_mix: sort(licences),
    errors: all.filter((s) => s.errors?.length).length,
  };
}

async function main() {
  const started = Date.now();
  fs.mkdirSync(DISCOVERY_DIR, { recursive: true });
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const db = pool();
  let spots: SpotRow[] = await loadSpots(db, IDS);
  await db.end();
  const scope = scopeFromArgs(args);
  if (scope) {
    spots = spots.filter((s) => scope.test(s));
    console.log(`scope: ${scope.label}: ${spots.length} spots`);
  }
  if (!REFRESH) spots = spots.filter((s) => !fs.existsSync(discoveryFile(s.spot_id)));
  if (LIMIT > 0) spots = spots.slice(0, LIMIT);
  console.log(`discover: ${spots.length} spots to do (geosearch=${GEO}, radius=${RADIUS} m)`);

  const idx = loadSeedIndex({
    destinations: SEED_DESTINATIONS,
    osmDestinations: SEED_OSM_DESTINATIONS,
    osmCandidates: OSM_CANDIDATES,
  });
  const commons = commonsClient(HTTP_CACHE);

  const qids = [...new Set(spots.map((s) => s.wikidata).filter((q): q is string => !!q))];
  const claims = await wikidataPhotoClaims(qids, HTTP_CACHE);
  console.log(`wikidata: claims for ${claims.size}/${qids.length} QIDs`);

  // Named files for all spots in one batched pass (50 titles per request).
  const links = new Map(spots.map((s) => [s.spot_id, seedLinks(s, idx)]));
  for (const s of spots) {
    const l = links.get(s.spot_id)!;
    const c = s.wikidata ? claims.get(s.wikidata) : undefined;
    for (const f of c?.p18 ?? []) {
      const t = normaliseFileTitle(f);
      if (t && !l.files.some((x) => x.title === t)) l.files.unshift({ title: t, via: 'wikidata_p18' });
    }
    const cat = c?.p373 ? normaliseCategory(c.p373) : null;
    if (cat) {
      l.categories = l.categories.filter((x) => x.category !== cat);
      l.categories.unshift({ category: cat, via: 'commons_category' });
    }
    if (!l.context.includes(s.municipality) && s.municipality) l.context.push(s.municipality);
  }
  const allTitles = [
    ...new Set([...links.values()].flatMap((l) => [...l.files.map((f) => f.title), ...l.geoFiles.map((g) => g.title)])),
  ];
  const info = await commons.imageInfo(allTitles);
  console.log(`commons: imageinfo for ${info.size}/${allTitles.length} named files`);

  let ovToken: string | null = null;
  if (OPENVERSE) ovToken = await openverseToken();
  let ovUsed = 0;
  let ovBlocked = false;
  const flickrLic = FLICKR ? await flickrLicences(HTTP_CACHE) : new Map();

  let done = 0;
  for (const s of spots) {
    const l = links.get(s.spot_id)!;
    const errors: string[] = [];
    const hits: CommonsHits = { named: [], category: [], geo: [] };
    for (const f of l.files) {
      const p = info.get(f.title);
      if (p && !p.missing) hits.named.push({ page: p, via: f.via });
    }
    for (const g of l.geoFiles) {
      const p = info.get(g.title);
      if (p && !p.missing) hits.geo.push(p);
    }
    try {
      for (const c of l.categories.slice(0, 2)) {
        for (const page of await commons.categoryFiles(c.category)) hits.category.push({ page, via: c.via });
      }
      if (GEO) hits.geo.push(...(await commons.geosearch(s.lat, s.lng, RADIUS)));
    } catch (e) {
      if (e instanceof SourceBlockedError) throw e;
      errors.push(`commons: ${(e as Error).message}`);
    }
    let candidates = buildCommonsCandidates(s, hits, l.context);
    const usable = () => candidates.some((c) => !c.rejected);
    if (!usable() && OPENVERSE && !ovBlocked && ovUsed < OPENVERSE_MAX) {
      try {
        ovUsed++;
        candidates = screenCandidates([...candidates, ...(await openverseSearch(s, l.context, HTTP_CACHE, ovToken))]);
      } catch (e) {
        if (e instanceof SourceBlockedError) ovBlocked = true;
        errors.push(`openverse: ${(e as Error).message}`);
      }
    }
    if (FLICKR && candidates.filter((c) => !c.rejected).length < 3) {
      try {
        candidates = screenCandidates([...candidates, ...(await flickrSearch(s, HTTP_CACHE, flickrLic))]);
      } catch (e) {
        errors.push(`flickr: ${(e as Error).message}`);
      }
    }
    const out: SpotCandidates = {
      spot: { spot_id: s.spot_id, name: s.name, lat: s.lat, lng: s.lng, wikidata: s.wikidata, osm: s.osm },
      candidates,
      discovered_at: new Date().toISOString(),
      ...(errors.length ? { errors } : {}),
    };
    fs.writeFileSync(`${discoveryFile(s.spot_id)}.part`, JSON.stringify(out));
    fs.renameSync(`${discoveryFile(s.spot_id)}.part`, discoveryFile(s.spot_id));
    if (++done % 50 === 0)
      console.log(
        `  ${done}/${spots.length} spots, ${stats.requests} requests, ${stats.cacheHits} cache hits, ${Math.round((Date.now() - started) / 1000)} s`,
      );
  }

  const summary = {
    run: {
      finished_at: new Date().toISOString(),
      spots_this_run: spots.length,
      wall_s: Math.round((Date.now() - started) / 1000),
      http_requests: stats.requests,
      http_cache_hits: stats.cacheHits,
      http_retries: stats.retries,
      openverse_queries: ovUsed,
      openverse_blocked: ovBlocked,
      flickr_enabled: FLICKR,
    },
    scope: scope?.label ?? 'all',
    ...summarise(readAllDiscovery().filter((d) => !scope || scope.test(d.spot))),
  };
  fs.writeFileSync(path.join(REPORTS_DIR, 'discovery-summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
