import { newDb } from 'pg-mem';
import { db } from '../src/db/index';
import { closePool } from '../src/db/pool';

function createSchemaDb() {
  const mem = newDb();
  mem.public.none(`
    CREATE TABLE merchant_affiliate_applications (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      business_name TEXT NOT NULL,
      category TEXT NOT NULL,
      municipality TEXT NOT NULL,
      contact_name TEXT NOT NULL,
      contact_email TEXT NOT NULL,
      contact_phone TEXT NOT NULL,
      sponsorship_goals TEXT NOT NULL DEFAULT '[]',
      proposal_details TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      business_address TEXT NOT NULL DEFAULT '',
      business_province TEXT NOT NULL DEFAULT 'Pangasinan',
      gps_lat DOUBLE PRECISION,
      gps_lng DOUBLE PRECISION,
      preferred_contact_method TEXT NOT NULL DEFAULT 'email',
      declaration_version TEXT NOT NULL DEFAULT '1.0',
      applicant_feedback TEXT,
      reviewer_id TEXT,
      reviewer_notes TEXT,
      reviewed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE merchant_application_audits (
      id TEXT PRIMARY KEY,
      application_id TEXT NOT NULL REFERENCES merchant_affiliate_applications(id),
      actor_id TEXT,
      from_status TEXT NOT NULL,
      to_status TEXT NOT NULL,
      revision INTEGER NOT NULL,
      notes TEXT,
      applicant_feedback TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE merchant_affiliate_drafts (
      user_id TEXT PRIMARY KEY,
      draft_data JSONB NOT NULL,
      current_step TEXT NOT NULL DEFAULT 'business',
      revision INTEGER NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE merchants (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      location TEXT NOT NULL,
      description TEXT NOT NULL,
      status TEXT NOT NULL,
      is_published BOOLEAN NOT NULL DEFAULT FALSE,
      category TEXT,
      municipality TEXT,
      contact_email TEXT,
      contact_phone TEXT,
      source_application_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE merchant_memberships (
      id TEXT PRIMARY KEY,
      merchant_id TEXT NOT NULL REFERENCES merchants(id),
      user_id TEXT NOT NULL,
      role TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (merchant_id, user_id)
    );
  `);
  const { Pool } = mem.adapters.createPg();
  return new Pool() as any;
}

const applicationPayload = (userId: string) => ({
  user_id: userId,
  business_name: `Durability Test ${userId}`,
  category: 'pasalubong',
  municipality: 'Alaminos City',
  business_province: 'Pangasinan',
  contact_name: 'Owner',
  contact_email: 'owner@example.ph',
  contact_phone: '+63 900 000 0000',
  sponsorship_goals: ['quest_sponsorship'],
  proposal_details: 'Durability regression fixture.',
});

describe('Merchant affiliation durability (parent-first transactions)', () => {
  afterEach(async () => {
    db.attachDurabilityPool(null);
    await closePool().catch(() => {});
  });

  it('persists the application before its audit row (FK-safe ordering)', async () => {
    const pool = createSchemaDb();
    db.attachDurabilityPool(pool);

    const application = await db.createAffiliateApplication(applicationPayload('durable-user-1'));

    const { rows: applications } = await pool.query('SELECT * FROM merchant_affiliate_applications WHERE id = $1', [application.id]);
    expect(applications).toHaveLength(1);

    const { rows: audits } = await pool.query('SELECT * FROM merchant_application_audits WHERE application_id = $1', [application.id]);
    expect(audits).toHaveLength(1);
    expect(audits[0].to_status).toBe('received');
    expect(db.getApplicationAudits(application.id)).toHaveLength(1);
  });

  it('fails the request and keeps memory untouched when the durable write fails', async () => {
    const brokenPool = createSchemaDb();
    brokenPool.query = async () => {
      throw new Error('simulated durable outage');
    };
    brokenPool.connect = async () => {
      throw new Error('simulated durable outage');
    };
    db.attachDurabilityPool(brokenPool);

    await expect(db.createAffiliateApplication(applicationPayload('durable-user-2'))).rejects.toMatchObject({
      code: 'STORAGE_UNAVAILABLE',
    });

    expect(db.affiliate_applications.some((a) => a.user_id === 'durable-user-2')).toBe(false);
  });

  it('provisions merchant, owner membership and audit in one approval transaction', async () => {
    const pool = createSchemaDb();
    db.attachDurabilityPool(pool);

    const application = await db.createAffiliateApplication(applicationPayload('durable-user-3'));
    const approved = await db.updateAffiliateApplicationStatus(application.id, {
      status: 'approved',
      reviewer_id: 'admin-durability-1',
    });
    expect(approved?.status).toBe('approved');

    const { rows: merchants } = await pool.query('SELECT * FROM merchants WHERE source_application_id = $1', [application.id]);
    expect(merchants).toHaveLength(1);

    const { rows: memberships } = await pool.query('SELECT * FROM merchant_memberships WHERE merchant_id = $1', [merchants[0].id]);
    expect(memberships).toHaveLength(1);
    expect(memberships[0].user_id).toBe('durable-user-3');
    expect(memberships[0].role).toBe('owner');

    const { rows: audits } = await pool.query(
      "SELECT * FROM merchant_application_audits WHERE application_id = $1 AND to_status = 'approved'",
      [application.id]
    );
    expect(audits).toHaveLength(1);
  });

  it('keeps the in-memory application unchanged when approval cannot be persisted', async () => {
    const pool = createSchemaDb();
    db.attachDurabilityPool(pool);
    const application = await db.createAffiliateApplication(applicationPayload('durable-user-4'));

    const brokenPool = createSchemaDb();
    brokenPool.connect = async () => {
      throw new Error('simulated durable outage');
    };
    db.attachDurabilityPool(brokenPool);

    await expect(
      db.updateAffiliateApplicationStatus(application.id, { status: 'approved', reviewer_id: 'admin-durability-2' })
    ).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });

    expect(db.findAffiliateApplicationById(application.id)?.status).toBe('received');
    expect(db.merchants.some((m) => m.source_application_id === application.id)).toBe(false);
  });
});
