import { createTestDb, TestDbInstance } from '../src/db/testHarness.js';
import { EconomyError, EconomyService, SIM_ASSET } from '../src/economy/service.js';
import { reconcileEconomy } from '../src/economy/reconcile.js';

describe('isolated Explorer Coin economic pilot', () => {
  const realIt = process.env.JDQ_REAL_PG_URL ? it : it.skip;
  let fixture: TestDbInstance;
  let economy: EconomyService;

  beforeAll(async () => {
    fixture = await createTestDb();
    economy = new EconomyService(fixture.pool);
    await fixture.pool.query(`
      INSERT INTO users(id, seed_id, display_name, email, role) VALUES
      ('economy-admin', 'economy-admin', 'Reviewer', 'reviewer@economy.test', 'admin'),
      ('economy-a', 'economy-a', 'Traveler A', 'a@economy.test', 'user'),
      ('economy-b', 'economy-b', 'Traveler B', 'b@economy.test', 'user')
    `);
    await fixture.pool.query(`
      INSERT INTO quests(id, title, description, category, location_name, gps_lat, gps_lng,
        reward_points, marker_code, marker_image_url)
      VALUES ('economy-quest', 'Economic pilot', 'Test activity', 'eco', 'Test', 16.0, 120.0,
        50, 'ECONOMY_MARKER', 'https://example.test/marker.png')
    `);
  });

  afterAll(async () => { await fixture?.close(); });

  async function reviewAuthority(questId: string, scopeKey: string, policyId: string,
    rewardMinor: bigint, allocationMinor: bigint) {
    if (!process.env.JDQ_REAL_PG_URL) return;
    await economy.createReviewedPilotAuthority({
      questId, scopeId: scopeKey, scopeKey, policyId, policyKey: policyId,
      policyVersion: 1, proposedBy: 'economy-a', reviewedBy: 'economy-admin',
      countryCode: 'PH', provinceName: 'Pangasinan', activityKind: 'visit',
      activityFingerprint: scopeKey, summary: `Fixture activity ${scopeKey}`,
      rationale: 'Independent test review', rewardMinor,
      reservationSeconds: 3600, appealSeconds: 3600,
    });
    void allocationMinor;
  }

  async function linkProof(held: { id: string; attemptId?: string }, submissionId: string) {
    if (!process.env.JDQ_REAL_PG_URL) return;
    if (!held.attemptId) throw new Error('TEST_ATTEMPT_MISSING');
    await fixture.pool.query('UPDATE submissions SET economic_attempt_id = $2 WHERE id = $1',
      [submissionId, held.attemptId]);
    await fixture.pool.query(
      `UPDATE reward_reservations SET status = 'submitted', submission_id = $2,
       submitted_at = (SELECT created_at FROM submissions WHERE id = $2) WHERE id = $1`,
      [held.id, submissionId]
    );
  }

  it('keeps pool allocation conserved and awards exactly once after review', async () => {
    await reviewAuthority('economy-quest', 'destination:eco:pilot', 'pilot-v1', 100n, 100n);
    await economy.createPilotPool({
      id: 'economy-pool', questId: 'economy-quest', scopeKey: 'destination:eco:pilot',
      scopeId: 'destination:eco:pilot', policyId: 'pilot-v1',
      policyVersion: 'pilot-v1', rewardMinor: 100n, allocationMinor: 100n,
      reservationSeconds: 3600, appealSeconds: 3600, adminId: 'economy-admin',
    });
    await economy.activatePilotPool('economy-pool', 'economy-admin');
    await expect(economy.activatePilotPool('economy-pool', 'economy-admin')).resolves.toBeUndefined();
    const held = await economy.reserveReward('economy-pool', 'economy-a');
    expect(held.amountMinor).toBe('100');
    expect((await economy.reserveReward('economy-pool', 'economy-a')).id).toBe(held.id);
    await expect(economy.reserveReward('economy-pool', 'economy-b'))
      .rejects.toMatchObject({ code: 'NO_FUNDED_SLOT' } satisfies Partial<EconomyError>);
    const before = await fixture.pool.query('SELECT * FROM reward_pools WHERE id = $1', ['economy-pool']);
    expect(Number(before.rows[0].available_minor)).toBe(0);
    expect(Number(before.rows[0].reserved_minor)).toBe(100);

    await fixture.pool.query(`
      INSERT INTO submissions(id, idempotency_key, user_id, quest_id, scanned_marker_code,
        captured_lat, captured_lng, captured_accuracy, status)
      VALUES ('economy-sub', 'economy-sub-key', 'economy-a', 'economy-quest',
        'ECONOMY_MARKER', 16.0, 120.0, 8, 'approved')
    `);
    await linkProof(held, 'economy-sub');
    const sub = (await fixture.pool.query(
      'SELECT id, user_id, quest_id, created_at FROM submissions WHERE id = $1', ['economy-sub']
    )).rows[0];
    const client = await fixture.pool.connect();
    let receipt;
    try {
      await client.query('BEGIN');
      receipt = await economy.settleApprovedSubmissionInTx(client, sub, 'economy-admin');
      await client.query('COMMIT');
    } finally { client.release(); }
    expect(receipt?.amountMinor).toBe('100');
    expect(await economy.balance('economy-a')).toBe('100');

    const replay = await economy.settleApprovedSubmissionInTx(fixture.pool, sub, 'economy-admin');
    expect(replay?.transactionId).toBe(receipt?.transactionId);
    const recovered = await economy.receiptForApprovedSubmissionInTx(fixture.pool, sub);
    expect(recovered).toEqual(receipt);
    const pool = (await fixture.pool.query('SELECT * FROM reward_pools WHERE id = $1', ['economy-pool'])).rows[0];
    expect([pool.allocated_minor, pool.available_minor, pool.reserved_minor, pool.paid_minor, pool.returned_minor]
      .map(Number)).toEqual([100, 0, 0, 100, 0]);
    expect((await fixture.pool.query('SELECT * FROM reward_awards')).rowCount).toBe(1);
    const transfer = (await fixture.pool.query('SELECT * FROM economic_transfers')).rows[0];
    expect(transfer.asset_code).toBe(SIM_ASSET);
    expect(Number(transfer.amount_minor)).toBe(100);
    expect((await fixture.pool.query('SELECT demo_points FROM users WHERE id = $1', ['economy-a'])).rows[0].demo_points).toBe(0);
  });

  it('spends an optional cosmetic once and refuses overdraft', async () => {
    await fixture.pool.query(`
      INSERT INTO economic_cosmetics(id, asset_code, cost_minor, active)
      VALUES ('profile-frame', 'EXPLORER_COIN_SIM', 40, true),
             ('expensive-theme', 'EXPLORER_COIN_SIM', 80, true)
    `);
    const purchase = await economy.purchaseCosmetic('economy-a', 'profile-frame', 'cosmetic-key');
    expect(purchase.amountMinor).toBe('40');
    expect((await economy.purchaseCosmetic('economy-a', 'profile-frame', 'cosmetic-key')).transactionId)
      .toBe(purchase.transactionId);
    await expect(economy.purchaseCosmetic('economy-a', 'expensive-theme', 'expensive-key'))
      .rejects.toMatchObject({ code: 'INSUFFICIENT_COINS' } satisfies Partial<EconomyError>);
    expect(await economy.balance('economy-a')).toBe('60');
    expect(Number((await fixture.pool.query("SELECT balance_minor FROM economic_accounts WHERE id = 'sim:retired'"))
      .rows[0].balance_minor)).toBe(40);
    expect((await fixture.pool.query('SELECT * FROM economic_entitlements')).rowCount).toBe(1);
    const report = await reconcileEconomy(fixture.pool);
    expect(report.pilotAccountDrift).toEqual([]);
    expect(report.unbalancedLegacyGroups).toEqual([]);
  });

  it('rejects cross-asset and nonpositive transfers at the schema boundary', async () => {
    await fixture.pool.query("INSERT INTO economic_assets(code,scale,environment) VALUES ('OTHER_SIM',0,'simulation')");
    await fixture.pool.query("INSERT INTO economic_accounts(id,asset_code,kind) VALUES ('other:treasury','OTHER_SIM','treasury')");
    await fixture.pool.query("INSERT INTO economic_transactions(id,asset_code,business_event,operation,actor_id,policy_version) VALUES ('invalid-transfer','EXPLORER_COIN_SIM','invalid-transfer','transfer','test','v1')");
    await expect(fixture.pool.query(
      "INSERT INTO economic_transfers(transaction_id,sequence,asset_code,from_account_id,to_account_id,amount_minor) VALUES ('invalid-transfer',1,'EXPLORER_COIN_SIM','other:treasury','sim:retired',1)"
    )).rejects.toThrow();
    await expect(fixture.pool.query(
      "INSERT INTO economic_transfers(transaction_id,sequence,asset_code,from_account_id,to_account_id,amount_minor) VALUES ('invalid-transfer',2,'EXPLORER_COIN_SIM','sim:issuance','sim:retired',0)"
    )).rejects.toThrow();
  });

  realIt('serializes the last funded slot and two concurrent spends on real PostgreSQL', async () => {
    await fixture.pool.query(`
      INSERT INTO quests(id, title, description, category, location_name, gps_lat, gps_lng,
        reward_points, marker_code, marker_image_url)
      VALUES ('economy-race', 'Race', 'Race fixture', 'eco', 'Test', 16.0, 120.0,
        50, 'ECONOMY_RACE_MARKER', 'https://example.test/race.png')
    `);
    await reviewAuthority('economy-race', 'race-scope', 'race-v1', 100n, 100n);
    await economy.createPilotPool({
      id: 'economy-race-pool', questId: 'economy-race', scopeKey: 'race-scope',
      scopeId: 'race-scope', policyId: 'race-v1',
      policyVersion: 'race-v1', rewardMinor: 100n, allocationMinor: 100n,
      reservationSeconds: 3600, appealSeconds: 3600, adminId: 'economy-admin',
    });
    await economy.activatePilotPool('economy-race-pool', 'economy-admin');
    const starts = await Promise.allSettled([
      economy.reserveReward('economy-race-pool', 'economy-a'),
      economy.reserveReward('economy-race-pool', 'economy-b'),
    ]);
    expect(starts.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    const pool = (await fixture.pool.query('SELECT * FROM reward_pools WHERE id = $1', ['economy-race-pool'])).rows[0];
    expect([pool.available_minor, pool.reserved_minor].map(Number)).toEqual([0, 100]);

    await fixture.pool.query(`
      INSERT INTO economic_cosmetics(id, asset_code, cost_minor, active)
      VALUES ('race-frame-a', 'EXPLORER_COIN_SIM', 40, true),
             ('race-frame-b', 'EXPLORER_COIN_SIM', 40, true)
    `);
    const spends = await Promise.allSettled([
      economy.purchaseCosmetic('economy-a', 'race-frame-a', 'race-spend-a'),
      economy.purchaseCosmetic('economy-a', 'race-frame-b', 'race-spend-b'),
    ]);
    expect(spends.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(await economy.balance('economy-a')).toBe('20');
  });

  realIt('rolls back an award atomically and permits a single later commit', async () => {
    await fixture.pool.query(`
      INSERT INTO quests(id, title, description, category, location_name, gps_lat, gps_lng,
        reward_points, marker_code, marker_image_url)
      VALUES ('economy-rollback', 'Rollback', 'Rollback fixture', 'eco', 'Test', 16.0, 120.0,
        50, 'ECONOMY_ROLLBACK_MARKER', 'https://example.test/rollback.png')
    `);
    await reviewAuthority('economy-rollback', 'rollback-scope', 'rollback-v1', 100n, 100n);
    await economy.createPilotPool({
      id: 'economy-rollback-pool', questId: 'economy-rollback', scopeKey: 'rollback-scope',
      scopeId: 'rollback-scope', policyId: 'rollback-v1',
      policyVersion: 'rollback-v1', rewardMinor: 100n, allocationMinor: 100n,
      reservationSeconds: 3600, appealSeconds: 3600, adminId: 'economy-admin',
    });
    await economy.activatePilotPool('economy-rollback-pool', 'economy-admin');
    const held = await economy.reserveReward('economy-rollback-pool', 'economy-b');
    await fixture.pool.query(`
      INSERT INTO submissions(id, idempotency_key, user_id, quest_id, scanned_marker_code,
        captured_lat, captured_lng, captured_accuracy, status)
      VALUES ('economy-rollback-sub', 'economy-rollback-key', 'economy-b', 'economy-rollback',
        'ECONOMY_ROLLBACK_MARKER', 16.0, 120.0, 8, 'approved')
    `);
    await linkProof(held, 'economy-rollback-sub');
    const submission = (await fixture.pool.query(
      'SELECT id, user_id, quest_id, created_at FROM submissions WHERE id = $1',
      ['economy-rollback-sub']
    )).rows[0];
    const client = await fixture.pool.connect();
    try {
      await client.query('BEGIN');
      await economy.settleApprovedSubmissionInTx(client, submission, 'economy-admin');
      await client.query('ROLLBACK');
    } finally { client.release(); }

    expect(await economy.balance('economy-b')).toBe('0');
    expect((await fixture.pool.query('SELECT id FROM reward_awards WHERE reservation_id = $1', [held.id])).rowCount)
      .toBe(0);
    const before = (await fixture.pool.query('SELECT status FROM reward_reservations WHERE id = $1', [held.id])).rows[0];
    expect(before.status).toBe(process.env.JDQ_REAL_PG_URL ? 'submitted' : 'reserved');

    const retry = await fixture.pool.connect();
    let receipt;
    try {
      await retry.query('BEGIN');
      receipt = await economy.settleApprovedSubmissionInTx(retry, submission, 'economy-admin');
      await retry.query('COMMIT');
    } finally { retry.release(); }
    expect(receipt?.amountMinor).toBe('100');
    expect(await economy.balance('economy-b')).toBe('100');
    expect((await fixture.pool.query('SELECT id FROM reward_awards WHERE reservation_id = $1', [held.id])).rowCount)
      .toBe(1);
  });

  it('holds a timely submission through expiry and returns an abandoned reservation', async () => {
    await fixture.pool.query(`
      INSERT INTO quests(id, title, description, category, location_name, gps_lat, gps_lng,
        reward_points, marker_code, marker_image_url)
      VALUES ('economy-expiry', 'Expiry', 'Expiry fixture', 'eco', 'Test', 16.0, 120.0,
        50, 'ECONOMY_EXPIRY_MARKER', 'https://example.test/expiry.png')
    `);
    await reviewAuthority('economy-expiry', 'expiry-scope', 'expiry-v1', 100n, 200n);
    await economy.createPilotPool({
      id: 'economy-expiry-pool', questId: 'economy-expiry', scopeKey: 'expiry-scope',
      scopeId: 'expiry-scope', policyId: 'expiry-v1',
      policyVersion: 'expiry-v1', rewardMinor: 100n, allocationMinor: 200n,
      reservationSeconds: 3600, appealSeconds: 3600, adminId: 'economy-admin',
    });
    await economy.activatePilotPool('economy-expiry-pool', 'economy-admin');
    const timely = await economy.reserveReward('economy-expiry-pool', 'economy-b');
    const abandoned = await economy.reserveReward('economy-expiry-pool', 'economy-a');
    const startAt = new Date(Date.now() - 10 * 60_000);
    const submitAt = new Date(Date.now() - 2 * 60_000);
    const expireAt = new Date(Date.now() - 60_000);
    if (process.env.JDQ_REAL_PG_URL) {
      // Disposable fixture clock manipulation only; production reservation
      // snapshots are immutable after a start receipt is issued.
      await fixture.pool.query('ALTER TABLE reward_reservations DISABLE TRIGGER economic_reservation_authority_guard_trigger');
    }
    try {
      await fixture.pool.query(
        'UPDATE reward_reservations SET created_at = $2, expires_at = $3 WHERE id IN ($1, $4)',
        [timely.id, startAt, expireAt, abandoned.id]
      );
    } finally {
      if (process.env.JDQ_REAL_PG_URL) {
        await fixture.pool.query('ALTER TABLE reward_reservations ENABLE TRIGGER economic_reservation_authority_guard_trigger');
      }
    }
    await fixture.pool.query(`
      INSERT INTO submissions(id, idempotency_key, user_id, quest_id, scanned_marker_code,
        captured_lat, captured_lng, captured_accuracy, status, created_at)
      VALUES ('economy-timely-sub', 'economy-timely-key', 'economy-b', 'economy-expiry',
        'ECONOMY_EXPIRY_MARKER', 16.0, 120.0, 8, 'pending', $1)
    `, [submitAt]);
    if (process.env.JDQ_REAL_PG_URL) {
      await fixture.pool.query(
        'UPDATE submissions SET economic_attempt_id = $2 WHERE id = $1',
        ['economy-timely-sub', timely.attemptId]
      );
    }
    expect(await economy.releaseExpiredReservation(timely.id)).toBe(false);
    expect(await economy.releaseExpiredReservation(abandoned.id)).toBe(true);
    const held = (await fixture.pool.query('SELECT status FROM reward_reservations WHERE id = $1', [timely.id])).rows[0];
    expect(held.status).toBe('submitted');
    await fixture.pool.query("UPDATE submissions SET status = 'approved' WHERE id = 'economy-timely-sub'");
    const submission = (await fixture.pool.query(
      'SELECT id, user_id, quest_id, created_at FROM submissions WHERE id = $1', ['economy-timely-sub']
    )).rows[0];
    const reviewClient = await fixture.pool.connect();
    let receipt;
    try {
      await reviewClient.query('BEGIN');
      receipt = await economy.settleApprovedSubmissionInTx(reviewClient, submission, 'economy-admin');
      await reviewClient.query('COMMIT');
    } catch (error) {
      await reviewClient.query('ROLLBACK');
      throw error;
    } finally {
      reviewClient.release();
    }
    expect(receipt?.amountMinor).toBe('100');
    const pool = (await fixture.pool.query('SELECT * FROM reward_pools WHERE id = $1', ['economy-expiry-pool'])).rows[0];
    expect([pool.allocated_minor, pool.available_minor, pool.reserved_minor, pool.paid_minor].map(Number))
      .toEqual([200, 100, 0, 100]);
  });
});
