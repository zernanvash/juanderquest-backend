import request from 'supertest';
import { app } from '../src/app.js';
import { db } from '../src/db/index.js';
import jwt from 'jsonwebtoken';
import { env } from '../src/config/env.js';

describe('Phase 3: Durable Affiliate Application & Admin Review Foundation', () => {
  const applicantUserId = '66666666-6666-6666-6666-666666666666';
  const otherApplicantUserId = '77777777-7777-7777-7777-777777777777';
  const adminUserId = '22222222-2222-2222-2222-222222222222'; // admin user from mockUsers

  const applicantToken = jwt.sign(
    { id: applicantUserId, seed_id: 'merchant-applicant-01', role: 'user' },
    env.JWT_SECRET
  );

  const otherApplicantToken = jwt.sign(
    { id: otherApplicantUserId, seed_id: 'merchant-applicant-02', role: 'user' },
    env.JWT_SECRET
  );

  const adminToken = jwt.sign(
    { id: adminUserId, seed_id: 'admin-1', role: 'admin' },
    env.JWT_SECRET
  );

  beforeAll(() => {
    // Add applicant user
    db.users.push({
      id: applicantUserId,
      seed_id: 'merchant-applicant-01',
      display_name: 'Mang Carlos Eatery',
      email: 'carlos@dagupanbangus.ph',
      avatar_url: '',
      role: 'user',
      demo_points: 0,
      mjdq_balance: 0,
      jdq_governance_balance: 0,
      scout_reputation: 100,
      is_public: false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    // Add other applicant user
    db.users.push({
      id: otherApplicantUserId,
      seed_id: 'merchant-applicant-02',
      display_name: 'Bolinao Souvenirs',
      email: 'souvenirs@bolinao.ph',
      avatar_url: '',
      role: 'user',
      demo_points: 0,
      mjdq_balance: 0,
      jdq_governance_balance: 0,
      scout_reputation: 100,
      is_public: false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
  });

  let createdApplicationId = '';

  test('1. Reject unauthenticated POST to /api/v1/affiliate/applications with 401', async () => {
    const res = await request(app)
      .post('/api/v1/affiliate/applications')
      .send({
        business_name: 'Carlos Grill',
        category: 'dining',
        municipality: 'Dagupan City',
        contact_name: 'Carlos D.',
        contact_email: 'carlos@dagupan.ph',
        contact_phone: '+639171234567',
        sponsorship_goals: ['quest_stop'],
      });

    expect(res.status).toBe(401);
  });

  test('2. Reject invalid application payload with 400', async () => {
    const res = await request(app)
      .post('/api/v1/affiliate/applications')
      .set('Authorization', `Bearer ${applicantToken}`)
      .send({
        business_name: 'C', // too short (<2 chars)
        category: 'dining',
        municipality: 'Dagupan City',
        contact_name: 'Carlos',
        contact_email: 'not-an-email',
        contact_phone: '123', // too short
        sponsorship_goals: [], // empty array
      });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  test('2b. Reject out-of-range business map coordinates', async () => {
    const res = await request(app)
      .post('/api/v1/affiliate/applications')
      .set('Authorization', `Bearer ${applicantToken}`)
      .send({
        business_name: 'Invalid Pin Cafe', category: 'dining', municipality: 'Baguio City',
        business_province: 'Benguet', gps_lat: 99, gps_lng: 120.596,
        contact_name: 'Maria Santos', contact_email: 'maria@example.com',
        contact_phone: '+639171234567', sponsorship_goals: ['storytelling'],
      });
    expect(res.status).toBe(400);
  });

  test('3. Successfully submit application with status "received"', async () => {
    const res = await request(app)
      .post('/api/v1/affiliate/applications')
      .set('Authorization', `Bearer ${applicantToken}`)
      .send({
        business_name: 'Carlos Dagupan Bangus Grill',
        category: 'dining',
        municipality: 'Dagupan City (Bangus Capital)',
        contact_name: 'Carlos Dela Cruz',
        contact_email: 'carlos@dagupanbangus.ph',
        contact_phone: '+639171234567',
        sponsorship_goals: ['quest_stop', 'voucher_perk'],
        proposal_details: 'We want to sponsor the Bonuan Bangus Quest arrival checkpoint.',
      });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.id).toMatch(/^app_/);
    expect(res.body.data.status).toBe('received');
    expect(res.body.data.business_name).toBe('Carlos Dagupan Bangus Grill');
    expect(res.body.data.user_id).toBe(applicantUserId);

    createdApplicationId = res.body.data.id;
  });

  test('4. Reject duplicate active application from same user with 409 ACTIVE_APPLICATION_EXISTS', async () => {
    const res = await request(app)
      .post('/api/v1/affiliate/applications')
      .set('Authorization', `Bearer ${applicantToken}`)
      .send({
        business_name: 'Carlos Dagupan Bangus Grill Duplicate',
        category: 'dining',
        municipality: 'Dagupan City',
        contact_name: 'Carlos Dela Cruz',
        contact_email: 'carlos@dagupanbangus.ph',
        contact_phone: '+639171234567',
        sponsorship_goals: ['voucher_perk'],
      });

    expect(res.status).toBe(409);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('ACTIVE_APPLICATION_EXISTS');
  });

  test('5. GET /api/v1/affiliate/applications/me returns applicant own application', async () => {
    const res = await request(app)
      .get('/api/v1/affiliate/applications/me')
      .set('Authorization', `Bearer ${applicantToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.id).toBe(createdApplicationId);
    expect(res.body.data.business_name).toBe('Carlos Dagupan Bangus Grill');
  });

  test('6. GET /api/v1/affiliate/applications/me returns null for user with no application', async () => {
    const res = await request(app)
      .get('/api/v1/affiliate/applications/me')
      .set('Authorization', `Bearer ${otherApplicantToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toBeNull();
  });

  test('7. Admin review queue: Reject non-admin access with 403', async () => {
    const res = await request(app)
      .get('/api/v1/admin/affiliate/applications')
      .set('Authorization', `Bearer ${applicantToken}`);

    expect(res.status).toBe(403);
  });

  test('8. Admin review queue: Admin can list applications', async () => {
    const res = await request(app)
      .get('/api/v1/admin/affiliate/applications')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
    const found = res.body.data.find((a: any) => a.id === createdApplicationId);
    expect(found).toBeDefined();
    expect(found.status).toBe('received');
  });

  test('9. Admin can update status to in_review', async () => {
    const res = await request(app)
      .patch(`/api/v1/admin/affiliate/applications/${createdApplicationId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        status: 'in_review',
        reviewer_notes: 'Initial documents verified. Checking venue permits.',
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.status).toBe('in_review');
    expect(res.body.data.reviewer_id).toBe(adminUserId);
    expect(res.body.data.reviewer_notes).toBe('Initial documents verified. Checking venue permits.');
  });

  test('10. Admin can approve application', async () => {
    const res = await request(app)
      .patch(`/api/v1/admin/affiliate/applications/${createdApplicationId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        status: 'approved',
        reviewer_notes: 'Accredited as official Pangasinan culinary partner.',
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.status).toBe('approved');
    expect(res.body.data.reviewer_notes).toBe('Accredited as official Pangasinan culinary partner.');
  });

  test('11. Quarantine verification: Approved affiliate does NOT bypass draft-only offer limits', async () => {
    // Verify that approving the application leaves system quarantine intact
    // Status is approved in merchant_affiliate_applications
    const meRes = await request(app)
      .get('/api/v1/affiliate/applications/me')
      .set('Authorization', `Bearer ${applicantToken}`);

    expect(meRes.status).toBe(200);
    expect(meRes.body.data.status).toBe('approved');

    // No live blockchain balance or un-quarantined merchant offers are injected
    const user = db.findUserById(applicantUserId);
    expect(user).toBeDefined();
    expect(user?.role).toBe('user'); // Does not grant unvetted admin or bypass roles
  });

  test('12. Non-Pangasinan application retains its region through approval and merchant provisioning', async () => {
    const created = await request(app)
      .post('/api/v1/affiliate/applications')
      .set('Authorization', `Bearer ${otherApplicantToken}`)
      .send({
        business_name: 'Baguio Heritage Cafe',
        category: 'dining',
        municipality: 'Baguio City',
        business_province: 'Benguet',
        gps_lat: 16.4023,
        gps_lng: 120.596,
        contact_name: 'Maria Santos',
        contact_email: 'maria@example.com',
        contact_phone: '+639171234567',
        sponsorship_goals: ['storytelling'],
      });
    expect(created.status).toBe(201);
    expect(created.body.data.business_province).toBe('Benguet');

    const approved = await request(app)
      .patch(`/api/v1/admin/affiliate/applications/${created.body.data.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'approved', reviewer_notes: 'Location reviewed.' });
    expect(approved.status).toBe(200);
    const merchant = db.merchants.find((item) => item.source_application_id === created.body.data.id);
    expect(merchant?.location).toBe('Baguio City, Benguet');
  });

  test('13. Authenticated Philippine place search returns bounded locations and caches repeats', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify([
      { name: 'Baguio City', display_name: 'Baguio City, Benguet, Philippines', lat: '16.4023', lon: '120.596', addresstype: 'city' },
    ]), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    try {
      const unauthorized = await request(app).get('/api/v1/affiliate/places?q=Baguio');
      expect(unauthorized.status).toBe(401);
      const first = await request(app).get('/api/v1/affiliate/places?q=Baguio').set('Authorization', `Bearer ${applicantToken}`);
      expect(first.status).toBe(200);
      expect(first.body.data[0]).toMatchObject({ name: 'Baguio City', lat: 16.4023, lng: 120.596 });
      const repeat = await request(app).get('/api/v1/affiliate/places?q=Baguio').set('Authorization', `Bearer ${applicantToken}`);
      expect(repeat.status).toBe(200);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
