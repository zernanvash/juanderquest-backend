import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { ZodType } from 'zod';
import { createNimClient, TrailAiError, type AiFallbackReason } from './client.js';
import { TRAIL_PROMPT_VERSION, type TrailAiPurpose } from './prompts.js';

export const TRAIL_AI_TTL_MS: Readonly<Record<TrailAiPurpose, number>> = Object.freeze({
  trend_digest: 7 * 24 * 60 * 60 * 1000,
  parse_preferences: 24 * 60 * 60 * 1000,
  tell_story: 30 * 24 * 60 * 60 * 1000,
});

export interface CachedAiResult<T> { value: T; aiUsed: boolean; model: string | null; fallbackReason: AiFallbackReason | null; cacheHit: boolean }
export interface CachedAiOptions<T> {
  queryable: Pool | PoolClient;
  purpose: TrailAiPurpose;
  input: unknown;
  schema: ZodType<T>;
  fallback: (reason: AiFallbackReason) => T;
  validate?: (value: T) => boolean;
  client?: ReturnType<typeof createNimClient>;
  now?: () => Date;
}

export async function cachedTrailAi<T>(options: CachedAiOptions<T>): Promise<CachedAiResult<T>> {
  const client = options.client ?? createNimClient();
  // Tests must supply an explicit local/mock NIM client to make a request.
  // A developer's private key file must never turn an unrelated test into a
  // real NVIDIA call.
  if (process.env.NODE_ENV === 'test' && !options.client) {
    return fallbackResult(options, 'nim_not_configured', client.model);
  }
  const canonicalInput = canonicalize(options.input);
  const cacheKey = createHash('sha256').update(JSON.stringify({
    purpose: options.purpose, model: client.model, promptVersion: TRAIL_PROMPT_VERSION, input: canonicalInput,
  })).digest('hex');

  try {
    const cached = await options.queryable.query(
      `SELECT response FROM ai_cache WHERE cache_key=$1 AND purpose=$2 AND expires_at>clock_timestamp()`,
      [cacheKey, options.purpose],
    );
    if (cached.rows[0]) {
      const parsed = options.schema.safeParse(cached.rows[0].response);
      if (parsed.success && (!options.validate || options.validate(parsed.data))) {
        return { value: parsed.data, aiUsed: true, model: client.model, fallbackReason: null, cacheHit: true };
      }
      await options.queryable.query('DELETE FROM ai_cache WHERE cache_key=$1', [cacheKey]);
    }
  } catch {
    return fallbackResult(options, 'cache_unavailable', client.model);
  }

  try {
    const generated = await client.complete(options.purpose, options.input, options.schema);
    if (options.validate && !options.validate(generated.value)) throw new TrailAiError('hallucinated_place');
    const now = options.now?.() ?? new Date();
    const expiresAt = new Date(now.getTime() + TRAIL_AI_TTL_MS[options.purpose]);
    try {
      await options.queryable.query(
        `INSERT INTO ai_cache (cache_key,purpose,response,created_at,expires_at)
         VALUES ($1,$2,$3::jsonb,$4,$5)
         ON CONFLICT (cache_key) DO UPDATE SET response=EXCLUDED.response,created_at=EXCLUDED.created_at,expires_at=EXCLUDED.expires_at`,
        [cacheKey, options.purpose, JSON.stringify(generated.value), now, expiresAt],
      );
    } catch { return fallbackResult(options, 'cache_unavailable', client.model); }
    return { value: generated.value, aiUsed: true, model: generated.model, fallbackReason: null, cacheHit: false };
  } catch (error) {
    const reason = error instanceof TrailAiError ? error.reason : 'upstream_unavailable';
    return fallbackResult(options, reason, client.model);
  }
}

function fallbackResult<T>(options: CachedAiOptions<T>, reason: AiFallbackReason, model: string | null): CachedAiResult<T> {
  return { value: options.fallback(reason), aiUsed: false, model, fallbackReason: reason, cacheHit: false };
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonicalize(item)]));
  }
  return value;
}
