import request from 'supertest';
import { app } from '../src/app.js';
import { db } from '../src/db/index.js';
import jwt from 'jsonwebtoken';
import { env } from '../src/config/env.js';

describe('Phase 5: Sourced Privacy-Safe Rankings and Provenance', () => {
  const publicScoutId = '88888888-8888-8888-8888-888888888888';
  const privateScoutId = '99999999-9999-9999-9999-999999999999';
  const testScoutId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

  const publicScoutToken = jwt.sign(
    { id: publicScoutId, seed_id: 'public-scout-01', role: 'user' },
    env.JWT_SECRET
  );

  beforeAll(() => {
    // Add public scout
    db.users.push({
      id: publicScoutId,
      seed_id: 'public-scout-01',
      display_name: 'Alaminos Pioneer',
      handle: 'alaminospioneer',
      email: 'pioneer@alaminos.test',
      avatar_url: 'https://images.unsplash.com/photo-scout',
      role: 'user',
      demo_points: 350,
      mjdq_balance: 350000,
      jdq_governance_balance: 10,
      scout_reputation: 420,
      is_public: true,
      is_test: false,
      created_at: new Date(Date.now() - 30 * 86400000).toISOString(),
      updated_at: new Date().toISOString(),
    });

    // Add private scout (opted out of public identity display)
    db.users.push({
      id: privateScoutId,
      seed_id: 'private-scout-02',
      display_name: 'Secret Explorer',
      handle: 'secretexplorer',
      email: 'private@scout.test',
      avatar_url: '',
      role: 'user',
      demo_points: 500,
      mjdq_balance: 500000,
      jdq_governance_balance: 5,
      scout_reputation: 600,
      is_public: false,
      is_test: false,
      created_at: new Date(Date.now() - 20 * 86400000).toISOString(),
      updated_at: new Date().toISOString(),
    });

    // Add test user (must be completely excluded from rankings)
    db.users.push({
      id: testScoutId,
      seed_id: 'qa-tester-scout',
      display_name: 'QA Synthetic Scout',
      handle: 'qatester',
      email: 'qa@tester.test',
      avatar_url: '',
      role: 'user',
      demo_points: 99999,
      mjdq_balance: 99999000,
      jdq_governance_balance: 999,
      scout_reputation: 9999,
      is_public: true,
      is_test: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    // Add an approved submission for public scout
    db.submissions.push({
      id: `sub_public_${Date.now()}`,
      idempotency_key: `key_sub_${Date.now()}`,
      user_id: publicScoutId,
      quest_id: 'q1111111-1111-1111-1111-111111111111',
      scanned_marker_code: 'TEST_MARKER',
      captured_lat: 16.0,
      captured_lng: 120.0,
      captured_accuracy: 5,
      status: 'approved',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
  });

  test('1. GET /api/v1/leaderboard returns dynamic sourced rankings', async () => {
    const res = await request(app).get('/api/v1/leaderboard');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const data = res.body.data;
    expect(Array.isArray(data.top_scouts)).toBe(true);
    expect(data.provenance_note).toContain('dynamically from verified');

    // Synthetic QA scout must be excluded
    const qaFound = data.top_scouts.find((s: any) => s.user_id === testScoutId);
    expect(qaFound).toBeUndefined();
  });

  test('2. Protect privacy: Private scout identity is anonymized for public requests', async () => {
    const res = await request(app).get('/api/v1/leaderboard');

    expect(res.status).toBe(200);
    const privateEntry = res.body.data.top_scouts.find((s: any) => s.user_id === privateScoutId);
    if (privateEntry) {
      expect(privateEntry.display_name).toBe('Anonymous Scout');
      expect(privateEntry.handle).toBeNull();
      expect(privateEntry.avatar_url).toContain('seed=anon-');
    }
  });

  test('3. Authenticated scout lookup attaches my_rank and is_self', async () => {
    const res = await request(app)
      .get('/api/v1/leaderboard')
      .set('Authorization', `Bearer ${publicScoutToken}`);

    expect(res.status).toBe(200);
    const data = res.body.data;
    expect(data.my_rank).toBeDefined();
    expect(data.my_rank.user_id).toBe(publicScoutId);
    expect(data.my_rank.is_self).toBe(true);
    expect(data.my_rank.display_name).toBe('Alaminos Pioneer');
  });

  test('4. Support metric query parameter (quests_completed)', async () => {
    const res = await request(app).get('/api/v1/leaderboard?metric=quests_completed');

    expect(res.status).toBe(200);
    expect(res.body.data.metric).toBe('quests_completed');
    const scouts = res.body.data.top_scouts;
    if (scouts.length >= 2) {
      expect(scouts[0].approved_quests).toBeGreaterThanOrEqual(scouts[1].approved_quests);
    }
  });

  test('5. Aggregates top municipalities from approved submissions', async () => {
    const res = await request(app).get('/api/v1/leaderboard');

    expect(res.status).toBe(200);
    const towns = res.body.data.top_municipalities;
    expect(Array.isArray(towns)).toBe(true);
    for (const t of towns) {
      expect(t.name).toBeDefined();
      expect(t.quests_completed).toBeGreaterThanOrEqual(1);
    }
  });
});
