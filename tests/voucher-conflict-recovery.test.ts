import * as pools from '../src/db/pool.js';
import { vouchersService } from '../src/services/vouchers.js';
import type { Pool } from 'pg';

describe('Voucher conflict recovery uses the rolled-back connection', () => {
  afterEach(() => jest.restoreAllMocks());

  it('does not acquire another connection and rejects a mismatched replay', async () => {
    let replayReads = 0;
    let rolledBack = false;
    const query = jest.fn(async (sql: string) => {
      if (sql === 'ROLLBACK') { rolledBack = true; return { rows: [] }; }
      if (sql.includes('FROM governance_snapshot')) return { rows: [{ data: { controls: {} } }] };
      if (sql.includes('FOR UPDATE')) return { rows: [{ demo_points: 100 }] };
      if (sql.includes('idempotency_key =')) {
        replayReads++;
        if (replayReads === 1) return { rows: [] };
        expect(rolledBack).toBe(true);
        return { rows: [{ voucher_id: 'different-voucher' }] };
      }
      if (sql.includes('SELECT 1 FROM redemptions')) return { rows: [] };
      if (sql.includes('FROM vouchers')) return { rows: [{ id: 'v', cost_points: 80 }] };
      if (sql.includes('INSERT INTO redemptions')) throw Object.assign(new Error('duplicate'), { code: '23505' });
      return { rows: [] };
    });
    const client = { query, release: jest.fn() };
    const pool = { connect: jest.fn().mockResolvedValue(client), query: jest.fn() };
    jest.spyOn(pools, 'getPool').mockReturnValue(pool as unknown as Pool);
    const result = await vouchersService.redeemVoucher('v', 'u', 'key');
    expect(result.error?.code).toBe('IDEMPOTENCY_CONFLICT');
    expect(pool.query).not.toHaveBeenCalled();
    expect(client.release).toHaveBeenCalledTimes(1);
  });
});
