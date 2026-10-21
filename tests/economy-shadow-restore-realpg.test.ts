import { execFileSync } from 'child_process';
import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import { createTestDb, type TestDbInstance } from '../src/db/testHarness';
import { reconcileEconomy, summarizeEconomyReconciliation } from '../src/economy/reconcile';

const realDockerPg = process.env.JDQ_REAL_PG_URL && process.platform === 'linux'
  ? describe : describe.skip;

realDockerPg('economy shadow backup/restore on isolated real PostgreSQL', () => {
  const container = process.env.JDQ_REAL_PG_CONTAINER ?? 'jdq-reliability-pg-20260910';
  const databaseUser = 'jdq_test';
  let source: TestDbInstance;

  beforeAll(async () => { source = await createTestDb(); }, 120_000);
  afterAll(async () => { await source?.close(); }, 120_000);

  it('restores legacy classifications and transfer-derived pilot balances exactly', async () => {
    const sourceSchema = String((await source.pool.query('SELECT current_schema() AS name')).rows[0].name);
    if (!/^jdq_test_[a-f0-9]{32}$/.test(sourceSchema)) throw new Error('UNSAFE_SHADOW_SOURCE_SCHEMA');
    const suffix = randomUUID().replace(/-/g, '');
    const targetName = `jdq_shadow_restore_${suffix}`;
    const archive = `/tmp/${targetName}.dump`;
    const runDocker = (...args: string[]) => execFileSync('docker', ['exec', container, ...args], {
      encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'],
    });

    await source.pool.query(`
      INSERT INTO users(id,seed_id,display_name,email,role,demo_points)
      VALUES ('shadow-restore-user','shadow-restore-user','Restore Fixture',
              'restore@test.invalid','user',20)
    `);
    await source.pool.query(
      `UPDATE governance_snapshot
       SET data = jsonb_set(data, '{balances}', ($1)::jsonb) WHERE id = 1`,
      ['{"shadow-restore-user":20550}']
    );
    await source.pool.query(`
      INSERT INTO governance_ledger(id,transaction_group_id,type,account,amount_mjdq,
        reference_type,reference_id,actor_id)
      VALUES ('shadow-legacy-row','shadow-legacy-group','historical_fixture',
        'shadow-restore-user',41,'test','shadow-legacy-ref','shadow-restore-user')
    `);
    const writer = await source.pool.connect();
    try {
      await writer.query('BEGIN');
      await writer.query(`
        INSERT INTO economic_accounts(id,asset_code,kind,user_id)
        VALUES ('sim:traveler:shadow-restore-user','EXPLORER_COIN_SIM',
                'traveler','shadow-restore-user')
      `);
      await writer.query(`
        INSERT INTO economic_transactions(id,asset_code,business_event,operation,actor_id,policy_version)
        VALUES ('shadow-pilot-tx','EXPLORER_COIN_SIM','shadow-pilot-event','reward',
                'shadow-restore-user','fixture-v1')
      `);
      await writer.query(`UPDATE economic_accounts SET balance_minor = -7 WHERE id = 'sim:issuance'`);
      await writer.query(`UPDATE economic_accounts SET balance_minor = 7
        WHERE id = 'sim:traveler:shadow-restore-user'`);
      await writer.query(`
        INSERT INTO economic_transfers(transaction_id,sequence,asset_code,
          from_account_id,to_account_id,amount_minor)
        VALUES ('shadow-pilot-tx',1,'EXPLORER_COIN_SIM','sim:issuance',
                'sim:traveler:shadow-restore-user',7)
      `);
      await writer.query('COMMIT');
    } catch (error) {
      await writer.query('ROLLBACK');
      throw error;
    } finally {
      writer.release();
    }

    const before = summarizeEconomyReconciliation(await reconcileEconomy(source.pool));
    expect(before.legacyClassifications.fractional_remainder).toBe(1);
    expect(before.legacyUnbalancedNetMjdq).toBe('41');
    expect(before.pilotAccountDriftCount).toBe(0);

    // The target name is random, checked absent, and created only by this
    // drill. On a restore failure it is retained for forensics, not dropped.
    const exists = await source.pool.query('SELECT 1 FROM pg_database WHERE datname = $1', [targetName]);
    if (exists.rowCount) throw new Error('SHADOW_RESTORE_TARGET_EXISTS');
    runDocker('pg_dump', '-U', databaseUser, '-d', 'jdq_reliability_test',
      '-n', sourceSchema, '-Fc', '-f', archive);
    runDocker('createdb', '-U', databaseUser, targetName);
    let verified = false;
    try {
      runDocker('pg_restore', '-U', databaseUser, '-d', targetName,
        '--no-owner', '--exit-on-error', '--single-transaction', archive);
      const targetUrl = new URL(process.env.JDQ_REAL_PG_URL!);
      targetUrl.pathname = `/${targetName}`;
      const restored = new Pool({ connectionString: targetUrl.toString(),
        options: `-c search_path=${sourceSchema}`, max: 2 });
      try {
        const after = summarizeEconomyReconciliation(await reconcileEconomy(restored));
        expect(after).toEqual(before);
        const sourceMigrations = await source.pool.query('SELECT filename,checksum FROM schema_migrations ORDER BY filename');
        const restoredMigrations = await restored.query('SELECT filename,checksum FROM schema_migrations ORDER BY filename');
        expect(restoredMigrations.rows).toEqual(sourceMigrations.rows);
        const balance = await restored.query(
          `SELECT balance_minor FROM economic_accounts
           WHERE id = 'sim:traveler:shadow-restore-user'`
        );
        expect(String(balance.rows[0].balance_minor)).toBe('7');
        verified = true;
      } finally {
        await restored.end();
      }
    } finally {
      if (verified) runDocker('dropdb', '-U', databaseUser, targetName);
      // Retain the archive on failure; remove only our exact generated file
      // after successful verification and target cleanup.
      if (verified) runDocker('rm', archive);
    }
  }, 180_000);
});
