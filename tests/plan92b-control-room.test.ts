import request from 'supertest';
import jwt from 'jsonwebtoken';
import { app } from '../src/app.js';
import { db } from '../src/db/index.js';
import { createTestDb, type TestDbInstance } from '../src/db/testHarness.js';
import { setPool } from '../src/db/pool.js';
import { env } from '../src/config/env.js';
import { spotStore } from '../src/spots/store.js';
import { FieldLogStore } from '../src/spots/field-logs.js';

// Plan 92b: durable spot reports, admin quest list + pause/publish, and the area switcher.
const realPgDescribe = process.env.JDQ_REAL_PG_URL ? describe : describe.skip;

realPgDescribe('Plan 92b control room (real PostgreSQL)', () => {
  let fixture: TestDbInstance;
  const platformId = 'p92b-platform';
  const areaId = 'p92b-area';
  const outsiderId = 'p92b-outsider';
  const token = (id: string, role: string) =>
    jwt.sign({ id, seed_id: `${id}-seed`, role, typ: 'session' }, env.JWT_SECRET);
  const platformToken = token(platformId, 'admin');
  const areaToken = token(areaId, 'area_admin');
  const outsiderToken = token(outsiderId, 'area_admin');
  const spots = {
    dagupan: 'spot-p92b-dagupan',
    lingayen: 'spot-p92b-lingayen',
    launion: 'spot-p92b-launion',
  };
  const quests = {
    dagupan: 'quest-p92b-dagupan',
    lingayen: 'quest-p92b-lingayen',
    launion: 'quest-p92b-launion',
  };
  const ids = (body: { data: Array<{ id: string }> }) => body.data.map((row) => row.id).sort();

  beforeAll(async () => {
    fixture = await createTestDb();
    setPool(fixture.pool);
    const q = (sql: string, values: unknown[] = []) => fixture.pool.query(sql, values);
    await q(
      `INSERT INTO users(id,seed_id,display_name,email,role,admin_scope) VALUES
      ($1,'p92b-platform-seed','Platform','p92b-platform@test.local','admin','developer'),
      ($2,'p92b-area-seed','Pangasinan Admin','p92b-area@test.local','area_admin',NULL),
      ($3,'p92b-outsider-seed','La Union Admin','p92b-outsider@test.local','area_admin',NULL),
      ('p92b-author','p92b-author-seed','Author','p92b-author@test.local','user',NULL)`,
      [platformId, areaId, outsiderId],
    );
    const addArea = (id: string, level: string, name: string, parent: string | null) =>
      q(
        `INSERT INTO admin_areas(id,level,name,display_name,parent_id,has_boundary,label_lat,label_lng,bbox,min_zoom)
         VALUES ($1,$2,$3,$3,$4,TRUE,16,120,$5,5) ON CONFLICT (id) DO NOTHING`,
        [id, level, name, parent, [119, 15, 121, 17]],
      );
    await addArea('p92b-pangasinan', 'province', 'Pangasinan', null);
    await addArea('p92b-dagupan', 'town', 'Dagupan City', 'p92b-pangasinan');
    await addArea('p92b-lingayen', 'town', 'Lingayen', 'p92b-pangasinan');
    await addArea('p92b-unassigned', 'town', 'Unassigned Town', 'p92b-pangasinan');
    await addArea('p92b-la-union', 'province', 'La Union', null);
    await addArea('p92b-san-fernando', 'town', 'San Fernando', 'p92b-la-union');
    await q(
      `INSERT INTO admin_area_assignments(id,user_id,area_id,powers,granted_by) VALUES
       ('p92b-grant-a',$1,'p92b-dagupan',ARRAY['destinations','quests_quizzes']::text[],$3),
       ('p92b-grant-b',$1,'p92b-lingayen',ARRAY['destinations','quests_quizzes']::text[],$3),
       ('p92b-grant-c',$2,'p92b-la-union',ARRAY['destinations','quests_quizzes']::text[],$3)`,
      [areaId, outsiderId, platformId],
    );
    for (const [key, town, municipality] of [
      ['dagupan', 'p92b-dagupan', 'Dagupan City'],
      ['lingayen', 'p92b-lingayen', 'Lingayen'],
      ['launion', 'p92b-san-fernando', 'San Fernando'],
    ] as const) {
      const spotId = spots[key];
      const questId = quests[key];
      await q(
        `INSERT INTO quests(id,title,description,category,location_name,gps_lat,gps_lng,radius_meters,reward_points,marker_code,marker_image_url,author_id,status,version,steps,is_test)
         VALUES($1,$2,'Visit the place','eco','Test',16,120,100,50,$3,'','p92b-author',$4,1,'[]'::jsonb,false)`,
        [questId, `Quest ${key}`, `marker-${key}`, key === 'lingayen' ? 'draft' : 'published'],
      );
      db.quests.push({
        id: questId,
        title: `Quest ${key}`,
        description: 'Visit the place',
        category: 'eco',
        location_name: 'Test',
        gps_lat: 16,
        gps_lng: 120,
        radius_meters: 100,
        reward_points: 50,
        marker_code: `marker-${key}`,
        marker_image_url: '',
        author_id: 'p92b-author',
        status: key === 'lingayen' ? 'draft' : 'published',
        version: 1,
        steps: [],
        is_active: key !== 'lingayen',
        is_test: false,
      } as any);
      await q(
        `INSERT INTO spots(id,slug,name,description,category,subcategory,municipality,address,gps_lat,gps_lng,price_level,source_type,source_name,trust_level,status,town_area_id)
         VALUES ($1,$2,$3,'Control room test spot','culture_heritage','heritage_site',$4,'',16,120,1,'lgu','test','lgu_verified','published',$5)`,
        [spotId, spotId, spotId, municipality, town],
      );
      spotStore.spots.push({
        id: spotId,
        slug: spotId,
        name: spotId,
        description: '',
        category: 'culture_heritage',
        subcategory: 'heritage_site',
        tags: [],
        municipality,
        address: '',
        gps_lat: 16,
        gps_lng: 120,
        price_level: 1,
        hours: {},
        amenities: [],
        image_url: '',
        source_type: 'lgu',
        source_name: 'test',
        trust_level: 'lgu_verified',
        status: 'published',
        town_area_id: town,
        quest_id: questId,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
    }
    await db.hydrateFromPg(fixture.pool);
  });

  afterAll(async () => {
    const ours = new Set<string>(Object.values(spots));
    spotStore.spots = spotStore.spots.filter((spot) => !ours.has(spot.id));
    db.quests = db.quests.filter((quest) => !Object.values(quests).includes(quest.id));
    setPool(null);
    db.usersRepo.setPool(null);
    if (fixture) await fixture.close();
  });

  const as = (tokenValue: string, method: 'get' | 'patch' | 'post', path: string) =>
    request(app)[method](`/api/v1${path}`).set('Authorization', `Bearer ${tokenValue}`);
  const auditActions = async () =>
    (await fixture.pool.query('SELECT action FROM admin_audit_log ORDER BY created_at')).rows.map((r) => r.action);

  describe('spot reports', () => {
    let reportId: string;

    it('stores a report in spot_reports and lists it from a fresh store', async () => {
      const created = await request(app)
        .post(`/api/v1/spots/${spots.dagupan}/reports`)
        .send({ reason: 'inaccurate_location', details: 'The pin is one street off.' });
      expect(created.status).toBe(201);
      reportId = created.body.data.report_id;
      const row = await fixture.pool.query('SELECT reason, status FROM spot_reports WHERE id = $1', [reportId]);
      expect(row.rows[0]).toEqual({ reason: 'inaccurate_location', status: 'pending' });
      const fresh = await new FieldLogStore().listReports(spots.dagupan);
      expect(fresh.map((report) => report.id)).toContain(reportId);
    });

    it('lets an in-area admin resolve it and audits the change', async () => {
      const res = await as(areaToken, 'patch', `/admin/spot-reports/${reportId}`).send({
        status: 'reviewed',
        resolution_note: 'Moved the pin to the plaza entrance.',
      });
      expect(res.status).toBe(200);
      const row = await fixture.pool.query(
        'SELECT status, resolved_by, resolved_at, resolution_note FROM spot_reports WHERE id = $1',
        [reportId],
      );
      expect(row.rows[0]).toMatchObject({
        status: 'reviewed',
        resolved_by: areaId,
        resolution_note: 'Moved the pin to the plaza entrance.',
      });
      expect(row.rows[0].resolved_at).not.toBeNull();
      expect(await auditActions()).toContain('spot_report.reviewed');
    });

    it('hides the report from an admin of another area and rejects a short note', async () => {
      const outside = await as(outsiderToken, 'patch', `/admin/spot-reports/${reportId}`).send({
        status: 'dismissed',
        resolution_note: 'Not my area at all.',
      });
      expect(outside.status).toBe(404);
      const short = await as(areaToken, 'patch', `/admin/spot-reports/${reportId}`).send({
        status: 'dismissed',
        resolution_note: 'no',
      });
      expect(short.status).toBe(400);
    });
  });

  describe('quests', () => {
    it('lists only in-area quests, drafts included, without marker codes', async () => {
      const res = await as(areaToken, 'get', '/admin/quests');
      expect(res.status).toBe(200);
      const mine = ids(res.body).filter((id) => id.startsWith('quest-p92b-'));
      expect(mine).toEqual([quests.dagupan, quests.lingayen].sort());
      expect(res.body.data.every((quest: Record<string, unknown>) => !('marker_code' in quest))).toBe(true);
    });

    it('lets an area admin pause and republish an in-area quest, and refuses one outside', async () => {
      const paused = await as(areaToken, 'patch', `/quests/${quests.dagupan}/status`).send({ status: 'paused' });
      expect(paused.status).toBe(200);
      expect(paused.body.data.status).toBe('paused');
      const published = await as(areaToken, 'patch', `/quests/${quests.dagupan}/status`).send({ status: 'published' });
      expect(published.status).toBe(200);
      const outside = await as(areaToken, 'patch', `/quests/${quests.launion}/status`).send({ status: 'paused' });
      expect(outside.status).toBe(403);
      expect((await auditActions()).filter((action) => action === 'quest.status_changed')).toHaveLength(2);
    });
  });

  describe('area switcher (?area_id=)', () => {
    it('narrows a two-town area admin to one town', async () => {
      const res = await as(areaToken, 'get', '/admin/spots?area_id=p92b-lingayen');
      expect(res.status).toBe(200);
      expect(ids(res.body).filter((id) => id.startsWith('spot-p92b-'))).toEqual([spots.lingayen]);
      const questsRes = await as(areaToken, 'get', '/admin/quests?area_id=p92b-lingayen');
      expect(ids(questsRes.body).filter((id) => id.startsWith('quest-p92b-'))).toEqual([quests.lingayen]);
    });

    it('returns an empty list for a town the admin does not hold', async () => {
      const res = await as(areaToken, 'get', '/admin/spots?area_id=p92b-unassigned');
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
    });

    it('limits a platform admin to the chosen subtree', async () => {
      const res = await as(platformToken, 'get', '/admin/spots?area_id=p92b-pangasinan');
      expect(res.status).toBe(200);
      const mine = ids(res.body).filter((id) => id.startsWith('spot-p92b-'));
      expect(mine).toEqual([spots.dagupan, spots.lingayen].sort());
      expect(res.body.data.every((spot: { town_area_id?: string }) => spot.town_area_id !== 'p92b-san-fernando')).toBe(
        true,
      );
    });
  });
});
