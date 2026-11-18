import { randomUUID } from 'crypto';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { app } from '../src/app.js';
import { db } from '../src/db/index.js';
import { env } from '../src/config/env.js';
import { setPool } from '../src/db/pool.js';
import { createTestDb, type TestDbInstance } from '../src/db/testHarness.js';

// v0.3.8 quest builder "Merchants nearby": the sponsor directory returns each shop's
// distance from the quest pin and lists the nearest first.
const realPg = process.env.JDQ_REAL_PG_URL ? describe : describe.skip;
realPg('sponsor directory distance (disposable PostgreSQL)', () => {
  let fixture: TestDbInstance;
  const originalFlag = env.QUEST_FUNDING_ENABLED;
  const suffix = randomUUID().slice(0, 8);
  const authorId = `dir-author-${suffix}`;
  const questId = `dir-quest-${suffix}`;
  const token = (id: string) => `Bearer ${jwt.sign({ id, seed_id: id, role: 'user', typ: 'session' }, env.JWT_SECRET)}`;

  async function merchant(id: string, name: string, municipality: string, gps: [number, number] | null) {
    let appId: string | null = null;
    if (gps) {
      appId = `app-${id}`;
      await fixture.pool.query(
        `INSERT INTO merchant_affiliate_applications
          (id,user_id,business_name,category,municipality,contact_name,contact_email,contact_phone,sponsorship_goals,proposal_details,status,gps_lat,gps_lng)
         VALUES($1,$2,$3,'cafe',$4,'Owner','owner@shop.test','09170000000','[]'::jsonb,'Local shop','approved',$5,$6)`,
        [appId, authorId, name, municipality, gps[0], gps[1]],
      );
    }
    await fixture.pool.query(
      `INSERT INTO merchants(id,name,location,description,status,is_published,municipality,category,source_application_id,is_test)
       VALUES($1,$2,$3,'Local partner','active',TRUE,$3,'cafe',$4,FALSE)`,
      [id, name, municipality, appId],
    );
  }

  beforeAll(async () => {
    fixture = await createTestDb();
    setPool(fixture.pool);
    db.usersRepo.setPool(fixture.pool);
    env.QUEST_FUNDING_ENABLED = true;
    await fixture.pool.query(
      'INSERT INTO users(id,seed_id,display_name,email,role,demo_points) VALUES($1,$1,$1,$2,$3,0)',
      [authorId, `${authorId}@example.test`, 'user'],
    );
    db.users.push({
      id: authorId,
      seed_id: authorId,
      display_name: authorId,
      email: `${authorId}@example.test`,
      role: 'user',
      demo_points: 0,
      is_test: false,
    } as any);
    await fixture.pool.query(
      `INSERT INTO quests(id,title,description,category,location_name,gps_lat,gps_lng,radius_meters,reward_points,marker_code,marker_image_url,author_id,status,version,steps,is_active)
       VALUES($1,'Dir quest','Visit','eco','Dagupan',16,120,100,50,$2,'',$3,'draft',1,'[]'::jsonb,false)`,
      [questId, `marker-${suffix}`, authorId],
    );
    await merchant(`far-${suffix}`, 'Far Cafe', 'Dagupan', [16.02, 120]);
    await merchant(`near-${suffix}`, 'Near Cafe', 'Dagupan', [16.001, 120]);
    await merchant(`nogps-${suffix}`, 'Aaa No GPS', 'Dagupan', null);
  });
  afterAll(async () => {
    env.QUEST_FUNDING_ENABLED = originalFlag;
    setPool(null);
    db.usersRepo.setPool(null);
    if (fixture) await fixture.close();
  });

  const ours = (items: any[]) => items.filter((m) => String(m.id).endsWith(suffix));

  it('sorts by distance from the saved quest location, unknown distance last', async () => {
    const res = await request(app)
      .get(`/api/v1/sponsor-directory?quest_id=${encodeURIComponent(questId)}`)
      .set('Authorization', token(authorId));
    expect(res.status).toBe(200);
    const items = ours(res.body.data.items);
    expect(items.map((m: any) => m.name)).toEqual(['Near Cafe', 'Far Cafe', 'Aaa No GPS']);
    expect(items[0].distance_m).toBeGreaterThan(100);
    expect(items[0].distance_m).toBeLessThan(125);
    expect(items[1].distance_m).toBeGreaterThan(2000);
    expect(items[2].distance_m).toBeNull();
  });

  it('uses the builder pin when lat/lng are given', async () => {
    const res = await request(app)
      .get(`/api/v1/sponsor-directory?quest_id=${encodeURIComponent(questId)}&lat=16.02&lng=120`)
      .set('Authorization', token(authorId));
    expect(res.status).toBe(200);
    const items = ours(res.body.data.items);
    expect(items.map((m: any) => m.name)).toEqual(['Far Cafe', 'Near Cafe', 'Aaa No GPS']);
    expect(items[0].distance_m).toBeLessThan(5);
  });
});
