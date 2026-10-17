import { randomUUID } from 'crypto';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { app } from '../src/app.js';
import { db } from '../src/db/index.js';
import { env } from '../src/config/env.js';
import { setPool } from '../src/db/pool.js';
import { spotStore } from '../src/spots/store.js';
import { createTestDb, type TestDbInstance } from '../src/db/testHarness.js';

// Regression: the author-quest INSERT wrote base_reward_php / difficulty_factor /
// geo_multiplier, columns no migration creates, so every PostgreSQL insert failed
// with "Failed to record quest in database." In-memory tests could not see it.
const realPg = process.env.JDQ_REAL_PG_URL ? describe : describe.skip;

realPg('author quest creation persists to PostgreSQL', () => {
  let fixture: TestDbInstance;
  const authorId = `author-${randomUUID()}`;
  const spotId = `spot-${randomUUID()}`;
  const originalFunding = env.QUEST_FUNDING_ENABLED;

  beforeAll(async () => {
    fixture = await createTestDb();
    setPool(fixture.pool);
    db.usersRepo.setPool(fixture.pool);
    env.QUEST_FUNDING_ENABLED = false;
    await fixture.pool.query(
      'INSERT INTO users(id,seed_id,display_name,email,role,demo_points) VALUES($1,$2,$3,$4,$5,$6)',
      [authorId, authorId, 'Author', `${authorId}@example.test`, 'user', 100],
    );
    db.users.push({ id: authorId, seed_id: authorId, display_name: 'Author', email: `${authorId}@example.test`,
      role: 'user', demo_points: 100, is_test: false } as any);
    await fixture.pool.query(
      `INSERT INTO spots(id, slug, name, description, category, subcategory, municipality, address, gps_lat, gps_lng,
         status, is_test, recommendation_suppressed, source_type, source_name, created_by)
       VALUES($1::text, $1::text, 'Author Spot', 'A test destination for quest creation.', 'nature_outdoors', 'beach',
         'Bolinao', 'Patar, Bolinao', 16.3, 119.79, 'published', false, false, 'community', 'Author', $2)`,
      [spotId, authorId],
    );
    spotStore.spots.push({ id: spotId, slug: spotId, name: 'Author Spot', gps_lat: 16.3, gps_lng: 119.79,
      municipality: 'Bolinao', image_url: '', status: 'published', is_test: false, created_by: authorId } as any);
  });

  afterAll(async () => {
    env.QUEST_FUNDING_ENABLED = originalFunding;
    spotStore.spots = spotStore.spots.filter((s) => s.id !== spotId);
    setPool(null);
    db.usersRepo.setPool(null);
    if (fixture) await fixture.close();
  });

  it('creates the quest row with steps instead of failing on non-existent columns', async () => {
    const token = jwt.sign({ id: authorId, seed_id: authorId, role: 'user' }, env.JWT_SECRET);
    const res = await request(app)
      .post(`/api/v1/spots/${spotId}/quests`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        title: 'Patar sunrise walk',
        description: 'Walk the beach at sunrise and check in at the rocks.',
        category: 'eco',
        steps: [{ step_order: 1, title: 'Arrive', description: 'Check in at the beach.', checkpoint_type: 'location', required: true }],
      });
    expect(res.status).toBe(201);
    const row = await fixture.pool.query('SELECT id, author_id, steps FROM quests WHERE id = $1', [res.body.data.id]);
    expect(row.rows[0]?.author_id).toBe(authorId);
    expect(row.rows[0]?.steps).toHaveLength(1);
  });
});
