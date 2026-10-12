import { createTestDb, type TestDbInstance } from '../src/db/testHarness';
import type { PoolClient } from 'pg';

const realPg = process.env.JDQ_REAL_PG_URL ? describe : describe.skip;

realPg('append-only economic correction invariants on real PostgreSQL', () => {
  let fixture: TestDbInstance;

  beforeAll(async () => {
    fixture = await createTestDb();
    await fixture.pool.query(`
      INSERT INTO users(id, seed_id, display_name, email, role) VALUES
      ('correction-admin', 'correction-admin', 'Reviewer', 'correction-admin@economy.test', 'admin'),
      ('correction-user', 'correction-user', 'Traveler', 'correction-user@economy.test', 'user')
    `);
    await fixture.pool.query(
      "INSERT INTO economic_accounts(id, asset_code, kind, user_id) VALUES ('sim:traveler:correction-user', 'EXPLORER_COIN_SIM', 'traveler', 'correction-user')"
    );
  }, 120_000);
  afterAll(async () => { await fixture?.close(); }, 120_000);

  async function post(
    client: PoolClient, id: string, event: string, operation: string,
    actor: string, from: string, to: string, amount: number
  ): Promise<void> {
    await client.query(
      `INSERT INTO economic_transactions(id, asset_code, business_event, operation, actor_id, policy_version)
       VALUES ($1, 'EXPLORER_COIN_SIM', $2, $3, $4, 'correction-test-v1')`,
      [id, event, operation, actor]
    );
    await client.query('UPDATE economic_accounts SET balance_minor = balance_minor - $2 WHERE id = $1', [from, amount]);
    await client.query('UPDATE economic_accounts SET balance_minor = balance_minor + $2 WHERE id = $1', [to, amount]);
    await client.query(
      `INSERT INTO economic_transfers(transaction_id, sequence, asset_code, from_account_id, to_account_id, amount_minor)
       VALUES ($1, 1, 'EXPLORER_COIN_SIM', $2, $3, $4)`,
      [id, from, to, amount]
    );
  }

  it('rejects a partial inverse and accepts exactly one immutable full refund', async () => {
    const client = await fixture.pool.connect();
    try {
      await client.query('BEGIN');
      await post(client, 'correction-funding', 'correction-funding', 'reward',
        'correction-admin', 'sim:issuance', 'sim:traveler:correction-user', 100);
      await post(client, 'correction-spend', 'correction-spend', 'spend',
        'correction-user', 'sim:traveler:correction-user', 'sim:retired', 40);
      await client.query('COMMIT');

      await client.query('BEGIN');
      await post(client, 'correction-short', 'refund:correction-spend', 'refund',
        'correction-admin', 'sim:retired', 'sim:traveler:correction-user', 39);
      await client.query(`
        INSERT INTO economic_corrections
          (id, original_transaction_id, correcting_transaction_id, reason, actor_id)
        VALUES ('correction-short-link', 'correction-spend', 'correction-short',
          'Approved cosmetic refund', 'correction-admin')
      `);
      await expect(client.query('COMMIT')).rejects.toMatchObject({ code: '23514' });
      await client.query('ROLLBACK');

      await client.query('BEGIN');
      await post(client, 'correction-full', 'refund:correction-spend', 'refund',
        'correction-admin', 'sim:retired', 'sim:traveler:correction-user', 40);
      await client.query(`
        INSERT INTO economic_corrections
          (id, original_transaction_id, correcting_transaction_id, reason, actor_id)
        VALUES ('correction-full-link', 'correction-spend', 'correction-full',
          'Approved cosmetic refund', 'correction-admin')
      `);
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    const state = await fixture.pool.query(
      "SELECT id, balance_minor FROM economic_accounts WHERE id IN ('sim:retired', 'sim:traveler:correction-user') ORDER BY id"
    );
    expect(state.rows.map((row) => [row.id, String(row.balance_minor)])).toEqual([
      ['sim:retired', '0'], ['sim:traveler:correction-user', '100'],
    ]);
    expect((await fixture.pool.query('SELECT id FROM economic_corrections')).rows.map((row) => row.id))
      .toEqual(['correction-full-link']);
    await expect(fixture.pool.query(
      "UPDATE economic_corrections SET reason = 'Changed reason' WHERE id = 'correction-full-link'"
    )).rejects.toMatchObject({ code: '23514' });
  }, 120_000);
});
