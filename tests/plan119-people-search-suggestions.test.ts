import { randomUUID } from 'crypto';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { app } from '../src/app.js';
import { env } from '../src/config/env.js';
import { db } from '../src/db/index.js';
import { MIGRATIONS } from '../src/db/migrations.js';
import { setPool } from '../src/db/pool.js';
import { createTestDb, type TestDbInstance } from '../src/db/testHarness.js';
import { invalidateSessionScopeCache } from '../src/middleware/auth.js';
import { resetRateLimits } from '../src/middleware/rateLimit.js';

const realPg = process.env.JDQ_REAL_PG_URL ? describe : describe.skip;
jest.setTimeout(180_000);

realPg('Plan 119: Plaza People Search & Unified Follow Suggestions (real PostgreSQL)', () => {
  let fixture: TestDbInstance;
  const suffix = randomUUID().slice(0, 8);

  const viewerId = `p119-viewer-${suffix}`;
  const coldViewerId = `p119-cold-${suffix}`;
  const testViewerId = `p119-testv-${suffix}`;

  const followsYouId = `p119-fb-${suffix}`;
  const mutualBridgeId = `p119-bridge-${suffix}`;
  const mutualTargetId = `p119-mutual-${suffix}`;
  const hometownId = `p119-home-${suffix}`;
  const sharedSpotId = `p119-shared-${suffix}`;
  const activeExplorerId = `p119-active-${suffix}`;
  const inactiveOtherId = `p119-inactive-${suffix}`;

  const privateUserId = `p119-priv-${suffix}`;
  const suspendedUserId = `p119-susp-${suffix}`;
  const testCandidateId = `p119-testc-${suffix}`;
  const typoTargetId = `p119-typo-${suffix}`;

  const token = (id: string, role = 'user') =>
    jwt.sign({ id, seed_id: id, role, typ: 'session', sep: 0 }, env.JWT_SECRET, { expiresIn: '1h' });
  const as = (id: string) => ({ Authorization: `Bearer ${token(id)}` });

  beforeAll(async () => {
    fixture = await createTestDb({ poolMax: 10 });
    setPool(fixture.pool);
    db.attachDurabilityPool(fixture.pool);
    invalidateSessionScopeCache();
    resetRateLimits();

    await fixture.pool.query(
      `INSERT INTO users (
         id, seed_id, display_name, email, handle, role, is_public, is_test, home_municipality, suspended_at, session_epoch
       ) VALUES
         ($1::text, $1::text, 'Viewer One', $1::text || '@example.test', 'viewer_one', 'user', TRUE, FALSE, 'Lingayen', NULL, 0),
         ($2::text, $2::text, 'Cold Viewer', $2::text || '@example.test', 'cold_viewer', 'user', TRUE, FALSE, NULL, NULL, 0),
         ($3::text, $3::text, 'QA Viewer', $3::text || '@example.test', 'qa_viewer', 'user', TRUE, TRUE, NULL, NULL, 0),
         ($4::text, $4::text, 'Follows Back', $4::text || '@example.test', 'follows_back', 'user', TRUE, FALSE, 'Dagupan', NULL, 0),
         ($5::text, $5::text, 'Mutual Bridge', $5::text || '@example.test', 'mutual_bridge', 'user', TRUE, FALSE, 'Dagupan', NULL, 0),
         ($6::text, $6::text, 'Mutual Friend', $6::text || '@example.test', 'mutual_friend', 'user', TRUE, FALSE, 'Dagupan', NULL, 0),
         ($7::text, $7::text, 'Hometown Mate', $7::text || '@example.test', 'hometown_mate', 'user', TRUE, FALSE, 'lingayen', NULL, 0),
         ($8::text, $8::text, 'Shared Spotter', $8::text || '@example.test', 'shared_spotter', 'user', TRUE, FALSE, 'Alaminos', NULL, 0),
         ($9::text, $9::text, 'Active Explorer', $9::text || '@example.test', 'active_explorer', 'user', TRUE, FALSE, 'Bolinao', NULL, 0),
         ($10::text, $10::text, 'Quiet Explorer', $10::text || '@example.test', 'quiet_explorer', 'user', TRUE, FALSE, 'Sual', NULL, 0),
         ($11::text, $11::text, 'Private User', $11::text || '@example.test', 'private_user', 'user', FALSE, FALSE, 'Lingayen', NULL, 0),
         ($12::text, $12::text, 'Suspended User', $12::text || '@example.test', 'suspended_user', 'user', TRUE, FALSE, 'Lingayen', NOW(), 0),
         ($13::text, $13::text, 'QA Candidate', $13::text || '@example.test', 'qa_candidate', 'user', TRUE, TRUE, 'Lingayen', NULL, 0),
         ($14::text, $14::text, 'Maria Clara', 'secret-email-only@example.test', 'maria_clara', 'user', TRUE, FALSE, 'Vigan', NULL, 0)`,
      [
        viewerId,
        coldViewerId,
        testViewerId,
        followsYouId,
        mutualBridgeId,
        mutualTargetId,
        hometownId,
        sharedSpotId,
        activeExplorerId,
        inactiveOtherId,
        privateUserId,
        suspendedUserId,
        testCandidateId,
        typoTargetId,
      ],
    );

    // viewer follows mutualBridgeId; followsYouId follows viewer; mutualBridgeId follows mutualTargetId
    await fixture.pool.query(
      `INSERT INTO user_follows (follower_id, following_id)
       VALUES ($1, $2), ($3, $1), ($2, $4)`,
      [viewerId, mutualBridgeId, followsYouId, mutualTargetId],
    );

    // Recent activity for activeExplorerId and testCandidateId (for QA cold-start isolation check)
    await fixture.pool.query(
      `INSERT INTO social_activities (
         id, event_key, actor_id, verb, subject_type, subject_id, subject_title, subject_href, is_test
       ) VALUES
         ($1, $2, $3, 'quest_completed', 'quest', 'q1', 'Quest One', '/quests/q1', FALSE),
         ($4, $5, $6, 'quest_completed', 'quest', 'q2', 'Quest Two', '/quests/q2', TRUE)`,
      [`act_${suffix}`, `evt_${suffix}`, activeExplorerId, `act_qa_${suffix}`, `evt_qa_${suffix}`, testCandidateId],
    );

    // Shared verified visit (spot) between viewerId and sharedSpotId
    const spotId = `p119-spot-${suffix}`;
    await fixture.pool.query(
      `INSERT INTO spots (id, slug, name, description, category, subcategory, municipality, address, gps_lat, gps_lng, price_level, source_type, source_name, trust_level, status)
       VALUES ($1::text, $1::text, 'Test Spot', 'Test', 'nature', 'beach', 'Lingayen', 'Lingayen', 16.0, 120.2, 0, 'community', 'test', 'verified', 'published')`,
      [spotId],
    );
    const questId = `p119-quest-${suffix}`;
    await fixture.pool.query(
      `INSERT INTO quests (id, title, description, category, location_name, gps_lat, gps_lng, marker_code, marker_image_url)
       VALUES ($1::text, 'Test Quest', 'Desc', 'eco', 'Lingayen', 16.0, 120.2, $2::text, 'http://x/m.png')`,
      [questId, `m-${suffix}`],
    );
    const sub1 = `sub1-${suffix}`;
    const sub2 = `sub2-${suffix}`;
    await fixture.pool.query(
      `INSERT INTO submissions (id, idempotency_key, user_id, quest_id, scanned_marker_code, captured_lat, captured_lng, captured_accuracy, status)
       VALUES ($1::text, $1::text, $3::text, $5::text, 'm', 16.0, 120.2, 5, 'approved'),
              ($2::text, $2::text, $4::text, $5::text, 'm', 16.0, 120.2, 5, 'approved')`,
      [sub1, sub2, viewerId, sharedSpotId, questId],
    );
    await fixture.pool.query(
      `INSERT INTO verified_visits (id, user_id, spot_id, source_submission_id, occurred_at)
       VALUES ($1, $3, $5, $6, NOW() - INTERVAL '2 days'), ($2, $4, $5, $7, NOW() - INTERVAL '3 days')`,
      [randomUUID(), randomUUID(), viewerId, sharedSpotId, spotId, sub1, sub2],
    );
  });

  afterAll(async () => {
    if (fixture) await fixture.close();
  });

  it('registers migration 115 right after 114 and creates user_suggestion_dismissals', async () => {
    const idx114 = MIGRATIONS.indexOf('114_user_suspension_and_risk_flags.sql');
    const idx115 = MIGRATIONS.indexOf('115_people_suggestion_dismissals.sql');
    expect(idx114).toBeGreaterThan(-1);
    expect(idx115).toBe(idx114 + 1);

    const tbl = await fixture.pool.query(`SELECT to_regclass('user_suggestion_dismissals') AS tbl`);
    expect(tbl.rows[0].tbl).toBe('user_suggestion_dismissals');
  });

  it('returns blended suggestions excluding self, followed, private, suspended, and mismatched is_test without leaking private fields', async () => {
    const res = await request(app).get('/api/v1/users/suggestions').set(as(viewerId));
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const items: Array<Record<string, unknown>> = res.body.data.items;
    const ids = items.map((i) => i.id);

    expect(ids).not.toContain(viewerId);
    expect(ids).not.toContain(mutualBridgeId); // already followed
    expect(ids).not.toContain(privateUserId);
    expect(ids).not.toContain(suspendedUserId);
    expect(ids).not.toContain(testCandidateId);

    // Relevant signals should be suggested; unrelated inactive user is excluded from signal pool
    expect(ids).toContain(followsYouId);
    expect(ids).toContain(hometownId);
    expect(ids).toContain(mutualTargetId);
    expect(ids).toContain(sharedSpotId);
    expect(ids).toContain(activeExplorerId);
    expect(ids).not.toContain(inactiveOtherId);

    for (const item of items) {
      expect(item.is_following).toBe(false);
      expect(item.email).toBeUndefined();
      expect(item.home_municipality).toBeUndefined();
      expect(item.distance_m).toBeUndefined();
      expect(item.mutual_count).toBeUndefined();
      expect(item.score).toBeUndefined();
      expect(item.reason).toBeUndefined();
    }
  });

  it('gives cold-start users active public explorers and isolates test users', async () => {
    const coldRes = await request(app).get('/api/v1/users/suggestions').set(as(coldViewerId));
    expect(coldRes.status).toBe(200);
    const coldIds = coldRes.body.data.items.map((i: any) => i.id);
    expect(coldIds).toContain(activeExplorerId);
    expect(coldIds).not.toContain(testCandidateId);

    const qaRes = await request(app).get('/api/v1/users/suggestions').set(as(testViewerId));
    expect(qaRes.status).toBe(200);
    const qaIds = qaRes.body.data.items.map((i: any) => i.id);
    expect(qaIds).toContain(testCandidateId);
    expect(qaIds).not.toContain(activeExplorerId);
  });

  it('dismisses a suggestion idempotently and excludes it from subsequent suggestions; validates self/unknown', async () => {
    const selfRes = await request(app).post(`/api/v1/users/suggestions/${viewerId}/dismiss`).set(as(viewerId));
    expect(selfRes.status).toBe(400);

    const unknownRes = await request(app)
      .post('/api/v1/users/suggestions/nonexistent-user-xyz/dismiss')
      .set(as(viewerId));
    expect(unknownRes.status).toBe(404);

    const d1 = await request(app).post(`/api/v1/users/suggestions/${hometownId}/dismiss`).set(as(viewerId));
    expect(d1.status).toBe(204);
    const d2 = await request(app).post(`/api/v1/users/suggestions/${hometownId}/dismiss`).set(as(viewerId));
    expect(d2.status).toBe(204);

    const afterRes = await request(app).get('/api/v1/users/suggestions').set(as(viewerId));
    expect(afterRes.status).toBe(200);
    const afterIds = afterRes.body.data.items.map((i: any) => i.id);
    expect(afterIds).not.toContain(hometownId);
  });

  it('searches people by @handle, name, and minor typos; never matches email; returns is_following and excludes suspended/private/test', async () => {
    const handleRes = await request(app)
      .get('/api/v1/search')
      .query({ type: 'people', mode: 'results', q: '@maria_clara' })
      .set(as(viewerId));
    expect(handleRes.status).toBe(200);
    expect(handleRes.body.data.items[0].id).toBe(typoTargetId);
    expect(handleRes.body.data.items[0].is_following).toBe(false);
    expect(handleRes.body.data.items[0].score).toBe(1);
    expect('bio' in handleRes.body.data.items[0]).toBe(true);
    expect('status_text' in handleRes.body.data.items[0]).toBe(true);
    expect(handleRes.body.data.items[0].email).toBeUndefined();

    // Followed user shows is_following: true
    const followedRes = await request(app)
      .get('/api/v1/search')
      .query({ type: 'people', mode: 'results', q: 'mutual_bridge' })
      .set(as(viewerId));
    expect(followedRes.status).toBe(200);
    expect(followedRes.body.data.items[0].id).toBe(mutualBridgeId);
    expect(followedRes.body.data.items[0].is_following).toBe(true);

    // Typo tolerance on display_name
    const typoRes = await request(app)
      .get('/api/v1/search')
      .query({ type: 'people', mode: 'results', q: 'maria clra' })
      .set(as(viewerId));
    expect(typoRes.status).toBe(200);
    expect(typoRes.body.data.items.some((i: any) => i.id === typoTargetId)).toBe(true);

    // Never matches email
    const emailRes = await request(app)
      .get('/api/v1/search')
      .query({ type: 'people', mode: 'results', q: 'secret-email-only' })
      .set(as(viewerId));
    expect(emailRes.status).toBe(200);
    expect(emailRes.body.data.items).toHaveLength(0);

    // Excludes suspended, private, and test users for normal viewer
    const privRes = await request(app)
      .get('/api/v1/search')
      .query({ type: 'people', mode: 'results', q: 'private_user' })
      .set(as(viewerId));
    expect(privRes.body.data.items).toHaveLength(0);

    const suspRes = await request(app)
      .get('/api/v1/search')
      .query({ type: 'people', mode: 'results', q: 'suspended_user' })
      .set(as(viewerId));
    expect(suspRes.body.data.items).toHaveLength(0);

    const qaRes = await request(app)
      .get('/api/v1/search')
      .query({ type: 'people', mode: 'results', q: 'qa_candidate' })
      .set(as(viewerId));
    expect(qaRes.body.data.items).toHaveLength(0);
  });

  it('includes accurate is_following on /users/me/followers and /users/me/following', async () => {
    const followersRes = await request(app).get('/api/v1/users/me/followers').set(as(viewerId));
    expect(followersRes.status).toBe(200);
    const fb = followersRes.body.data.items.find((i: any) => i.id === followsYouId);
    expect(fb).toBeDefined();
    expect(fb.is_following).toBe(false);

    const followingRes = await request(app).get('/api/v1/users/me/following').set(as(viewerId));
    expect(followingRes.status).toBe(200);
    const mb = followingRes.body.data.items.find((i: any) => i.id === mutualBridgeId);
    expect(mb).toBeDefined();
    expect(mb.is_following).toBe(true);
  });

  it('includes an older follows-you user on the first page even with 250 newer inactive users', async () => {
    const scaleViewerId = `p119-scale-v-${suffix}`;
    const olderFollowerId = `p119-scale-old-${suffix}`;
    await fixture.pool.query(
      `INSERT INTO users (
         id, seed_id, display_name, email, handle, role, is_public, is_test, created_at, session_epoch
       ) VALUES
         ($1::text, $1::text, 'Scale Viewer', $1::text || '@example.test', 'scale_viewer', 'user', TRUE, FALSE, NOW(), 0),
         ($2::text, $2::text, 'Older Follower', $2::text || '@example.test', 'older_follower', 'user', TRUE, FALSE, NOW() - INTERVAL '30 days', 0)`,
      [scaleViewerId, olderFollowerId],
    );
    await fixture.pool.query(
      `INSERT INTO users (
         id, seed_id, display_name, email, handle, role, is_public, is_test, created_at, session_epoch
       )
       SELECT
         $1::text || '-' || g::text,
         $1::text || '-' || g::text,
         'Newer Inactive ' || g::text,
         $1::text || '-' || g::text || '@example.test',
         'newer_inactive_' || g::text,
         'user',
         TRUE,
         FALSE,
         NOW(),
         0
       FROM generate_series(1, 250) AS g`,
      [`p119-scale-new-${suffix}`],
    );
    await fixture.pool.query(`INSERT INTO user_follows (follower_id, following_id) VALUES ($1, $2)`, [
      olderFollowerId,
      scaleViewerId,
    ]);

    const res = await request(app).get('/api/v1/users/suggestions').set(as(scaleViewerId));
    expect(res.status).toBe(200);
    const ids = res.body.data.items.map((i: any) => i.id);
    expect(ids).toContain(olderFollowerId);
  });
});
