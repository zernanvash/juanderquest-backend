import { randomUUID } from 'crypto';
import { createTestDb, type TestDbInstance } from '../src/db/testHarness';
import { EconomyService } from '../src/economy/service';

const realPg = process.env.JDQ_REAL_PG_URL ? describe : describe.skip;

realPg('economic posting under a disposable non-owner PostgreSQL role', () => {
  let fixture: TestDbInstance;
  let role: string;
  let schema: string;
  let reservationId: string;

  beforeAll(async () => {
    fixture = await createTestDb();
    role = `jdq_econ_test_${randomUUID().replace(/-/g, '')}`;
    schema = String((await fixture.pool.query('SELECT current_schema() AS name')).rows[0].name);
    if (!/^jdq_test_[a-f0-9]{32}$/.test(schema) || !/^jdq_econ_test_[a-f0-9]{32}$/.test(role)) {
      throw new Error('DISPOSABLE_ROLE_SCOPE_MISMATCH');
    }
    await fixture.pool.query(`CREATE ROLE ${role} NOLOGIN`);
    await fixture.pool.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);
    await fixture.pool.query(
      `GRANT SELECT ON ${schema}.economic_accounts, ${schema}.economic_transactions,
        ${schema}.economic_transfers, ${schema}.reward_awards,
        ${schema}.reward_reservations, ${schema}.reward_pools,
        ${schema}.economic_outbox, ${schema}.users,
        ${schema}.economic_cosmetics, ${schema}.economic_entitlements,
        ${schema}.economic_commands TO ${role}`
    );
    await fixture.pool.query(`GRANT INSERT ON ${schema}.economic_accounts TO ${role}`);
    await fixture.pool.query(`GRANT UPDATE ON ${schema}.users TO ${role}`);
    await fixture.pool.query(
      `GRANT EXECUTE ON FUNCTION ${schema}.economic_post_transfer(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,BIGINT,TEXT,TEXT,TEXT,TEXT) TO ${role}`
    );
    await fixture.pool.query(`
      INSERT INTO users(id, seed_id, display_name, email, role) VALUES
      ('role-admin', 'role-admin', 'Reviewer', 'role-admin@economy.test', 'admin'),
      ('role-traveler', 'role-traveler', 'Traveler', 'role-traveler@economy.test', 'user')
    `);
    await fixture.pool.query(`
      INSERT INTO quests(id, title, description, category, location_name, gps_lat, gps_lng,
        reward_points, marker_code, marker_image_url)
      VALUES ('role-quest', 'Role test', 'Approved reward source', 'eco', 'Test', 16.0, 120.0,
        50, 'ROLE_MARKER', 'https://example.test/role.png')
    `);
    const economy = new EconomyService(fixture.pool);
    await economy.createReviewedPilotAuthority({
      questId: 'role-quest', scopeId: 'role-scope', scopeKey: 'role-scope',
      policyId: 'role-v1', policyKey: 'role-v1', policyVersion: 1,
      proposedBy: 'role-traveler', reviewedBy: 'role-admin', countryCode: 'PH',
      provinceName: 'Pangasinan', activityKind: 'visit', activityFingerprint: 'role-scope',
      summary: 'Role test activity', rationale: 'Independent fixture review',
      rewardMinor: 100n, reservationSeconds: 3600, appealSeconds: 3600,
    });
    await economy.createPilotPool({
      id: 'role-pool', questId: 'role-quest', scopeKey: 'role-scope', policyVersion: 'role-v1',
      scopeId: 'role-scope', policyId: 'role-v1',
      rewardMinor: 100n, allocationMinor: 100n, reservationSeconds: 3600,
      appealSeconds: 3600, adminId: 'role-admin',
    });
    await economy.activatePilotPool('role-pool', 'role-admin');
    const reservation = await economy.reserveReward('role-pool', 'role-traveler');
    await fixture.pool.query(`
      INSERT INTO submissions(id, idempotency_key, user_id, quest_id, scanned_marker_code,
        captured_lat, captured_lng, captured_accuracy, status)
      VALUES ('role-sub', 'role-sub-key', 'role-traveler', 'role-quest',
        'ROLE_MARKER', 16.0, 120.0, 8, 'approved')
    `);
    await fixture.pool.query('UPDATE submissions SET economic_attempt_id = $2 WHERE id = $1',
      ['role-sub', reservation.attemptId]);
    await fixture.pool.query(
      `UPDATE reward_reservations SET status = 'submitted', submission_id = $2,
       submitted_at = (SELECT created_at FROM submissions WHERE id = $2) WHERE id = $1`,
      [reservation.id, 'role-sub']
    );
    await fixture.pool.query(
      "INSERT INTO economic_accounts(id, asset_code, kind, user_id) VALUES ('sim:traveler:role-traveler', 'EXPLORER_COIN_SIM', 'traveler', 'role-traveler')"
    );
    reservationId = reservation.id;
  }, 120_000);

  afterAll(async () => {
    try {
      if (fixture && role && schema) {
        // The role is unique, NOLOGIN, and never owns data. DROP OWNED revokes
        // only its grants in this disposable database, including partial setup.
        await fixture.pool.query(`DROP OWNED BY ${role}`);
        await fixture.pool.query(`DROP ROLE ${role}`);
      }
    } finally {
      await fixture?.close();
    }
  }, 120_000);

  it('denies direct ledger DML while allowing only an eligible posting function call', async () => {
    const client = await fixture.pool.connect();
    try {
      await client.query(`SET ROLE ${role}`);
      await expect(client.query(
        "UPDATE economic_accounts SET balance_minor = 100000 WHERE id = 'sim:retired'"
      )).rejects.toMatchObject({ code: '42501' });
      await expect(client.query(
        "INSERT INTO economic_transactions(id,asset_code,business_event,operation,actor_id,policy_version) VALUES ('forged','EXPLORER_COIN_SIM','forged','reward','role-admin','role-v1')"
      )).rejects.toMatchObject({ code: '42501' });
      await client.query('BEGIN');
      await expect(client.query(
        `SELECT economic_post_transfer($1,$2,'reward','role-admin','role-v1',
          'sim:issuance','sim:traveler:role-traveler',100,$3,'role-sub')`,
        [randomUUID(), `reward:${reservationId}`, reservationId]
      )).resolves.toBeDefined();
      const award = await client.query(
        'SELECT transaction_id FROM reward_awards WHERE reservation_id = $1', [reservationId]
      );
      expect(award.rowCount).toBe(1);
      const pool = await client.query("SELECT reserved_minor, paid_minor FROM reward_pools WHERE id = 'role-pool'");
      expect([String(pool.rows[0].reserved_minor), String(pool.rows[0].paid_minor)]).toEqual(['0', '100']);
      await client.query('COMMIT');
    } finally {
      await client.query('RESET ROLE');
      client.release();
    }
    const state = await fixture.pool.query(
      "SELECT balance_minor FROM economic_accounts WHERE id = 'sim:traveler:role-traveler'"
    );
    expect(String(state.rows[0].balance_minor)).toBe('100');
  }, 120_000);

  it('completes a cosmetic purchase through the service as the restricted role', async () => {
    await fixture.pool.query(
      "INSERT INTO economic_cosmetics(id, asset_code, cost_minor, active) VALUES ('role-frame', 'EXPLORER_COIN_SIM', 3, true)"
    );
    const client = await fixture.pool.connect();
    const roleClient = {
      query: client.query.bind(client),
      release: () => undefined,
    };
    const rolePool = { connect: async () => roleClient } as unknown as import('pg').Pool;
    const originalNodeEnv = process.env.NODE_ENV;
    const originalProfile = process.env.JDQ_ENV;
    try {
      await client.query(`SET ROLE ${role}`);
      process.env.NODE_ENV = 'development';
      process.env.JDQ_ENV = 'dev';
      const receipt = await new EconomyService(rolePool).purchaseCosmetic(
        'role-traveler', 'role-frame', 'role-spend-key'
      );
      expect(receipt.amountMinor).toBe('3');
    } finally {
      process.env.NODE_ENV = originalNodeEnv;
      if (originalProfile === undefined) delete process.env.JDQ_ENV;
      else process.env.JDQ_ENV = originalProfile;
      await client.query('RESET ROLE');
      client.release();
    }
    const state = await fixture.pool.query(
      "SELECT balance_minor FROM economic_accounts WHERE id = 'sim:traveler:role-traveler'"
    );
    expect(String(state.rows[0].balance_minor)).toBe('97');
    expect((await fixture.pool.query(
      "SELECT id FROM economic_entitlements WHERE user_id = 'role-traveler' AND cosmetic_id = 'role-frame'"
    )).rowCount).toBe(1);
    expect((await fixture.pool.query(
      "SELECT transaction_id FROM economic_commands WHERE actor_id = 'role-traveler' AND idempotency_key = 'role-spend-key'"
    )).rowCount).toBe(1);
  }, 120_000);

  it('refuses an owner-powered development posting even when the request is otherwise valid', async () => {
    await fixture.pool.query(
      "INSERT INTO economic_cosmetics(id, asset_code, cost_minor, active) VALUES ('owner-guard-frame', 'EXPLORER_COIN_SIM', 1, true)"
    );
    const originalNodeEnv = process.env.NODE_ENV;
    const originalProfile = process.env.JDQ_ENV;
    try {
      process.env.NODE_ENV = 'development';
      process.env.JDQ_ENV = 'dev';
      await expect(new EconomyService(fixture.pool).purchaseCosmetic(
        'role-traveler', 'owner-guard-frame', 'owner-guard-key'
      )).rejects.toMatchObject({ code: 'RESTRICTED_ECONOMY_ROLE_REQUIRED' });
    } finally {
      process.env.NODE_ENV = originalNodeEnv;
      if (originalProfile === undefined) delete process.env.JDQ_ENV;
      else process.env.JDQ_ENV = originalProfile;
    }
  }, 120_000);
});
