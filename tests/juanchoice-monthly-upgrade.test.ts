import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import path from 'path';
import { Pool } from 'pg';
import { applyMigrations, MIGRATIONS } from '../src/db/pool.js';

const realIt = process.env.JDQ_REAL_PG_URL ? it : it.skip;

realIt('quarantines unverified offers and unfunded budgets during a disposable 019-to-current upgrade', async () => {
  const url = new URL(process.env.JDQ_REAL_PG_URL!);
  if (!['localhost', '127.0.0.1'].includes(url.hostname) || url.pathname !== '/jdq_reliability_test') {
    throw new Error('Monthly upgrade test only accepts the loopback reliability database');
  }
  const schema = `jdq_test_${randomUUID().replace(/-/g, '')}`;
  const admin = new Pool({ connectionString: url.toString(), connectionTimeoutMillis: 3000 });
  let pool: Pool | undefined;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString: url.toString(), options: `-c search_path=${schema}`, max: 2, connectionTimeoutMillis: 3000 });
    await pool.query(`CREATE TABLE schema_migrations(filename TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    const migrationsDir = path.join(__dirname, '..', 'migrations');
    for (const file of MIGRATIONS.slice(0, 19)) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(readFileSync(path.join(migrationsDir, file), 'utf8'));
        await client.query('INSERT INTO schema_migrations(filename) VALUES($1)', [file]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    }
    expect((await pool.query('SELECT COUNT(*)::int AS count FROM schema_migrations')).rows[0].count).toBe(19);
    const campaignId = randomUUID();
    await pool.query(`INSERT INTO juanchoice_campaigns(id,slug,region,theme,status,opens_at,closes_at,is_test)
      VALUES($1,'pre-upgrade-fixture','Pangasinan','Nature','finalized',
      '2026-08-01T00:00:00Z','2026-08-08T00:00:00Z',TRUE)`, [campaignId]);
    const before = (await pool.query('SELECT id,slug,region,theme,status,opens_at,closes_at,is_test FROM juanchoice_campaigns WHERE id=$1', [campaignId])).rows[0];

    // Reproduce a pre-021 row whose only "consent" was the old admin boolean.
    const monthlyMigration = MIGRATIONS[19];
    expect(monthlyMigration).toBe('020_juanchoice_monthly_schedules.sql');
    await pool.query(readFileSync(path.join(migrationsDir, monthlyMigration), 'utf8'));
    await pool.query('INSERT INTO schema_migrations(filename) VALUES($1)', [monthlyMigration]);
    const offerId = randomUUID();
    await pool.query(`INSERT INTO juanchoice_merchant_offers
      (id,campaign_id,merchant_id,voucher_id,terms_snapshot,status,partner_consent_at,starts_at,ends_at,is_test)
      VALUES($1,$2,'m1','v1','{}'::jsonb,'approved',NOW(),NOW()-INTERVAL '1 day',NOW()+INTERVAL '1 day',TRUE)`,
      [offerId,campaignId]);

    const offerMigration = MIGRATIONS[20];
    expect(offerMigration).toBe('021_juanchoice_unverified_offer_quarantine.sql');
    await pool.query(readFileSync(path.join(migrationsDir, offerMigration), 'utf8'));
    await pool.query('INSERT INTO schema_migrations(filename) VALUES($1)', [offerMigration]);
    const budgetId = randomUUID();
    await pool.query(`INSERT INTO juanchoice_promotion_budgets
      (id,campaign_id,authorized_budget_mjdq,reserved_mjdq,status,approval_reference,is_test)
      VALUES($1,$2,1000,1,'approved','Unverified admin note',TRUE)`,[budgetId,campaignId]);

    // An existing reservation cannot be silently turned into an empty draft.
    await expect(applyMigrations(pool)).rejects.toBeDefined();
    expect((await pool.query('SELECT COUNT(*)::int AS count FROM schema_migrations')).rows[0].count).toBe(21);
    expect((await pool.query('SELECT status,reserved_mjdq FROM juanchoice_promotion_budgets WHERE id=$1',[budgetId])).rows[0])
      .toMatchObject({status:'approved',reserved_mjdq:'1'});
    await pool.query('UPDATE juanchoice_promotion_budgets SET reserved_mjdq=0 WHERE id=$1',[budgetId]);

    await applyMigrations(pool);
    await applyMigrations(pool);

    expect((await pool.query('SELECT COUNT(*)::int AS count FROM schema_migrations')).rows[0].count).toBe(MIGRATIONS.length);
    expect((await pool.query("SELECT filename FROM schema_migrations WHERE filename='020_juanchoice_monthly_schedules.sql'")).rowCount).toBe(1);
    expect((await pool.query('SELECT id,slug,region,theme,status,opens_at,closes_at,is_test FROM juanchoice_campaigns WHERE id=$1', [campaignId])).rows[0]).toEqual(before);
    expect((await pool.query('SELECT COUNT(*)::int AS count FROM juanchoice_schedules')).rows[0].count).toBe(0);
    expect((await pool.query('SELECT COUNT(*)::int AS count FROM juanchoice_schedule_periods')).rows[0].count).toBe(0);
    const offer = (await pool.query('SELECT status,partner_consent_at,quarantined_at,quarantine_reason FROM juanchoice_merchant_offers WHERE id=$1',
      [offerId])).rows[0];
    expect(offer.status).toBe('suspended');
    expect(offer.partner_consent_at).toBeTruthy(); // Original data retained for audit, not trusted.
    expect(offer.quarantined_at).toBeTruthy();
    expect(offer.quarantine_reason).toBe('UNVERIFIED_LEGACY_CONSENT');
    await expect(pool.query("UPDATE juanchoice_merchant_offers SET status='approved' WHERE id=$1",[offerId])).rejects.toBeDefined();
    const budget = (await pool.query(`SELECT status,authorized_budget_mjdq,reserved_mjdq,spent_mjdq,
      request_reference,quarantined_at,quarantine_reason FROM juanchoice_promotion_budgets WHERE id=$1`,[budgetId])).rows[0];
    expect(budget).toMatchObject({status:'draft',authorized_budget_mjdq:'1000',reserved_mjdq:'0',spent_mjdq:'0',
      request_reference:'Unverified admin note',quarantine_reason:'UNVERIFIED_LEGACY_FUNDING'});
    expect(budget.quarantined_at).toBeTruthy();
    await expect(pool.query("UPDATE juanchoice_promotion_budgets SET status='approved' WHERE id=$1",[budgetId])).rejects.toBeDefined();
  } finally {
    if (pool) await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
}, 60000);
