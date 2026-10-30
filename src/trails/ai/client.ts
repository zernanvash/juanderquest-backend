import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ZodType } from 'zod';
import { env } from '../../config/env.js';
import { promptFor, type TrailAiPurpose } from './prompts.js';

export const DEFAULT_NIM_BASE_URL = 'https://integrate.api.nvidia.com/v1';
export const DEFAULT_NIM_MODEL = 'nvidia/nemotron-3.5-lightning-30b-a3b';

export type AiFallbackReason =
  | 'traveler_request' | 'nim_not_configured' | 'nim_key_unavailable' | 'rate_limited' | 'timeout'
  | 'upstream_http_error' | 'upstream_unavailable' | 'invalid_json' | 'schema_mismatch'
  | 'hallucinated_place' | 'cache_unavailable';

export class TrailAiError extends Error {
  constructor(readonly reason: AiFallbackReason) { super(reason); }
}

export interface TokenBucketOptions { capacity?: number; refillPerMs?: number; now?: () => number }

export class TokenBucket {
  private tokens: number;
  private updatedAt: number;
  private readonly capacity: number;
  private readonly refillPerMs: number;
  private readonly now: () => number;

  constructor(options: TokenBucketOptions = {}) {
    this.capacity = options.capacity ?? 30;
    this.refillPerMs = options.refillPerMs ?? 30 / 60_000;
    this.now = options.now ?? Date.now;
    this.tokens = this.capacity;
    this.updatedAt = this.now();
  }

  take(): boolean {
    const now = this.now();
    this.tokens = Math.min(this.capacity, this.tokens + Math.max(0, now - this.updatedAt) * this.refillPerMs);
    this.updatedAt = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

const processTrailNimBucket = new TokenBucket();

export async function readNimApiKey(filePath = join(homedir(), '.config', 'juanderquest-alpha', 'nvidia-api-key')): Promise<string> {
  if (env.NODE_ENV === 'test') throw new TrailAiError('nim_key_unavailable');
  try {
    const info = await stat(filePath);
    if (!info.isFile() || info.size < 1 || info.size > 16_384) throw new TrailAiError('nim_key_unavailable');
    if (process.platform !== 'win32' && (info.mode & 0o077) !== 0) throw new TrailAiError('nim_key_unavailable');
    if (typeof process.getuid === 'function' && info.uid !== process.getuid()) throw new TrailAiError('nim_key_unavailable');
    const value = (await readFile(filePath, 'utf8')).trim();
    if (!value || /[\r\n]/.test(value)) throw new TrailAiError('nim_key_unavailable');
    return value;
  } catch (error) {
    if (error instanceof TrailAiError) throw error;
    throw new TrailAiError('nim_key_unavailable');
  }
}

export interface NimClientOptions {
  baseUrl?: string;
  model?: string;
  getApiKey?: () => Promise<string>;
  fetcher?: typeof fetch;
  timeoutMs?: number;
  retries?: number;
  bucket?: TokenBucket;
  sleep?: (ms: number) => Promise<void>;
}

export interface NimResult<T> { value: T; model: string }

export function createNimClient(options: NimClientOptions = {}) {
  const baseUrl = (options.baseUrl ?? env.NIM_BASE_URL ?? DEFAULT_NIM_BASE_URL).replace(/\/+$/, '');
  const model = options.model ?? env.NIM_MODEL ?? DEFAULT_NIM_MODEL;
  const fetcher = options.fetcher ?? fetch;
  const bucket = options.bucket ?? processTrailNimBucket;
  const timeoutMs = options.timeoutMs ?? 20_000;
  const retries = options.retries ?? 2;
  const sleep = options.sleep ?? ((ms: number) => new Promise(resolve => setTimeout(resolve, ms)));
  const getApiKey = options.getApiKey ?? readNimApiKey;

  async function complete<T>(purpose: TrailAiPurpose, input: unknown, schema: ZodType<T>): Promise<NimResult<T>> {
    let apiKey: string;
    try { apiKey = await getApiKey(); }
    catch (error) { throw error instanceof TrailAiError ? error : new TrailAiError('nim_key_unavailable'); }
    if (!apiKey) throw new TrailAiError('nim_key_unavailable');

    let endpoint: URL;
    try {
      endpoint = new URL(`${baseUrl}/chat/completions`);
      if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('invalid');
      if (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && ['127.0.0.1', 'localhost', '::1'].includes(endpoint.hostname))) throw new Error('invalid');
      if (env.NODE_ENV === 'production' && endpoint.hostname !== 'integrate.api.nvidia.com') throw new Error('invalid');
    } catch { throw new TrailAiError('nim_not_configured'); }

    const prompt = promptFor(purpose, input);
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (!bucket.take()) throw new TrailAiError('rate_limited');
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      timeout.unref?.();
      let response: Response;
      let responseText = '';
      try {
        response = await fetcher(endpoint, {
          method: 'POST',
          headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({
            model,
            messages: [{ role: 'system', content: prompt.system }, { role: 'user', content: prompt.user }],
            response_format: { type: 'json_object' },
            temperature: 0.2,
            max_tokens: 1600,
            stream: false,
          }),
          signal: controller.signal,
        });
        if (response.ok) responseText = await response.text();
      } catch (error) {
        if (controller.signal.aborted) throw new TrailAiError('timeout');
        throw new TrailAiError('upstream_unavailable');
      } finally { clearTimeout(timeout); }

      if ((response.status === 429 || response.status >= 500) && attempt < retries) {
        await sleep(150 * (2 ** attempt));
        continue;
      }
      if (!response.ok) throw new TrailAiError(response.status === 429 || response.status >= 500 ? 'upstream_unavailable' : 'upstream_http_error');

      let envelope: unknown;
      try { envelope = JSON.parse(responseText); } catch { throw new TrailAiError('invalid_json'); }
      const content = (envelope as { choices?: Array<{ message?: { content?: unknown } }> })?.choices?.[0]?.message?.content;
      if (typeof content !== 'string') throw new TrailAiError('invalid_json');
      let decoded: unknown;
      try { decoded = JSON.parse(stripJsonFence(content)); } catch { throw new TrailAiError('invalid_json'); }
      const parsed = schema.safeParse(decoded);
      if (!parsed.success) throw new TrailAiError('schema_mismatch');
      return { value: parsed.data, model };
    }
    throw new TrailAiError('upstream_unavailable');
  }

  return { complete, model };
}

function stripJsonFence(value: string): string {
  const trimmed = value.trim();
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return match ? match[1] : trimmed;
}
