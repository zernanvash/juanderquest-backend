// Polite HTTP for the photo pipeline (brief hard rule 2): identified User-Agent, ≤ 1 request/s
// per host, Retry-After / 429 / 503 honoured, JSON responses cached on disk, no retries on 403
// (a block means we stop using the source).
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

export const USER_AGENT = 'JuanderQuestSeed/1.0 (+https://juanderquest.app)';

export class SourceBlockedError extends Error {
  constructor(
    readonly host: string,
    readonly status: number,
  ) {
    super(`SOURCE_BLOCKED ${host} HTTP ${status}`);
  }
}

const lastRequestAt = new Map<string, number>();
const hostQueue = new Map<string, Promise<void>>();
let minIntervalMs = 1000;
export const stats = { requests: 0, cacheHits: 0, bytes: 0, retries: 0 };

export function setMinIntervalMs(ms: number): void {
  minIntervalMs = Math.max(1000, ms);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Serialises requests per host and spaces them ≥ minIntervalMs apart. */
async function throttle(host: string): Promise<void> {
  const prev = hostQueue.get(host) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((r) => (release = r));
  hostQueue.set(
    host,
    prev.then(() => mine),
  );
  await prev;
  const wait = (lastRequestAt.get(host) ?? 0) + minIntervalMs - Date.now();
  if (wait > 0) await sleep(wait);
  lastRequestAt.set(host, Date.now());
  // Release the next caller once our request has started; spacing is enforced by lastRequestAt.
  release();
}

export function retryAfterMs(header: string | null, fallbackMs: number): number {
  if (!header) return fallbackMs;
  const secs = Number(header);
  if (Number.isFinite(secs)) return Math.min(Math.max(secs * 1000, 1000), 15 * 60 * 1000);
  const at = Date.parse(header);
  if (Number.isFinite(at)) return Math.min(Math.max(at - Date.now(), 1000), 15 * 60 * 1000);
  return fallbackMs;
}

async function politeFetch(url: string, init: RequestInit = {}, attempts = 5): Promise<Response> {
  const host = new URL(url).host;
  for (let i = 0; ; i++) {
    await throttle(host);
    stats.requests++;
    const res = await fetch(url, {
      ...init,
      headers: { 'User-Agent': USER_AGENT, 'Api-User-Agent': USER_AGENT, ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(60_000),
    });
    if (res.status === 429 || res.status === 503 || res.status === 502 || res.status === 504) {
      if (i + 1 >= attempts) throw new Error(`HTTP ${res.status} after ${attempts} attempts: ${host}`);
      stats.retries++;
      const wait = retryAfterMs(res.headers.get('retry-after'), 5000 * 2 ** i);
      await res.arrayBuffer().catch(() => undefined);
      await sleep(wait);
      continue;
    }
    if (res.status === 403 || res.status === 401) {
      await res.arrayBuffer().catch(() => undefined);
      throw new SourceBlockedError(host, res.status);
    }
    return res;
  }
}

export interface JsonCacheOptions {
  cacheDir: string;
  /** Re-fetch when the cached copy is older than this (ms). Default: never expires. */
  maxAgeMs?: number;
  headers?: Record<string, string>;
  /** Cache key override (e.g. a URL without credentials). */
  cacheKey?: string;
}

export async function getJson<T = unknown>(url: string, opts: JsonCacheOptions): Promise<T> {
  const key = crypto
    .createHash('sha1')
    .update(opts.cacheKey ?? url)
    .digest('hex');
  const host = new URL(url).host;
  const file = path.join(opts.cacheDir, 'http', host, key.slice(0, 2), `${key}.json`);
  if (fs.existsSync(file)) {
    const age = Date.now() - fs.statSync(file).mtimeMs;
    if (!opts.maxAgeMs || age < opts.maxAgeMs) {
      stats.cacheHits++;
      return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
    }
  }
  const res = await politeFetch(url, { headers: { Accept: 'application/json', ...(opts.headers ?? {}) } });
  const text = await res.text();
  stats.bytes += text.length;
  if (!res.ok) throw new Error(`HTTP ${res.status} ${host}: ${text.slice(0, 200)}`);
  const body = JSON.parse(text) as T;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return body;
}

/** Downloads a binary to `dest` (atomic rename). Returns the byte count. */
export async function downloadTo(url: string, dest: string, maxBytes = 40 * 1024 * 1024): Promise<number> {
  const res = await politeFetch(url, { headers: { Accept: 'image/*' } });
  if (!res.ok) {
    await res.arrayBuffer().catch(() => undefined);
    throw new Error(`HTTP ${res.status} downloading ${new URL(url).host}`);
  }
  const len = Number(res.headers.get('content-length') ?? 0);
  if (len > maxBytes) throw new Error(`download too large (${len} bytes)`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > maxBytes) throw new Error(`download too large (${buf.length} bytes)`);
  stats.bytes += buf.length;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(`${dest}.part`, buf);
  fs.renameSync(`${dest}.part`, dest);
  return buf.length;
}
