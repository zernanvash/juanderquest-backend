import { createTestDb, type TestDbInstance } from '../src/db/testHarness';
import { EconomyService } from '../src/economy/service';

const realPg = process.env.JDQ_REAL_PG_URL ? describe : describe.skip;

realPg('reviewed canonical activity and attempt authority', () => {
  let fixture: TestDbInstance;
  let economy: EconomyService;

  beforeAll(async () => {
    fixture = await createTestDb();
    economy = new EconomyService(fixture.pool);
    await fixture.pool.query(`
      INSERT INTO users(id, seed_id, display_name, email, role) VALUES
      ('scope-admin','scope-admin','Reviewer','scope-admin@test.invalid','admin'),
      ('scope-author','scope-author','Author','scope-author@test.invalid','user'),
      ('scope-traveler','scope-traveler','Traveler','scope-traveler@test.invalid','user')
    `);
    for (const id of ['scope-quest', 'scope-clone', 'scope-other', 'scope-delayed']) {
      await fixture.pool.query(
        `INSERT INTO quests(id,title,description,category,location_name,gps_lat,gps_lng,
         marker_code,marker_image_url,author_id,status,version)
         VALUES ($1,$2,'Reviewed activity fixture','eco','Test',16,120,$3,
          'https://example.test/marker.png','scope-author','published',1)`,
        [id, id, `${id}-marker`]
      );
    }
  }, 120_000);

  afterAll(async () => { await fixture?.close(); }, 120_000);

  const review = (questId: string, scopeId: string, policyId: string) => ({
    questId, scopeId, scopeKey: scopeId, policyId, policyKey: policyId,
    policyVersion: 1, proposedBy: 'scope-author', reviewedBy: 'scope-admin',
    countryCode: 'PH', provinceName: 'Pangasinan', activityKind: 'visit' as const,
    activityFingerprint: scopeId, summary: `Verified ${scopeId}`,
    rationale: 'Independently reviewed distinct traveler action', rewardMinor: 100n,
    reservationSeconds: 3600, appealSeconds: 3600,
  });

  it('refuses unreviewed pool authority, self-review and changed policy facts', async () => {
    await expect(economy.createPilotPool({
      id: 'unreviewed', questId: 'scope-quest', scopeKey: 'unreviewed',
      policyVersion: 'unreviewed', rewardMinor: 100n, allocationMinor: 100n,
      reservationSeconds: 3600, appealSeconds: 3600, adminId: 'scope-admin',
    })).rejects.toMatchObject({ code: 'REVIEWED_AUTHORITY_REQUIRED' });
    await expect(economy.createReviewedPilotAuthority({
      ...review('scope-quest', 'scope-one', 'scope-policy-one'), reviewedBy: 'scope-author',
    })).rejects.toMatchObject({ code: 'INVALID_REVIEWED_AUTHORITY' });
    await fixture.pool.query(
      `INSERT INTO economic_activity_scopes
       (id,scope_key,country_code,activity_kind,activity_fingerprint,summary,proposed_by)
       VALUES ('forged-scope','forged-scope','PH','visit','forged-scope',
       'Unreviewed proposed activity','scope-author')`
    );
    await expect(fixture.pool.query(
      `UPDATE economic_activity_scopes SET status = 'approved',
       reviewed_by = 'scope-traveler', reviewed_at = now() WHERE id = 'forged-scope'`
    )).rejects.toThrow(/ADMIN_REVIEW_REQUIRED/);
    await economy.createReviewedPilotAuthority(review('scope-quest', 'scope-one', 'scope-policy-one'));
    await expect(fixture.pool.query(
      `UPDATE economic_reward_policies SET reward_minor = 200 WHERE id = 'scope-policy-one'`
    )).rejects.toThrow(/ECONOMIC_REVIEW_FACT_IMMUTABLE/);
  });

  it('binds a clone to the same activity without resetting eligibility', async () => {
    await economy.bindReviewedQuestRevision({
      questId: 'scope-clone', scopeId: 'scope-one', proposedBy: 'scope-author',
      reviewedBy: 'scope-admin', rationale: 'Same physical activity as original quest',
    });
    await economy.createPilotPool({
      id: 'scope-pool-one', questId: 'scope-quest', scopeId: 'scope-one', scopeKey: 'scope-one',
      policyId: 'scope-policy-one', policyVersion: 'scope-policy-one', rewardMinor: 100n,
      allocationMinor: 100n, reservationSeconds: 3600, appealSeconds: 3600, adminId: 'scope-admin',
    });
    await economy.activatePilotPool('scope-pool-one', 'scope-admin');
    const held = await economy.reserveReward('scope-pool-one', 'scope-traveler');
    expect(held.attemptId).toBeTruthy();
    await expect(fixture.pool.query(
      `UPDATE reward_reservations SET expires_at = expires_at + interval '1 hour' WHERE id = $1`,
      [held.id]
    )).rejects.toThrow(/RESERVATION_SNAPSHOT_IMMUTABLE/);
    const retry = await economy.reserveReward('scope-pool-one', 'scope-traveler');
    expect(retry.id).toBe(held.id);
    expect(retry.attemptId).toBe(held.attemptId);

    await fixture.pool.query(
      `INSERT INTO submissions(id,idempotency_key,user_id,quest_id,scanned_marker_code,
       captured_lat,captured_lng,captured_accuracy,status,economic_attempt_id)
       VALUES ('scope-proof','scope-proof-key','scope-traveler','scope-quest',
       'scope-quest-marker',16,120,8,'approved',$1)`, [held.attemptId]
    );
    await fixture.pool.query(
      `UPDATE reward_reservations SET status = 'submitted', submission_id = 'scope-proof',
       submitted_at = (SELECT created_at FROM submissions WHERE id = 'scope-proof') WHERE id = $1`,
      [held.id]
    );
    const proof = (await fixture.pool.query(
      `SELECT id,user_id,quest_id,created_at FROM submissions WHERE id = 'scope-proof'`
    )).rows[0];
    const client = await fixture.pool.connect();
    try {
      await client.query('BEGIN');
      await economy.settleApprovedSubmissionInTx(client, proof, 'scope-admin');
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
    await fixture.pool.query(`UPDATE reward_pools SET status = 'closed' WHERE id = 'scope-pool-one'`);
    await expect(fixture.pool.query(
      `UPDATE reward_pools SET policy_version = 'forged' WHERE id = 'scope-pool-one'`
    )).rejects.toThrow(/ACTIVE_POOL_AUTHORITY_IMMUTABLE/);
    await expect(fixture.pool.query(
      `UPDATE reward_pools SET status = 'active' WHERE id = 'scope-pool-one'`
    )).rejects.toThrow(/REVIEWED_POOL_INVALID_STATUS_TRANSITION/);
    await economy.createPilotPool({
      id: 'scope-clone-pool', questId: 'scope-clone', scopeId: 'scope-one', scopeKey: 'scope-one',
      policyId: 'scope-policy-one', policyVersion: 'scope-policy-one', rewardMinor: 100n,
      allocationMinor: 100n, reservationSeconds: 3600, appealSeconds: 3600, adminId: 'scope-admin',
    });
    await economy.activatePilotPool('scope-clone-pool', 'scope-admin');
    await expect(economy.reserveReward('scope-clone-pool', 'scope-traveler'))
      .rejects.toMatchObject({ code: 'ALREADY_AWARDED' });
    expect((await fixture.pool.query(
      `SELECT id FROM reward_awards WHERE user_id = 'scope-traveler' AND scope_id = 'scope-one'`
    )).rowCount).toBe(1);
  });

  it('allows a separately reviewed activity and rejects an unreviewed quest revision', async () => {
    await economy.createReviewedPilotAuthority(review('scope-other', 'scope-two', 'scope-policy-two'));
    await economy.createPilotPool({
      id: 'scope-pool-two', questId: 'scope-other', scopeId: 'scope-two', scopeKey: 'scope-two',
      policyId: 'scope-policy-two', policyVersion: 'scope-policy-two', rewardMinor: 100n,
      allocationMinor: 100n, reservationSeconds: 3600, appealSeconds: 3600, adminId: 'scope-admin',
    });
    await economy.activatePilotPool('scope-pool-two', 'scope-admin');
    expect((await economy.reserveReward('scope-pool-two', 'scope-traveler')).attemptId).toBeTruthy();
    await fixture.pool.query(`UPDATE quests SET version = 2 WHERE id = 'scope-other'`);
    await expect(economy.reserveReward('scope-pool-two', 'scope-author'))
      .rejects.toMatchObject({ code: 'QUEST_REVISION_UNREVIEWED' });
  });

  it('rejects unrelated proof but honors a timely bound proof after a quest edit', async () => {
    await economy.createReviewedPilotAuthority(review('scope-delayed', 'scope-three', 'scope-policy-three'));
    await economy.createPilotPool({
      id: 'scope-pool-three', questId: 'scope-delayed', scopeId: 'scope-three', scopeKey: 'scope-three',
      policyId: 'scope-policy-three', policyVersion: 'scope-policy-three', rewardMinor: 100n,
      allocationMinor: 100n, reservationSeconds: 3600, appealSeconds: 3600, adminId: 'scope-admin',
    });
    await economy.activatePilotPool('scope-pool-three', 'scope-admin');
    const held = await economy.reserveReward('scope-pool-three', 'scope-traveler');
    await fixture.pool.query(
      `INSERT INTO submissions(id,idempotency_key,user_id,quest_id,scanned_marker_code,
       captured_lat,captured_lng,captured_accuracy,status)
       VALUES ('unbound-proof','unbound-proof-key','scope-traveler','scope-delayed',
       'scope-delayed-marker',16,120,8,'approved')`
    );
    const unbound = (await fixture.pool.query(
      `SELECT id,user_id,quest_id,created_at FROM submissions WHERE id = 'unbound-proof'`
    )).rows[0];
    await expect(economy.settleApprovedSubmissionInTx(fixture.pool, unbound, 'scope-admin'))
      .rejects.toMatchObject({ code: 'ATTEMPT_PROOF_MISMATCH' });
    await fixture.pool.query(`UPDATE submissions SET status = 'rejected' WHERE id = 'unbound-proof'`);
    await fixture.pool.query(
      `INSERT INTO submissions(id,idempotency_key,user_id,quest_id,scanned_marker_code,
       captured_lat,captured_lng,captured_accuracy,status,economic_attempt_id)
       VALUES ('bound-proof','bound-proof-key','scope-traveler','scope-delayed',
       'scope-delayed-marker',16,120,8,'approved',$1)`, [held.attemptId]
    );
    await fixture.pool.query(
      `UPDATE reward_reservations SET status = 'submitted', submission_id = 'bound-proof',
       submitted_at = (SELECT created_at FROM submissions WHERE id = 'bound-proof') WHERE id = $1`,
      [held.id]
    );
    await fixture.pool.query(`UPDATE quests SET version = 2 WHERE id = 'scope-delayed'`);
    const bound = (await fixture.pool.query(
      `SELECT id,user_id,quest_id,created_at FROM submissions WHERE id = 'bound-proof'`
    )).rows[0];
    const client = await fixture.pool.connect();
    try {
      await client.query('BEGIN');
      await economy.settleApprovedSubmissionInTx(client, bound, 'scope-admin');
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
    expect((await fixture.pool.query(
      `SELECT id FROM reward_awards WHERE reservation_id = $1 AND scope_id = 'scope-three'`, [held.id]
    )).rowCount).toBe(1);
  });
});
