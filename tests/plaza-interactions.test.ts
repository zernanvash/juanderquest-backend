import { createTestDb, TestDbInstance } from '../src/db/testHarness.js';
import { setPool } from '../src/db/pool.js';
import { db } from '../src/db/index.js';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { app } from '../src/app.js';
import { env } from '../src/config/env.js';
import { recordActivity } from '../src/social/activity.js';

describe('Plan 41 Phase 3: Interactions, Comments, Moderation & Preferences', () => {
  let testDb: TestDbInstance;

  const userAlpha = {
    id: 'u1111111-1111-1111-1111-111111111111',
    seed_id: 'seed_alpha',
    display_name: 'Alpha Explorer',
    handle: 'alpha',
    email: 'alpha@traveler.test',
    is_public: true,
    share_activity: true,
    is_test: false,
    role: 'user',
  };

  const userBeta = {
    id: 'u2222222-2222-2222-2222-222222222222',
    seed_id: 'seed_beta',
    display_name: 'Beta Wanderer',
    handle: 'beta',
    email: 'beta@traveler.test',
    is_public: true,
    share_activity: true,
    is_test: false,
    role: 'user',
  };

  const userPrivate = {
    id: 'u3333333-3333-3333-3333-333333333333',
    seed_id: 'seed_private',
    display_name: 'Private Ghost',
    handle: 'ghost',
    email: 'ghost@traveler.test',
    is_public: false,
    share_activity: true,
    is_test: false,
    role: 'user',
  };

  const userReporter2 = {
    id: 'u5555555-5555-5555-5555-555555555555',
    seed_id: 'seed_rep2',
    display_name: 'Reporter Two',
    handle: 'rep2',
    email: 'rep2@traveler.test',
    is_public: true,
    share_activity: true,
    is_test: false,
    role: 'user',
  };

  const userReporter3 = {
    id: 'u6666666-6666-6666-6666-666666666666',
    seed_id: 'seed_rep3',
    display_name: 'Reporter Three',
    handle: 'rep3',
    email: 'rep3@traveler.test',
    is_public: true,
    share_activity: true,
    is_test: false,
    role: 'user',
  };

  const userAdmin = {
    id: 'u4444444-4444-4444-4444-444444444444',
    seed_id: 'seed_admin',
    display_name: 'Super Admin',
    handle: 'admin',
    email: 'admin@traveler.test',
    is_public: true,
    share_activity: true,
    is_test: false,
    role: 'admin',
  };

  const tokenAlpha = jwt.sign(
    { id: userAlpha.id, seed_id: userAlpha.seed_id, role: 'user' },
    env.JWT_SECRET,
  );

  const tokenBeta = jwt.sign(
    { id: userBeta.id, seed_id: userBeta.seed_id, role: 'user' },
    env.JWT_SECRET,
  );

  const tokenPrivate = jwt.sign(
    { id: userPrivate.id, seed_id: userPrivate.seed_id, role: 'user' },
    env.JWT_SECRET,
  );

  const tokenReporter2 = jwt.sign(
    { id: userReporter2.id, seed_id: userReporter2.seed_id, role: 'user' },
    env.JWT_SECRET,
  );

  const tokenReporter3 = jwt.sign(
    { id: userReporter3.id, seed_id: userReporter3.seed_id, role: 'user' },
    env.JWT_SECRET,
  );

  const tokenAdmin = jwt.sign(
    { id: userAdmin.id, seed_id: userAdmin.seed_id, role: 'admin' },
    env.JWT_SECRET,
  );

  let sampleActivityId: string;

  beforeAll(async () => {
    testDb = await createTestDb();
    setPool(testDb.pool);
    db.usersRepo.setPool(testDb.pool);

    // Insert test users
    for (const u of [userAlpha, userBeta, userPrivate, userReporter2, userReporter3, userAdmin]) {
      await testDb.pool.query(
        `INSERT INTO users (id, seed_id, display_name, email, handle, is_public, share_activity, is_test, role)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (id) DO NOTHING`,
        [u.id, u.seed_id, u.display_name, u.email, u.handle, u.is_public, u.share_activity, u.is_test, u.role],
      );
    }

    // Create a sample activity by Alpha
    const client = await testDb.pool.connect();
    try {
      const actId = await recordActivity(client, {
        eventKey: 'quest_completed:alpha:q100',
        actorId: userAlpha.id,
        verb: 'quest_completed',
        subjectType: 'quest',
        subjectId: 'q100',
        subjectTitle: 'Lingayen Capitol Walk',
        subjectHref: '/quests/q100',
        municipality: 'Lingayen',
        payload: { points: 100 },
        isTest: false,
      });
      sampleActivityId = actId!;
    } finally {
      client.release();
    }
  });

  afterAll(async () => {
    if (testDb) {
      await testDb.close();
    }
  });

  describe('Cheers (PUT/DELETE /plaza/activities/:id/cheer)', () => {
    it('cheer is idempotent and increments count; notifies activity owner', async () => {
      // Beta cheers Alpha's activity
      const res1 = await request(app)
        .put(`/api/v1/plaza/activities/${sampleActivityId}/cheer`)
        .set('Authorization', `Bearer ${tokenBeta}`)
        .expect(200);

      expect(res1.body.success).toBe(true);
      expect(res1.body.data.cheered).toBe(true);
      expect(res1.body.data.cheer_count).toBe(1);

      // Repeat cheer (idempotent)
      const res2 = await request(app)
        .put(`/api/v1/plaza/activities/${sampleActivityId}/cheer`)
        .set('Authorization', `Bearer ${tokenBeta}`)
        .expect(200);

      expect(res2.body.data.cheered).toBe(true);
      expect(res2.body.data.cheer_count).toBe(1);

      // Check notification sent to Alpha
      const notifs = await testDb.pool.query(
        `SELECT * FROM user_notifications WHERE user_id = $1 AND kind = 'cheer'`,
        [userAlpha.id],
      );
      expect(notifs.rows.length).toBe(1);
      expect(notifs.rows[0].title).toBe('👏 Cheers!');
      expect(notifs.rows[0].message).toContain('Beta Wanderer cheered your Lingayen Capitol Walk.');
    });

    it('private viewer cheer is allowed, increments count, and notifies as "Someone"', async () => {
      const res = await request(app)
        .put(`/api/v1/plaza/activities/${sampleActivityId}/cheer`)
        .set('Authorization', `Bearer ${tokenPrivate}`)
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.cheered).toBe(true);
      expect(res.body.data.cheer_count).toBe(2);

      // Check notification
      const notifs = await testDb.pool.query(
        `SELECT * FROM user_notifications WHERE user_id = $1 AND event_key = $2`,
        [userAlpha.id, `cheer:${sampleActivityId}:${userPrivate.id}`],
      );
      expect(notifs.rows.length).toBe(1);
      expect(notifs.rows[0].message).toContain('Someone cheered your Lingayen Capitol Walk.');
    });

    it('uncheer decrements count and never goes below 0', async () => {
      const res1 = await request(app)
        .delete(`/api/v1/plaza/activities/${sampleActivityId}/cheer`)
        .set('Authorization', `Bearer ${tokenBeta}`)
        .expect(200);

      expect(res1.body.data.cheered).toBe(false);
      expect(res1.body.data.cheer_count).toBe(1);

      // Repeat uncheer
      const res2 = await request(app)
        .delete(`/api/v1/plaza/activities/${sampleActivityId}/cheer`)
        .set('Authorization', `Bearer ${tokenBeta}`)
        .expect(200);

      expect(res2.body.data.cheered).toBe(false);
      expect(res2.body.data.cheer_count).toBe(1);
    });
  });

  describe('Comments (POST/GET/DELETE /plaza/activities/:id/comments)', () => {
    let createdCommentId: string;

    it('rejects commenting for private profiles with 403 PUBLIC_PROFILE_REQUIRED', async () => {
      const res = await request(app)
        .post(`/api/v1/plaza/activities/${sampleActivityId}/comments`)
        .set('Authorization', `Bearer ${tokenPrivate}`)
        .send({
          body: 'Great job!',
          idempotency_key: 'idemp-priv-001',
        })
        .expect(403);

      expect(res.body.error.code).toBe('PUBLIC_PROFILE_REQUIRED');
    });

    it('rejects profanity and links with 422 COMMENT_REJECTED', async () => {
      // Profanity
      const res1 = await request(app)
        .post(`/api/v1/plaza/activities/${sampleActivityId}/comments`)
        .set('Authorization', `Bearer ${tokenBeta}`)
        .send({
          body: 'You are so gago man!',
          idempotency_key: 'idemp-bad-001',
        })
        .expect(422);

      expect(res1.body.error.code).toBe('COMMENT_REJECTED');

      // Hyperlink
      const res2 = await request(app)
        .post(`/api/v1/plaza/activities/${sampleActivityId}/comments`)
        .set('Authorization', `Bearer ${tokenBeta}`)
        .send({
          body: 'Check out https://spam.site for free tokens!',
          idempotency_key: 'idemp-bad-002',
        })
        .expect(422);

      expect(res2.body.error.code).toBe('COMMENT_REJECTED');
    });

    it('posts a valid comment (201) and replays idempotently (200)', async () => {
      const res1 = await request(app)
        .post(`/api/v1/plaza/activities/${sampleActivityId}/comments`)
        .set('Authorization', `Bearer ${tokenBeta}`)
        .send({
          body: 'Awesome exploration! Keep it up!',
          idempotency_key: 'idemp-beta-001',
        })
        .expect(201);

      expect(res1.body.success).toBe(true);
      expect(res1.body.data.body).toBe('Awesome exploration! Keep it up!');
      expect(res1.body.data.author.display_name).toBe('Beta Wanderer');
      createdCommentId = res1.body.data.id;

      // Idempotent replay
      const res2 = await request(app)
        .post(`/api/v1/plaza/activities/${sampleActivityId}/comments`)
        .set('Authorization', `Bearer ${tokenBeta}`)
        .send({
          body: 'Awesome exploration! Keep it up!',
          idempotency_key: 'idemp-beta-001',
        })
        .expect(200);

      expect(res2.body.data.id).toBe(createdCommentId);

      // Notification sent to Alpha
      const notifs = await testDb.pool.query(
        `SELECT * FROM user_notifications WHERE user_id = $1 AND kind = 'comment'`,
        [userAlpha.id],
      );
      expect(notifs.rows.length).toBe(1);
      expect(notifs.rows[0].message).toContain('Beta Wanderer: "Awesome exploration! Keep it up!"');
    });

    it('lists comments in chronological order with permissions flags', async () => {
      // Alpha views comments
      const res = await request(app)
        .get(`/api/v1/plaza/activities/${sampleActivityId}/comments`)
        .set('Authorization', `Bearer ${tokenAlpha}`)
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.items.length).toBeGreaterThanOrEqual(1);
      const cmt = res.body.data.items.find((c: any) => c.id === createdCommentId);
      expect(cmt).toBeDefined();
      expect(cmt.can_delete).toBe(true); // Activity owner can delete any comment on their activity
      expect(cmt.can_report).toBe(true);
    });

    it('deletes comment by activity owner or author', async () => {
      // Create a comment by Beta
      const addRes = await request(app)
        .post(`/api/v1/plaza/activities/${sampleActivityId}/comments`)
        .set('Authorization', `Bearer ${tokenBeta}`)
        .send({
          body: 'Delete me soon!',
          idempotency_key: 'idemp-beta-del-001',
        })
        .expect(201);

      const delId = addRes.body.data.id;

      // Alpha (activity owner) deletes it
      const delRes = await request(app)
        .delete(`/api/v1/plaza/comments/${delId}`)
        .set('Authorization', `Bearer ${tokenAlpha}`)
        .expect(200);

      expect(delRes.body.data.deleted).toBe(true);

      // Deleted comment no longer listed
      const listRes = await request(app)
        .get(`/api/v1/plaza/activities/${sampleActivityId}/comments`)
        .expect(200);

      expect(listRes.body.data.items.some((c: any) => c.id === delId)).toBe(false);
    });
  });

  describe('Reports & Auto-Hide', () => {
    let reportCommentId: string;

    beforeAll(async () => {
      const res = await request(app)
        .post(`/api/v1/plaza/activities/${sampleActivityId}/comments`)
        .set('Authorization', `Bearer ${tokenBeta}`)
        .send({
          body: 'This comment will get reported by 3 users.',
          idempotency_key: 'idemp-report-test-001',
        })
        .expect(201);
      reportCommentId = res.body.data.id;
    });

    it('auto-hides comment after 3 distinct reports', async () => {
      // Report 1: by Alpha
      await request(app)
        .post(`/api/v1/plaza/comments/${reportCommentId}/report`)
        .set('Authorization', `Bearer ${tokenAlpha}`)
        .send({ reason: 'spam', note: 'annoying' })
        .expect(200);

      // Report 2: by Reporter 2
      await request(app)
        .post(`/api/v1/plaza/comments/${reportCommentId}/report`)
        .set('Authorization', `Bearer ${tokenReporter2}`)
        .send({ reason: 'harassment' })
        .expect(200);

      // Comment should still be visible (2 reports)
      let list = await request(app)
        .get(`/api/v1/plaza/activities/${sampleActivityId}/comments`)
        .expect(200);
      let found = list.body.data.items.find((c: any) => c.id === reportCommentId);
      expect(found).toBeDefined();

      // Report 3: by Reporter 3
      await request(app)
        .post(`/api/v1/plaza/comments/${reportCommentId}/report`)
        .set('Authorization', `Bearer ${tokenReporter3}`)
        .send({ reason: 'other', note: 'threshold hit' })
        .expect(200);

      // Now hidden for normal visitors
      list = await request(app)
        .get(`/api/v1/plaza/activities/${sampleActivityId}/comments`)
        .expect(200);
      found = list.body.data.items.find((c: any) => c.id === reportCommentId);
      expect(found).toBeUndefined();

      // Author sees "Hidden pending review"
      const authorList = await request(app)
        .get(`/api/v1/plaza/activities/${sampleActivityId}/comments`)
        .set('Authorization', `Bearer ${tokenBeta}`)
        .expect(200);
      const authorFound = authorList.body.data.items.find((c: any) => c.id === reportCommentId);
      expect(authorFound).toBeDefined();
      expect(authorFound.body).toBe('Hidden pending review');
      expect(authorFound.hidden_pending_review).toBe(true);
    });
  });

  describe('Author Hide & Admin Moderation', () => {
    it('author can hide their activity via DELETE /plaza/activities/:id', async () => {
      const res = await request(app)
        .delete(`/api/v1/plaza/activities/${sampleActivityId}`)
        .set('Authorization', `Bearer ${tokenAlpha}`)
        .expect(200);

      expect(res.body.data.hidden).toBe(true);

      // Activity is now 404
      await request(app)
        .get(`/api/v1/plaza/activities/${sampleActivityId}`)
        .expect(404);
    });

    it('admin can list reports and restore/hide comments and activities', async () => {
      // Admin lists reports
      const reportsRes = await request(app)
        .get('/api/v1/admin/plaza/reports?status=open')
        .set('Authorization', `Bearer ${tokenAdmin}`)
        .expect(200);

      expect(reportsRes.body.success).toBe(true);
      expect(reportsRes.body.data.length).toBeGreaterThanOrEqual(1);

      const reportedGroup = reportsRes.body.data[0];
      const commentId = reportedGroup.comment.id;

      // Admin restores the comment
      const patchRes = await request(app)
        .patch(`/api/v1/admin/plaza/comments/${commentId}`)
        .set('Authorization', `Bearer ${tokenAdmin}`)
        .send({ action: 'restore', note: 'False positive' })
        .expect(200);

      expect(patchRes.body.success).toBe(true);
      expect(patchRes.body.data.hidden_at).toBeNull();

      // Admin restores the activity
      const actPatch = await request(app)
        .patch(`/api/v1/admin/plaza/activities/${sampleActivityId}`)
        .set('Authorization', `Bearer ${tokenAdmin}`)
        .send({ action: 'restore' })
        .expect(200);

      expect(actPatch.body.success).toBe(true);
      expect(actPatch.body.data.hidden_at).toBeNull();
    });
  });

  describe('User Settings, Devices & Privacy', () => {
    it('PUT /me/privacy updates share_activity', async () => {
      const res = await request(app)
        .put('/api/v1/me/privacy')
        .set('Authorization', `Bearer ${tokenAlpha}`)
        .send({ share_activity: false })
        .expect(200);

      expect(res.body.data.share_activity).toBe(false);

      // Turn back on
      const res2 = await request(app)
        .put('/api/v1/me/privacy')
        .set('Authorization', `Bearer ${tokenAlpha}`)
        .send({ share_activity: true })
        .expect(200);

      expect(res2.body.data.share_activity).toBe(true);
    });

    it('GET & PUT /me/notification-preferences updates preference booleans', async () => {
      // Default preferences
      const get1 = await request(app)
        .get('/api/v1/me/notification-preferences')
        .set('Authorization', `Bearer ${tokenAlpha}`)
        .expect(200);

      expect(get1.body.data.push_overtaken).toBe(true);
      expect(get1.body.data.quiet_hours).toBe(true);

      // Update quiet_hours = false
      const putRes = await request(app)
        .put('/api/v1/me/notification-preferences')
        .set('Authorization', `Bearer ${tokenAlpha}`)
        .send({ quiet_hours: false, push_overtaken: false })
        .expect(200);

      expect(putRes.body.data.quiet_hours).toBe(false);
      expect(putRes.body.data.push_overtaken).toBe(false);
      expect(putRes.body.data.push_social).toBe(true); // preserved
    });

    it('PUT & DELETE /me/devices manages FCM device tokens', async () => {
      const tokenStr = 'fcm_test_device_token_1234567890_abcdef';

      // Register device
      const regRes = await request(app)
        .put('/api/v1/me/devices')
        .set('Authorization', `Bearer ${tokenAlpha}`)
        .send({
          token: tokenStr,
          platform: 'android',
          app_build: 104,
        })
        .expect(200);

      expect(regRes.body.data.registered).toBe(true);

      // Verify in DB
      const devCheck = await testDb.pool.query(
        'SELECT * FROM user_devices WHERE token = $1',
        [tokenStr],
      );
      expect(devCheck.rows.length).toBe(1);
      expect(devCheck.rows[0].user_id).toBe(userAlpha.id);

      // Remove device
      const delRes = await request(app)
        .delete('/api/v1/me/devices')
        .set('Authorization', `Bearer ${tokenAlpha}`)
        .send({ token: tokenStr })
        .expect(200);

      expect(delRes.body.data.removed).toBe(true);

      const devCheckAfter = await testDb.pool.query(
        'SELECT * FROM user_devices WHERE token = $1',
        [tokenStr],
      );
      expect(devCheckAfter.rows.length).toBe(0);
    });
  });
});
