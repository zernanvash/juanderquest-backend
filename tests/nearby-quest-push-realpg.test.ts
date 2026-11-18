import { randomUUID } from 'crypto';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { app } from '../src/app.js';
import { db } from '../src/db/index.js';
import { env } from '../src/config/env.js';
import { setPool } from '../src/db/pool.js';
import { spotStore } from '../src/spots/store.js';
import { createTestDb, type TestDbInstance } from '../src/db/testHarness.js';
import {
  runNearbyQuestAnnouncement,
  waitForNearbyQuestAnnouncements,
  type NearbyQuest,
} from '../src/social/nearbyQuest.js';

// Owner 2026-11-18: push when a new quest is published within 10 km of a
// traveler's home town; at most one push per traveler per Manila day.
const realPg = process.env.JDQ_REAL_PG_URL ? describe : describe.skip;

realPg('nearby quest push (real PostgreSQL)', () => {
  let fixture: TestDbInstance;
  const tag = randomUUID().slice(0, 8);
  const ids = {
    near: `u-near-${tag}`,
    far: `u-far-${tag}`,
    optedOut: `u-optout-${tag}`,
    author: `u-author-${tag}`,
    tester: `u-tester-${tag}`,
    quiet: `u-quiet-${tag}`,
  };
  const spotId = `spot-nearby-${tag}`;
  const noon = new Date('2026-11-18T04:00:00Z'); // 12:00 Manila
  const originalFunding = env.QUEST_FUNDING_ENABLED;
  // Dagupan City centre; the quest pin is ~3 km away. Alaminos is ~40 km away.
  const pin = { gps_lat: 16.06, gps_lng: 120.31 };
  let questSeq = 0;

  const quest = (overrides: Partial<NearbyQuest> = {}): NearbyQuest => ({
    id: `quest-nearby-${tag}-${++questSeq}`,
    title: 'Tondaligan sunset walk',
    location_name: 'Tondaligan Beach',
    author_id: ids.author,
    is_test: false,
    ...pin,
    ...overrides,
  });

  const inbox = async (userId: string) =>
    (
      await fixture.pool.query(
        `SELECT kind, title, href FROM user_notifications WHERE user_id = $1 AND kind = 'nearby_quest' ORDER BY created_at`,
        [userId],
      )
    ).rows;
  const pushes = async (userId: string) =>
    (
      await fixture.pool.query(
        `SELECT category, status, href, send_after FROM push_deliveries WHERE user_id = $1 AND category = 'nearby_quest'`,
        [userId],
      )
    ).rows;

  beforeAll(async () => {
    fixture = await createTestDb();
    setPool(fixture.pool);
    db.usersRepo.setPool(fixture.pool);
    env.QUEST_FUNDING_ENABLED = false;
    const addTown = (id: string, name: string, lat: number, lng: number) =>
      fixture.pool.query(
        `INSERT INTO admin_areas(id,level,name,display_name,has_boundary,label_lat,label_lng,bbox,min_zoom)
         VALUES ($1,'town',$2,$2,FALSE,$3,$4,$5,9)`,
        [id, name, lat, lng, [lng - 0.1, lat - 0.1, lng + 0.1, lat + 0.1]],
      );
    await addTown(`dagupan-${tag}`, 'Dagupan City', 16.043, 120.334);
    await addTown(`alaminos-${tag}`, 'Alaminos City', 16.156, 119.981);
    const addUser = (id: string, town: string, isTest = false) =>
      fixture.pool.query(
        `INSERT INTO users(id,seed_id,display_name,email,role,demo_points,home_municipality,is_test)
         VALUES($1::text,$1::text,$1::text,$2,'user',0,$3,$4)`,
        [id, `${id}@example.test`, town, isTest],
      );
    await addUser(ids.near, 'Dagupan City');
    await addUser(ids.far, 'Alaminos City');
    await addUser(ids.optedOut, 'Dagupan City');
    await addUser(ids.author, 'Dagupan City');
    await addUser(ids.tester, 'Dagupan City', true);
    await addUser(ids.quiet, 'Dagupan City');
    await fixture.pool.query(
      'INSERT INTO user_notification_preferences(user_id, push_nearby_quest) VALUES ($1, FALSE)',
      [ids.optedOut],
    );
    db.users.push({
      id: ids.author,
      seed_id: ids.author,
      display_name: 'Author',
      email: `${ids.author}@example.test`,
      role: 'user',
      demo_points: 0,
      is_test: false,
    } as any);
    await fixture.pool.query(
      `INSERT INTO spots(id, slug, name, description, category, subcategory, municipality, address, gps_lat, gps_lng,
         status, is_test, recommendation_suppressed, source_type, source_name, created_by)
       VALUES($1::text, $1::text, 'Tondaligan Beach', 'A test destination near Dagupan.', 'nature_outdoors', 'beach',
         'Dagupan City', 'Bonuan, Dagupan', $2, $3, 'published', false, false, 'community', 'Author', $4)`,
      [spotId, pin.gps_lat, pin.gps_lng, ids.author],
    );
    spotStore.spots.push({
      id: spotId,
      slug: spotId,
      name: 'Tondaligan Beach',
      ...pin,
      municipality: 'Dagupan City',
      image_url: '',
      status: 'published',
      is_test: false,
      created_by: ids.author,
    } as any);
  });

  afterAll(async () => {
    env.QUEST_FUNDING_ENABLED = originalFunding;
    spotStore.spots = spotStore.spots.filter((s) => s.id !== spotId);
    setPool(null);
    db.usersRepo.setPool(null);
    if (fixture) await fixture.close();
  });

  beforeEach(async () => {
    await fixture.pool.query('DELETE FROM push_deliveries');
    await fixture.pool.query('DELETE FROM user_notifications');
    await fixture.pool.query('DELETE FROM nearby_quest_push_days');
    await fixture.pool.query(`UPDATE user_notification_preferences SET quiet_hours = TRUE`);
  });

  it('notifies and pushes an in-range traveler once; out of range, opted out, author and test users get nothing', async () => {
    const q = quest();
    const notified = await runNearbyQuestAnnouncement(fixture.pool, q, noon);

    expect(await inbox(ids.near)).toEqual([
      { kind: 'nearby_quest', title: 'New quest near Dagupan City', href: `/quests/${q.id}` },
    ]);
    const near = await pushes(ids.near);
    expect(near).toHaveLength(1);
    expect(near[0]).toMatchObject({ category: 'nearby_quest', status: 'queued', href: `/quests/${q.id}` });
    expect(new Date(near[0].send_after).getTime()).toBe(noon.getTime());

    for (const id of [ids.far, ids.optedOut, ids.author, ids.tester]) {
      expect(await inbox(id)).toEqual([]);
      expect(await pushes(id)).toEqual([]);
    }
    expect(notified).toBe(2); // near + quiet (both Dagupan, both opted in)

    // Publishing the same quest again (pause -> publish) is not "new".
    expect(await runNearbyQuestAnnouncement(fixture.pool, q, noon)).toBe(0);
    expect(await pushes(ids.near)).toHaveLength(1);
  });

  it('a second new quest the same Manila day lands in the inbox but sends no second push', async () => {
    await runNearbyQuestAnnouncement(fixture.pool, quest(), noon);
    await runNearbyQuestAnnouncement(fixture.pool, quest(), new Date(noon.getTime() + 3 * 3600_000));
    expect(await inbox(ids.near)).toHaveLength(2);
    expect(await pushes(ids.near)).toHaveLength(1);

    // Next Manila day: a push again.
    await runNearbyQuestAnnouncement(fixture.pool, quest(), new Date(noon.getTime() + 24 * 3600_000));
    expect(await pushes(ids.near)).toHaveLength(2);
  });

  it('during quiet hours stores the inbox row and holds the push until 08:00 Manila', async () => {
    const lateNight = new Date('2026-11-18T15:30:00Z'); // 23:30 Manila
    await runNearbyQuestAnnouncement(fixture.pool, quest(), lateNight);
    expect(await inbox(ids.quiet)).toHaveLength(1);
    const rows = await pushes(ids.quiet);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('queued');
    expect(new Date(rows[0].send_after).toISOString()).toBe('2026-11-19T00:00:00.000Z');
  });

  it('test quests and the admin switch send nothing', async () => {
    expect(await runNearbyQuestAnnouncement(fixture.pool, quest({ is_test: true }), noon)).toBe(0);
    await fixture.pool.query(
      `INSERT INTO system_settings_document(id, values) VALUES (1, '{"nearby_quest_push_enabled": false}'::jsonb)
       ON CONFLICT (id) DO UPDATE SET values = system_settings_document.values || EXCLUDED.values`,
    );
    try {
      expect(await runNearbyQuestAnnouncement(fixture.pool, quest(), noon)).toBe(0);
    } finally {
      await fixture.pool.query(
        `UPDATE system_settings_document SET values = values - 'nearby_quest_push_enabled' WHERE id = 1`,
      );
    }
    expect(await inbox(ids.near)).toEqual([]);
  });

  it('the notification-preferences API reads and writes push_nearby_quest', async () => {
    const token = jwt.sign({ id: ids.near, seed_id: ids.near, role: 'user', typ: 'session' }, env.JWT_SECRET);
    const before = await request(app)
      .get('/api/v1/me/notification-preferences')
      .set('Authorization', `Bearer ${token}`);
    expect(before.status).toBe(200);
    expect(before.body.data.push_nearby_quest).toBe(true);
    const put = await request(app)
      .put('/api/v1/me/notification-preferences')
      .set('Authorization', `Bearer ${token}`)
      .send({ push_nearby_quest: false });
    expect(put.status).toBe(200);
    expect(put.body.data).toMatchObject({ push_nearby_quest: false, push_social: true });
    await runNearbyQuestAnnouncement(fixture.pool, quest(), noon);
    expect(await inbox(ids.near)).toEqual([]);
    await fixture.pool.query('UPDATE user_notification_preferences SET push_nearby_quest = TRUE WHERE user_id = $1', [
      ids.near,
    ]);
  });

  it('publishing a quest through the API announces it after the response', async () => {
    const token = jwt.sign({ id: ids.author, seed_id: ids.author, role: 'user', typ: 'session' }, env.JWT_SECRET);
    const res = await request(app)
      .post(`/api/v1/spots/${spotId}/quests`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        title: 'Bonuan boardwalk',
        description: 'Walk the Bonuan boardwalk and check in at the end.',
        category: 'eco',
        steps: [
          { step_order: 1, title: 'Arrive', description: 'Check in.', checkpoint_type: 'location', required: true },
        ],
      });
    expect(res.status).toBe(201);
    await waitForNearbyQuestAnnouncements();
    expect(await inbox(ids.near)).toEqual([
      { kind: 'nearby_quest', title: 'New quest near Dagupan City', href: `/quests/${res.body.data.id}` },
    ]);
    expect(await inbox(ids.author)).toEqual([]);
  });

  it('a failing announcement never breaks publishing', async () => {
    await fixture.pool.query('ALTER TABLE nearby_quest_announcements RENAME TO nearby_quest_announcements_off');
    const errors = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const token = jwt.sign({ id: ids.author, seed_id: ids.author, role: 'user', typ: 'session' }, env.JWT_SECRET);
      const res = await request(app)
        .post(`/api/v1/spots/${spotId}/quests`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          title: 'Bonuan fish port visit',
          description: 'Visit the fish port early in the morning.',
          category: 'eco',
          steps: [
            { step_order: 1, title: 'Arrive', description: 'Check in.', checkpoint_type: 'location', required: true },
          ],
        });
      expect(res.status).toBe(201);
      await waitForNearbyQuestAnnouncements();
      const row = await fixture.pool.query('SELECT status FROM quests WHERE id = $1', [res.body.data.id]);
      expect(row.rows[0]?.status).toBe('published');
      expect(errors).toHaveBeenCalledWith('[nearby-quest] announcement failed:', expect.anything());
      expect(await inbox(ids.near)).toEqual([]);
    } finally {
      errors.mockRestore();
      await fixture.pool.query('ALTER TABLE nearby_quest_announcements_off RENAME TO nearby_quest_announcements');
    }
  });
});
