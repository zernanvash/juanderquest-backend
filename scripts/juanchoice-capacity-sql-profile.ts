import { performance } from 'node:perf_hooks';
import type { Pool } from 'pg';

export type SqlProfilePath = 'pool_query' | 'transaction_client_query' | 'client_callback_query';

export function sqlShape(query: unknown): string {
  const text = typeof query === 'string' ? query
    : query && typeof query === 'object' && 'text' in query ? String(query.text) : '<unknown>';
  return text.replace(/\s+/g, ' ').trim().slice(0, 160);
}

export type ReadQueryFocusShapeKey =
  | 'durable_wallet_batch'
  | 'campaign_lookup'
  | 'standings_aggregate'
  | 'monthly_overview_schedule'
  | 'monthly_overview_current_period'
  | 'monthly_overview_next_period'
  | 'monthly_overview_previous_period'
  | 'monthly_overview_pending_period'
  | 'monthly_overview_postponed_period';

export interface ReadQueryFocusDefinition {
  readonly key: ReadQueryFocusShapeKey;
  readonly label: string;
  readonly match: (shape: string) => boolean;
}

export const KNOWN_READ_QUERY_SHAPES: readonly ReadQueryFocusDefinition[] = [
  {
    key: 'durable_wallet_batch',
    label: 'durable_wallet_batch',
    match: shape => shape === 'SELECT id, seed_id, is_test FROM users WHERE id = ANY($1::text[])',
  },
  {
    key: 'campaign_lookup',
    label: 'campaign_lookup',
    match: shape => shape.startsWith('SELECT id,slug,region,theme,status,opens_at,closes_at,is_test,policy_version FROM juanchoice_campaigns WHERE id = $1'),
  },
  {
    key: 'standings_aggregate',
    label: 'standings_aggregate',
    match: shape => shape.startsWith('SELECT c.id AS candidate_id, c.spot_id, s.slug AS spot_slug, s.name AS spot_name, COUNT(b.user_id)::int AS votes FROM juanchoice_candidates c'),
  },
  {
    key: 'monthly_overview_schedule',
    label: 'monthly_overview_schedule',
    match: shape => shape.startsWith('SELECT id,region_key,display_region,timezone,enabled FROM juanchoice_schedules WHERE region_key=$1'),
  },
  {
    key: 'monthly_overview_current_period',
    label: 'monthly_overview_current_period',
    match: shape => shape.startsWith('SELECT c.id,c.slug,c.region,c.theme,c.status,c.opens_at,c.closes_at,c.policy_version,p.period_start FROM juanchoice_schedule_periods p'),
  },
  {
    key: 'monthly_overview_next_period',
    label: 'monthly_overview_next_period',
    match: shape => shape.startsWith('SELECT opens_at,closes_at,selected_theme,status,period_start FROM juanchoice_schedule_periods WHERE schedule_id=$1 AND opens_at > $2'),
  },
  {
    key: 'monthly_overview_previous_period',
    label: 'monthly_overview_previous_period',
    // sqlShape caps keys at 160 characters; match before the truncated FROM.
    match: shape => shape.startsWith('SELECT c.id AS campaign_id,c.theme,p.period_start,p.opens_at,p.closes_at, r.finalized_at,r.valid_ballots,r.co_winner_ids,r.standings'),
  },
  {
    key: 'monthly_overview_pending_period',
    label: 'monthly_overview_pending_period',
    match: shape => shape.startsWith('SELECT 1 FROM juanchoice_schedule_periods p JOIN juanchoice_campaigns c ON c.id=p.campaign_id LEFT JOIN juanchoice_results r'),
  },
  {
    key: 'monthly_overview_postponed_period',
    label: 'monthly_overview_postponed_period',
    match: shape => shape.startsWith('SELECT period_start FROM juanchoice_schedule_periods WHERE schedule_id=$1 AND status=\'postponed\''),
  },
];

export function classifyReadQueryShape(shape: string): ReadQueryFocusDefinition | null {
  for (const def of KNOWN_READ_QUERY_SHAPES) {
    if (def.match(shape)) return def;
  }
  return null;
}

export function computePercentile(sortedValues: readonly number[], p: number): number {
  if (sortedValues.length === 0) return 0;
  const index = Math.min(sortedValues.length - 1, Math.ceil(sortedValues.length * p) - 1);
  return Math.round(sortedValues[index] ?? 0);
}

export type ReadQueryElapsedScope =
  | 'end_to_end_pool_query_elapsed'
  | 'transaction_client_query_elapsed'
  | 'client_callback_elapsed';

export interface ReadQueryFocusItem {
  readonly key: ReadQueryFocusShapeKey;
  readonly label: string;
  readonly path: SqlProfilePath;
  readonly elapsed_scope: ReadQueryElapsedScope;
  readonly count: number;
  readonly error_count: number;
  readonly p50_ms: number;
  readonly p95_ms: number;
  readonly max_ms: number;
  readonly total_ms: number;
}

export function buildReadQueryFocusReport(
  sqlTimings: ReadonlyMap<string, readonly number[]>,
  sqlErrors: ReadonlyMap<string, number>
): ReadQueryFocusItem[] {
  const items: ReadQueryFocusItem[] = [];

  for (const [compositeKey, rawSamples] of sqlTimings.entries()) {
    const pipeIdx = compositeKey.indexOf('|');
    if (pipeIdx === -1) continue;
    const path = compositeKey.slice(0, pipeIdx) as SqlProfilePath;
    if (path !== 'pool_query' && path !== 'transaction_client_query' && path !== 'client_callback_query') continue;
    const sql = compositeKey.slice(pipeIdx + 1);

    const matchDef = classifyReadQueryShape(sql);
    if (!matchDef) continue;

    if (!rawSamples || rawSamples.length === 0) continue;

    const sorted = [...rawSamples].sort((a, b) => a - b);
    const count = sorted.length;
    const error_count = sqlErrors.get(compositeKey) ?? 0;
    const total_ms = Math.round(sorted.reduce((sum, val) => sum + val, 0));
    const p50_ms = computePercentile(sorted, 0.50);
    const p95_ms = computePercentile(sorted, 0.95);
    const max_ms = Math.round(sorted[sorted.length - 1] ?? 0);
    const elapsed_scope: ReadQueryElapsedScope = path === 'pool_query'
      ? 'end_to_end_pool_query_elapsed'
      : path === 'client_callback_query'
        ? 'client_callback_elapsed'
        : 'transaction_client_query_elapsed';

    items.push({
      key: matchDef.key,
      label: matchDef.label,
      path,
      elapsed_scope,
      count,
      error_count,
      p50_ms,
      p95_ms,
      max_ms,
      total_ms,
    });
  }

  // Stable deterministic sorting by key then path
  return items.sort((a, b) => {
    if (a.key !== b.key) return a.key.localeCompare(b.key);
    return a.path.localeCompare(b.path);
  });
}

export interface CallbackClientQueryHooks {
  readonly isActive: () => boolean;
  readonly record: (query: unknown, elapsedMs: number, success: boolean, startMs?: number, endMs?: number) => void;
}

/**
 * Instruments callback-style client.query calls for known bounded read shapes only.
 * Preserves callback receiver, arguments, return value, and error behavior.
 * Records once on callback success/failure; records synchronous throw once.
 * Never logs parameter values, raw bind arrays, or secrets.
 */
export function instrumentCallbackClientQuery<TClient extends { query: (...args: any[]) => any }>(
  client: TClient,
  hooks: CallbackClientQueryHooks
): void {
  const original = client.query;
  client.query = (function (this: unknown, ...args: unknown[]) {
    // Locate trailing callback function argument
    let callbackIndex = -1;
    for (let index = args.length - 1; index >= 0; index--) {
      if (typeof args[index] === 'function') {
        callbackIndex = index;
        break;
      }
    }

    // Only instrument callback-style calls
    if (callbackIndex < 0) {
      return Reflect.apply(original, this, args);
    }

    const query = args[0];
    const shape = sqlShape(query);
    const matched = classifyReadQueryShape(shape);

    // Only instrument known bounded read query shapes
    if (!matched) {
      return Reflect.apply(original, this, args);
    }

    const active = hooks.isActive();
    const started = performance.now();
    let recorded = false;
    const finish = (success: boolean) => {
      if (recorded) return;
      recorded = true;
      if (!active) return;
      const finished = performance.now();
      hooks.record(query, finished - started, success, started, finished);
    };

    const originalCallback = args[callbackIndex] as (...cbArgs: unknown[]) => unknown;
    const wrappedArgs = [...args];
    wrappedArgs[callbackIndex] = function (this: unknown, ...cbArgs: unknown[]) {
      finish(cbArgs[0] == null);
      return Reflect.apply(originalCallback, this, cbArgs);
    };

    try {
      return Reflect.apply(original, this, wrappedArgs);
    } catch (error) {
      finish(false);
      throw error;
    }
  }) as typeof client.query;
}

interface PoolQueryProfileHooks {
  readonly isActive: () => boolean;
  readonly record: (query: unknown, elapsedMs: number, success: boolean) => void;
  readonly isWalletLookup: (query: unknown, values: unknown) => boolean;
  readonly onWalletLookup: (query: unknown, values: unknown) => void;
}

/** Wrap only one disposable Pool instance; restore it after the rehearsal. */
export function installPoolQueryProfile(pool: Pool, hooks: PoolQueryProfileHooks): () => void {
  const original = pool.query;
  pool.query = (function (this: Pool, ...args: unknown[]) {
    const active = hooks.isActive();
    const started = performance.now();
    const query = args[0];
    const values = args[1];
    let finished = false;
    const finish = (success: boolean) => {
      if (finished) return;
      finished = true;
      if (!active) return;
      hooks.record(query, performance.now() - started, success);
      if (success && hooks.isWalletLookup(query, values)) hooks.onWalletLookup(query, values);
    };

    let callbackIndex = -1;
    for (let index = args.length - 1; index >= 0; index--) {
      if (typeof args[index] === 'function') { callbackIndex = index; break; }
    }
    if (callbackIndex >= 0) {
      const callback = args[callbackIndex] as (...callbackArgs: unknown[]) => unknown;
      const callArgs = [...args];
      callArgs[callbackIndex] = function (this: unknown, ...callbackArgs: unknown[]) {
        finish(callbackArgs[0] == null);
        return Reflect.apply(callback, this, callbackArgs);
      };
      try {
        return Reflect.apply(original, this, callArgs);
      } catch (error) {
        finish(false);
        throw error;
      }
    }

    try {
      const result = Reflect.apply(original, this, args);
      if (result && typeof result.then === 'function') {
        return result.then(
          (value: unknown) => { finish(true); return value; },
          (error: unknown) => { finish(false); throw error; },
        );
      }
      finish(true);
      return result;
    } catch (error) {
      finish(false);
      throw error;
    }
  }) as typeof pool.query;
  return () => { pool.query = original; };
}
