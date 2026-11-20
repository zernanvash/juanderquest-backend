// Plan 116 destinations: data paths (never inside git) and small file helpers.

import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';

const SEED = process.env.JDQ_SEED_DIR || join(homedir(), 'jdq-seed');
export const OUT_DIR = process.env.JDQ_DEST_OUT_DIR || join(SEED, 'national-116', 'destinations');

export const paths = {
  osmCandidates: join(SEED, 'osm-candidates.jsonl'),
  betaWikidata: join(SEED, 'beta-national', 'destinations.json'),
  betaOsm: join(SEED, 'beta-national', 'osm-destinations.json'),
  osmExport: join(SEED, 'beta-national', 'osm', 'dest.geojsonseq'),
  cache: join(OUT_DIR, 'cache'),
  enrichment: join(OUT_DIR, 'enrichment.json'),
  catalogue: join(OUT_DIR, 'catalogue.jsonl'),
  catalogueStats: join(OUT_DIR, 'catalogue-stats.json'),
  photoCandidates: join(OUT_DIR, 'photo-candidates.jsonl'),
  reports: join(OUT_DIR, 'reports'),
};

export async function readJsonl<T>(file: string): Promise<T[]> {
  const out: T[] = [];
  const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    const t = line.trim();
    if (t) out.push(JSON.parse(t) as T);
  }
  return out;
}

export function writeJsonl(file: string, rows: unknown[]): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
}

export function readJson<T>(file: string, fallback?: T): T {
  if (!existsSync(file)) {
    if (fallback !== undefined) return fallback;
    throw new Error(`missing ${file}`);
  }
  return JSON.parse(readFileSync(file, 'utf8')) as T;
}

export function writeJson(file: string, data: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(data, null, 1));
}

export function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

export function flag(name: string): boolean {
  return process.argv.includes(name);
}

export function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function writeCsv(file: string, header: string[], rows: unknown[][]): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\n') + '\n');
}
