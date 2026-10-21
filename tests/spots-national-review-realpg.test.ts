import request from 'supertest';
import jwt from 'jsonwebtoken';
import { app } from '../src/app.js';
import { env } from '../src/config/env.js';
import { db } from '../src/db/index.js';
import { createTestDb, TestDbInstance } from '../src/db/testHarness.js';
import { setPool } from '../src/db/pool.js';

const realPg = process.env.JDQ_REAL_PG_URL ? describe : describe.skip;

realPg('national imported destination review API (disposable real PostgreSQL)', () => {
  let fixture: TestDbInstance;
  const adminId = 'national-seed-review-admin';
  const adminToken = jwt.sign({ id: adminId, seed_id: 'national-seed-review-admin', role: 'admin' }, env.JWT_SECRET);
  const travelerToken = jwt.sign({ id: 'national-seed-review-traveler', seed_id: 'national-seed-review-traveler', role: 'user' }, env.JWT_SECRET);

  beforeAll(async () => {
    fixture = await createTestDb({ poolMax: 5 });
    setPool(fixture.pool);
    db.usersRepo.setPool(fixture.pool);
    await fixture.pool.query(`INSERT INTO users (id,seed_id,display_name,email,role) VALUES
      ($1,'national-seed-review-admin','Seed Admin','seed-admin@example.test','admin'),
      ('national-seed-review-traveler','national-seed-review-traveler','Seed Traveler','seed-traveler@example.test','user')`, [adminId]);
    await fixture.pool.query(`INSERT INTO admin_areas
      (id,psgc_code,level,name,display_name,parent_id,has_boundary,label_lat,label_lng,bbox,min_zoom,boundary)
      VALUES ('national-seed-province',105500000,'province','Pangasinan','Pangasinan',NULL,FALSE,16,120,ARRAY[119,15,122,17]::float8[],7,'{}'::jsonb),
             ('national-seed-town',105501000,'town','Test Town','Test Town, Pangasinan','national-seed-province',FALSE,16,120,ARRAY[119,15,122,17]::float8[],9,'{}'::jsonb)`);
    await fixture.pool.query(`INSERT INTO spots
      (id,slug,name,description,category,subcategory,municipality,address,gps_lat,gps_lng,source_type,source_name,source_url,trust_level,status,
       external_refs,field_sources,import_confidence,import_wave,town_area_id)
      VALUES
      ('national-review-one','national-review-one','Imported One','','nature_outdoors','attraction','Test Town','',16,120,'open_data','OpenStreetMap','https://www.openstreetmap.org/','open_data','needs_review',
       '{"osm":"node/910001"}'::jsonb,'{"scraped_pending":{"contact_number":{"source":"scrapling","proposed_value":"+63 900 000 0000","url":"https://example.gov.ph/place","reviewed":false}}}'::jsonb,0.7,'w0-pangasinan','national-seed-town'),
      ('national-review-two','national-review-two','Imported Two','','nature_outdoors','attraction','Test Town','',16.01,120.01,'open_data','OpenStreetMap','https://www.openstreetmap.org/','open_data','needs_review',
       '{"osm":"node/910002"}'::jsonb,'{}'::jsonb,0.9,'w0-pangasinan','national-seed-town')`);
  }, 120_000);

  afterAll(async () => {
    setPool(null);
    db.usersRepo.setPool(null);
    await fixture?.close();
  }, 120_000);

  it('requires administrator authorization for the review queue and actions', async () => {
    const anonymous = await request(app).get('/api/v1/admin/imported-spots');
    const traveler = await request(app).get('/api/v1/admin/imported-spots').set('Authorization', `Bearer ${travelerToken}`);
    expect(anonymous.status).toBe(401);
    expect(traveler.status).toBe(403);
  });

  it('filters and paginates imported candidates without exposing the provenance map publicly', async () => {
    const response = await request(app).get('/api/v1/admin/imported-spots?wave=w0-pangasinan&region_psgc=105500000&limit=1')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(response.status).toBe(200);
    expect(response.body.data).toHaveLength(1);
    expect(response.body.meta.has_more).toBe(true);
    const secondPage = await request(app).get(`/api/v1/admin/imported-spots?wave=w0-pangasinan&region_psgc=105500000&limit=1&cursor=${encodeURIComponent(response.body.meta.next_cursor)}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(secondPage.status).toBe(200);
    expect(secondPage.body.data[0].field_sources.scraped_pending.contact_number.reviewed).toBe(false);

    const publicResponse = await request(app).get('/api/v1/spots?bbox=119,15,122,17&limit=200');
    expect(publicResponse.status).toBe(200);
    expect(publicResponse.body.data.map((row: { id: string }) => row.id)).not.toContain('national-review-one');
    expect(publicResponse.body.data.map((row: { id: string }) => row.id)).not.toContain('national-review-two');
    expect(publicResponse.body.data.every((row: Record<string, unknown>) => !('field_sources' in row))).toBe(true);
  });

  it('keeps unreviewed scraped facts out of bulk publication until an admin explicitly approves them', async () => {
    const bulkPath = '/api/v1/admin/imported-spots/bulk-approve';
    const payload = { wave: 'w0-pangasinan', region_psgc: '105500000', minimum_confidence: 0.6, max_items: 10 };
    const blocked = await request(app).post(bulkPath).set('Authorization', `Bearer ${adminToken}`).send(payload);
    expect(blocked.status).toBe(200);
    expect(blocked.body.meta.approved_count).toBe(1);
    expect(blocked.body.data.map((row: { id: string }) => row.id)).toEqual(['national-review-two']);

    const approved = await request(app).patch('/api/v1/admin/imported-spots/national-review-one')
      .set('Authorization', `Bearer ${adminToken}`).send({ action: 'approve', approve_scraped_fields: ['contact_number'] });
    expect(approved.status).toBe(200);
    expect(approved.body.data.contact_phone).toBe('+63 900 000 0000');
    expect(approved.body.data.status).toBe('published');
    expect(approved.body.data.field_sources).toBeUndefined();

    const visible = await request(app).get('/api/v1/spots?bbox=119,15,122,17&limit=200');
    expect(visible.status).toBe(200);
    expect(visible.body.data.map((row: { id: string }) => row.id)).toContain('national-review-one');
    expect(visible.body.data.every((row: Record<string, unknown>) => !('field_sources' in row))).toBe(true);
  });
});
