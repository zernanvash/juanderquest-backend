import request from 'supertest';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import { app } from '../src/app';
import { env } from '../src/config/env';
import { db } from '../src/db/index';
import { setPool } from '../src/db/pool';
import { createTestDb, type TestDbInstance } from '../src/db/testHarness';
import { EconomyService } from '../src/economy/service';

const realPg = process.env.JDQ_REAL_PG_URL ? describe : describe.skip;

realPg('funded proof appeal and independent review on disposable PostgreSQL', () => {
  let fixture: TestDbInstance;
  let economy: EconomyService;
  const questId = 'appeal-quest';
  const token = (id: string, role: 'admin' | 'user') =>
    `Bearer ${jwt.sign({ id, seed_id: id, role }, env.JWT_SECRET)}`;

  beforeAll(async () => {
    fixture = await createTestDb();
    setPool(fixture.pool);
    economy = new EconomyService(fixture.pool);
    await fixture.pool.query(`
      INSERT INTO users(id,seed_id,display_name,email,role) VALUES
      ('appeal-admin-1','appeal-admin-1','First reviewer','appeal-a1@test.invalid','admin'),
      ('appeal-admin-2','appeal-admin-2','Independent reviewer','appeal-a2@test.invalid','admin'),
      ('appeal-author','appeal-author','Author','appeal-author@test.invalid','user'),
      ('appeal-user-1','appeal-user-1','Traveler one','appeal-u1@test.invalid','user'),
      ('appeal-user-2','appeal-user-2','Traveler two','appeal-u2@test.invalid','user')
    `);
    await fixture.pool.query(
      `INSERT INTO quests(id,title,description,category,location_name,gps_lat,gps_lng,
       radius_meters,reward_points,marker_code,marker_image_url,author_id,status,is_active)
       VALUES ($1,'Appeal quest','Local review test','eco','Fictional venue',16,120,
       100,50,'APPEAL_MARKER','https://example.test/appeal.png','appeal-author','published',true)`,
      [questId]
    );
    await economy.createReviewedPilotAuthority({
      questId, scopeId: 'appeal-scope', scopeKey: 'appeal-scope',
      policyId: 'appeal-policy-v1', policyKey: 'appeal-policy', policyVersion: 1,
      proposedBy: 'appeal-author', reviewedBy: 'appeal-admin-1', countryCode: 'PH',
      provinceName: 'Pangasinan', activityKind: 'visit', activityFingerprint: 'appeal-scope',
      summary: 'Fictional on-site activity', rationale: 'Independent review fixture',
      rewardMinor: 100n, reservationSeconds: 3600, appealSeconds: 3600,
    });
    await economy.createPilotPool({
      id: 'appeal-pool', questId, scopeId: 'appeal-scope', scopeKey: 'appeal-scope',
      policyId: 'appeal-policy-v1', policyVersion: 'appeal-policy-v1',
      rewardMinor: 100n, allocationMinor: 200n, reservationSeconds: 3600,
      appealSeconds: 3600, adminId: 'appeal-admin-1',
    });
    await economy.activatePilotPool('appeal-pool', 'appeal-admin-1');
    await db.hydrateFromPg(fixture.pool);
  }, 120_000);

  afterAll(async () => {
    setPool(null);
    await fixture?.close();
  }, 120_000);

  async function startSubmitReject(userId: string) {
    const auth = token(userId, 'user');
    const start = await request(app).post(`/api/v1/quests/${questId}/attempts`)
      .set('Authorization', auth);
    expect(start.status).toBe(201);
    const challenge = await request(app).post(`/api/v1/quests/${questId}/challenge`)
      .set('Authorization', auth);
    expect(challenge.status).toBe(200);
    const proof = await request(app).post('/api/v1/submissions').set('Authorization', auth)
      .send({ idempotency_key: randomUUID(), quest_id: questId,
        challenge_token: challenge.body.data.challenge_token,
        captured_lat: 16, captured_lng: 120, captured_accuracy: 8 });
    expect(proof.status).toBe(201);
    const reject = await request(app).patch(`/api/v1/admin/submissions/${proof.body.data.id}`)
      .set('Authorization', token('appeal-admin-1', 'admin'))
      .send({ action: 'reject', rejection_reason: 'Physical proof needs independent recheck.' });
    expect(reject.status).toBe(200);
    return { auth, attemptId: start.body.data.id,
      reservationId: start.body.data.reward_reservation.id, submissionId: proof.body.data.id };
  }

  it('holds timely appeal through review and awards exactly once after independent approval', async () => {
    const first = await startSubmitReject('appeal-user-1');
    const appeal = await request(app).post(`/api/v1/economy/reservations/${first.reservationId}/appeal`)
      .set('Authorization', first.auth)
      .send({ reason: 'The on-site evidence was valid and needs another reviewer.' });
    expect(appeal.status).toBe(200);
    expect(appeal.body.data.status).toBe('submitted');
    const appealId = appeal.body.data.id;
    const replay = await request(app).post(`/api/v1/economy/reservations/${first.reservationId}/appeal`)
      .set('Authorization', first.auth)
      .send({ reason: 'The on-site evidence was valid and needs another reviewer.' });
    expect(replay.body.data.id).toBe(appealId);
    expect(await economy.releaseExpiredReservation(first.reservationId)).toBe(false);
    const originalReviewer = await request(app).post(`/api/v1/admin/economy/appeals/${appealId}/approve`)
      .set('Authorization', token('appeal-admin-1', 'admin'))
      .send({ reason: 'I agree this original evidence should be accepted.' });
    expect(originalReviewer.status).toBe(409);
    const approved = await request(app).post(`/api/v1/admin/economy/appeals/${appealId}/approve`)
      .set('Authorization', token('appeal-admin-2', 'admin'))
      .send({ reason: 'Independent review validates the original on-site proof.' });
    expect(approved.status).toBe(200);
    expect(approved.body.data.awarded_explorer_coins).toBe('100');
    const approvedReplay = await request(app).post(`/api/v1/admin/economy/appeals/${appealId}/approve`)
      .set('Authorization', token('appeal-admin-2', 'admin'))
      .send({ reason: 'Independent review validates the original on-site proof.' });
    expect(approvedReplay.status).toBe(200);
    expect(approvedReplay.body.data.explorer_coin_transaction_id)
      .toBe(approved.body.data.explorer_coin_transaction_id);
    expect((await fixture.pool.query(
      `SELECT count(*)::int AS n FROM reward_awards WHERE user_id = 'appeal-user-1'`
    )).rows[0].n).toBe(1);
    expect((await fixture.pool.query(
      `SELECT a.status AS attempt_status, r.status AS reservation_status
       FROM quest_attempts a JOIN reward_reservations r ON r.attempt_id = a.id
       WHERE a.id = $1`, [first.attemptId]
    )).rows[0]).toMatchObject({ attempt_status: 'completed', reservation_status: 'paid' });
  });

  it('returns the held allowance once after independent appeal denial', async () => {
    const second = await startSubmitReject('appeal-user-2');
    const appeal = await request(app).post(`/api/v1/economy/reservations/${second.reservationId}/appeal`)
      .set('Authorization', second.auth)
      .send({ reason: 'I request a second review of the captured location proof.' });
    expect(appeal.status).toBe(200);
    const denialReason = 'Independent evidence still does not meet the published quest requirement.';
    const denied = await request(app).post(`/api/v1/admin/economy/appeals/${appeal.body.data.id}/reject`)
      .set('Authorization', token('appeal-admin-2', 'admin'))
      .send({ reason: denialReason });
    expect(denied.status).toBe(200);
    expect(denied.body.data.status).toBe('rejected');
    const denialReplay = await request(app).post(`/api/v1/admin/economy/appeals/${appeal.body.data.id}/reject`)
      .set('Authorization', token('appeal-admin-2', 'admin'))
      .send({ reason: denialReason });
    expect(denialReplay.status).toBe(200);
    const pool = (await fixture.pool.query(`SELECT * FROM reward_pools WHERE id = 'appeal-pool'`)).rows[0];
    expect([pool.available_minor, pool.reserved_minor, pool.paid_minor].map(Number)).toEqual([100, 0, 100]);
    expect((await fixture.pool.query(
      `SELECT status FROM quest_attempts WHERE id = $1`, [second.attemptId]
    )).rows[0].status).toBe('abandoned');
  });
});
