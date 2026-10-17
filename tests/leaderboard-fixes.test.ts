import request from 'supertest';
import { app } from '../src/app.js';
import { db } from '../src/db/index.js';
import jwt from 'jsonwebtoken';
import { env } from '../src/config/env.js';

describe('Leaderboard fixes (Bugs A & B)', () => {
  const userId = '12345678-1234-1234-1234-123456789012';
  const token = jwt.sign(
    { id: userId, seed_id: 'test-user', role: 'user' },
    env.JWT_SECRET
  );

  beforeAll(() => {
    db.users.push({
      id: userId,
      seed_id: 'test-user',
      display_name: 'Cookie Scout',
      handle: 'cookiescout',
      email: 'cookie@scout.test',
      avatar_url: '',
      role: 'user',
      demo_points: 200,
      mjdq_balance: 200000,
      jdq_governance_balance: 5,
      scout_reputation: 250,
      is_public: true,
      is_test: false,
      created_at: new Date(Date.now() - 30 * 86400000).toISOString(),
      updated_at: new Date().toISOString(),
    });

    db.quests.push({
      id: 'quest-bug-test',
      title: 'Bug Test Quest',
      description: 'Testing weekly approval filter',
      category: 'eco',
      location_name: 'Bolinao',
      gps_lat: 16.3,
      gps_lng: 119.8,
      radius_meters: 100,
      reward_points: 50,
      marker_code: 'JDQ-BUGTEST',
      marker_image_url: '',
      is_active: true,
      is_test: false,
      created_at: new Date(Date.now() - 20 * 86400000).toISOString(),
      updated_at: new Date().toISOString(),
    });

    // Submission created 10 days ago, but approved yesterday!
    db.submissions.push({
      id: 'sub-bug-test',
      idempotency_key: 'idemp-bug-test',
      user_id: userId,
      quest_id: 'quest-bug-test',
      scanned_marker_code: 'JDQ-BUGTEST',
      captured_lat: 16.3,
      captured_lng: 119.8,
      captured_accuracy: 10,
      status: 'approved',
      reviewed_by: 'admin',
      reviewed_at: new Date(Date.now() - 86400000).toISOString(), // 1 day ago
      created_at: new Date(Date.now() - 10 * 86400000).toISOString(), // 10 days ago
      updated_at: new Date(Date.now() - 86400000).toISOString(),
      is_test: false,
    });
  });

  afterAll(() => {
    db.users = db.users.filter((u) => u.id !== userId);
    db.quests = db.quests.filter((q) => q.id !== 'quest-bug-test');
    db.submissions = db.submissions.filter((s) => s.id !== 'sub-bug-test');
  });

  it('Bug A: extracts user from session cookie and returns my_rank', async () => {
    const res = await request(app)
      .get('/api/v1/leaderboard')
      .set('Cookie', [`jdq_session=${token}`]);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.my_rank).toBeDefined();
    expect(res.body.data.my_rank.user_id).toBe(userId);
    expect(res.body.data.my_rank.display_name).toBe('Cookie Scout');
  });

  it('Bug B: a submission created 10 days ago but approved yesterday counts in weekly leaderboard', async () => {
    const res = await request(app)
      .get('/api/v1/leaderboard?timeframe=weekly&metric=quests_completed')
      .set('Cookie', [`jdq_session=${token}`]);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.timeframe).toBe('weekly');
    // The user should have approved_quests = 1 in weekly
    expect(res.body.data.my_rank).toBeDefined();
    expect(res.body.data.my_rank.approved_quests).toBeGreaterThanOrEqual(1);
  });
});
