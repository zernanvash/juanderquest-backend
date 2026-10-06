import type { Pool } from 'pg';
import {
  buildReadQueryFocusReport,
  classifyReadQueryShape,
  computePercentile,
  installPoolQueryProfile,
  instrumentCallbackClientQuery,
  sqlShape,
  type ReadQueryFocusItem,
} from '../scripts/juanchoice-capacity-sql-profile.js';
import { countDisposableWalletReaderBatchChecks } from '../scripts/juanchoice-capacity-reader-matcher.js';

describe('capacity SQL profile pool-query wrapper', () => {
  it('counts successful batched identities but no failed or guest queries', async () => {
    const sql = 'SELECT id, seed_id, is_test FROM users WHERE id = ANY($1::text[])';
    const ids = ['reader-a', 'reader-b'];
    const allowed = new Set(ids);
    const query = jest.fn((_sql: string, values: unknown[]) =>
      values[0] === 'fail' ? Promise.reject(new Error('outage')) : Promise.resolve({ rows: [] }));
    const pool = { query } as unknown as Pool;
    let identityChecks = 0;
    let identityQueries = 0;
    const restore = installPoolQueryProfile(pool, {
      isActive: () => true,
      record: () => undefined,
      isWalletLookup: (statement, values) => countDisposableWalletReaderBatchChecks(statement, values, allowed) > 0,
      onWalletLookup: (statement, values) => {
        identityChecks += countDisposableWalletReaderBatchChecks(statement, values, allowed);
        identityQueries++;
      },
    });
    await pool.query(sql, [ids]);
    await expect(pool.query(sql, ['fail'])).rejects.toThrow('outage');
    expect(identityChecks).toBe(2);
    expect(identityQueries).toBe(1);
    restore();

    expect(countDisposableWalletReaderBatchChecks(sql, [ids], new Set())).toBe(0);
  });
  it('profiles promise success/failure once and preserves results and errors', async () => {
    const failure = new Error('expected test failure');
    const result = { rows: [{ value: 1 }] };
    const original = jest.fn((_sql: string) => _sql === 'SELECT fail' ? Promise.reject(failure) : Promise.resolve(result));
    const pool = { query: original } as unknown as Pool;
    const records: Array<{ sql: string; success: boolean; elapsed: number }> = [];
    let lookups = 0;
    const restore = installPoolQueryProfile(pool, {
      isActive: () => true,
      record: (query, elapsed, success) => records.push({ sql: sqlShape(query), success, elapsed }),
      isWalletLookup: (query) => query === 'SELECT ok',
      onWalletLookup: () => { lookups++; },
    });

    expect(await pool.query('SELECT ok')).toBe(result);
    await expect(pool.query('SELECT fail')).rejects.toBe(failure);
    expect(records.map(row => [row.sql, row.success])).toEqual([
      ['SELECT ok', true], ['SELECT fail', false],
    ]);
    expect(records.every(row => Number.isFinite(row.elapsed) && row.elapsed >= 0)).toBe(true);
    expect(lookups).toBe(1);
    restore();
    expect(pool.query).toBe(original);
  });

  it('profiles callback success/failure once and preserves callback context, result and error', () => {
    const failure = new Error('expected callback failure');
    const result = { rows: [{ value: 2 }] };
    const original = jest.fn(function (this: unknown, sql: string, _values: unknown[], callback: (...args: unknown[]) => void) {
      callback.call(this, sql === 'SELECT fail' ? failure : null, sql === 'SELECT fail' ? undefined : result);
      return 'callback-return';
    });
    const pool = { query: original } as unknown as Pool;
    const records: Array<{ success: boolean; elapsed: number }> = [];
    let lookups = 0;
    const restore = installPoolQueryProfile(pool, {
      isActive: () => true,
      record: (_query, elapsed, success) => records.push({ success, elapsed }),
      isWalletLookup: (_query, values) => Array.isArray(values) && values[0] === 'wallet-reader',
      onWalletLookup: () => { lookups++; },
    });
    const callback = jest.fn(function (this: unknown, error: unknown, value: unknown) {
      expect(this).toBe(pool);
      return [error, value];
    });

    expect(Reflect.apply(pool.query, pool, ['SELECT ok', ['wallet-reader'], callback])).toBe('callback-return');
    expect(Reflect.apply(pool.query, pool, ['SELECT fail', ['wallet-reader'], callback])).toBe('callback-return');
    expect(callback.mock.calls).toEqual([[null, result], [failure, undefined]]);
    expect(records.map(row => row.success)).toEqual([true, false]);
    expect(records.every(row => Number.isFinite(row.elapsed) && row.elapsed >= 0)).toBe(true);
    expect(lookups).toBe(1);
    restore();
  });

  it('omits bind values from SQL shape and does not profile inactive calls', async () => {
    const original = jest.fn((_query: unknown, _values: unknown) => Promise.resolve({ rows: [] }));
    const pool = { query: original } as unknown as Pool;
    const records: string[] = [];
    const restore = installPoolQueryProfile(pool, {
      isActive: () => false,
      record: query => { records.push(sqlShape(query)); },
      isWalletLookup: () => true,
      onWalletLookup: () => { throw new Error('should not count inactive lookups'); },
    });
    await pool.query('SELECT id FROM users WHERE id = $1', ['secret-user-id']);
    expect(records).toEqual([]);
    expect(sqlShape({ text: 'SELECT id FROM users WHERE id = $1', values: ['secret-user-id'] }))
      .toBe('SELECT id FROM users WHERE id = $1');
    restore();
  });
});

describe('read query focus reporting', () => {

  it('classifies exact known read query shapes accurately', () => {
    const walletSql = 'SELECT id, seed_id, is_test FROM users WHERE id = ANY($1::text[])';
    const campaignSql = "SELECT id,slug,region,theme,status,opens_at,closes_at,is_test,policy_version FROM juanchoice_campaigns WHERE id = $1 AND status <> 'draft' AND ($2::boolean OR is_test = FALSE)";
    const standingsSql = "SELECT c.id AS candidate_id, c.spot_id, s.slug AS spot_slug, s.name AS spot_name, COUNT(b.user_id)::int AS votes FROM juanchoice_candidates c JOIN spots s ON s.id = c.spot_id LEFT JOIN juanchoice_ballots b ON b.campaign_id = c.campaign_id AND b.candidate_id = c.id WHERE c.campaign_id = $1 AND c.status = 'eligible' AND c.is_test = $2 AND s.is_test = $2 AND s.status = 'published' AND s.recommendation_suppressed = FALSE GROUP BY c.id,c.spot_id,s.slug,s.name ORDER BY votes DESC,c.id";
    const overviewScheduleSql = "SELECT id,region_key,display_region,timezone,enabled FROM juanchoice_schedules WHERE region_key=$1 AND is_test=$2 ORDER BY created_at,id LIMIT 1";
    const currentPeriodSql = "SELECT c.id,c.slug,c.region,c.theme,c.status,c.opens_at,c.closes_at,c.policy_version,p.period_start FROM juanchoice_schedule_periods p JOIN juanchoice_campaigns c ON c.id=p.campaign_id WHERE p.schedule_id=$1 AND p.status='prepared' AND c.status IN ('scheduled','voting') AND p.opens_at <= $2 AND p.closes_at > $2 ORDER BY p.period_start DESC,p.id DESC LIMIT 1";
    const previousPeriodSql = `SELECT c.id AS campaign_id,c.theme,p.period_start,p.opens_at,p.closes_at,
         r.finalized_at,r.valid_ballots,r.co_winner_ids,r.standings
       FROM juanchoice_schedule_periods p JOIN juanchoice_campaigns c ON c.id=p.campaign_id`;

    expect(classifyReadQueryShape(walletSql)?.key).toBe('durable_wallet_batch');
    expect(classifyReadQueryShape(campaignSql)?.key).toBe('campaign_lookup');
    expect(classifyReadQueryShape(standingsSql)?.key).toBe('standings_aggregate');
    expect(classifyReadQueryShape(overviewScheduleSql)?.key).toBe('monthly_overview_schedule');
    expect(classifyReadQueryShape(currentPeriodSql)?.key).toBe('monthly_overview_current_period');
    expect(classifyReadQueryShape(sqlShape(previousPeriodSql))?.key).toBe('monthly_overview_previous_period');

    // Ballot write query or unrelated query must return null
    expect(classifyReadQueryShape('INSERT INTO juanchoice_ballots(campaign_id,user_id,candidate_id,version,is_test) VALUES($1,$2,$3,$4,$5)')).toBeNull();
    expect(classifyReadQueryShape('SELECT clock_timestamp() AS now')).toBeNull();
    expect(classifyReadQueryShape('COMMIT')).toBeNull();
  });

  it('computes percentiles correctly without fabricating samples', () => {
    expect(computePercentile([], 0.50)).toBe(0);
    expect(computePercentile([], 0.95)).toBe(0);

    const single = [100];
    expect(computePercentile(single, 0.50)).toBe(100);
    expect(computePercentile(single, 0.95)).toBe(100);

    // 10 samples: 10, 20, 30, ..., 100
    const ten = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    // p50: index Math.min(9, Math.ceil(10 * 0.50) - 1) = index 4 -> 50
    expect(computePercentile(ten, 0.50)).toBe(50);
    // p95: index Math.min(9, Math.ceil(10 * 0.95) - 1) = index Math.min(9, 10 - 1) = index 9 -> 100
    expect(computePercentile(ten, 0.95)).toBe(100);
  });

  it('builds bounded read query focus report for selected shapes only and produces no fabricated zero samples for missing shapes', () => {
    const timings = new Map<string, number[]>();
    const errors = new Map<string, number>();

    // Add wallet query under pool_query
    timings.set('pool_query|SELECT id, seed_id, is_test FROM users WHERE id = ANY($1::text[])', [50, 100, 250, 75, 125]);
    // Add campaign lookup under pool_query
    timings.set("pool_query|SELECT id,slug,region,theme,status,opens_at,closes_at,is_test,policy_version FROM juanchoice_campaigns WHERE id = $1 AND status <> 'draft' AND ($2::boolean OR is_test = FALSE)", [40, 80, 120]);
    errors.set("pool_query|SELECT id,slug,region,theme,status,opens_at,closes_at,is_test,policy_version FROM juanchoice_campaigns WHERE id = $1 AND status <> 'draft' AND ($2::boolean OR is_test = FALSE)", 1);

    // Add ballot write under transaction_client_query (must be ignored)
    timings.set('transaction_client_query|INSERT INTO juanchoice_ballots(campaign_id,user_id,candidate_id,version,is_test) VALUES($1,$2,$3,$4,$5)', [10, 15, 20]);

    const report = buildReadQueryFocusReport(timings, errors);

    // Only the 2 matching read query shapes must be present in report
    expect(report).toHaveLength(2);

    // Sorted deterministically: campaign_lookup before durable_wallet_batch
    expect(report[0].key).toBe('campaign_lookup');
    expect(report[0].path).toBe('pool_query');
    expect(report[0].elapsed_scope).toBe('end_to_end_pool_query_elapsed');
    expect(report[0].count).toBe(3);
    expect(report[0].error_count).toBe(1);
    expect(report[0].total_ms).toBe(240);
    expect(report[0].p50_ms).toBe(80);
    expect(report[0].p95_ms).toBe(120);
    expect(report[0].max_ms).toBe(120);

    expect(report[1].key).toBe('durable_wallet_batch');
    expect(report[1].path).toBe('pool_query');
    expect(report[1].elapsed_scope).toBe('end_to_end_pool_query_elapsed');
    expect(report[1].count).toBe(5);
    expect(report[1].error_count).toBe(0);
    expect(report[1].total_ms).toBe(600);
    expect(report[1].p50_ms).toBe(100);
    expect(report[1].p95_ms).toBe(250);
    expect(report[1].max_ms).toBe(250);

    // Missing shapes (e.g. standings_aggregate, monthly_overview_*) must NOT produce fabricated zero entries
    expect(report.find(r => r.key === 'standings_aggregate')).toBeUndefined();
    expect(report.find(r => r.key === 'monthly_overview_schedule')).toBeUndefined();
  });

  it('reports client_callback_query path with client_callback_elapsed scope alongside pool_query', () => {
    const timings = new Map<string, number[]>();
    const errors = new Map<string, number>();

    const walletSql = 'SELECT id, seed_id, is_test FROM users WHERE id = ANY($1::text[])';
    timings.set(`pool_query|${walletSql}`, [200, 300]);
    timings.set(`client_callback_query|${walletSql}`, [5, 15]);

    const report = buildReadQueryFocusReport(timings, errors);
    expect(report).toHaveLength(2);

    expect(report[0].key).toBe('durable_wallet_batch');
    expect(report[0].path).toBe('client_callback_query');
    expect(report[0].elapsed_scope).toBe('client_callback_elapsed');
    expect(report[0].count).toBe(2);
    expect(report[0].p50_ms).toBe(5);
    expect(report[0].p95_ms).toBe(15);

    expect(report[1].key).toBe('durable_wallet_batch');
    expect(report[1].path).toBe('pool_query');
    expect(report[1].elapsed_scope).toBe('end_to_end_pool_query_elapsed');
    expect(report[1].count).toBe(2);
    expect(report[1].p50_ms).toBe(200);
    expect(report[1].p95_ms).toBe(300);
  });
});

describe('instrumentCallbackClientQuery harness helper', () => {
  it('profiles callback success once and preserves context, args and return value', () => {
    const sql = 'SELECT id, seed_id, is_test FROM users WHERE id = ANY($1::text[])';
    const clientResult = { rows: [{ id: 'user-1' }] };
    const originalQuery = jest.fn(function (this: unknown, _text: string, _values: unknown[], cb: (...args: unknown[]) => void) {
      cb.call(this, null, clientResult);
      return 'query-handle';
    });
    const fakeClient = { query: originalQuery };
    const records: Array<{ query: unknown; elapsed: number; success: boolean; start?: number; end?: number }> = [];
    instrumentCallbackClientQuery(fakeClient, {
      isActive: () => true,
      record: (query, elapsed, success, start, end) => records.push({ query, elapsed, success, start, end }),
    });

    const callback = jest.fn(function (this: unknown, err: unknown, res: unknown) {
      expect(this).toBe(fakeClient);
      return [err, res];
    });

    const ret = Reflect.apply(fakeClient.query, fakeClient, [sql, [['secret-user-1']], callback]);
    expect(ret).toBe('query-handle');
    expect(callback).toHaveBeenCalledWith(null, clientResult);
    expect(records).toHaveLength(1);
    expect(records[0].query).toBe(sql);
    expect(records[0].success).toBe(true);
    expect(Number.isFinite(records[0].elapsed) && records[0].elapsed >= 0).toBe(true);
    expect(Number.isFinite(records[0].start)).toBe(true);
    expect(Number.isFinite(records[0].end)).toBe(true);
    expect(records[0].end! - records[0].start!).toBeCloseTo(records[0].elapsed, 5);
  });

  it('profiles callback error once and preserves error to caller', () => {
    const sql = 'SELECT id, seed_id, is_test FROM users WHERE id = ANY($1::text[])';
    const failure = new Error('simulated pg wire error');
    const originalQuery = jest.fn((_text: string, cb: (...args: unknown[]) => void) => {
      cb(failure, undefined);
    });
    const fakeClient = { query: originalQuery };
    const records: Array<{ query: unknown; elapsed: number; success: boolean }> = [];
    instrumentCallbackClientQuery(fakeClient, {
      isActive: () => true,
      record: (query, elapsed, success) => records.push({ query, elapsed, success }),
    });

    const callback = jest.fn();
    Reflect.apply(fakeClient.query, fakeClient, [sql, callback]);
    expect(callback).toHaveBeenCalledWith(failure, undefined);
    expect(records).toHaveLength(1);
    expect(records[0].success).toBe(false);
  });

  it('profiles synchronous throw once and bubbles error', () => {
    const sql = 'SELECT id, seed_id, is_test FROM users WHERE id = ANY($1::text[])';
    const syncError = new Error('sync dispatch failure');
    const originalQuery = jest.fn(() => {
      throw syncError;
    });
    const fakeClient = { query: originalQuery };
    const records: Array<{ query: unknown; elapsed: number; success: boolean }> = [];
    instrumentCallbackClientQuery(fakeClient, {
      isActive: () => true,
      record: (query, elapsed, success) => records.push({ query, elapsed, success }),
    });

    const callback = jest.fn();
    expect(() => Reflect.apply(fakeClient.query, fakeClient, [sql, callback])).toThrow('sync dispatch failure');
    expect(records).toHaveLength(1);
    expect(records[0].success).toBe(false);
    expect(callback).not.toHaveBeenCalled();
  });

  it('does not record when inactive', () => {
    const sql = 'SELECT id, seed_id, is_test FROM users WHERE id = ANY($1::text[])';
    const originalQuery = jest.fn((_text: string, cb: (...args: unknown[]) => void) => {
      cb(null, { rows: [] });
    });
    const fakeClient = { query: originalQuery };
    const records: unknown[] = [];
    instrumentCallbackClientQuery(fakeClient, {
      isActive: () => false,
      record: () => records.push('recorded'),
    });

    const callback = jest.fn();
    Reflect.apply(fakeClient.query, fakeClient, [sql, callback]);
    expect(records).toHaveLength(0);
    expect(callback).toHaveBeenCalled();
  });

  it('ignores unknown SQL queries not in KNOWN_READ_QUERY_SHAPES', () => {
    const unknownSql = 'INSERT INTO juanchoice_ballots(campaign_id,user_id) VALUES($1,$2)';
    const originalQuery = jest.fn((_text: string, cb: (...args: unknown[]) => void) => {
      cb(null, { rows: [] });
    });
    const fakeClient = { query: originalQuery };
    const records: unknown[] = [];
    instrumentCallbackClientQuery(fakeClient, {
      isActive: () => true,
      record: () => records.push('recorded'),
    });

    const callback = jest.fn();
    Reflect.apply(fakeClient.query, fakeClient, [unknownSql, callback]);
    expect(records).toHaveLength(0);
    expect(callback).toHaveBeenCalled();
  });

  it('ignores non-callback calls without throwing or recording', () => {
    const sql = 'SELECT id, seed_id, is_test FROM users WHERE id = ANY($1::text[])';
    const promise = Promise.resolve({ rows: [] });
    const originalQuery = jest.fn(() => promise);
    const fakeClient = { query: originalQuery };
    const records: unknown[] = [];
    instrumentCallbackClientQuery(fakeClient, {
      isActive: () => true,
      record: () => records.push('recorded'),
    });

    const result = Reflect.apply(fakeClient.query, fakeClient, [sql]);
    expect(result).toBe(promise);
    expect(records).toHaveLength(0);
  });

  it('does not leak parameter values or secrets into recorded query', () => {
    const sql = 'SELECT id, seed_id, is_test FROM users WHERE id = ANY($1::text[])';
    const sensitiveValues = [['secret-wallet-address', 'secret-key-123']];
    const originalQuery = jest.fn((_text: string, _values: unknown[], cb: (...args: unknown[]) => void) => {
      cb(null, { rows: [] });
    });
    const fakeClient = { query: originalQuery };
    let recordedQuery: unknown;
    instrumentCallbackClientQuery(fakeClient, {
      isActive: () => true,
      record: (q) => { recordedQuery = q; },
    });

    const callback = jest.fn();
    Reflect.apply(fakeClient.query, fakeClient, [sql, sensitiveValues, callback]);
    // recordedQuery is the query object/string passed to client.query (args[0]); args[1] contains sensitive values
    expect(recordedQuery).toBe(sql);
    expect(JSON.stringify(recordedQuery)).not.toContain('secret-wallet-address');
  });
});
