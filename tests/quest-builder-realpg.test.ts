import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { Pool } from 'pg';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { app } from '../src/app.js';
import { db } from '../src/db/index.js';
import { env } from '../src/config/env.js';
import { setPool } from '../src/db/pool.js';
import { MIGRATIONS } from '../src/db/migrations.js';
import { spotStore } from '../src/spots/store.js';
import { createTestDb, type TestDbInstance } from '../src/db/testHarness.js';
import { signQuestChallenge } from '../src/auth/tokens.js';
import { invalidateSessionScopeCache } from '../src/middleware/auth.js';

const realPg = process.env.JDQ_REAL_PG_URL ? describe : describe.skip;

realPg('Plan 43 Quest Builder & Multi-Task Verification Suite (Real PostgreSQL)', () => {
  let fixture: TestDbInstance;
  const authorId = `author-${randomUUID()}`;
  const travelerId = `traveler-${randomUUID()}`;
  const adminId = `admin-${randomUUID()}`;
  const otherUserId = `other-${randomUUID()}`;

  const spotId = `spot-${randomUUID()}`;
  const spotLat = 16.3000;
  const spotLng = 119.7900;
  const originalFunding = env.QUEST_FUNDING_ENABLED;

  const authorToken = jwt.sign({ id: authorId, seed_id: authorId, role: 'user', typ: 'session' }, env.JWT_SECRET);
  const travelerToken = jwt.sign({ id: travelerId, seed_id: travelerId, role: 'user', typ: 'session' }, env.JWT_SECRET);
  const adminToken = jwt.sign({ id: adminId, seed_id: adminId, role: 'admin', typ: 'session' }, env.JWT_SECRET);
  const otherToken = jwt.sign({ id: otherUserId, seed_id: otherUserId, role: 'user', typ: 'session' }, env.JWT_SECRET);

  let createdQuestId: string;
  let qrMarkerCode: string;

  beforeAll(async () => {
    fixture = await createTestDb();
    setPool(fixture.pool);
    db.usersRepo.setPool(fixture.pool);
    env.QUEST_FUNDING_ENABLED = false;

    // Seed users
    for (const u of [
      { id: authorId, role: 'user', name: 'Author' },
      { id: travelerId, role: 'user', name: 'Traveler' },
      { id: adminId, role: 'admin', name: 'Admin' },
      { id: otherUserId, role: 'user', name: 'Other' },
    ]) {
      await fixture.pool.query(
        'INSERT INTO users(id, seed_id, display_name, email, role, demo_points) VALUES($1, $2, $3, $4, $5, $6)',
        [u.id, u.id, u.name, `${u.id}@example.test`, u.role, 100]
      );
      db.users.push({
        id: u.id,
        seed_id: u.id,
        display_name: u.name,
        email: `${u.id}@example.test`,
        role: u.role as any,
        demo_points: 100,
        is_test: false,
      } as any);
    }

    // Seed spot
    await fixture.pool.query(
      `INSERT INTO spots(id, slug, name, description, category, subcategory, municipality, address, gps_lat, gps_lng,
         status, is_test, recommendation_suppressed, source_type, source_name, created_by)
       VALUES($1::text, $1::text, 'Patar Test Beach', 'A destination for Plan 43 testing.', 'nature_outdoors', 'beach',
         'Bolinao', 'Patar, Bolinao', $2, $3, 'published', false, false, 'community', 'Author', $4)`,
      [spotId, spotLat, spotLng, authorId]
    );
    spotStore.spots.push({
      id: spotId,
      slug: spotId,
      name: 'Patar Test Beach',
      gps_lat: spotLat,
      gps_lng: spotLng,
      municipality: 'Bolinao',
      image_url: '',
      status: 'published',
      is_test: false,
      created_by: authorId,
    } as any);
  });

  afterAll(async () => {
    env.QUEST_FUNDING_ENABLED = originalFunding;
    spotStore.spots = spotStore.spots.filter((s) => s.id !== spotId);
    setPool(null);
    db.usersRepo.setPool(null);
    if (fixture) await fixture.close();
  });

  describe('Phase 2 Authoring API', () => {
    it('rejects quest creation if any task is further than 5 km (TASK_TOO_FAR)', async () => {
      const res = await request(app)
        .post(`/api/v1/spots/${spotId}/quests`)
        .set('Authorization', `Bearer ${authorToken}`)
        .send({
          title: 'Faraway Task Quest',
          description: 'A quest with a task far away from Patar beach.',
          category: 'eco',
          tasks: [
            {
              title: 'Far task',
              description: 'Too far away',
              checkpoint_type: 'location',
              verification: {
                type: 'location',
                fence: { lat: 16.5000, lng: 119.7900, radius_meters: 100 }, // ~22 km away
              },
            },
          ],
        });

      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('TASK_TOO_FAR');
    });

    it('creates a multi-task quest with step_order_mode = "any" and ignores client marker_code', async () => {
      const res = await request(app)
        .post(`/api/v1/spots/${spotId}/quests`)
        .set('Authorization', `Bearer ${authorToken}`)
        .send({
          title: 'Patar Multi-Task Adventure',
          description: 'Complete all 4 tasks in any order you choose!',
          category: 'eco',
          step_order_mode: 'any',
          tasks: [
            {
              title: 'Check-in at the Sandbar',
              description: 'Walk onto the sandbar at low tide.',
              checkpoint_type: 'location',
              required: true,
              verification: {
                type: 'location',
                fence: { lat: spotLat + 0.001, lng: spotLng + 0.001, radius_meters: 150 },
              },
            },
            {
              title: 'Scan Heritage Board QR',
              description: 'Scan the brass QR plaque near the lighthouse.',
              checkpoint_type: 'qr',
              required: true,
              marker_code: 'CLIENT-SUPPLIED-SPOOF', // Should be ignored
              verification: {
                type: 'qr',
                fence: { lat: spotLat + 0.002, lng: spotLng + 0.002, radius_meters: 100 },
              },
            },
            {
              title: 'Photograph Rock Formations',
              description: 'Take a photo of the rock arches.',
              checkpoint_type: 'photo',
              required: true,
              verification: {
                type: 'photo',
                prompt: 'Capture the waves crashing against the rocks',
                fence: { lat: spotLat + 0.003, lng: spotLng + 0.003, radius_meters: 200 },
                require_gps: true,
              },
            },
            {
              title: 'Find AR Coral Gem',
              description: 'Find the AR virtual gem floating over the reef.',
              checkpoint_type: 'ar',
              required: false, // Optional task
              verification: {
                type: 'ar',
                fence: { lat: spotLat + 0.0015, lng: spotLng + 0.0015, radius_meters: 50 },
                object: 'gem',
                color: '#3B82F6',
              },
            },
          ],
        });

      expect(res.status).toBe(201);
      createdQuestId = res.body.data.id;
      expect(createdQuestId).toBeDefined();
      expect(res.body.data.step_order_mode).toBe('any');
      expect(res.body.data.steps).toHaveLength(4);

      // Verify client marker code was ignored and generated by server
      const qrTask = res.body.data.steps[1];
      expect(qrTask.marker_code).not.toBe('CLIENT-SUPPLIED-SPOOF');
      expect(qrTask.marker_code).toBeDefined();
      qrMarkerCode = qrTask.marker_code;
    });

    it('GET /quests/:id/edit returns full definition including marker_code for author/admin only', async () => {
      // Other user -> 403
      const forbiddenRes = await request(app)
        .get(`/api/v1/quests/${createdQuestId}/edit`)
        .set('Authorization', `Bearer ${otherToken}`);
      expect(forbiddenRes.status).toBe(403);

      // Author -> 200 with marker_code
      const authorRes = await request(app)
        .get(`/api/v1/quests/${createdQuestId}/edit`)
        .set('Authorization', `Bearer ${authorToken}`);
      expect(authorRes.status).toBe(200);
      expect(authorRes.body.data.tasks[1].marker_code).toBe(qrMarkerCode);

      // Traveler detail view (public) strips marker_code
      const publicRes = await request(app)
        .get(`/api/v1/quests/${createdQuestId}`)
        .set('Authorization', `Bearer ${travelerToken}`);
      expect(publicRes.status).toBe(200);
      expect(publicRes.body.data.steps[1].marker_code).toBeUndefined();
      expect(publicRes.body.data.steps[1].verification.marker_code).toBeUndefined();
    });

    it('GET /quests/:id/qr-sheet returns printable sheet with secret marker_code', async () => {
      const res = await request(app)
        .get(`/api/v1/quests/${createdQuestId}/qr-sheet`)
        .set('Authorization', `Bearer ${authorToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.qr_tasks).toHaveLength(1);
      expect(res.body.data.qr_tasks[0].marker_code).toBe(qrMarkerCode);
      expect(res.body.data.qr_tasks[0].qr_payload).toBe(qrMarkerCode);
    });

    it('PATCH /quests/:id bumps version on published quest while preserving task keys & QR codes', async () => {
      const editRes = await request(app)
        .get(`/api/v1/quests/${createdQuestId}/edit`)
        .set('Authorization', `Bearer ${authorToken}`);
      const currentTasks = editRes.body.data.tasks;

      // Update title and keep tasks
      const patchRes = await request(app)
        .patch(`/api/v1/quests/${createdQuestId}`)
        .set('Authorization', `Bearer ${authorToken}`)
        .send({
          expected_version: 1,
          title: 'Patar Multi-Task Adventure (Updated)',
          tasks: currentTasks,
        });

      expect(patchRes.status).toBe(200);
      expect(patchRes.body.data.version).toBe(2);
      expect(patchRes.body.data.tasks[1].marker_code).toBe(qrMarkerCode);
      expect(patchRes.body.data.tasks[0].key).toBe(currentTasks[0].key);

      // Second patch with stale version -> 409 VERSION_CONFLICT
      const staleRes = await request(app)
        .patch(`/api/v1/quests/${createdQuestId}`)
        .set('Authorization', `Bearer ${authorToken}`)
        .send({
          expected_version: 1, // Stale!
          title: 'Conflict test',
        });
      expect(staleRes.status).toBe(409);
      expect(staleRes.body.error.code).toBe('VERSION_CONFLICT');
    });
  });

  describe('Phase 1 & 2 Playing, Verification, and Attempt Progression', () => {
    let attemptId: string;

    it('POST /quests/:id/attempts starts attempt in "any" mode with all tasks initialized to "ready"', async () => {
      const res = await request(app)
        .post(`/api/v1/quests/${createdQuestId}/attempts`)
        .set('Authorization', `Bearer ${travelerToken}`);

      expect([200, 201]).toContain(res.status);
      attemptId = res.body.data.id;
      expect(res.body.data.step_order_mode).toBe('any');

      // Check evidence rows in DB
      const stepsRes = await fixture.pool.query(
        'SELECT step_order, status, required, checkpoint_type FROM quest_step_evidence WHERE attempt_id = $1 ORDER BY step_order ASC',
        [attemptId]
      );
      expect(stepsRes.rows).toHaveLength(4);
      // In "any" mode, all tasks should be ready immediately!
      for (const row of stepsRes.rows) {
        expect(row.status).toBe('ready');
      }
    });

    it('tracks failed_tries and first_try_at on verification failure', async () => {
      // Submit GPS out of radius for step 1
      const res = await request(app)
        .post(`/api/v1/quests/${createdQuestId}/steps/1/evidence`)
        .set('Authorization', `Bearer ${travelerToken}`)
        .send({
          captured_lat: spotLat + 0.05, // Far away
          captured_lng: spotLng + 0.05,
          captured_accuracy: 5,
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('GPS_RADIUS_EXCEEDED');

      const checkRes = await fixture.pool.query(
        'SELECT failed_tries, first_try_at FROM quest_step_evidence WHERE attempt_id = $1 AND step_order = 1',
        [attemptId]
      );
      expect(checkRes.rows[0].failed_tries).toBe(1);
      expect(checkRes.rows[0].first_try_at).toBeDefined();
    });

    it('completes Task 1 (location) within fence', async () => {
      const res = await request(app)
        .post(`/api/v1/quests/${createdQuestId}/steps/1/evidence`)
        .set('Authorization', `Bearer ${travelerToken}`)
        .send({
          captured_lat: spotLat + 0.001,
          captured_lng: spotLng + 0.001,
          captured_accuracy: 5,
        });

      expect(res.status).toBe(200);
      expect(res.body.data.step.status).toBe('verified');
    });

    it('completes Task 2 (QR) out of order using valid QR marker code and fresh GPS', async () => {
      const res = await request(app)
        .post(`/api/v1/quests/${createdQuestId}/steps/2/evidence`)
        .set('Authorization', `Bearer ${travelerToken}`)
        .send({
          qr_code: qrMarkerCode,
          captured_lat: spotLat + 0.002,
          captured_lng: spotLng + 0.002,
          captured_accuracy: 5,
        });

      expect(res.status).toBe(200);
      expect(res.body.data.step.status).toBe('verified');
    });

    it('rejects photo evidence without an image file (URL-only or hash-only rejected)', async () => {
      const res = await request(app)
        .post(`/api/v1/quests/${createdQuestId}/steps/3/evidence`)
        .set('Authorization', `Bearer ${travelerToken}`)
        .send({
          photo_url: 'https://example.com/spoofed.jpg',
          photo_sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('submits valid photo image file for Task 3 with on-site GPS -> pending_review', async () => {
      // Minimal valid 1x1 GIF buffer
      const gifBuffer = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

      const res = await request(app)
        .post(`/api/v1/quests/${createdQuestId}/steps/3/evidence`)
        .set('Authorization', `Bearer ${travelerToken}`)
        .field('captured_lat', spotLat + 0.003)
        .field('captured_lng', spotLng + 0.003)
        .field('captured_accuracy', 5)
        .field('gallery_opt_in', 'true')
        .attach('photo', gifBuffer, 'patar_rocks.gif');

      expect(res.status).toBe(200);
      expect(res.body.data.step.status).toBe('pending_review');
      expect(res.body.data.step.submitted_at).toBeDefined();
    });

    it('issues and verifies AR challenge token for Task 4', async () => {
      // Request AR challenge inside fence
      const challengeRes = await request(app)
        .post(`/api/v1/quests/${createdQuestId}/steps/4/ar-challenge`)
        .set('Authorization', `Bearer ${travelerToken}`)
        .send({
          captured_lat: spotLat + 0.0015,
          captured_lng: spotLng + 0.0015,
          captured_accuracy: 5,
        });

      expect(challengeRes.status).toBe(200);
      const token = challengeRes.body.data.challenge_token;
      expect(token).toBeDefined();

      // Ensure AR challenge token cannot be accepted as session auth
      const authProbe = await request(app)
        .get('/api/v1/users/me/profile')
        .set('Authorization', `Bearer ${token}`);
      expect(authProbe.status).toBe(401);

      // Verify AR task with token and fresh GPS
      const verifyRes = await request(app)
        .post(`/api/v1/quests/${createdQuestId}/steps/4/evidence`)
        .set('Authorization', `Bearer ${travelerToken}`)
        .send({
          challenge_token: token,
          captured_lat: spotLat + 0.0015,
          captured_lng: spotLng + 0.0015,
          captured_accuracy: 5,
        });

      expect(verifyRes.status).toBe(200);
      expect(verifyRes.body.data.step.status).toBe('verified');
    });

    it('POST /quests/:id/submit-for-review succeeds since required tasks are verified or pending review', async () => {
      const res = await request(app)
        .post(`/api/v1/quests/${createdQuestId}/submit-for-review`)
        .set('Authorization', `Bearer ${travelerToken}`);

      expect(res.status).toBe(200);
      const attemptData = res.body.data?.attempt ?? res.body.data;
      expect(attemptData.status).toBe('submitted');
    });
  });

  describe('Admin Per-Task Review & Attempt Completion', () => {
    it('blocks attempt approval when photo task is still pending review (TASKS_PENDING_REVIEW)', async () => {
      const attemptRes = await fixture.pool.query(
        "SELECT id FROM quest_attempts WHERE quest_id = $1 AND user_id = $2",
        [createdQuestId, travelerId]
      );
      const attemptId = attemptRes.rows[0].id;

      const res = await request(app)
        .patch(`/api/v1/admin/quest-attempts/${attemptId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ action: 'approve' });

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('TASKS_PENDING_REVIEW');
      expect(res.body.error.pending_tasks).toHaveLength(1);
      expect(res.body.error.pending_tasks[0].step_order).toBe(3);
    });

    it('quest author cannot review tasks on own quest (CREATOR_SELF_ATTEMPT)', async () => {
      const attemptRes = await fixture.pool.query(
        "SELECT id FROM quest_attempts WHERE quest_id = $1 AND user_id = $2",
        [createdQuestId, travelerId]
      );
      const attemptId = attemptRes.rows[0].id;

      // Make author an admin in DB as well so requireAdmin passes
      await fixture.pool.query("UPDATE users SET role = 'admin' WHERE id = $1", [authorId]);
      invalidateSessionScopeCache(authorId);
      const authorAdminToken = jwt.sign({ id: authorId, seed_id: authorId, role: 'admin', typ: 'session' }, env.JWT_SECRET);
      const res = await request(app)
        .patch(`/api/v1/admin/quest-attempts/${attemptId}/steps/3`)
        .set('Authorization', `Bearer ${authorAdminToken}`)
        .send({ action: 'approve' });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('CREATOR_SELF_ATTEMPT');

      // Revert author role
      await fixture.pool.query("UPDATE users SET role = 'user' WHERE id = $1", [authorId]);
      invalidateSessionScopeCache(authorId);
    });

    it('admin approves Task 3 via PATCH /admin/quest-attempts/:id/steps/3', async () => {
      const attemptRes = await fixture.pool.query(
        "SELECT id FROM quest_attempts WHERE quest_id = $1 AND user_id = $2",
        [createdQuestId, travelerId]
      );
      const attemptId = attemptRes.rows[0].id;

      const res = await request(app)
        .patch(`/api/v1/admin/quest-attempts/${attemptId}/steps/3`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ action: 'approve' });

      expect(res.status).toBe(200);
      expect(res.body.data.step.status).toBe('verified');
    });

    it('admin approves the attempt and settles rewards once all required tasks are verified', async () => {
      const attemptRes = await fixture.pool.query(
        "SELECT id FROM quest_attempts WHERE quest_id = $1 AND user_id = $2",
        [createdQuestId, travelerId]
      );
      const attemptId = attemptRes.rows[0].id;

      const res = await request(app)
        .patch(`/api/v1/admin/quest-attempts/${attemptId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ action: 'approve' });

      expect(res.status).toBe(200);
      expect(res.body.data.attempt.status).toBe('completed');
    });

    it('GET /quests/:id/analytics aggregates task funnel correctly', async () => {
      const res = await request(app)
        .get(`/api/v1/quests/${createdQuestId}/analytics`)
        .set('Authorization', `Bearer ${authorToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data.overall.started).toBe(1);
      expect(res.body.data.overall.completed).toBe(1);
      expect(res.body.data.task_funnel).toHaveLength(4);
      expect(res.body.data.task_funnel[0].verified).toBe(1);
      expect(res.body.data.task_funnel[0].avg_failed_tries).toBe(1); // 1 failed try recorded earlier
    });
  });

  describe('Migration 054 Pre-054 Schema Upgrade Verification', () => {
    it('upgrades v1 steps on a pre-054 schema without inventing QR codes, coordinates, or using quest.id as spot_id', async () => {
      const url = new URL(process.env.JDQ_REAL_PG_URL!);
      const schema = `jdq_test_mig054_${randomUUID().replace(/-/g, '')}`;
      const admin = new Pool({ connectionString: url.toString(), connectionTimeoutMillis: 3000 });
      await admin.query(`CREATE SCHEMA ${schema}`);
      const migPool = new Pool({
        connectionString: url.toString(),
        options: `-c search_path=${schema}`,
        max: 2,
        connectionTimeoutMillis: 3000,
      });

      try {
        // 1. Apply all migrations BEFORE 054_quest_builder.sql
        const pre054Files = MIGRATIONS.filter((f) => f !== '054_quest_builder.sql');
        for (const file of pre054Files) {
          const sql = readFileSync(join(process.cwd(), 'migrations', file), 'utf8');
          await migPool.query(sql);
        }

        // Allow nullable gps_lat/gps_lng and empty marker_code on quests to test missing-coordinate and missing-code edge cases
        await migPool.query('ALTER TABLE quests ALTER COLUMN gps_lat DROP NOT NULL');
        await migPool.query('ALTER TABLE quests ALTER COLUMN gps_lng DROP NOT NULL');
        await migPool.query('ALTER TABLE quests ALTER COLUMN marker_code DROP NOT NULL');

        // 2. Seed users & spots
        await migPool.query(
          `INSERT INTO users(id, seed_id, display_name, email, role, demo_points)
           VALUES ('u-mig-author', 'u-mig-author', 'Mig Author', 'mig@example.test', 'user', 0)`
        );
        await migPool.query(
          `INSERT INTO spots(id, slug, name, description, category, subcategory, municipality, address, gps_lat, gps_lng,
             status, is_test, recommendation_suppressed, source_type, source_name, created_by)
           VALUES
             ('spot-bound-1', 'spot-bound-1', 'Bound Spot 1', 'Desc', 'nature_outdoors', 'beach', 'Bolinao', 'Addr', 16.35, 119.85, 'published', false, false, 'community', 'Author', 'u-mig-author'),
             ('spot-direct-2', 'spot-direct-2', 'Direct Spot 2', 'Desc', 'nature_outdoors', 'beach', 'Bolinao', 'Addr', 16.36, 119.86, 'published', false, false, 'community', 'Author', 'u-mig-author')`
        );

        // Quest A: Has quest coordinates (16.35, 119.85), quest marker_code ('QUEST-QR-STICKER-01'), and an active binding to 'spot-bound-1'
        const v1StepsQuestA = [
          // Case 1a: QR step WITH its own marker_code and step coordinates
          {
            title: 'QR with step code & coords',
            description: 'Scan plaque 1',
            checkpoint_type: 'qr',
            marker_code: 'STEP-QR-EXPLICIT-99',
            gps_lat: 16.351,
            gps_lng: 119.851,
            radius_meters: 80,
          },
          // Case 1b: QR step WITHOUT step marker_code -> falls back to quests.marker_code ('QUEST-QR-STICKER-01'), and without step coords -> falls back to quests.gps_lat/lng
          {
            title: 'QR fallback to quest code & quest coords',
            description: 'Scan main sticker',
            checkpoint_type: 'qr',
          },
          // Case 3a: Action step WITH explicit action_target_id
          {
            title: 'Action with explicit target',
            checkpoint_type: 'action',
            action_kind: 'like_spot',
            action_target_id: 'spot-explicit-target',
          },
          // Case 3b: Action step WITHOUT action_target_id -> falls back to active binding ('spot-bound-1'), never quests.id
          {
            title: 'Action fallback to bound spot',
            checkpoint_type: 'action',
            action_kind: 'save_spot',
          },
          // Case 4: AR step with custom object/color and fallback to quest coords
          {
            title: 'AR step',
            checkpoint_type: 'ar',
            object: 'gem',
            color: '#2D6A4F',
            radius_meters: 20, // should clamp to >= 30
          },
          // Case 5: view_story demoted to required: false
          {
            title: 'Story step',
            checkpoint_type: 'action',
            action_kind: 'view_story',
          },
        ];

        await migPool.query(
          `INSERT INTO quests(id, title, description, category, location_name, gps_lat, gps_lng, radius_meters, reward_points, marker_code, marker_image_url, author_id, steps)
           VALUES ('quest-mig-a', 'Quest A', 'Desc', 'eco', 'Bolinao', 16.35, 119.85, 100, 50, 'QUEST-QR-STICKER-01', '', 'u-mig-author', $1::jsonb)`,
          [JSON.stringify(v1StepsQuestA)]
        );

        await migPool.query(
          `INSERT INTO reviewed_quest_spot_bindings(id, quest_id, spot_id, status, is_test)
           VALUES ($1, 'quest-mig-a', 'spot-bound-1', 'active', false)`,
          [randomUUID()]
        );

        // Quest B: Missing quest coordinates (NULL, NULL), blank/null quest marker_code, no binding, and no spot linked -> tests missing-data flags without inventing values
        const v1StepsQuestB = [
          // QR step with no step code and no quest code, and no coords
          {
            title: 'QR missing code and coords',
            checkpoint_type: 'qr',
          },
          // Location step with no step coords and no quest coords
          {
            title: 'Location missing coords',
            checkpoint_type: 'location',
          },
          // AR step with no step coords and no quest coords
          {
            title: 'AR missing coords',
            checkpoint_type: 'ar',
          },
          // Action step with no target and no bound/linked spot
          {
            title: 'Action missing spot',
            checkpoint_type: 'action',
            action_kind: 'save_spot',
          },
        ];

        await migPool.query(
          `INSERT INTO quests(id, title, description, category, location_name, gps_lat, gps_lng, radius_meters, reward_points, marker_code, marker_image_url, author_id, steps)
           VALUES ('quest-mig-b', 'Quest B', 'Desc', 'eco', 'Nowhere', NULL, NULL, 100, 50, NULL, '', 'u-mig-author', $1::jsonb)`,
          [JSON.stringify(v1StepsQuestB)]
        );

        // Quest C: Linked via spots.quest_id ('spot-direct-2') without reviewed_quest_spot_bindings row
        const v1StepsQuestC = [
          {
            title: 'Action fallback to spots.quest_id',
            checkpoint_type: 'action',
            action_kind: 'complete_quiz',
          },
        ];
        await migPool.query(
          `INSERT INTO quests(id, title, description, category, location_name, gps_lat, gps_lng, radius_meters, reward_points, marker_code, marker_image_url, author_id, steps)
           VALUES ('quest-mig-c', 'Quest C', 'Desc', 'cultural', 'Bolinao', 16.36, 119.86, 100, 50, 'QUEST-QR-C', '', 'u-mig-author', $1::jsonb)`,
          [JSON.stringify(v1StepsQuestC)]
        );
        await migPool.query(`UPDATE spots SET quest_id = 'quest-mig-c' WHERE id = 'spot-direct-2'`);

        // 3. Apply 054_quest_builder.sql
        const sql054 = readFileSync(join(process.cwd(), 'migrations', '054_quest_builder.sql'), 'utf8');
        await migPool.query(sql054);

        // 4. Assert Quest A upgraded tasks
        const resA = await migPool.query(`SELECT steps FROM quests WHERE id = 'quest-mig-a'`);
        const stepsA = resA.rows[0].steps as any[];
        expect(stepsA).toHaveLength(6);

        // Step 1: QR with explicit step code & coords
        expect(stepsA[0].verification.type).toBe('qr');
        expect(stepsA[0].verification.marker_code).toBe('STEP-QR-EXPLICIT-99');
        expect(stepsA[0].verification.needs_new_qr_sheet).toBe(false);
        expect(stepsA[0].verification.fence).toEqual({ lat: 16.351, lng: 119.851, radius_meters: 80 });

        // Step 2: QR without step code -> uses quest's existing marker_code ('QUEST-QR-STICKER-01') and quest's gps_lat/lng (16.35, 119.85)
        expect(stepsA[1].verification.type).toBe('qr');
        expect(stepsA[1].verification.marker_code).toBe('QUEST-QR-STICKER-01');
        expect(stepsA[1].marker_code).toBe('QUEST-QR-STICKER-01');
        expect(stepsA[1].verification.needs_new_qr_sheet).toBe(false);
        expect(stepsA[1].verification.fence).toEqual({ lat: 16.35, lng: 119.85, radius_meters: 100 });

        // Step 3: Action with explicit action_target_id
        expect(stepsA[2].verification.type).toBe('action');
        expect(stepsA[2].verification.task).toEqual({ kind: 'like_spot', spot_id: 'spot-explicit-target' });

        // Step 4: Action without action_target_id -> uses bound spot ('spot-bound-1'), NOT 'quest-mig-a'
        expect(stepsA[3].verification.type).toBe('action');
        expect(stepsA[3].verification.task).toEqual({ kind: 'save_spot', spot_id: 'spot-bound-1' });
        expect(stepsA[3].verification.task.spot_id).not.toBe('quest-mig-a');

        // Step 5: AR step with quest coords and clamped radius
        expect(stepsA[4].verification.type).toBe('ar');
        expect(stepsA[4].verification.fence).toEqual({ lat: 16.35, lng: 119.85, radius_meters: 30 });
        expect(stepsA[4].verification.object).toBe('gem');
        expect(stepsA[4].verification.color).toBe('#2D6A4F');

        // Step 6: view_story demoted to required: false
        expect(stepsA[5].required).toBe(false);

        // 5. Assert Quest B missing-data edge cases (never invents 16.0/120.0, random QR code, or quest.id as spot_id)
        const resB = await migPool.query(`SELECT steps FROM quests WHERE id = 'quest-mig-b'`);
        const stepsB = resB.rows[0].steps as any[];
        expect(stepsB).toHaveLength(4);

        // QR with no code & no coords
        expect(stepsB[0].verification.type).toBe('qr');
        expect(stepsB[0].verification.marker_code ?? null).toBeNull();
        expect(stepsB[0].verification.needs_new_qr_sheet).toBe(true);
        expect(stepsB[0].needs_new_qr_sheet).toBe(true);
        expect(stepsB[0].verification.fence ?? null).toBeNull();
        expect(stepsB[0].verification.needs_author_review).toBe(true);
        expect(stepsB[0].needs_author_review).toBe(true);
        expect(stepsB[0].gps_lat ?? null).toBeNull();
        expect(stepsB[0].gps_lng ?? null).toBeNull();

        // Location with no coords
        expect(stepsB[1].verification.type).toBe('location');
        expect(stepsB[1].verification.fence ?? null).toBeNull();
        expect(stepsB[1].verification.needs_author_review).toBe(true);
        expect(stepsB[1].needs_author_review).toBe(true);

        // AR with no coords
        expect(stepsB[2].verification.type).toBe('ar');
        expect(stepsB[2].verification.fence ?? null).toBeNull();
        expect(stepsB[2].verification.needs_author_review).toBe(true);
        expect(stepsB[2].needs_author_review).toBe(true);

        // Action with no target and no bound/linked spot -> spot_id is null/omitted, needs_author_review: true, never 'quest-mig-b'
        expect(stepsB[3].verification.type).toBe('action');
        expect(stepsB[3].verification.task.spot_id ?? null).toBeNull();
        expect(stepsB[3].verification.needs_author_review).toBe(true);
        expect(stepsB[3].needs_author_review).toBe(true);

        // 6. Assert Quest C action step resolves spot via spots.quest_id ('spot-direct-2')
        const resC = await migPool.query(`SELECT steps FROM quests WHERE id = 'quest-mig-c'`);
        const stepsC = resC.rows[0].steps as any[];
        expect(stepsC[0].verification.task).toEqual({ kind: 'complete_quiz', spot_id: 'spot-direct-2' });
      } finally {
        await migPool.end();
        await admin.query(`DROP SCHEMA ${schema} CASCADE`);
        await admin.end();
      }
    });
  });
});
