import request from 'supertest';
import { app, parseCorsOrigin } from '../src/app';

describe('JuanderQuest Backend REST API & QA Rules', () => {
  let userToken: string;
  let adminToken: string;
  const testIdempotencyKey = 'a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d';

  it('supports comma-separated CORS origins for local web development', () => {
    expect(parseCorsOrigin('https://jdq.zernanvash.dev, http://localhost:3000')).toEqual([
      'https://jdq.zernanvash.dev',
      'http://localhost:3000',
    ]);
  });

  it('GET /api/v1/health should return ok', async () => {
    const res = await request(app).get('/api/v1/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  it('discovers and ranks public spots by intent and location', async () => {
    const res = await request(app).get('/api/v1/spots?intent=coffee&lat=16.047&lng=120.34&radius_km=10');
    expect(res.status).toBe(200);
    expect(res.body.data[0].subcategory).toBe('cafe');
    expect(res.body.data[0].recommendation_reasons).toContain('Matches coffee');
    expect(res.body.data.every((spot: any) => spot.distance_km <= 10)).toBe(true);
  });

  it('filters spots by category and optional quest availability', async () => {
    const res = await request(app).get('/api/v1/spots?categories=nature_outdoors&has_quest=true');
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThan(0);
    expect(res.body.data.every((spot: any) => spot.category === 'nature_outdoors' && spot.quest_id)).toBe(true);
  });

  it('rejects a duplicate community spot within 50 meters', async () => {
    const login = await request(app).post('/api/v1/auth/demo-login').send({ seed_id: 'user-1' });
    const res = await request(app).post('/api/v1/spots').set('Authorization', `Bearer ${login.body.data.token}`).send({
      name: 'Hundred Islands Park', description: 'A duplicate test entry close to the known destination pin.',
      category: 'nature_outdoors', subcategory: 'park', municipality: 'Alaminos City', address: 'Lucap',
      gps_lat: 16.20631, gps_lng: 119.97061, tags: [], price_level: 1, hours: {}, amenities: [], image_url: '',
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('DUPLICATE_SPOT');
  });

  it('reports local wallet auth mode during test development', async () => {
    const res = await request(app).get('/api/v1/auth/wallet/config');
    expect(res.status).toBe(200);
    expect(res.body.data.mode).toBe('local');
  });

  it('issues a JWT through the explicit local wallet bypass', async () => {
    const address = 'dev-wallet-42';
    const res = await request(app).post('/api/v1/auth/wallet/local-login').send({ address });
    expect(res.status).toBe(200);
    expect(res.body.data.auth_method).toBe('local_bypass');
    expect(res.body.data.wallet_address).toBe(address);
    expect(res.body.data.token).toBeDefined();
    expect(res.body.data.user.seed_id).toBe(`wallet:${address}`);
  });

  it('does not expose signature challenges while local bypass mode is active', async () => {
    const res = await request(app)
      .post('/api/v1/auth/wallet/challenge')
      .send({ address: '0x0000000000000000000000000000000000000001' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('AUTH_MODE_MISMATCH');
  });

  it('POST /api/v1/auth/demo-login for user-1', async () => {
    const res = await request(app)
      .post('/api/v1/auth/demo-login')
      .send({ seed_id: 'user-1' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.token).toBeDefined();
    expect(res.body.data.user.role).toBe('user');
    userToken = res.body.data.token;
  });

  it('POST /api/v1/auth/demo-login for admin-1', async () => {
    const res = await request(app)
      .post('/api/v1/auth/demo-login')
      .send({ seed_id: 'admin-1' });

    expect(res.status).toBe(200);
    expect(res.body.data.user.role).toBe('admin');
    adminToken = res.body.data.token;
  });

  it('Reject submission with HTTP 422 if GPS distance exceeds radius', async () => {
    const res = await request(app)
      .post('/api/v1/submissions')
      .set('Authorization', `Bearer ${userToken}`)
      .send({
        idempotency_key: 'b2c3d4e5-f6a7-8b9c-0d1e-2f3a4b5c6d7e',
        quest_id: 'q1111111-1111-1111-1111-111111111111',
        scanned_marker_code: 'MARKER_HUNDRED_ISLANDS_01',
        captured_lat: 16.5000, // Very far from 16.2063
        captured_lng: 119.9706,
        captured_accuracy: 5.0,
      });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('OUT_OF_RANGE');
  });

  it('POST /api/v1/submissions succeeds within valid GPS radius', async () => {
    const res = await request(app)
      .post('/api/v1/submissions')
      .set('Authorization', `Bearer ${userToken}`)
      .send({
        idempotency_key: testIdempotencyKey,
        quest_id: 'q1111111-1111-1111-1111-111111111111',
        scanned_marker_code: 'MARKER_HUNDRED_ISLANDS_01',
        captured_lat: 16.20635, // ~5 meters offset
        captured_lng: 119.9706,
        captured_accuracy: 4.5,
      });

    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('pending');
  });

  it('GET /api/v1/admin/submissions lists pending submission', async () => {
    const res = await request(app)
      .get('/api/v1/admin/submissions?status=pending')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThan(0);
  });

  it('PATCH /api/v1/admin/submissions/:id approves submission and awards points', async () => {
    const listRes = await request(app)
      .get('/api/v1/admin/submissions?status=pending')
      .set('Authorization', `Bearer ${adminToken}`);
    const subId = listRes.body.data[0].id;

    const approveRes = await request(app)
      .patch(`/api/v1/admin/submissions/${subId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ action: 'approve' });

    expect(approveRes.status).toBe(200);
    expect(approveRes.body.data.status).toBe('approved');

    const profileRes = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${userToken}`);
    expect(profileRes.body.data.demo_points).toBe(150); // 100 initial + 50
  });

  it('Re-approving an already approved submission does NOT inflate points', async () => {
    const listRes = await request(app)
      .get('/api/v1/admin/submissions?status=approved')
      .set('Authorization', `Bearer ${adminToken}`);
    const subId = listRes.body.data[0].id;

    const reApproveRes = await request(app)
      .patch(`/api/v1/admin/submissions/${subId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ action: 'approve' });

    expect(reApproveRes.status).toBe(200);
    expect(reApproveRes.body.data.awarded_points).toBe(0);

    const profileRes = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${userToken}`);
    expect(profileRes.body.data.demo_points).toBe(150); // Remains 150
  });

  it('Reject duplicate submission attempt for already completed quest with 409 ALREADY_COMPLETED', async () => {
    const res = await request(app)
      .post('/api/v1/submissions')
      .set('Authorization', `Bearer ${userToken}`)
      .send({
        idempotency_key: 'c3d4e5f6-a7b8-9c0d-1e2f-3a4b5c6d7e8f',
        quest_id: 'q1111111-1111-1111-1111-111111111111',
        scanned_marker_code: 'MARKER_HUNDRED_ISLANDS_01',
        captured_lat: 16.2063,
        captured_lng: 119.9706,
        captured_accuracy: 2.0,
      });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ALREADY_COMPLETED');
  });

  it('FORBIDDEN for regular user accessing admin routes', async () => {
    const res = await request(app)
      .get('/api/v1/admin/submissions')
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('GET /api/v1/proposals returns destination proposals', async () => {
    const res = await request(app).get('/api/v1/proposals');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.length).toBeGreaterThan(0);
  });

  it('POST /api/v1/proposals creates new tourism location proposal', async () => {
    const res = await request(app)
      .post('/api/v1/proposals')
      .set('Authorization', `Bearer ${userToken}`)
      .send({
        title: 'Balingasay River Eco Cruise',
        location_name: 'Bolinao, Pangasinan',
        category: 'eco',
        description: 'Explore the cleanest river in Region 1 with mangrove kayaking.',
      });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.title).toBe('Balingasay River Eco Cruise');
  });

  it('GET governance overview and tokenomics exposes reconciled admin controls', async () => {
    const overview = await request(app)
      .get('/api/v1/admin/governance/overview')
      .set('Authorization', `Bearer ${adminToken}`);
    const tokenomics = await request(app)
      .get('/api/v1/admin/tokenomics/analytics')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(overview.status).toBe(200);
    expect(overview.body.data.screening_backlog).toBeGreaterThan(0);
    expect(overview.body.data.configuration.burn_bps).toBe(2000);
    expect(tokenomics.status).toBe(200);
    expect(tokenomics.body.data.reconciliation_difference_mjdq).toBe(0);
  });

  it('admin screening locks the 25 JDQ organizer bond with an audit trail', async () => {
    const res = await request(app)
      .post('/api/v1/admin/governance/proposals/prop_1/screen')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        decision: 'approve',
        reason: 'Identity, safety, location, budget, recipients, and consent checks completed.',
        evidence_reference: 'SCREEN-2026-001',
        checklist_complete: true,
      });

    expect(res.status).toBe(200);
    expect(res.body.data.state).toBe('voting');
    expect(res.body.data.bond_status).toBe('locked');
    expect(res.body.data.organizer_bond_mjdq).toBe(25000);
  });

  it('paid proposal vote burns 20%, escrows 80%, and is idempotent', async () => {
    const voteBody = {
      choice: 'yes',
      idempotency_key: 'governance-vote-user-1-prop-1',
    };
    const first = await request(app)
      .post('/api/v1/proposals/prop_1/votes')
      .set('Authorization', `Bearer ${userToken}`)
      .send(voteBody);
    const repeat = await request(app)
      .post('/api/v1/proposals/prop_1/votes')
      .set('Authorization', `Bearer ${userToken}`)
      .send(voteBody);

    expect(first.status).toBe(200);
    expect(first.body.data.charged_mjdq).toBe(5000);
    expect(first.body.data.burned_mjdq).toBe(1000);
    expect(first.body.data.escrowed_mjdq).toBe(4000);
    expect(repeat.status).toBe(200);
    expect(repeat.body.data.proposal.votes).toBe(1);

    const analytics = await request(app)
      .get('/api/v1/admin/tokenomics/analytics')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(analytics.body.data.reconciliation_difference_mjdq).toBe(0);
  });

  it('blocks a second paid vote by the same eligible user', async () => {
    const res = await request(app)
      .post('/api/v1/proposals/prop_1/votes')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ choice: 'no', idempotency_key: 'governance-vote-user-1-prop-1-second' });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ALREADY_VOTED');
  });

  it('requires admin role for tokenomics analytics', async () => {
    const res = await request(app)
      .get('/api/v1/admin/tokenomics/analytics')
      .set('Authorization', `Bearer ${userToken}`);
    expect(res.status).toBe(403);
  });

  it('GET /quests does not leak marker_code in the list', async () => {
    const res = await request(app).get('/api/v1/quests');
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThan(0);
    for (const quest of res.body.data) {
      expect(quest.marker_code).toBeUndefined();
    }
  });

  it('GET /quests/:id keeps marker_code for the simulated AR flow', async () => {
    const res = await request(app).get('/api/v1/quests/q1111111-1111-1111-1111-111111111111');
    expect(res.status).toBe(200);
    expect(res.body.data.marker_code).toBe('MARKER_HUNDRED_ISLANDS_01');
  });

  it('admin submission listing includes quest_radius_meters', async () => {
    const res = await request(app)
      .get('/api/v1/admin/submissions')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThan(0);
    for (const submission of res.body.data) {
      expect(typeof submission.quest_radius_meters).toBe('number');
    }
  });

  it('reject-after-approve returns 409 STATE_CONFLICT (no silent success)', async () => {
    const listRes = await request(app)
      .get('/api/v1/admin/submissions?status=approved')
      .set('Authorization', `Bearer ${adminToken}`);
    const subId = listRes.body.data[0].id;

    const res = await request(app)
      .patch(`/api/v1/admin/submissions/${subId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ action: 'reject', rejection_reason: 'Late attempt to override.' });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('STATE_CONFLICT');
  });

  it('GET /vouchers lists seeded merchant vouchers', async () => {
    const res = await request(app).get('/api/v1/vouchers');
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThanOrEqual(3);
    expect(res.body.data[0]).toHaveProperty('merchant_name');
  });

  it('voucher redemption deducts points, replays idempotently, and blocks repeat with a new key', async () => {
    const before = await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${userToken}`);
    const pointsBefore = before.body.data.demo_points;

    const first = await request(app)
      .post('/api/v1/vouchers/v1/redeem')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ idempotency_key: 'voucher-redeem-key-1' });

    expect(first.status).toBe(201);
    expect(first.body.data.code).toMatch(/^JDQ-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(first.body.data.cost_points).toBe(100);

    const afterFirst = await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${userToken}`);
    expect(afterFirst.body.data.demo_points).toBe(pointsBefore - 100);

    const replay = await request(app)
      .post('/api/v1/vouchers/v1/redeem')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ idempotency_key: 'voucher-redeem-key-1' });

    expect(replay.status).toBe(200);
    expect(replay.body.data.code).toBe(first.body.data.code);

    const afterReplay = await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${userToken}`);
    expect(afterReplay.body.data.demo_points).toBe(pointsBefore - 100);

    const repeat = await request(app)
      .post('/api/v1/vouchers/v1/redeem')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ idempotency_key: 'voucher-redeem-key-2' });

    expect(repeat.status).toBe(409);
    expect(repeat.body.error.code).toBe('ALREADY_REDEEMED');
  });

  it('voucher redemption rejects with 409 INSUFFICIENT_POINTS when points run out', async () => {
    const res = await request(app)
      .post('/api/v1/vouchers/v2/redeem')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ idempotency_key: 'voucher-redeem-user-1-poor' });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INSUFFICIENT_POINTS');
  });

  it('unknown API route returns JSON 404', async () => {
    const res = await request(app).get('/api/v1/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('malformed JSON body returns 400 INVALID_JSON', async () => {
    const res = await request(app)
      .post('/api/v1/auth/demo-login')
      .set('Content-Type', 'application/json')
      .send('{"seed_id": broken');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_JSON');
  });
});
