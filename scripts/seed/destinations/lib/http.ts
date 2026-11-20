// Plan 116 destinations: polite, cached HTTP for Wikidata / Wikipedia / Commons.
// Identified User-Agent (no personal email), ≤ 1 request per second per host, honours Retry-After / 429,
// every response cached on disk so re-runs make no requests.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const USER_AGENT = 'JuanderQuestSeed/1.0 (+https://juanderquest.app)';
const MIN_INTERVAL_MS = 1100;
const lastRequest = new Map<string, number>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface CachedResponse {
  url: string;
  status: number;
  fetched_at: string;
  body: unknown;
}

export class PoliteClient {
  requests = 0;
  cacheHits = 0;
  constructor(
    private readonly cacheDir: string,
    private readonly offline = false,
  ) {
    mkdirSync(cacheDir, { recursive: true });
  }

  private pathFor(key: string): string {
    return join(this.cacheDir, `${createHash('sha1').update(key).digest('hex')}.json`);
  }

  /** GET (or POST form when `form` is given) returning parsed JSON; cached by URL + form. */
  async json(url: string, form?: Record<string, string>): Promise<CachedResponse> {
    const key = form ? `${url}\n${new URLSearchParams(form).toString()}` : url;
    const file = this.pathFor(key);
    if (existsSync(file)) {
      this.cacheHits++;
      return JSON.parse(readFileSync(file, 'utf8')) as CachedResponse;
    }
    if (this.offline) throw new Error(`offline and not cached: ${url}`);
    const host = new URL(url).host;
    for (let attempt = 1; ; attempt++) {
      const wait = (lastRequest.get(host) ?? 0) + MIN_INTERVAL_MS - Date.now();
      if (wait > 0) await sleep(wait);
      lastRequest.set(host, Date.now());
      this.requests++;
      const res = await fetch(url, {
        method: form ? 'POST' : 'GET',
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'application/json, application/sparql-results+json',
          ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
        },
        body: form ? new URLSearchParams(form).toString() : undefined,
      });
      if (res.status === 429 || res.status === 503 || res.status >= 500) {
        if (attempt >= 6) throw new Error(`HTTP ${res.status} after ${attempt} attempts: ${host}`);
        const retryAfter = Number(res.headers.get('retry-after'));
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 5000 * attempt);
        continue;
      }
      if (res.status === 403) throw new Error(`HTTP 403 from ${host}: stop using this source and report`);
      const text = await res.text();
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        throw new Error(`HTTP ${res.status} non-JSON from ${host}: ${text.slice(0, 200)}`);
      }
      const record = { url, status: res.status, fetched_at: new Date().toISOString(), body };
      if (res.ok) writeFileSync(file, JSON.stringify(record));
      else throw new Error(`HTTP ${res.status} from ${host}`);
      return record;
    }
  }
}
