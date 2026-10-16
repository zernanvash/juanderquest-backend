import request from 'supertest';
import jwt from 'jsonwebtoken';
import { newDb } from 'pg-mem';
import { app } from '../src/app.js';
import { db } from '../src/db/index.js';
import { getPool, setPool } from '../src/db/pool.js';
import { env } from '../src/config/env.js';

describe('quest attempt durable authority', () => {
  const userId = 'a1252e55-7ad7-4ee9-b209-720a82c04237';
  const authorId = '8c8f56d3-a20c-4d91-b290-e9564a493125';
  const questId = 'durable-quest-proof-test';
  const token = jwt.sign({ id: userId, seed_id: 'durable-traveler', role: 'user' }, env.JWT_SECRET);

  beforeAll(async () => {
    const mem = newDb();
    mem.public.none(`CREATE TABLE users (id text PRIMARY KEY, is_test boolean NOT NULL DEFAULT false);
      CREATE TABLE quests (id text PRIMARY KEY, author_id text, is_test boolean NOT NULL DEFAULT false,
        status text NOT NULL, version integer NOT NULL, steps jsonb NOT NULL, funding_required boolean DEFAULT false);
      CREATE TABLE submissions (id text PRIMARY KEY, user_id text, quest_id text, status text);
      CREATE TABLE quest_attempts (id text PRIMARY KEY, quest_id text, user_id text,
        version integer, current_step integer, total_steps integer, status text,
        created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(), completed_at timestamptz);
      CREATE UNIQUE INDEX idx_quest_attempts_single_completion ON quest_attempts(user_id, quest_id) WHERE status = 'completed';
      CREATE TABLE reward_pools (id text, quest_id text, asset_code text, status text);
      CREATE TABLE quest_funding_plans (id text, quest_id text);`);
    mem.public.none(`INSERT INTO users(id) VALUES ('${userId}'), ('${authorId}');
      INSERT INTO quests(id, author_id, status, version, steps)
      VALUES ('${questId}', '${authorId}', 'published', 1,
        '[{"step_order":1,"title":"Arrive","checkpoint_type":"location","required":true}]');`);
    const adapter = mem.adapters.createPg();
    setPool(new adapter.Pool() as any);
    db.users.push({
      id: userId, seed_id: 'durable-traveler', display_name: 'Traveler', email: 'durable@example.test',
      avatar_url: '', role: 'user', demo_points: 0, mjdq_balance: 0, jdq_governance_balance: 0,
      scout_reputation: 0, is_public: false, created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    db.quests.push({
      id: questId, author_id: authorId, status: 'published', version: 1,
      steps: [{ step_order: 1, title: 'Arrive', description: 'Visit', checkpoint_type: 'location', required: true }],
      title: 'Durable test', description: 'Visit the destination', category: 'eco', location_name: 'Test',
      gps_lat: 16, gps_lng: 120, radius_meters: 100, base_reward_php: 0,
      difficulty_factor: 1, geo_multiplier: 1, reward_points: 50,
      marker_code: 'SECRET', marker_image_url: '', is_active: true,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    });
  });

  afterAll(() => {
    setPool(null);
    db.users = db.users.filter(user => user.id !== userId);
    db.quests = db.quests.filter(quest => quest.id !== questId);
    db.quest_attempts = db.quest_attempts.filter(attempt => attempt.quest_id !== questId);
  });

  it('resumes the same attempt from PostgreSQL after the in-memory mirror is cleared', async () => {
    const started = await request(app).post(`/api/v1/quests/${questId}/attempts`)
      .set('Authorization', `Bearer ${token}`);
    expect(started.status).toBe(201);
    const attemptId = started.body.data.id;
    db.quest_attempts = db.quest_attempts.filter(attempt => attempt.quest_id !== questId);

    const progress = await request(app).get(`/api/v1/quests/${questId}/progress`)
      .set('Authorization', `Bearer ${token}`);
    expect(progress.status).toBe(200);
    expect(progress.body.data.active_attempt.id).toBe(attemptId);

    const resumed = await request(app).post(`/api/v1/quests/${questId}/attempts`)
      .set('Authorization', `Bearer ${token}`);
    expect(resumed.status).toBe(200);
    expect(resumed.body.data.id).toBe(attemptId);
  });

  it('blocks a new attempt when the durable store records a completed attempt', async () => {
    await setPoolStatusCompletedAttempt();
    const started = await request(app).post(`/api/v1/quests/${questId}/attempts`)
      .set('Authorization', `Bearer ${token}`);
    expect(started.status).toBe(409);
    expect(started.body.error.code).toBe('ALREADY_COMPLETED');
  });

  async function setPoolStatusCompletedAttempt() {
    const pool = getPool();
    if (!pool) throw new Error('test pool missing');
    const current = await pool.query(
      'UPDATE quest_attempts SET status = $1 WHERE quest_id = $2 AND user_id = $3',
      ['completed', questId, userId],
    );
    expect(current.rowCount).toBe(1);
  }
});
