import request from 'supertest';
import jwt from 'jsonwebtoken';
import { app } from '../src/app.js';
import { db } from '../src/db/index.js';
import { createTestDb, type TestDbInstance } from '../src/db/testHarness.js';
import { setPool } from '../src/db/pool.js';
import { env } from '../src/config/env.js';
import { spotStore } from '../src/spots/store.js';

// Plan 59 phase 3: quizzes (quests_quizzes) and merchants, applications and vouchers (merchants_vouchers).
const realPgDescribe = process.env.JDQ_REAL_PG_URL ? describe : describe.skip;

realPgDescribe('Plan 59 phase 3 area administrator scope (real PostgreSQL)', () => {
  let fixture: TestDbInstance;
  const developerId = 'p3-developer';
  const areaUserId = 'p3-area-admin';
  const developerToken = jwt.sign({ id: developerId, seed_id: 'p3-developer-seed', role: 'admin' }, env.JWT_SECRET);
  const areaToken = jwt.sign({ id: areaUserId, seed_id: 'p3-area-seed', role: 'area_admin' }, env.JWT_SECRET);
  const inside = { spot: 'spot-p3-dagupan', merchant: 'm-p3-dagupan', voucher: 'v-p3-dagupan', application: 'app-p3-dagupan' };
  const outside = { spot: 'spot-p3-launion', merchant: 'm-p3-launion', voucher: 'v-p3-launion', application: 'app-p3-launion' };
  const quizIds: Record<string, string> = {};

  const quizPayload = (destinationId: string, title: string) => ({
    destination_id: destinationId,
    title,
    description: 'A short cultural quiz for the area admin scope test.',
    questions: [1, 2, 3, 4, 5].map((ordinal) => ({
      ordinal,
      question_text: `Question number ${ordinal}?`,
      explanation: 'Because the test says so.',
      options: [1, 2, 3, 4].map((option) => ({ ordinal: option, option_text: `Option ${option}`, is_correct: option === 1 })),
    })),
  });

  beforeAll(async () => {
    fixture = await createTestDb();
    setPool(fixture.pool);
    const q = (sql: string, values: unknown[] = []) => fixture.pool.query(sql, values);
    await q(`INSERT INTO users(id,seed_id,display_name,email,role,admin_scope) VALUES
      ($1,'p3-developer-seed','P3 Developer','p3-dev@test.local','admin','developer'),
      ($2,'p3-area-seed','P3 Area Admin','p3-area@test.local','area_admin',NULL),
      ('p3-applicant-a','p3-applicant-a-seed','Applicant A','p3-a@test.local','user',NULL),
      ('p3-applicant-b','p3-applicant-b-seed','Applicant B','p3-b@test.local','user',NULL)`, [developerId, areaUserId]);
    const addArea = (id: string, level: string, name: string, parent: string | null) =>
      q(`INSERT INTO admin_areas(id,level,name,display_name,parent_id,has_boundary,label_lat,label_lng,bbox,min_zoom)
         VALUES ($1,$2,$3,$3,$4,TRUE,16,120,$5,5) ON CONFLICT (id) DO NOTHING`, [id, level, name, parent, [119, 15, 121, 17]]);
    await addArea('p3-pangasinan', 'province', 'Pangasinan', null);
    await addArea('p3-dagupan', 'town', 'Dagupan City', 'p3-pangasinan');
    await addArea('p3-la-union', 'province', 'La Union', null);
    await addArea('p3-san-fernando', 'town', 'San Fernando', 'p3-la-union');
    await q(`INSERT INTO admin_area_assignments(id,user_id,area_id,powers,granted_by)
             VALUES ('p3-grant',$1,'p3-pangasinan',ARRAY['quests_quizzes','merchants_vouchers']::text[],$2)`, [areaUserId, developerId]);

    for (const [id, town, municipality] of [[inside.spot, 'p3-dagupan', 'Dagupan City'], [outside.spot, 'p3-san-fernando', 'San Fernando']]) {
      await q(`INSERT INTO spots(id,slug,name,description,category,subcategory,municipality,address,gps_lat,gps_lng,price_level,source_type,source_name,trust_level,status,town_area_id)
               VALUES ($1,$2,$3,'Area scope test spot','culture_heritage','heritage_site',$4,'',16,120,1,'lgu','test','lgu_verified','published',$5)`, [id, id, id, municipality, town]);
      spotStore.spots.push({ id, slug: id, name: id, description: '', category: 'culture_heritage', subcategory: 'heritage_site', tags: [], municipality, address: '', gps_lat: 16, gps_lng: 120, price_level: 1, hours: {}, amenities: [], image_url: '', source_type: 'lgu', source_name: 'test', trust_level: 'lgu_verified', status: 'published', town_area_id: town, created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
    }
    for (const [id, town] of [[inside.merchant, 'p3-dagupan'], [outside.merchant, 'p3-san-fernando'], ['m-p3-unassigned', null]]) {
      await q('INSERT INTO merchants(id,name,location,description,town_area_id) VALUES ($1,$2,$3,$4,$5)', [id, id, 'Test location', 'Area scope test merchant', town]);
    }
    for (const [id, merchant] of [[inside.voucher, inside.merchant], [outside.voucher, outside.merchant]]) {
      await q('INSERT INTO vouchers(id,merchant_id,title,description,cost_points,is_active) VALUES ($1,$2,$3,$4,100,TRUE)', [id, merchant, id, 'Area scope test voucher']);
    }
    for (const [id, user, municipality, province] of [
      [inside.application, 'p3-applicant-a', 'Dagupan City', 'Pangasinan'],
      [outside.application, 'p3-applicant-b', 'San Fernando', 'La Union'],
    ]) {
      await q(`INSERT INTO merchant_affiliate_applications(id,user_id,business_name,category,municipality,contact_name,contact_email,contact_phone,business_province)
               VALUES ($1,$2,$3,'food',$4,'Contact','contact@test.local','09170000000',$5)`, [id, user, id, municipality, province]);
    }
    await db.hydrateFromPg(fixture.pool);

    for (const spotId of [inside.spot, outside.spot]) {
      const created = await request(app).post('/api/v1/admin/quizzes').set('Authorization', `Bearer ${developerToken}`).send(quizPayload(spotId, `Quiz for ${spotId}`));
      expect(created.status).toBe(201);
      quizIds[spotId] = created.body.data.quiz.id;
    }
  });

  afterAll(async () => {
    spotStore.spots = spotStore.spots.filter((spot) => ![inside.spot, outside.spot].includes(spot.id));
    setPool(null);
    db.usersRepo.setPool(null);
    if (fixture) await fixture.close();
  });

  const asArea = (method: 'get' | 'post' | 'patch', path: string) => request(app)[method](`/api/v1${path}`).set('Authorization', `Bearer ${areaToken}`);
  const auditActions = async () => (await fixture.pool.query('SELECT action FROM admin_audit_log ORDER BY created_at')).rows.map((row) => row.action);

  it('limits quizzes to destinations in the area and audits quiz writes', async () => {
    const list = await asArea('get', '/admin/quizzes');
    expect(list.status).toBe(200);
    const listed = list.body.data.map((item: { quiz: { id: string } }) => item.quiz.id);
    expect(listed).toContain(quizIds[inside.spot]);
    expect(listed).not.toContain(quizIds[outside.spot]);
    expect((await asArea('get', `/admin/quizzes/${quizIds[outside.spot]}`)).status).toBe(404);
    expect((await asArea('get', `/admin/quizzes/${quizIds[inside.spot]}`)).status).toBe(200);
    // The quiz editor's destination picker: quests_quizzes alone lists the area's destinations (read-only).
    const spots = await asArea('get', '/admin/spots');
    expect(spots.status).toBe(200);
    expect(spots.body.data.map((spot: { id: string }) => spot.id)).toContain(inside.spot);
    expect(spots.body.data.map((spot: { id: string }) => spot.id)).not.toContain(outside.spot);
    expect((await asArea('patch', `/admin/spots/${inside.spot}`).send({ status: 'unpublished', crowd_capacity_band: 'medium' })).status).toBe(403);

    const outsideDraft = await asArea('post', '/admin/quizzes').send(quizPayload(outside.spot, 'Outside quiz'));
    expect(outsideDraft.status).toBe(403);
    expect(outsideDraft.body.error.code).toBe('OUT_OF_AREA');
    expect((await asArea('post', '/admin/quizzes').send(quizPayload(inside.spot, 'Inside quiz'))).status).toBe(201);
    // Moving a draft into another area needs that area too.
    const move = await asArea('patch', `/admin/quizzes/${quizIds[inside.spot]}`).send(quizPayload(outside.spot, 'Moved quiz'));
    expect(move.status).toBe(403);

    expect((await asArea('post', `/admin/quizzes/${quizIds[outside.spot]}/archive`)).status).toBe(404);
    expect((await asArea('post', `/admin/quizzes/${quizIds[inside.spot]}/archive`)).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await auditActions()).toEqual(expect.arrayContaining(['quiz.created', 'quiz.archived']));
  });

  it('limits the merchant directory to merchants in the area; unassigned merchants are platform-only', async () => {
    const list = await asArea('get', '/admin/merchants');
    expect(list.status).toBe(200);
    expect(list.body.data.map((merchant: { id: string }) => merchant.id)).toEqual([inside.merchant]);
    expect((await asArea('get', `/admin/merchants/${outside.merchant}`)).status).toBe(404);
    expect((await asArea('get', '/admin/merchants/m-p3-unassigned')).status).toBe(404);
    expect((await asArea('get', `/admin/merchants/${inside.merchant}`)).status).toBe(200);
  });

  it('reviews only applications from the area and gives the approved merchant its town', async () => {
    const list = await asArea('get', '/admin/affiliate/applications');
    expect(list.status).toBe(200);
    const ids = list.body.data.map((application: { id: string }) => application.id);
    expect(ids).toContain(inside.application);
    expect(ids).not.toContain(outside.application);
    expect((await asArea('get', `/admin/affiliate/applications/${outside.application}`)).status).toBe(404);
    expect((await asArea('patch', `/admin/affiliate/applications/${outside.application}`).send({ status: 'in_review' })).status).toBe(404);

    const approved = await asArea('patch', `/admin/affiliate/applications/${inside.application}`).send({ status: 'approved' });
    expect(approved.status).toBe(200);
    const merchant = await fixture.pool.query('SELECT town_area_id FROM merchants WHERE source_application_id=$1', [inside.application]);
    expect(merchant.rows[0]?.town_area_id).toBe('p3-dagupan');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await auditActions()).toContain('merchant_application.approved');
  });

  it('changes voucher availability only for merchants in the area', async () => {
    const list = await asArea('get', '/admin/vouchers');
    expect(list.status).toBe(200);
    expect(list.body.data.map((voucher: { id: string }) => voucher.id)).toEqual([inside.voucher]);
    expect((await asArea('patch', `/admin/vouchers/${outside.voucher}/availability`).send({ availability: 'preview' })).status).toBe(404);
    expect((await asArea('patch', `/admin/vouchers/${inside.voucher}/availability`).send({ availability: 'preview' })).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await auditActions()).toContain('voucher.availability_changed');
  });

  it.each([
    ['get', '/admin/shop/cosmetics'],
    ['get', '/admin/quest-attempts'],
    ['get', '/admin/quest-funding'],
    ['get', '/admin/merchant-point-credits'],
    ['post', `/admin/merchants/${inside.merchant}/points`],
    ['get', '/admin/settings'],
  ] as const)('keeps %s %s platform-only', async (method, path) => {
    expect((await asArea(method, path).send({})).status).toBe(403);
  });

  it('keeps every converted route open to platform admins', async () => {
    const asDeveloper = (path: string) => request(app).get(`/api/v1${path}`).set('Authorization', `Bearer ${developerToken}`);
    expect((await asDeveloper('/admin/merchants')).body.data.length).toBeGreaterThanOrEqual(3);
    expect((await asDeveloper('/admin/vouchers')).body.data.map((voucher: { id: string }) => voucher.id)).toEqual(expect.arrayContaining([inside.voucher, outside.voucher]));
    expect((await asDeveloper(`/admin/quizzes/${quizIds[outside.spot]}`)).status).toBe(200);
    expect((await asDeveloper(`/admin/affiliate/applications/${outside.application}`)).status).toBe(200);
  });
});
