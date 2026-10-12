import { createTestDb, type TestDbInstance } from '../src/db/testHarness';
import { EconomyService } from '../src/economy/service';

const realPg = process.env.JDQ_REAL_PG_URL ? describe : describe.skip;

realPg('funded reservation expiry and competing workers', () => {
  let fixture: TestDbInstance;
  let economy: EconomyService;
  beforeAll(async () => {
    fixture = await createTestDb({ poolMax: 8 });
    economy = new EconomyService(fixture.pool);
    await fixture.pool.query(`
      INSERT INTO users(id,seed_id,display_name,email,role) VALUES
      ('expiry-admin','expiry-admin','Reviewer','expiry-admin@test.invalid','admin'),
      ('expiry-author','expiry-author','Author','expiry-author@test.invalid','user'),
      ('expiry-user','expiry-user','Traveler','expiry-user@test.invalid','user')
    `);
    await fixture.pool.query(`
      INSERT INTO quests(id,title,description,category,location_name,gps_lat,gps_lng,
        marker_code,marker_image_url,author_id,status,version)
      VALUES ('expiry-quest','Expiry fixture','Disposable test','eco','Fictional venue',
        16,120,'EXPIRY_MARKER','https://example.test/expiry.png',
        'expiry-author','published',1)
    `);
    await economy.createReviewedPilotAuthority({
      questId: 'expiry-quest', scopeId: 'expiry-scope', scopeKey: 'expiry-scope',
      policyId: 'expiry-policy-v1', policyKey: 'expiry-policy', policyVersion: 1,
      proposedBy: 'expiry-author', reviewedBy: 'expiry-admin', countryCode: 'PH',
      activityKind: 'visit', activityFingerprint: 'expiry-scope',
      summary: 'Fictional activity', rationale: 'Independent fixture review',
      rewardMinor: 100n, reservationSeconds: 3600, appealSeconds: 3600,
    });
    await economy.createPilotPool({
      id: 'expiry-pool', questId: 'expiry-quest', scopeId: 'expiry-scope',
      scopeKey: 'expiry-scope', policyId: 'expiry-policy-v1',
      policyVersion: 'expiry-policy-v1', rewardMinor: 100n,
      allocationMinor: 100n, reservationSeconds: 3600,
      appealSeconds: 3600, adminId: 'expiry-admin',
    });
    await economy.activatePilotPool('expiry-pool', 'expiry-admin');
  }, 120_000);
  afterAll(async () => { await fixture?.close(); }, 120_000);

  it('returns an abandoned slot once across competing expiry workers', async () => {
    const held = await economy.reserveReward('expiry-pool', 'expiry-user');
    // Disposable schema only: simulate clock passage without waiting an hour.
    await fixture.pool.query(
      'ALTER TABLE reward_reservations DISABLE TRIGGER economic_reservation_authority_guard_trigger'
    );
    try {
      await fixture.pool.query(
        `UPDATE reward_reservations SET expires_at = now() - interval '1 second' WHERE id = $1`,
        [held.id]
      );
    } finally {
      await fixture.pool.query(
        'ALTER TABLE reward_reservations ENABLE TRIGGER economic_reservation_authority_guard_trigger'
      );
    }
    const results = await Promise.all(Array.from({ length: 5 }, () =>
      economy.releaseExpiredReservation(held.id)));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await fixture.pool.query(
      `SELECT available_minor,reserved_minor,paid_minor FROM reward_pools WHERE id = 'expiry-pool'`
    )).rows[0]).toMatchObject({ available_minor: '100', reserved_minor: '0', paid_minor: '0' });
    expect((await fixture.pool.query(
      'SELECT status FROM quest_attempts WHERE id = $1', [held.attemptId]
    )).rows[0].status).toBe('abandoned');
  });

  it('preserves a timely submitted proof through delayed review and a competing sweep', async () => {
    const held = await economy.reserveReward('expiry-pool', 'expiry-user');
    await fixture.pool.query(
      `INSERT INTO submissions(id,idempotency_key,user_id,quest_id,scanned_marker_code,
        captured_lat,captured_lng,captured_accuracy,status,economic_attempt_id)
       VALUES ('expiry-proof','expiry-proof-key','expiry-user','expiry-quest',
        'EXPIRY_MARKER',16,120,8,'approved',$1)`, [held.attemptId]
    );
    await fixture.pool.query(
      `UPDATE reward_reservations SET status = 'submitted', submission_id = 'expiry-proof',
       submitted_at = (SELECT created_at FROM submissions WHERE id = 'expiry-proof')
       WHERE id = $1`, [held.id]
    );
    const proof = (await fixture.pool.query(
      `SELECT id,user_id,quest_id,created_at FROM submissions WHERE id = 'expiry-proof'`
    )).rows[0];
    const settle = async () => {
      const client = await fixture.pool.connect();
      try {
        await client.query('BEGIN');
        const receipt = await economy.settleApprovedSubmissionInTx(client, proof, 'expiry-admin');
        await client.query('COMMIT');
        return receipt;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally { client.release(); }
    };
    const [receipt, released] = await Promise.all([
      settle(), economy.releaseExpiredReservation(held.id),
    ]);
    expect(receipt?.amountMinor).toBe('100');
    expect(released).toBe(false);
    expect((await fixture.pool.query(
      `SELECT available_minor,reserved_minor,paid_minor FROM reward_pools WHERE id = 'expiry-pool'`
    )).rows[0]).toMatchObject({ available_minor: '0', reserved_minor: '0', paid_minor: '100' });
    expect((await fixture.pool.query(
      `SELECT status FROM reward_reservations WHERE id = $1`, [held.id]
    )).rows[0].status).toBe('paid');
  });
});
