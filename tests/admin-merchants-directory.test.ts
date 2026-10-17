import request from 'supertest';
import jwt from 'jsonwebtoken';
import { app } from '../src/app.js';
import { db } from '../src/db/index.js';
import { env } from '../src/config/env.js';

const ADMIN_ID = '22222222-2222-2222-2222-222222222222';
const OWNER_ID = 'merchant-owner-admin-1'; // plain id, express route reads it

const adminToken = jwt.sign({ id: ADMIN_ID, seed_id: 'admin-1', role: 'admin' }, env.JWT_SECRET);
const ownerToken = jwt.sign({ id: OWNER_ID, seed_id: 'merchant-owner-seed', role: 'user' }, env.JWT_SECRET);

const MERCHANT_ID = 'merchant-admin-directory-1';

describe('Admin merchant directory (read-only inspection)', () => {
  beforeAll(async () => {
    const now = new Date().toISOString();

    db.users.push({
      id: OWNER_ID,
      seed_id: 'merchant-owner-seed',
      display_name: 'Alaminos Island Sweets Owner',
      email: 'owner@alaminos.ph',
      avatar_url: '',
      role: 'user',
      demo_points: 0,
      mjdq_balance: 0,
      jdq_governance_balance: 0,
      scout_reputation: 100,
      is_public: false,
      created_at: now,
      updated_at: now,
    });

    const application = await db.createAffiliateApplication({
      user_id: OWNER_ID,
      business_name: 'Alaminos Island Sweets',
      category: 'pasalubong',
      municipality: 'Alaminos City',
      business_province: 'Pangasinan',
      contact_name: 'Owner',
      contact_email: 'owner@alaminos.ph',
      contact_phone: '+63 900 000 0000',
      sponsorship_goals: ['quest_sponsorship'],
      proposal_details: 'Test application for the admin directory.',
    });

    db.merchants.push({
      id: MERCHANT_ID,
      name: 'Alaminos Island Sweets',
      location: 'Alaminos City, Pangasinan',
      description: 'Local sweets and pasalubong showcase.',
      status: 'active',
      is_published: true,
      category: 'pasalubong',
      municipality: 'Alaminos City',
      contact_email: 'owner@alaminos.ph',
      contact_phone: '+63 900 000 0000',
      logo_url: null,
      banner_url: null,
      source_application_id: application.id,
      created_at: now,
    });

    db.merchant_memberships.push({
      id: 'membership-admin-directory-1',
      merchant_id: MERCHANT_ID,
      user_id: OWNER_ID,
      role: 'owner',
      status: 'active',
      created_at: now,
      updated_at: now,
    });

    db.merchant_products.push(
      {
        id: 'product-admin-directory-1',
        merchant_id: MERCHANT_ID,
        name: 'Bottled Boneless Bangus',
        description: 'Classic Alaminos pasalubong.',
        price: 250,
        currency: 'PHP',
        image_url: null,
        is_published: true,
        is_archived: false,
        display_order: 0,
        created_at: now,
        updated_at: now,
      },
      {
        id: 'product-admin-directory-archived-1',
        merchant_id: MERCHANT_ID,
        name: 'Retired Sweet Box',
        description: 'Archived product for inspection tests.',
        price: 180,
        currency: 'PHP',
        image_url: null,
        is_published: false,
        is_archived: true,
        display_order: 1,
        created_at: now,
        updated_at: now,
      }
    );
  });

  it('lists merchants with minimized owner information and truthful counts', async () => {
    const response = await request(app)
      .get('/api/v1/admin/merchants')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(response.status).toBe(200);
    const merchant = response.body.data.find((item: { id: string }) => item.id === MERCHANT_ID);
    expect(merchant).toBeTruthy();
    expect(merchant.owner_display_name).toBe('Alaminos Island Sweets Owner');
    expect(merchant.membership_count).toBe(1);
    expect(merchant.active_product_count).toBe(1);
    expect(merchant.archived_product_count).toBe(1);
    expect(JSON.stringify(merchant)).not.toContain('owner@alaminos.ph');
    expect(merchant.source_application_id).toBeTruthy();
  });

  it('returns inspection detail with memberships, products and application linkage', async () => {
    const response = await request(app)
      .get(`/api/v1/admin/merchants/${MERCHANT_ID}`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(response.status).toBe(200);
    const { merchant, memberships, products, application } = response.body.data;
    expect(merchant.name).toBe('Alaminos Island Sweets');
    expect(memberships).toHaveLength(1);
    expect(memberships[0].role).toBe('owner');
    expect(memberships[0].member_display_name).toBe('Alaminos Island Sweets Owner');
    expect(products).toHaveLength(2);
    expect(products.some((product: { is_archived: boolean }) => product.is_archived)).toBe(true);
    expect(application.status).toBeDefined();
    expect(application.business_name).toBe('Alaminos Island Sweets');
    expect(application.business_province).toBe('Pangasinan');
    expect(JSON.stringify(memberships)).not.toContain('merchant-owner-admin-1');
  });

  it('denies non-administrator access and unknown merchants', async () => {
    const denied = await request(app)
      .get('/api/v1/admin/merchants')
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(denied.status).toBe(403);

    const missing = await request(app)
      .get('/api/v1/admin/merchants/does-not-exist')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('MERCHANT_NOT_FOUND');
  });
});
