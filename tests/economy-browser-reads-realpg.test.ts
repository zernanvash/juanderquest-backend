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

realDescribe('local economy browser read contracts on disposable PostgreSQL', () => {
  let fixture: TestDbInstance;
  const adminId = `lab-read-admin-${randomUUID()}`;
  const independentAdminId = `lab-read-independent-admin-${randomUUID()}`;
  const authorId = `lab-read-author-${randomUUID()}`;
  const travelerId = `lab-read-traveler-${randomUUID()}`;
  const otherId = `lab-read-other-${randomUUID()}`;
  const questId = `lab-read-quest-${randomUUID()}`;
  const scopeId = `lab-read-scope-${randomUUID()}`;
  const policyId = `lab-read-policy-${randomUUID()}`;
  const poolId = `lab-read-pool-${randomUUID()}`;
  const cosmeticId = `lab-read-cosmetic-${randomUUID()}`;
  const bearer = (id: string, role: 'admin' | 'user') =>
    `Bearer ${jwt.sign({ id, seed_id: id, role }, env.JWT_SECRET)}`;

  beforeAll(async () => {
    fixture = await createTestDb();
    setPool(fixture.pool);
    await fixture.pool.query(`
      INSERT INTO users(id, seed_id, display_name, email, role) VALUES
      ($1, 'lab-read-admin', 'Lab Admin', 'lab-read-admin@example.invalid', 'admin'),
      ($2, 'lab-read-author', 'Lab Author', 'lab-read-author@example.invalid', 'user'),
      ($3, 'lab-read-traveler', 'Lab Traveler', 'lab-read-traveler@example.invalid', 'user'),
      ($4, 'lab-read-other', 'Lab Other', 'lab-read-other@example.invalid', 'user'),
      ($5, 'lab-read-independent-admin', 'Lab Independent Admin', 'lab-read-independent-admin@example.invalid', 'admin')
    `, [adminId, authorId, travelerId, otherId, independentAdminId]);
    // Plan 67: shop purchases need a bound wallet.
    await fixture.pool.query(`UPDATE users SET wallet_address = '0x' || substr(md5(id) || md5(id || 'w'), 1, 40) WHERE id = ANY($1::text[])`, [[travelerId, otherId]]);
    await fixture.pool.query(`
      INSERT INTO quests(id, title, description, category, location_name, gps_lat, gps_lng,
        radius_meters, reward_points, marker_code, marker_image_url, status, is_active, author_id)
      VALUES ($1, 'Lab Read Quest', 'Disposable read contract fixture', 'eco',
        'Fictional venue', 16.0, 120.0, 100, 0, 'LAB_READ_MARKER',
        'https://example.invalid/marker.png', 'published', true, $2)
    `, [questId, authorId]);
    const service = new EconomyService(fixture.pool);
    await service.createReviewedPilotAuthority({
      questId, scopeId, scopeKey: scopeId, policyId, policyKey: 'lab-read',
      policyVersion: 1, proposedBy: authorId, reviewedBy: adminId,
      countryCode: 'PH', activityKind: 'visit', activityFingerprint: scopeId,
      summary: 'Fictional lab activity', rationale: 'Independent local review',
      rewardMinor: 100n, reservationSeconds: 3600, appealSeconds: 3600,
    });
    await service.createPilotPool({ id: poolId, questId, scopeId, scopeKey: scopeId,
      policyId, policyVersion: policyId, rewardMinor: 100n, allocationMinor: 300n,
      reservationSeconds: 3600, appealSeconds: 3600, adminId });
    await service.activatePilotPool(poolId, adminId);
    await fixture.pool.query(
      'INSERT INTO economic_cosmetics(id, asset_code, cost_minor, active) VALUES ($1, $2, $3, true)',
      [cosmeticId, 'EXPLORER_COIN_SIM', '40']
    );
    await db.hydrateFromPg(fixture.pool);
  });

  afterAll(async () => {
    setPool(null);
    if (fixture) await fixture.close();
  });

  it('requires auth, reports simulation capability, and never fabricates an opening balance', async () => {
    const unauthorized = await request(app).get('/api/v1/economy/me');
    expect(unauthorized.status).toBe(401);
    const token = bearer(travelerId, 'user');
    const capabilities = await request(app).get('/api/v1/economy/capabilities').set('Authorization', token);
    expect(capabilities.status).toBe(200);
    expect(capabilities.body.data).toMatchObject({ environment: 'local_simulation', schema_ready: true });
    const me = await request(app).get('/api/v1/economy/me').set('Authorization', token);
    expect(me.status).toBe(200);
    expect(me.headers['cache-control']).toBe('private, no-store');
    expect(me.body.data).toMatchObject({ asset: 'EXPLORER_COIN_SIM', balance_minor: '0', cash_value: null });
    expect(JSON.stringify(me.body)).not.toContain('mjdq_balance');
  });

  it('rejects expired cookies and forged or deleted admin identities', async () => {
    const expired = jwt.sign({ id: travelerId, seed_id: travelerId, role: 'user',
      iat: 1, exp: 2 }, env.JWT_SECRET);
    const staleCookie = await request(app).get('/api/v1/economy/me').set('Cookie', `jdq_session=${expired}`);
    expect(staleCookie.status).toBe(401);
    const forgedRole = await request(app).get('/api/v1/admin/economy/queue')
      .set('Authorization', bearer(travelerId, 'admin'));
    expect(forgedRole.status).toBe(403);
    const deleted = await request(app).get('/api/v1/admin/economy/queue')
      .set('Authorization', bearer(`deleted-${randomUUID()}`, 'admin'));
    expect(deleted.status).toBe(403);
    const deletedTraveler = await request(app).get('/api/v1/economy/me')
      .set('Authorization', bearer(`deleted-${randomUUID()}`, 'user'));
    expect(deletedTraveler.status).toBe(401);
  });

  it('returns 503 when the required migration ledger entry is missing', async () => {
    const removed = await fixture.pool.query("DELETE FROM schema_migrations WHERE filename='035_chain_indexer_reorg_safety.sql' RETURNING *");
    try {
      const response = await request(app).get('/api/v1/economy/me').set('Authorization', bearer(travelerId, 'user'));
      expect(response.status).toBe(503);
      expect(response.body.data).toBeUndefined();
    } finally {
      const row = removed.rows[0];
      await fixture.pool.query('INSERT INTO schema_migrations(filename,applied_at,checksum) VALUES($1,$2,$3)', [row.filename,row.applied_at,row.checksum]);
    }
  });

  it('reports only the owner’s reservation, pool conservation, and bounded pagination errors', async () => {
    const token = bearer(travelerId, 'user');
    const start = await request(app).post(`/api/v1/quests/${questId}/attempts`).set('Authorization', token);
    expect(start.status).toBe(201);
    const reservationId = start.body.data.reward_reservation.id;
    const owned = await request(app).get(`/api/v1/economy/reservations/${reservationId}`).set('Authorization', token);
    expect(owned.status).toBe(200);
    expect(owned.body.data).toMatchObject({ status: 'reserved', amount_minor: '100', asset: 'EXPLORER_COIN_SIM' });
    const other = await request(app).get(`/api/v1/economy/reservations/${reservationId}`)
      .set('Authorization', bearer(otherId, 'user'));
    expect(other.status).toBe(404);
    const list = await request(app).get('/api/v1/economy/me/reservations?limit=1').set('Authorization', token);
    expect(list.status).toBe(200);
    expect(list.body.data.items).toHaveLength(1);
    const badLimit = await request(app).get('/api/v1/economy/me/reservations?limit=999').set('Authorization', token);
    expect(badLimit.status).toBe(400);
    const badCursor = await request(app).get('/api/v1/economy/me/activity?cursor=broken').set('Authorization', token);
    expect(badCursor.status).toBe(400);
    const forbidden = await request(app).get(`/api/v1/admin/economy/pools/${poolId}/summary`).set('Authorization', token);
    expect(forbidden.status).toBe(403);
    const summary = await request(app).get(`/api/v1/admin/economy/pools/${poolId}/summary`)
      .set('Authorization', bearer(adminId, 'admin'));
    expect(summary.status).toBe(200);
    const p = summary.body.data;
    expect(BigInt(p.allocated_minor)).toBe(BigInt(p.available_minor) + BigInt(p.reserved_minor) +
      BigInt(p.paid_minor) + BigInt(p.returned_minor));
  });

  it('reads one approved award, one optional spend, and the durable entitlement', async () => {
    const traveler = bearer(travelerId, 'user');
    const admin = bearer(adminId, 'admin');
    const challenge = await request(app).post(`/api/v1/quests/${questId}/challenge`).set('Authorization', traveler);
    expect(challenge.status).toBe(200);
    const submission = await request(app).post('/api/v1/submissions').set('Authorization', traveler).send({
      idempotency_key: randomUUID(), quest_id: questId, challenge_token: challenge.body.data.challenge_token,
      captured_lat: 16.0, captured_lng: 120.0, captured_accuracy: 8,
    });
    expect(submission.status).toBe(201);
    const pending = await request(app).get('/api/v1/economy/me').set('Authorization', traveler);
    expect(pending.body.data.balance_minor).toBe('0');
    const review = await request(app).patch(`/api/v1/admin/submissions/${submission.body.data.id}`)
      .set('Authorization', admin).send({ action: 'approve' });
    expect(review.status).toBe(200);
    const earned = await request(app).get('/api/v1/economy/me').set('Authorization', traveler);
    expect(earned.body.data.balance_minor).toBe('100');
    const purchase = await request(app).post(`/api/v1/wallet/cosmetics/${cosmeticId}/purchase`)
      .set('Authorization', traveler).set('x-idempotency-key', randomUUID());
    expect(purchase.status).toBe(200);
    const left = await request(app).get('/api/v1/economy/me').set('Authorization', traveler);
    expect(left.body.data.balance_minor).toBe('60');
    const activity = await request(app).get('/api/v1/economy/me/activity?limit=1').set('Authorization', traveler);
    expect(activity.status).toBe(200);
    expect(activity.body.data.items).toHaveLength(1);
    expect(activity.body.data.next_cursor).toBeTruthy();
    const second = await request(app).get(`/api/v1/economy/me/activity?limit=1&cursor=${activity.body.data.next_cursor}`)
      .set('Authorization', traveler);
    expect(second.status).toBe(200);
    expect(second.body.data.items).toHaveLength(1);
    expect(activity.body.data.items[0].signed_amount_minor).toBe('-40');
    expect(second.body.data.items[0].signed_amount_minor).toBe('100');
    const other = await request(app).get('/api/v1/economy/me/activity').set('Authorization', bearer(otherId, 'user'));
    expect(other.body.data.items).toHaveLength(0);
    const entitlements = await request(app).get('/api/v1/economy/me/entitlements').set('Authorization', traveler);
    expect(entitlements.status).toBe(200);
    expect(entitlements.body.data.items[0]).toMatchObject({ cosmetic_id: cosmeticId, status: 'owned' });
    expect(JSON.stringify(entitlements.body)).not.toContain('captured_lat');
    const purchaseQueue = await request(app).get('/api/v1/admin/economy/cosmetic-purchases')
      .set('Authorization', admin);
    expect(purchaseQueue.status).toBe(200);
    expect(purchaseQueue.body.data[0]).toMatchObject({ cosmetic_id: cosmeticId, refunded_at: null });
    const appealQueue = await request(app).get('/api/v1/admin/economy/appeals')
      .set('Authorization', admin);
    expect(appealQueue.status).toBe(200);
    expect(appealQueue.body.data).toEqual([]);
  });

  it('reports a truthful rejected-appeal release reason without inventing a paid reward', async () => {
    const other = bearer(otherId, 'user');
    const start = await request(app).post(`/api/v1/quests/${questId}/attempts`).set('Authorization', other);
    expect(start.status).toBe(201);
    const reservationId = start.body.data.reward_reservation.id;
    const challenge = await request(app).post(`/api/v1/quests/${questId}/challenge`).set('Authorization', other);
    expect(challenge.status).toBe(200);
    const submission = await request(app).post('/api/v1/submissions').set('Authorization', other).send({
      idempotency_key: randomUUID(), quest_id: questId, challenge_token: challenge.body.data.challenge_token,
      captured_lat: 16.0, captured_lng: 120.0, captured_accuracy: 8,
    });
    expect(submission.status).toBe(201);
    const reject = await request(app).patch(`/api/v1/admin/submissions/${submission.body.data.id}`)
      .set('Authorization', bearer(adminId, 'admin'))
      .send({ action: 'reject', rejection_reason: 'Fictional proof requires independent second review.' });
    expect(reject.status).toBe(200);
    const appeal = await request(app).post(`/api/v1/economy/reservations/${reservationId}/appeal`)
      .set('Authorization', other).send({ reason: 'Please reconsider the fictional proof in this test.' });
    expect(appeal.status).toBe(200);
    const appealReject = await request(app).post(`/api/v1/admin/economy/appeals/${appeal.body.data.id}/reject`)
      .set('Authorization', bearer(independentAdminId, 'admin'))
      .send({ reason: 'Independent fictional reviewer confirms the denial.' });
    expect(appealReject.status).toBe(200);
    const read = await request(app).get(`/api/v1/economy/reservations/${reservationId}`).set('Authorization', other);
    expect(read.status).toBe(200);
    expect(read.body.data).toMatchObject({ status: 'released', release_reason: 'appeal_rejected' });
    const me = await request(app).get('/api/v1/economy/me').set('Authorization', other);
    expect(me.body.data.balance_minor).toBe('0');
  });

  it('returns unavailable without the durable pool', async () => {
    setPool(null);
    try {
      const result = await request(app).get('/api/v1/economy/me').set('Authorization', bearer(travelerId, 'user'));
      expect([503, 401]).toContain(result.status);
      if (result.status === 503) expect(result.body.data).toBeUndefined();
    } finally { setPool(fixture.pool); }
  });

  it('keeps fictional proof in the synthetic moderation scope', async () => {
    const syntheticUser = `lab-synthetic-user-${randomUUID().slice(0, 12)}`;
    const syntheticQuest = `lab-synthetic-quest-${randomUUID().slice(0, 12)}`;
    await fixture.pool.query(
      `INSERT INTO users(id, seed_id, display_name, email, role, is_test)
       VALUES ($1,$2,'Fictional Traveler',$3,'user',true)`,
      [syntheticUser, syntheticUser, `${syntheticUser}@example.invalid`]
    );
    await fixture.pool.query(
      `INSERT INTO quests(id,title,description,category,location_name,gps_lat,gps_lng,
        radius_meters,reward_points,marker_code,marker_image_url,status,is_active,author_id,is_test)
       VALUES ($1,'Fictional Quest','Scope test','eco','Fictional venue',16,120,
        100,0,'SYNTHETIC','https://example.invalid/marker.png','published',true,$2,true)`, [syntheticQuest, authorId]
    );
    await db.hydrateFromPg(fixture.pool);
    const token = bearer(syntheticUser, 'user');
    const challenge = await request(app).post(`/api/v1/quests/${syntheticQuest}/challenge`).set('Authorization', token);
    expect(challenge.status).toBe(200);
    const submission = await request(app).post('/api/v1/submissions').set('Authorization', token).send({
      idempotency_key: randomUUID(), quest_id: syntheticQuest,
      challenge_token: challenge.body.data.challenge_token,
      captured_lat: 16, captured_lng: 120, captured_accuracy: 8,
    });
    expect(submission.status).toBe(201);
    expect(submission.body.data.is_test).toBe(true);
    const durable = await fixture.pool.query('SELECT is_test FROM submissions WHERE id = $1', [submission.body.data.id]);
    expect(durable.rows[0].is_test).toBe(true);
  });

  it('conceals all pilot paths before authentication outside development', async () => {
    const previous = process.env.JDQ_ENV;
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.JDQ_ENV = 'dev'; // Accidental dev flag must not override production.
    process.env.NODE_ENV = 'production';
    try {
      for (const path of ['/api/v1/economy/me', '/api/v1/economy/capabilities',
        '/api/v1/admin/economy/queue', '/api/v1/admin/economy/reconciliation',
        `/api/v1/economy/quests/${questId}/reward`]) {
        const result = await request(app).get(path);
        expect(result.status).toBe(404);
      }
      const ordinaryWallet = await request(app).get('/api/v1/wallet')
        .set('Authorization', bearer(travelerId, 'user'));
      expect(ordinaryWallet.status).toBe(200);
      expect(ordinaryWallet.body.data.explorer_coin_balance).toBeUndefined();
      const purchase = await request(app).post(`/api/v1/wallet/cosmetics/${cosmeticId}/purchase`)
        .set('Authorization', bearer(travelerId, 'user')).set('x-idempotency-key', randomUUID()).send({});
      expect(purchase.status).toBe(404);
    } finally {
      if (previous === undefined) delete process.env.JDQ_ENV;
      else process.env.JDQ_ENV = previous;
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
    }
  });
});
