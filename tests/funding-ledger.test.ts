import { movePoints } from '../src/funding/ledger';

describe('shared funded-quest point ledger', () => {
  it('moves whole points atomically and preserves an existing sub-point mJDQ remainder', async () => {
    const userId = 'author-1';
    let userPoints = 100;
    let treasuryPoints = 0;
    let snapshot: any = { ledger: [], audit: [], balances: { [userId]: 100_250 } };
    const client = {
      query: jest.fn(async (sql: string, params: unknown[] = []) => {
        if (sql.includes('SELECT id, kind, balance_points')) {
          return { rows: [{ id: 'treasury', kind: 'treasury', balance_points: String(treasuryPoints) }] };
        }
        if (sql.includes('SELECT id, demo_points')) {
          return { rows: [{ id: userId, demo_points: String(userPoints) }] };
        }
        if (sql.includes('UPDATE points_accounts SET balance_points')) {
          treasuryPoints = Number(params[1]);
          return { rows: [] };
        }
        if (sql.includes('UPDATE users SET demo_points')) {
          userPoints = Number(params[1]);
          return { rows: [] };
        }
        if (sql.includes('SELECT data FROM governance_snapshot')) return { rows: [{ data: snapshot }] };
        if (sql.includes('UPDATE governance_snapshot SET data')) {
          snapshot = JSON.parse(String(params[0]));
          return { rows: [] };
        }
        return { rows: [] };
      }),
    };

    const group = await movePoints(client, {
      from: { id: userId, kind: 'traveler', userId },
      to: { id: 'treasury', kind: 'treasury' },
      points: 40,
      type: 'quest_fund_lock',
      referenceType: 'quest_funding_plan',
      referenceId: 'plan-1',
      actorId: userId,
      idempotencyKey: 'command-1',
    });

    expect(userPoints).toBe(60);
    expect(treasuryPoints).toBe(40);
    expect(group.entries.map((entry) => entry.amount_mjdq)).toEqual([-40_000, 40_000]);
    expect(group.userBalanceUpdate).toMatchObject({ demoPoints: 60, balanceMjdq: 60_250 });
    expect(snapshot.balances[userId]).toBe(60_250);
    expect(snapshot.ledger).toHaveLength(2);
    expect(snapshot.audit).toHaveLength(1);
  });

  it('rejects insufficient traveler balance before writing ledger postings', async () => {
    const client = {
      query: jest.fn(async (sql: string) => {
        if (sql.includes('SELECT id, kind, balance_points')) {
          return { rows: [{ id: 'treasury', kind: 'treasury', balance_points: '0' }] };
        }
        if (sql.includes('SELECT id, demo_points')) return { rows: [{ id: 'author-1', demo_points: '10' }] };
        return { rows: [] };
      }),
    };
    await expect(movePoints(client, {
      from: { id: 'author-1', kind: 'traveler', userId: 'author-1' },
      to: { id: 'treasury', kind: 'treasury' },
      points: 11,
      type: 'quest_fund_lock',
      referenceType: 'quest_funding_plan',
      referenceId: 'plan-1',
      actorId: 'author-1',
    })).rejects.toThrow('INSUFFICIENT_TRAVELER_POINTS');
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO governance_ledger'))).toBe(false);
  });
});
