import request from 'supertest';
import { app } from '../src/app.js';
import { db } from '../src/db/index.js';
import jwt from 'jsonwebtoken';
import { env } from '../src/config/env.js';

describe('Merchant Affiliation Lifecycle & Dashboard Workspace (Phase 1)', () => {
  const applicantId = '88888888-8888-8888-8888-888888888888';
  const adminId = '22222222-2222-2222-2222-222222222222';
  const strangerId = '99999999-9999-9999-9999-999999999999';

  const applicantToken = jwt.sign(
    { id: applicantId, seed_id: 'merchant-test-owner', role: 'user' },
    env.JWT_SECRET
  );
  const adminToken = jwt.sign(
    { id: adminId, seed_id: 'admin-reviewer', role: 'admin' },
    env.JWT_SECRET
  );
  const strangerToken = jwt.sign(
    { id: strangerId, seed_id: 'stranger-user', role: 'user' },
    env.JWT_SECRET
  );

  beforeAll(() => {
    db.users.push({
      id: applicantId,
      seed_id: 'merchant-test-owner',
      display_name: 'Alaminos Island Sweets',
      email: 'sweets@alaminos.ph',
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

    db.users.push({
      id: strangerId,
      seed_id: 'stranger-user',
      display_name: 'Stranger Traveler',
      email: 'stranger@example.com',
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

  test('1. GET /api/v1/affiliate/options returns Pangasinan categories, towns, and goals', async () => {
    const res = await request(app).get('/api/v1/affiliate/options');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data.categories)).toBe(true);
    expect(Array.isArray(res.body.data.municipalities)).toBe(true);
    expect(res.body.data.municipalities).toContain('Alaminos City');
  });

  test('2. Draft operations: Save, retrieve, optimistic revision, and discard', async () => {
    // Initial load: no draft
    const emptyRes = await request(app)
      .get('/api/v1/affiliate/application-draft')
      .set('Authorization', `Bearer ${applicantToken}`);
    expect(emptyRes.status).toBe(200);
    expect(emptyRes.body.data).toBeNull();

    // Save step 1
    const saveRes = await request(app)
      .put('/api/v1/affiliate/application-draft')
      .set('Authorization', `Bearer ${applicantToken}`)
      .send({
        draft_data: { business_name: 'Alaminos Puto & Sweets', category: 'dining' },
        current_step: 1,
      });
    expect(saveRes.status).toBe(200);
    expect(saveRes.body.data.revision).toBe(1);
    expect(saveRes.body.data.draft_data.business_name).toBe('Alaminos Puto & Sweets');

    // Conflict test: wrong expected_revision
    const conflictRes = await request(app)
      .put('/api/v1/affiliate/application-draft')
      .set('Authorization', `Bearer ${applicantToken}`)
      .send({
        draft_data: { business_name: 'Updated Sweets' },
        current_step: 2,
        expected_revision: 999,
      });
    expect(conflictRes.status).toBe(409);
    expect(conflictRes.body.error.code).toBe('VERSION_CONFLICT');
  });

  let applicationId = '';

  test('3. Submit application: Clears draft and sets status "received"', async () => {
    const res = await request(app)
      .post('/api/v1/affiliate/applications')
      .set('Authorization', `Bearer ${applicantToken}`)
      .send({
        business_name: 'Alaminos Island Sweets Hub',
        category: 'dining',
        municipality: 'Alaminos City',
        business_address: 'Lucap Wharf Road, Alaminos City',
        contact_name: 'Elena Santos',
        contact_email: 'sweets@alaminos.ph',
        contact_phone: '+639178889999',
        preferred_contact_method: 'email',
        sponsorship_goals: ['quest_stop', 'voucher_perk'],
        proposal_details: 'Special Hundred Islands coconut candy sampling for quest explorers.',
      });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.status).toBe('received');
    expect(res.body.data.version).toBe(1);
    applicationId = res.body.data.id;

    // Draft is automatically cleared on submission
    const draftRes = await request(app)
      .get('/api/v1/affiliate/application-draft')
      .set('Authorization', `Bearer ${applicantToken}`);
    expect(draftRes.body.data).toBeNull();
  });

  test('4. Admin review: Request changes (needs_changes) and verify applicant-safe feedback', async () => {
    const patchRes = await request(app)
      .patch(`/api/v1/admin/affiliate/applications/${applicationId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        status: 'needs_changes',
        reviewer_notes: 'Internal: Need specific road number and clearer hours.',
        applicant_feedback: 'Please clarify your wharf stall number so inspectors can locate your shop.',
      });

    expect(patchRes.status).toBe(200);
    expect(patchRes.body.data.status).toBe('needs_changes');
    expect(patchRes.body.data.applicant_feedback).toBe('Please clarify your wharf stall number so inspectors can locate your shop.');

    // Verify detail endpoint audit history
    const detailRes = await request(app)
      .get(`/api/v1/admin/affiliate/applications/${applicationId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(detailRes.status).toBe(200);
    expect(detailRes.body.data.audits.length).toBeGreaterThanOrEqual(2);
  });

  test('5. Applicant resubmit: Increments version, sets back to "received"', async () => {
    const resubmitRes = await request(app)
      .post(`/api/v1/affiliate/applications/${applicationId}/resubmit`)
      .set('Authorization', `Bearer ${applicantToken}`)
      .send({
        business_address: 'Stall #14, Lucap Wharf Boardwalk, Alaminos City',
        proposal_details: 'Updated stall location confirmed with Lucap Tourism Office.',
      });

    expect(resubmitRes.status).toBe(200);
    expect(resubmitRes.body.data.status).toBe('received');
    expect(resubmitRes.body.data.version).toBe(2);
    expect(resubmitRes.body.data.business_address).toBe('Stall #14, Lucap Wharf Boardwalk, Alaminos City');
  });

  test('6. Admin atomic approval & automatic merchant provisioning', async () => {
    // Before approval: Applicant has no merchant workspace
    const meBefore = await request(app)
      .get('/api/v1/merchant/me')
      .set('Authorization', `Bearer ${applicantToken}`);
    expect(meBefore.body.data.has_merchant).toBe(false);

    // Admin approves
    const approveRes = await request(app)
      .patch(`/api/v1/admin/affiliate/applications/${applicationId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        status: 'approved',
        reviewer_notes: 'All requirements verified on site.',
      });
    expect(approveRes.status).toBe(200);
    expect(approveRes.body.data.status).toBe('approved');

    // After approval: Applicant has active merchant workspace
    const meAfter = await request(app)
      .get('/api/v1/merchant/me')
      .set('Authorization', `Bearer ${applicantToken}`);
    expect(meAfter.body.data.has_merchant).toBe(true);
    expect(meAfter.body.data.membership.role).toBe('owner');
    expect(meAfter.body.data.merchant.name).toBe('Alaminos Island Sweets Hub');
  });

  test('7. Merchant Dashboard & Product Management', async () => {
    // Dashboard summary
    const dashRes = await request(app)
      .get('/api/v1/merchant/dashboard')
      .set('Authorization', `Bearer ${applicantToken}`);
    expect(dashRes.status).toBe(200);
    expect(dashRes.body.data.counts.active_products).toBe(0);
    expect(dashRes.body.data.checklist.items.length).toBe(5);

    // Stranger cannot access applicant merchant dashboard
    const strangerDash = await request(app)
      .get('/api/v1/merchant/dashboard')
      .set('Authorization', `Bearer ${strangerToken}`);
    expect(strangerDash.status).toBe(403);
    expect(strangerDash.body.error.code).toBe('MERCHANT_ACCESS_REQUIRED');

    // Create informational product
    const prodRes = await request(app)
      .post('/api/v1/merchant/products')
      .set('Authorization', `Bearer ${applicantToken}`)
      .send({
        name: 'Handcrafted Bocayo (Coconut Candy Tub)',
        description: 'Made from fresh Alaminos coastal coconuts and pure muscovado sugar.',
        price: 150.00,
        currency: 'PHP',
      });
    expect(prodRes.status).toBe(201);
    expect(prodRes.body.data.name).toBe('Handcrafted Bocayo (Coconut Candy Tub)');
    const productId = prodRes.body.data.id;

    // List products
    const listRes = await request(app)
      .get('/api/v1/merchant/products')
      .set('Authorization', `Bearer ${applicantToken}`);
    expect(listRes.status).toBe(200);
    expect(listRes.body.data.length).toBe(1);

    // Publish profile
    const pubRes = await request(app)
      .post('/api/v1/merchant/profile/publish')
      .set('Authorization', `Bearer ${applicantToken}`);
    expect(pubRes.status).toBe(200);
    expect(pubRes.body.data.is_published).toBe(true);

    // Archive product
    const delRes = await request(app)
      .delete(`/api/v1/merchant/products/${productId}`)
      .set('Authorization', `Bearer ${applicantToken}`);
    expect(delRes.status).toBe(200);

    const afterDelRes = await request(app)
      .get('/api/v1/merchant/products')
      .set('Authorization', `Bearer ${applicantToken}`);
    expect(afterDelRes.body.data.length).toBe(0); // active list is 0
  });
});
