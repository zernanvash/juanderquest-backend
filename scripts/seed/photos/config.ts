import os from 'os';
import path from 'path';

const home = os.homedir();

/** All outputs/caches live here (never in git). Override with PHOTO_ROOT. */
export const PHOTO_ROOT = process.env.PHOTO_ROOT || path.join(home, 'jdq-seed', 'national-116', 'photos');
export const HTTP_CACHE = path.join(PHOTO_ROOT, 'cache');
export const DISCOVERY_DIR = path.join(PHOTO_ROOT, 'discovery');
export const ORIGINALS_DIR = path.join(PHOTO_ROOT, 'originals');
export const WORK_DIR = path.join(PHOTO_ROOT, 'work');
export const MANIFEST_DIR = path.join(PHOTO_ROOT, 'processed');
export const REPORTS_DIR = path.join(PHOTO_ROOT, 'reports');

/** Transient original-download cache cap (brief: 2 GB). */
export const ORIGINALS_CAP_BYTES = 2 * 1024 ** 3;

export const SEED_DESTINATIONS = path.join(home, 'jdq-seed', 'beta-national', 'destinations.json');
export const SEED_OSM_DESTINATIONS = path.join(home, 'jdq-seed', 'beta-national', 'osm-destinations.json');
export const OSM_CANDIDATES = path.join(home, 'jdq-seed', 'osm-candidates.jsonl');
/** COD-AB admin polygons from the areas agent ({lvl, pcode, name, parent, geom} per line). */
export const AREAS_BUNDLE = path.join(home, 'jdq-seed', 'national-116', 'areas', 'codab-bundle.ndjson');
/** Destinations agent's merged catalogue (province hints). */
export const CATALOGUE = path.join(home, 'jdq-seed', 'national-116', 'destinations', 'catalogue.jsonl');

export function argValue(args: string[], name: string, fallback?: string): string | undefined {
  const i = args.indexOf(name);
  if (i >= 0 && i + 1 < args.length) return args[i + 1];
  const eq = args.find((a) => a.startsWith(`${name}=`));
  return eq ? eq.slice(name.length + 1) : fallback;
}

/** Filesystem-safe name for a spot id. */
export function safeName(id: string): string {
  return id.replace(/[^A-Za-z0-9_.-]/g, '_');
}
