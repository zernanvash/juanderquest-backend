import request from 'supertest';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import { app } from '../src/app.js';
import { env } from '../src/config/env.js';
import { db } from '../src/db/index.js';
import { setPool } from '../src/db/pool.js';
import { createTestDb, TestDbInstance } from '../src/db/testHarness.js';
import { EconomyService } from '../src/economy/service.js';

const realDescribe = process.env.JDQ_REAL_PG_URL ? describe : describe.skip;

realDescribe('disposable real-PostgreSQL economy HTTP flow', () => {
  let fixture: TestDbInstance;
  const questId = 'economy-http-quest';
  const adminId = 'economy-http-admin';
  const travelerId = 'economy-http-traveler';
  const otherId = 'economy-http-other';
  const bearer = (id: string, role: 'admin' | 'user') =>
    `Bearer ${jwt.sign({ id, seed_id: id, role }, env.JWT_SECRET)}`;

  beforeAll(async () => {
    fixture = await createTestDb();
    setPool(fixture.pool);
    await fixture.pool.query(`
      INSERT INTO users(id, seed_id, display_name, email, role) VALUES
      ($1, $2, 'Economic Admin', 'economy-http-admin@test.invalid', 'admin'),
      ($3, $4, 'Economic Traveler', 'economy-http-traveler@test.invalid', 'user'),
      ($5, $6, 'Other Traveler', 'economy-http-other@test.invalid', 'user')
    `, [adminId, adminId, travelerId, travelerId, otherId, otherId]);
    await fixture.pool.query(`
      INSERT INTO quests(id, title, description, category, location_name, gps_lat, gps_lng,
        radius_meters, reward_points, marker_code, marker_image_url, status, is_active)
      VALUES ($1, 'Economic HTTP Quest', 'Disposable integration fixture', 'eco',
        'Fictional venue', 16.0, 120.0, 100, 50, 'ECONOMY_HTTP_MARKER',
        'https://example.test/economy-http-marker.png', 'published', true)
    `, [questId]);
    await db.hydrateFromPg(fixture.pool);
  });

  afterAll(async () => {
    setPool(null);
    if (fixture) await fixture.close();
  });

  it('enforces admin ownership and completes one award plus one optional spend', async () => {
    const admin = bearer(adminId, 'admin');
    const traveler = bearer(travelerId, 'user');
    const other = bearer(otherId, 'user');
    await new EconomyService(fixture.pool).createReviewedPilotAuthority({
      questId, scopeId: 'economy-http-canonical-activity',
      scopeKey: 'economy-http-canonical-activity', policyId: 'http-v1',
      policyKey: 'http-v1', policyVersion: 1, proposedBy: travelerId,
      reviewedBy: adminId, countryCode: 'PH', provinceName: 'Pangasinan',
      activityKind: 'visit', activityFingerprint: 'economy-http-canonical-activity',
      summary: 'HTTP fixture activity', rationale: 'Independent integration review',
      rewardMinor: 100n, reservationSeconds: 3600, appealSeconds: 3600,
    });
    const poolBody = {
      quest_id: questId, scope_key: 'economy-http-canonical-activity', policy_version: 'http-v1',
      scope_id: 'economy-http-canonical-activity', policy_id: 'http-v1',
      reward_minor: '100', allocation_minor: '100', reservation_seconds: 3600,
      appeal_seconds: 3600,
    };

    const unauthenticated = await request(app).post('/api/v1/admin/economy/pools').send(poolBody);
    expect(unauthenticated.status).toBe(401);
    const forbiddenPool = await request(app).post('/api/v1/admin/economy/pools')
      .set('Authorization', traveler).send(poolBody);
    expect(forbiddenPool.status).toBe(403);
    const draft = await request(app).post('/api/v1/admin/economy/pools')
      .set('Authorization', admin).send(poolBody);
    expect(draft.status).toBe(201);
    const poolId = draft.body.data.id;
    expect(typeof poolId).toBe('string');

    const forbiddenActivate = await request(app).post(`/api/v1/admin/economy/pools/${poolId}/activate`)
      .set('Authorization', traveler);
    expect(forbiddenActivate.status).toBe(403);
    const activated = await request(app).post(`/api/v1/admin/economy/pools/${poolId}/activate`)
      .set('Authorization', admin);
    expect(activated.status).toBe(200);

    const preview = await request(app).get(`/api/v1/economy/quests/${questId}/reward`);
    expect(preview.status).toBe(200);
    expect(preview.body.data).toMatchObject({ reward_minor: '100', funded_slots_available: true });

    const start = await request(app).post(`/api/v1/quests/${questId}/attempts`)
      .set('Authorization', traveler);
    expect(start.status).toBe(201);
    expect(start.body.data.reward_reservation.amountMinor).toBe('100');
    const noSlot = await request(app).post(`/api/v1/quests/${questId}/attempts`)
      .set('Authorization', other);
    expect(noSlot.status).toBe(409);
    expect(noSlot.body.error.code).toBe('NO_FUNDED_SLOT');

    const challenge = await request(app).post(`/api/v1/quests/${questId}/challenge`)
      .set('Authorization', traveler);
    expect(challenge.status).toBe(200);
    const submission = await request(app).post('/api/v1/submissions')
      .set('Authorization', traveler)
      .send({
        idempotency_key: randomUUID(), quest_id: questId,
        challenge_token: challenge.body.data.challenge_token,
        captured_lat: 16.0, captured_lng: 120.0, captured_accuracy: 8,
      });
    expect(submission.status).toBe(201);
    expect(submission.body.data.status).toBe('pending');
    const submissionId = submission.body.data.id;

    const forbiddenReview = await request(app).patch(`/api/v1/admin/submissions/${submissionId}`)
      .set('Authorization', other).send({ action: 'approve' });
    expect(forbiddenReview.status).toBe(403);
    const approval = await request(app).patch(`/api/v1/admin/submissions/${submissionId}`)
      .set('Authorization', admin).send({ action: 'approve' });
    expect(approval.status).toBe(200);
    expect(approval.body.data.awarded_explorer_coins).toBe('100');
    const durableAttempt = await fixture.pool.query(
      `SELECT a.status, s.economic_attempt_id, r.status AS reservation_status
       FROM submissions s JOIN quest_attempts a ON a.id = s.economic_attempt_id
       JOIN reward_reservations r ON r.attempt_id = a.id WHERE s.id = $1`, [submissionId]
    );
    expect(durableAttempt.rows[0]).toMatchObject({
      status: 'completed', economic_attempt_id: start.body.data.id, reservation_status: 'paid',
    });
    const transactionId = approval.body.data.explorer_coin_transaction_id;
    expect(typeof transactionId).toBe('string');
    const replay = await request(app).patch(`/api/v1/admin/submissions/${submissionId}`)
      .set('Authorization', admin).send({ action: 'approve' });
    expect(replay.status).toBe(200);
    expect(replay.body.data.awarded_explorer_coins).toBe('100');
    expect(replay.body.data.explorer_coin_transaction_id).toBe(transactionId);

    const wallet = await request(app).get('/api/v1/wallet').set('Authorization', traveler);
    expect(wallet.status).toBe(200);
    expect(wallet.body.data.explorer_coin_balance).toBe('100');
    const otherWallet = await request(app).get('/api/v1/wallet').set('Authorization', other);
    expect(otherWallet.status).toBe(200);
    expect(otherWallet.body.data.explorer_coin_balance).toBe('0');

    const forbiddenCosmetic = await request(app).post('/api/v1/admin/economy/cosmetics')
      .set('Authorization', traveler).send({ id: 'http-frame', cost_minor: '40' });
    expect(forbiddenCosmetic.status).toBe(403);
    const cosmetic = await request(app).post('/api/v1/admin/economy/cosmetics')
      .set('Authorization', admin).send({ id: 'http-frame', cost_minor: '40' });
    expect(cosmetic.status).toBe(201);
    const otherPurchase = await request(app).post('/api/v1/wallet/cosmetics/http-frame/purchase')
      .set('Authorization', other).set('x-idempotency-key', 'other-http-spend');
    expect(otherPurchase.status).toBe(409);
    expect(otherPurchase.body.error.code).toBe('INSUFFICIENT_COINS');
    const purchase = await request(app).post('/api/v1/wallet/cosmetics/http-frame/purchase')
      .set('Authorization', traveler).set('x-idempotency-key', 'traveler-http-spend');
    expect(purchase.status).toBe(200);
    expect(purchase.body.data.amountMinor).toBe('40');
    const purchaseReplay = await request(app).post('/api/v1/wallet/cosmetics/http-frame/purchase')
      .set('Authorization', traveler).set('x-idempotency-key', 'traveler-http-spend');
    expect(purchaseReplay.status).toBe(200);
    expect(purchaseReplay.body.data.transactionId).toBe(purchase.body.data.transactionId);
    const finalWallet = await request(app).get('/api/v1/wallet').set('Authorization', traveler);
    expect(finalWallet.body.data.explorer_coin_balance).toBe('60');

    const awards = await fixture.pool.query('SELECT id FROM reward_awards WHERE user_id = $1', [travelerId]);
    const entitlements = await fixture.pool.query('SELECT id FROM economic_entitlements WHERE user_id = $1', [travelerId]);
    expect(awards.rowCount).toBe(1);
    expect(entitlements.rowCount).toBe(1);
  });
});
