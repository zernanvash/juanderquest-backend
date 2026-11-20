// CLI wiring for --region / --provinces (see region.ts). Province hints come from the on-disk
// seeds (beta-national destinations, the destinations agent's catalogue.jsonl hints).
import fs from 'fs';
import { AREAS_BUNDLE, argValue, CATALOGUE, SEED_DESTINATIONS, SEED_OSM_DESTINATIONS } from './config.js';
import { inScope, loadScope, type Area } from './region.js';
import { osmKeyToRef } from './seed-index.js';
import type { SpotRef } from './types.js';

export interface Scope {
  label: string;
  areas: Area[];
  test(spot: Pick<SpotRef, 'lat' | 'lng' | 'wikidata' | 'osm'>): boolean;
}

function provinceHints(): Map<string, string> {
  const m = new Map<string, string>();
  const put = (k: string | undefined | null, p: string | undefined | null) => {
    if (k && p && !m.has(k)) m.set(k, p);
  };
  if (fs.existsSync(SEED_DESTINATIONS))
    for (const it of JSON.parse(fs.readFileSync(SEED_DESTINATIONS, 'utf8')).items)
      put(`wikidata:${it.qid}`, it.province);
  if (fs.existsSync(SEED_OSM_DESTINATIONS))
    for (const it of JSON.parse(fs.readFileSync(SEED_OSM_DESTINATIONS, 'utf8')).items)
      put(`osm:${osmKeyToRef(it.key)}`, it.province);
  if (fs.existsSync(CATALOGUE))
    for (const line of fs.readFileSync(CATALOGUE, 'utf8').split('\n')) {
      if (!line.includes('"province"')) continue;
      const o = JSON.parse(line) as { refs?: { osm?: string; wikidata?: string }; hints?: { province?: string } };
      put(o.refs?.wikidata ? `wikidata:${o.refs.wikidata}` : null, o.hints?.province);
      put(o.refs?.osm ? `osm:${o.refs.osm}` : null, o.hints?.province);
    }
  return m;
}

/** null = whole country. `--region 0100000000|"Ilocos Region"`, `--provinces "La Union,Pangasinan"`. */
export function scopeFromArgs(args: string[]): Scope | null {
  const region = argValue(args, '--region');
  const provinces = argValue(args, '--provinces')
    ?.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!region && !provinces?.length) return null;
  const areas = loadScope(argValue(args, '--areas-bundle', AREAS_BUNDLE)!, { region, provinces });
  const hints = provinceHints();
  return {
    label: `${region ?? ''}${provinces?.length ? ` +${provinces.join('/')}` : ''} → ${areas.map((a) => a.name).join(', ')}`,
    areas,
    test: (s) =>
      inScope(
        areas,
        s.lat,
        s.lng,
        (s.wikidata && hints.get(`wikidata:${s.wikidata}`)) || (s.osm && hints.get(`osm:${s.osm}`)) || null,
      ),
  };
}
