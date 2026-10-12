import { createTestDb, type TestDbInstance } from '../src/db/testHarness';

const realPg = process.env.JDQ_REAL_PG_URL ? describe : describe.skip;

realPg('economic ledger integrity on disposable real PostgreSQL', () => {
  let fixture: TestDbInstance;

  beforeAll(async () => { fixture = await createTestDb(); }, 120_000);
  afterAll(async () => { await fixture?.close(); }, 120_000);

  it('rejects direct cached-balance edits at commit', async () => {
    await expect(fixture.pool.query(
      "UPDATE economic_accounts SET balance_minor = 1 WHERE id = 'sim:retired'"
    )).rejects.toMatchObject({ code: '23514' });
    const state = await fixture.pool.query("SELECT balance_minor FROM economic_accounts WHERE id = 'sim:retired'");
    expect(String(state.rows[0].balance_minor)).toBe('0');
  });

  it('rejects unprojected transfers and preserves immutable committed history', async () => {
    await fixture.pool.query(
      "INSERT INTO economic_transactions (id, asset_code, business_event, operation, actor_id, policy_version) VALUES ('integrity-tx', 'EXPLORER_COIN_SIM', 'integrity-event', 'transfer', 'test', 'v1')"
    );
    await expect(fixture.pool.query(
      "INSERT INTO economic_transfers (transaction_id, sequence, asset_code, from_account_id, to_account_id, amount_minor) VALUES ('integrity-tx', 1, 'EXPLORER_COIN_SIM', 'sim:issuance', 'sim:retired', 10)"
    )).rejects.toMatchObject({ code: '23514' });

    const client = await fixture.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("UPDATE economic_accounts SET balance_minor = balance_minor - 10 WHERE id = 'sim:issuance'");
      await client.query("UPDATE economic_accounts SET balance_minor = balance_minor + 10 WHERE id = 'sim:retired'");
      await client.query(
        "INSERT INTO economic_transfers (transaction_id, sequence, asset_code, from_account_id, to_account_id, amount_minor) VALUES ('integrity-tx', 1, 'EXPLORER_COIN_SIM', 'sim:issuance', 'sim:retired', 10)"
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    await expect(fixture.pool.query(
      "UPDATE economic_transfers SET amount_minor = 11 WHERE transaction_id = 'integrity-tx'"
    )).rejects.toMatchObject({ code: '23514' });
    await expect(fixture.pool.query(
      "DELETE FROM economic_transactions WHERE id = 'integrity-tx'"
    )).rejects.toMatchObject({ code: '23514' });
    const balances = await fixture.pool.query(
      "SELECT id, balance_minor FROM economic_accounts WHERE id IN ('sim:issuance', 'sim:retired') ORDER BY id"
    );
    expect(balances.rows.map((row) => [row.id, String(row.balance_minor)])).toEqual([
      ['sim:issuance', '-10'], ['sim:retired', '10'],
    ]);
  });
});
