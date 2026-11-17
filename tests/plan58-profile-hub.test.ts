import request from 'supertest';
import jwt from 'jsonwebtoken';
import { app } from '../src/app.js';
import { db } from '../src/db/index.js';
import { createTestDb, TestDbInstance } from '../src/db/testHarness.js';
import { setPool } from '../src/db/pool.js';
import { env } from '../src/config/env.js';

describe('Plan 58 — Profile hub real PostgreSQL (quests, progress, privacy, timeline)', () => {
  let testDb: TestDbInstance;

  const ownerId = 'owner-p58';
  const visitorId = 'visitor-p58';
  const signToken = (id: string) => jwt.sign({ id, seed_id: id, role: 'user', typ: 'session' }, env.JWT_SECRET);
  const ownerToken = signToken(ownerId);
  const visitorToken = signToken(visitorId);

  beforeAll(async () => {
    testDb = await createTestDb();
    setPool(testDb.pool);

    for (const u of [
      { id: ownerId, email: 'owner58@example.com', name: 'Owner Scout', handle: 'ownerscout' },
      { id: visitorId, email: 'visitor58@example.com', name: 'Visitor Scout', handle: 'visitorscout' },
    ]) {
      await testDb.pool.query(
        `INSERT INTO users (id, seed_id, display_name, email, avatar_url, role, is_public, handle)
         VALUES ($1, $2, $3, $4, '', 'user', TRUE, $5)
         ON CONFLICT (id) DO NOTHING`,
        [u.id, u.id, u.name, u.email, u.handle],
      );
      if (!db.findUserById(u.id)) {
        db.users.push({
          id: u.id,
          seed_id: u.id,
          display_name: u.name,
          email: u.email,
          avatar_url: '',
          role: 'user',
          demo_points: 100,
          mjdq_balance: 100000,
          jdq_governance_balance: 0,
          scout_reputation: 0,
          is_public: true,
          handle: u.handle,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });
      }
    }
  }, 120_000);

  afterAll(async () => {
    setPool(null);
    await testDb.close();
  });

  test('authored quests: owner sees draft/paused/published with private Cache-Control; visitor sees published only', async () => {
    await testDb.pool.query(
      `INSERT INTO quests (id, title, description, category, location_name, gps_lat, gps_lng, radius_meters, reward_points, marker_code, author_id, status)
       VALUES
         ('q-p58-pub', 'Published Quest', 'd', 'eco', 'Alaminos', 16.2, 119.9, 100, 50, 'P58-PUB', $1, 'published'),
         ('q-p58-draft', 'Secret Draft Quest', 'd', 'eco', 'Alaminos', 16.2, 119.9, 100, 50, 'P58-DRAFT', $1, 'draft'),
         ('q-p58-paused', 'Paused Quest', 'd', 'eco', 'Alaminos', 16.2, 119.9, 100, 50, 'P58-PAUSED', $1, 'paused')
       ON CONFLICT (id) DO NOTHING`,
      [ownerId],
    );

    const vis = await request(app)
      .get('/api/v1/users/ownerscout/quests')
      .set('Authorization', `Bearer ${visitorToken}`);
    expect(vis.status).toBe(200);
    const visTitles = vis.body.data.quests.map((q: any) => q.title);
    expect(visTitles).toEqual(['Published Quest']);

    const own = await request(app).get('/api/v1/users/ownerscout/quests').set('Authorization', `Bearer ${ownerToken}`);
    expect(own.status).toBe(200);
    expect(own.headers['cache-control']).toBe('private, no-store');
    const ownTitles = own.body.data.quests.map((q: any) => q.title).sort();
    expect(ownTitles).toEqual(['Paused Quest', 'Published Quest', 'Secret Draft Quest']);
  });

  test('/me/progress counts only required verified tasks (any-order quests) and respects progress_public privacy', async () => {
    await testDb.pool.query(
      `INSERT INTO quests (id, title, description, category, location_name, gps_lat, gps_lng, radius_meters, reward_points, marker_code, author_id, status, step_order_mode)
       VALUES ('q-p58-any', 'Any-Order Coastal Quest', 'd', 'eco', 'Bolinao', 16.3, 119.8, 100, 75, 'P58-ANY', $1, 'published', 'any')
       ON CONFLICT (id) DO NOTHING`,
      [visitorId],
    );

    const attemptId = 'att-p58-any';
    await testDb.pool.query(
      `INSERT INTO quest_attempts (id, quest_id, user_id, version, current_step, total_steps, status, verified_steps, required_steps, step_order_mode)
       VALUES ($1, 'q-p58-any', $2, 1, 99, 3, 'in_progress', 1, 2, 'any')
       ON CONFLICT (id) DO NOTHING`,
      [attemptId, ownerId],
    );

    // Step 1: required not_started; Step 2: optional verified; Step 3: required verified
    await testDb.pool.query(
      `INSERT INTO quest_step_evidence (id, attempt_id, quest_id, user_id, step_order, checkpoint_type, status, required, title)
       VALUES
         ('ev-p58-1', $1, 'q-p58-any', $2, 1, 'location', 'not_started', TRUE, 'Visit Lighthouse'),
         ('ev-p58-2', $1, 'q-p58-any', $2, 2, 'photo', 'verified', FALSE, 'Optional Sunset Shot'),
         ('ev-p58-3', $1, 'q-p58-any', $2, 3, 'location', 'verified', TRUE, 'Reach Falls')
       ON CONFLICT (id) DO NOTHING`,
      [attemptId, ownerId],
    );

    // Progress is private to visitor by default
    const privRes = await request(app)
      .get('/api/v1/users/ownerscout/progress')
      .set('Authorization', `Bearer ${visitorToken}`);
    expect(privRes.status).toBe(403);
    expect(privRes.body.error.code).toBe('PROGRESS_PRIVATE');

    // Owner sees exact required count (1 of 2, NOT counting optional step, NOT current_step=99)
    const meRes = await request(app).get('/api/v1/me/progress').set('Authorization', `Bearer ${ownerToken}`);
    expect(meRes.status).toBe(200);
    expect(meRes.headers['cache-control']).toBe('private, no-store');
    expect(meRes.body.data.progress_public).toBe(false);
    const item = meRes.body.data.items.find((i: any) => i.quest_id === 'q-p58-any');
    expect(item.verified_required).toBe(1);
    expect(item.total_required).toBe(2);
    expect(item.next_task_title).toBe('Visit Lighthouse');

    // Toggle progress_public on -> visitor can read it
    const toggleRes = await request(app)
      .put('/api/v1/me/profile-privacy')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ progress_public: true });
    expect(toggleRes.status).toBe(200);
    expect(toggleRes.body.data.progress_public).toBe(true);

    const visRes = await request(app)
      .get('/api/v1/users/ownerscout/progress')
      .set('Authorization', `Bearer ${visitorToken}`);
    expect(visRes.status).toBe(200);
    expect(visRes.body.data.items.some((i: any) => i.quest_id === 'q-p58-any')).toBe(true);
  });

  test('timeline hides under_review items from visitors and paginates stably across 25 items with identical timestamps', async () => {
    const fixedTs = '2026-11-16T12:00:00.000Z';
    // Insert 23 published spots + 2 pending spots at the exact same timestamp in a single batch
    await testDb.pool.query(
      `INSERT INTO spots (id, slug, name, description, category, subcategory, municipality, address, gps_lat, gps_lng, image_url, source_type, source_name, trust_level, status, created_by, created_at)
       SELECT
         'spot-p58-' || LPAD(g::text, 2, '0'),
         'spot-p58-' || LPAD(g::text, 2, '0'),
         'Spot ' || LPAD(g::text, 2, '0'),
         'desc', 'nature', 'beach', 'Alaminos', 'Addr', 16.1, 119.9, '', 'community', 'Scout', 'community',
         CASE WHEN g <= 23 THEN 'published' ELSE 'pending' END,
         $1,
         $2::timestamptz
       FROM generate_series(1, 25) AS g
       ON CONFLICT (id) DO NOTHING`,
      [ownerId, fixedTs],
    );

    // Visitor sees only the 23 published items across 2 stable pages (20 + 3)
    const p1 = await request(app)
      .get('/api/v1/users/ownerscout/timeline')
      .set('Authorization', `Bearer ${visitorToken}`);
    expect(p1.status).toBe(200);
    expect(p1.body.data.items).toHaveLength(20);
    expect(p1.body.data.items.every((it: any) => !it.under_review)).toBe(true);
    expect(p1.body.data.next_cursor).toBeTruthy();

    const p2 = await request(app)
      .get(`/api/v1/users/ownerscout/timeline?cursor=${encodeURIComponent(p1.body.data.next_cursor)}`)
      .set('Authorization', `Bearer ${visitorToken}`);
    expect(p2.status).toBe(200);
    expect(p2.body.data.items).toHaveLength(3);
    expect(p2.body.data.next_cursor).toBeNull();

    const allVisIds = new Set([...p1.body.data.items, ...p2.body.data.items].map((i: any) => i.id));
    expect(allVisIds.size).toBe(23);

    // Owner sees all 25 items including the 2 pending ones marked under_review: true
    const own1 = await request(app)
      .get('/api/v1/users/ownerscout/timeline')
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(own1.status).toBe(200);
    expect(own1.headers['cache-control']).toBe('private, no-store');
    expect(own1.body.data.items.slice(0, 2).every((it: any) => it.under_review === true)).toBe(true);
    const own2 = await request(app)
      .get(`/api/v1/users/ownerscout/timeline?cursor=${encodeURIComponent(own1.body.data.next_cursor)}`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(own2.body.data.items).toHaveLength(5);
  });
});
