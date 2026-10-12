import { createTestDb, type TestDbInstance } from '../src/db/testHarness';
import { reconcileEconomy, summarizeEconomyReconciliation } from '../src/economy/reconcile';

const realPg = process.env.JDQ_REAL_PG_URL ? describe : describe.skip;

realPg('read-only legacy shadow reconciliation on disposable PostgreSQL', () => {
  let fixture: TestDbInstance;

  beforeAll(async () => {
    fixture = await createTestDb();
    await fixture.pool.query(`
      INSERT INTO users(id,seed_id,display_name,email,role,demo_points) VALUES
      ('shadow-exact','shadow-exact','Exact','exact@test.invalid','user',20),
      ('shadow-fraction','shadow-fraction','Fraction','fraction@test.invalid','user',20),
      ('shadow-missing','shadow-missing','Missing','missing@test.invalid','user',20),
      ('shadow-invalid','shadow-invalid','Invalid','invalid@test.invalid','user',20),
      ('shadow-huge','shadow-huge','Huge','huge@test.invalid','user',20)
    `);
    // The huge JSONB number must remain text until BigInt parses it. A JS
    // JSON.parse/JSON.stringify round-trip would silently change its digits.
    await fixture.pool.query(
      `UPDATE governance_snapshot SET data = jsonb_set(data, '{balances}', ($1)::jsonb)
       WHERE id = 1`,
      ['{"shadow-exact":20000,"shadow-fraction":20550,"shadow-invalid":"20.5","shadow-huge":9007199254740993}']
    );
  }, 120_000);

  afterAll(async () => { await fixture?.close(); }, 120_000);

  it('classifies exact, subpoint, missing, invalid and huge mismatch without rounding', async () => {
    const first = await reconcileEconomy(fixture.pool);
    const second = await reconcileEconomy(fixture.pool);
    expect(second).toEqual(first);
    const byId = Object.fromEntries(first.legacy.map((finding) => [finding.userId, finding]));
    expect(byId['shadow-exact']).toMatchObject({ classification: 'exact', differenceMjdq: '0' });
    expect(byId['shadow-fraction']).toMatchObject({ classification: 'fractional_remainder', differenceMjdq: '550' });
    expect(byId['shadow-missing']).toMatchObject({ classification: 'missing_snapshot', snapshotMjdq: null });
    expect(byId['shadow-invalid']).toMatchObject({ classification: 'invalid_snapshot', snapshotMjdq: '20.5' });
    expect(byId['shadow-huge']).toMatchObject({
      classification: 'mismatch', snapshotMjdq: '9007199254740993',
      differenceMjdq: '9007199254720993',
    });
    expect(first.pilotAccountDrift).toEqual([]);
    expect(first.unbalancedLegacyGroups).toEqual([]);
    const summary = summarizeEconomyReconciliation(first);
    expect(summary.legacyClassifications).toMatchObject({
      exact: 1, fractional_remainder: 1, missing_snapshot: 1,
      invalid_snapshot: 1, mismatch: 1,
    });
    expect(summary.cutoverEligible).toBe(false);
    expect(summary.canonicalDigestSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(summarizeEconomyReconciliation(second).canonicalDigestSha256)
      .toBe(summary.canonicalDigestSha256);
  });

  it('does not modify any legacy or pilot accounting row', async () => {
    const before = await fixture.pool.query(`
      SELECT (SELECT count(*) FROM governance_ledger) AS legacy_rows,
             (SELECT count(*) FROM economic_transfers) AS pilot_rows,
             (SELECT data::text FROM governance_snapshot WHERE id = 1) AS snapshot_data
    `);
    await reconcileEconomy(fixture.pool);
    const after = await fixture.pool.query(`
      SELECT (SELECT count(*) FROM governance_ledger) AS legacy_rows,
             (SELECT count(*) FROM economic_transfers) AS pilot_rows,
             (SELECT data::text FROM governance_snapshot WHERE id = 1) AS snapshot_data
    `);
    expect(after.rows).toEqual(before.rows);
  });
});
