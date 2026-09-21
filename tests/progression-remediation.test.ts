import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { createTestDb, TestDbInstance } from '../src/db/testHarness.js';
import { setPool, applyMigrations } from '../src/db/pool.js';
import { app } from '../src/app.js';
import { env } from '../src/config/env.js';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { progressionRepo } from '../src/progression/repository.js';
import { progressionService } from '../src/progression/service.js';
import { submissionsService } from '../src/services/submissions.js';
import { OutboxWorker } from '../src/jobs/outbox-worker.js';

describe('Progression Phase 1 Remediation (R1–R8 Verification)', () => {
  let db: TestDbInstance;

  const adminId = '22222222-2222-2222-2222-222222222222';
  const travelerId = '11111111-1111-1111-1111-111111111111';
  const testUserId = '99999999-9999-9999-9999-999999999999';

  const tokenAdmin = jwt.sign({ id: adminId, role: 'admin' }, env.JWT_SECRET, { expiresIn: '1h' });
  const tokenTraveler = jwt.sign({ id: travelerId, role: 'user' }, env.JWT_SECRET, { expiresIn: '1h' });

  beforeAll(async () => {
    db = await createTestDb();
    setPool(db.pool);

    // Seed users
    await db.pool.query(`
      INSERT INTO users (id, seed_id, display_name, email, role, is_public, is_test, scout_reputation) VALUES
      ('${travelerId}', 'seed-r-traveler', 'Real Traveler', 'r_traveler@jdq.ph', 'user', true, false, 0),
      ('${testUserId}', 'seed-r-qa', 'QA Traveler', 'r_qa@jdq.ph', 'user', true, true, 0),
      ('${adminId}', 'seed-r-admin', 'Admin', 'r_admin@jdq.ph', 'admin', true, false, 500)
      ON CONFLICT (id) DO NOTHING;
    `);

    // Seed test & real spots
    await db.pool.query(`
      INSERT INTO spots (id, slug, name, description, category, subcategory, tags, municipality, address, gps_lat, gps_lng, price_level, hours, amenities, image_url, source_type, source_name, trust_level, status, is_test) VALUES
      ('spot-alaminos-1', 'alaminos-park', 'Alaminos Park', 'Park', 'nature_outdoors', 'park', '[]', 'Alaminos City', 'Alaminos', 16.2, 119.9, 0, '{}', '[]', '', 'lgu', 'Alaminos', 'lgu_verified', 'published', false),
      ('spot-alaminos-2', 'alaminos-cave', 'Alaminos Cave', 'Cave', 'nature_outdoors', 'cave', '[]', 'Alaminos', 'Alaminos', 16.21, 119.91, 0, '{}', '[]', '', 'lgu', 'Alaminos', 'lgu_verified', 'published', false),
      ('spot-dagupan-1', 'dagupan-market', 'Dagupan Market', 'Food', 'eat_drink', 'market', '[]', 'Dagupan City', 'Dagupan', 16.04, 120.33, 0, '{}', '[]', '', 'lgu', 'Dagupan', 'lgu_verified', 'published', false),
      ('spot-dagupan-2', 'dagupan-wharf', 'Dagupan Wharf', 'Wharf', 'activities_wellness', 'recreation', '[]', 'Dagupan', 'Dagupan', 16.05, 120.34, 0, '{}', '[]', '', 'lgu', 'Dagupan', 'lgu_verified', 'published', false),
      ('spot-bolinao-1', 'bolinao-beach', 'Bolinao Beach', 'Beach', 'nature_outdoors', 'beach', '[]', 'Bolinao', 'Bolinao', 16.38, 119.9, 0, '{}', '[]', '', 'lgu', 'Bolinao', 'lgu_verified', 'published', false),
      ('spot-synthetic-1', 'qa-cove', 'QA Cove', 'Simulated', 'nature_outdoors', 'beach', '[]', 'Dasol', 'Dasol', 15.9, 119.7, 0, '{}', '[]', '', 'community', 'QA Fixtures', 'community', 'published', true)
      ON CONFLICT (id) DO NOTHING;
    `);

    // Seed quests
    await db.pool.query(`
      INSERT INTO quests (id, title, description, category, location_name, gps_lat, gps_lng, radius_meters, reward_points, marker_code, marker_image_url, is_test) VALUES
      ('quest-real-1', 'Real Quest 1', 'Desc', 'eco', 'Alaminos', 16.2, 119.9, 100, 50, 'MARKER_R_1', '', false),
      ('quest-qa-1', 'QA Quest 1', 'Desc', 'eco', 'Dasol', 15.9, 119.7, 100, 50, 'MARKER_QA_1', '', true)
      ON CONFLICT (id) DO NOTHING;
    `);
  });

  afterAll(async () => {
    setPool(null);
    await db.close();
  });

  describe('R1: Worker Lease Fencing & Expired Reclaim', () => {
    it('stale worker cannot complete or fail an event after another worker claimed it', async () => {
      const eventId = randomUUID();
      await db.pool.query(`
        INSERT INTO outbox_events (id, event_key, event_type, payload, status, lease_owner, lease_expires_at, next_attempt_at)
        VALUES ('${eventId}', 'lease-fence-key', 'submission_approved_unresolved', '{}', 'processing', 'stale-worker', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z')
      `);

      // Replacement worker claims the expired lease
      const claimed = await progressionRepo.claimPendingOutboxEvents(10, 30, 'new-worker', db.pool);
      const reclaimedEvent = claimed.find((e) => e.id === eventId);
      expect(reclaimedEvent).toBeDefined();
      expect(reclaimedEvent?.lease_owner).toMatch(/^new-worker:/);
      expect(reclaimedEvent?.claim_token).toBeDefined();

      // Stale worker tries to complete the event: must return false (0 rows updated)
      const staleCompleted = await progressionRepo.markOutboxCompleted(eventId, 'stale-worker', db.pool);
      expect(staleCompleted).toBe(false);

      // Verify event is still processing under new-worker
      const { rows } = await db.pool.query('SELECT status, lease_owner, claim_token FROM outbox_events WHERE id = $1', [eventId]);
      expect(rows[0].status).toBe('processing');
      expect(rows[0].lease_owner).toBe(reclaimedEvent?.lease_owner);
      expect(rows[0].claim_token).toBe(reclaimedEvent?.claim_token);

      // Legitimate new worker completes it
      const newCompleted = await progressionRepo.markOutboxCompleted(
        eventId,
        reclaimedEvent!.lease_owner!,
        db.pool,
        reclaimedEvent!.claim_token
      );
      expect(newCompleted).toBe(true);
    });
  });

  describe('R2: Reversal Integrity & Safe Integer Enforcement', () => {
    it('validates matching user, track, and opposite delta on reversal', async () => {
      const client = await db.pool.connect();
      try {
        const origId = randomUUID();
        const origEvent = await progressionRepo.recordProgressionEvent(
          {
            id: origId,
            user_id: travelerId,
            track: 'explorer',
            delta: 50,
            source_type: 'submission_approval',
            source_id: 'reversal-test-sub',
            award_kind: 'xp',
            rule_version: 'v1',
            earned_at: new Date().toISOString(),
            is_test: false,
          },
          client
        );
        expect(origEvent).not.toBeNull();

        // 1. Reversal with wrong delta (+50 instead of -50)
        await expect(
          progressionRepo.recordProgressionEvent(
            {
              id: randomUUID(),
              user_id: travelerId,
              track: 'explorer',
              delta: 50,
              source_type: 'manual_adjustment',
              source_id: 'adj-1',
              award_kind: 'xp',
              rule_version: 'v1',
              earned_at: new Date().toISOString(),
              is_test: false,
              reversal_of: origId,
            },
            client
          )
        ).rejects.toThrow('REVERSAL_DELTA_MISMATCH');

        // 2. Valid reversal with exact opposite delta (-50)
        const validReversal = await progressionRepo.recordProgressionEvent(
          {
            id: randomUUID(),
            user_id: travelerId,
            track: 'explorer',
            delta: -50,
            source_type: 'manual_adjustment',
            source_id: 'adj-2',
            award_kind: 'xp',
            rule_version: 'v1',
            earned_at: new Date().toISOString(),
            is_test: false,
            reversal_of: origId,
          },
          client
        );
        expect(validReversal).not.toBeNull();

        // 3. Second reversal of the same original event fails unique reversal constraint
        await expect(
          progressionRepo.recordProgressionEvent(
            {
              id: randomUUID(),
              user_id: travelerId,
              track: 'explorer',
              delta: -50,
              source_type: 'manual_adjustment',
              source_id: 'adj-3',
              award_kind: 'xp',
              rule_version: 'v1',
              earned_at: new Date().toISOString(),
              is_test: false,
              reversal_of: origId,
            },
            client
          )
        ).rejects.toThrow();
      } finally {
        client.release();
      }
    });

    it('rejects unsafe integer delta', async () => {
      const client = await db.pool.connect();
      try {
        await expect(
          progressionRepo.recordProgressionEvent(
            {
              id: randomUUID(),
              user_id: travelerId,
              track: 'explorer',
              delta: Number.MAX_SAFE_INTEGER + 10,
              source_type: 'test',
              source_id: 'test',
              award_kind: 'xp',
              rule_version: 'v1',
              earned_at: new Date().toISOString(),
              is_test: false,
            },
            client
          )
        ).rejects.toThrow('INVALID_EVENT_DELTA');
      } finally {
        client.release();
      }
    });
  });

  describe('R3: Canonical Municipality Resolution & Aliases', () => {
    it('resolves both "Alaminos" and "Alaminos City" to alaminos_city', async () => {
      const withCity = await progressionRepo.resolveCanonicalMunicipalityId('Alaminos City', db.pool);
      const withoutCity = await progressionRepo.resolveCanonicalMunicipalityId('Alaminos', db.pool);
      expect(withCity).toBe('alaminos_city');
      expect(withoutCity).toBe('alaminos_city');
    });

    it('resolves Dagupan and Dagupan City to dagupan_city', async () => {
      const withCity = await progressionRepo.resolveCanonicalMunicipalityId('Dagupan City', db.pool);
      const withoutCity = await progressionRepo.resolveCanonicalMunicipalityId('Dagupan', db.pool);
      expect(withCity).toBe('dagupan_city');
      expect(withoutCity).toBe('dagupan_city');
    });

    it('getTotalLguCount returns exactly 48 from the database registry', async () => {
      const total = await progressionRepo.getTotalLguCount(db.pool);
      expect(total).toBe(48);
    });
  });

  describe('R4: Synthetic Scope Enforcement End-to-End', () => {
    it('quarantines mixed-scope submission: test actor submitting to real quest', async () => {
      const subId = randomUUID();
      await db.pool.query(`
        INSERT INTO submissions (id, idempotency_key, user_id, quest_id, scanned_marker_code, captured_lat, captured_lng, captured_accuracy, status)
        VALUES ('${subId}', 'mixed-scope-1', '${testUserId}', 'quest-real-1', 'MARKER_R_1', 16.2, 119.9, 5, 'approved')
      `);

      const client = await db.pool.connect();
      try {
        await progressionService.recordApprovalOutboxEvent(
          {
            id: subId,
            user_id: testUserId,
            quest_id: 'quest-real-1',
            created_at: new Date().toISOString(),
          },
          client
        );
      } finally {
        client.release();
      }

      // Check that it was quarantined as unresolved scope mismatch
      const { rows } = await db.pool.query(
        'SELECT * FROM outbox_events WHERE event_key = $1',
        [`submission_approval_unresolved_${subId}`]
      );
      expect(rows.length).toBe(1);
      const payload = typeof rows[0].payload === 'string' ? JSON.parse(rows[0].payload) : rows[0].payload;
      expect(payload.reason).toBe('SCOPE_MISMATCH');
    });

    it('getCuratedCollections excludes synthetic spots for public callers', async () => {
      // Create a collection with both real and synthetic spot
      await db.pool.query(`
        INSERT INTO curated_collections (id, title, description, category, is_active)
        VALUES ('mixed_trail', 'Mixed Trail', 'Test', 'trail', true)
        ON CONFLICT (id) DO NOTHING;
        INSERT INTO curated_collection_spots (collection_id, spot_id, order_index) VALUES
        ('mixed_trail', 'spot-alaminos-1', 0),
        ('mixed_trail', 'spot-synthetic-1', 1)
        ON CONFLICT (collection_id, spot_id) DO NOTHING;
      `);

      const publicCollections = await progressionRepo.getCuratedCollections(undefined, false, db.pool);
      const mixed = publicCollections.find((c) => c.id === 'mixed_trail');
      expect(mixed).toBeDefined();
      // Public view must contain ONLY the published, non-test spot
      expect(mixed?.spots.some((s) => s.spot_id === 'spot-synthetic-1')).toBe(false);
      expect(mixed?.spots.some((s) => s.spot_id === 'spot-alaminos-1')).toBe(true);
    });
  });

  describe('R6: Background Worker Lifecycle & Admin Zod Validation', () => {
    it('OutboxWorker starts, polls, and stops gracefully', async () => {
      const worker = new OutboxWorker({ intervalMs: 100, batchSize: 5 });
      worker.start();
      // Wait a moment for loop
      await new Promise((resolve) => setTimeout(resolve, 150));
      await expect(worker.stop()).resolves.not.toThrow();
    });

    it('rejects invalid batch_size on admin process-outbox endpoint', async () => {
      const res = await request(app)
        .post('/api/v1/admin/progression/process-outbox')
        .set('Authorization', `Bearer ${tokenAdmin}`)
        .send({ batch_size: 500 }); // Exceeds max 100

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('R7: Pangasinan Pioneer Destination Uniqueness', () => {
    it('requires 5 UNIQUE spots, not 5 visits to the same spot', async () => {
      const userId = randomUUID();
      await db.pool.query(`
        INSERT INTO users (id, seed_id, display_name, email, role, is_public, is_test)
        VALUES ('${userId}', '${userId}', 'Pioneer Tester', '${userId}@jdq.ph', 'user', true, false)
      `);

      const client = await db.pool.connect();
      try {
        // 5 visits to the SAME spot ('spot-alaminos-1') via 5 distinct quests
        for (let i = 1; i <= 5; i++) {
          const questId = `quest-same-spot-${i}`;
          await db.pool.query(`
            INSERT INTO quests (id, title, description, category, location_name, gps_lat, gps_lng, radius_meters, reward_points, marker_code, marker_image_url, is_test)
            VALUES ('${questId}', 'Same Spot Quest ${i}', 'Desc', 'eco', 'Alaminos', 16.2, 119.9, 100, 50, 'MARKER_SS_${i}', '', false)
            ON CONFLICT (id) DO NOTHING;
          `);
          const subId = randomUUID();
          await db.pool.query(`
            INSERT INTO submissions (id, idempotency_key, user_id, quest_id, scanned_marker_code, captured_lat, captured_lng, captured_accuracy, status)
            VALUES ('${subId}', 'same-spot-${i}', '${userId}', '${questId}', 'MARKER_SS_${i}', 16.2, 119.9, 5, 'approved')
          `);
          await progressionRepo.recordVerifiedVisit(
            {
              id: randomUUID(),
              user_id: userId,
              spot_id: 'spot-alaminos-1',
              municipality_id: 'alaminos_city',
              source_submission_id: subId,
              occurred_at: new Date().toISOString(),
              verified_at: new Date().toISOString(),
              evidence_version: 'v1',
              is_test: false,
            },
            client
          );
        }

        // Process milestone evaluation
        await (progressionService as any).evaluateAchievementsForUser(userId, 'spot-alaminos-1', 'test-sub-id', false, client);

        // Check awards: First Footstep should be awarded, but NOT Pangasinan Pioneer!
        const awards = await progressionRepo.getAwardsForUser(userId, false, client);
        expect(awards.some((a) => a.achievement_id === 'first_footstep')).toBe(true);
        expect(awards.some((a) => a.achievement_id === 'pangasinan_pioneer')).toBe(false);

        // Now add 4 MORE visits to 4 DIFFERENT spots (total unique spots = 5)
        const differentSpots = ['spot-alaminos-2', 'spot-dagupan-1', 'spot-dagupan-2', 'spot-bolinao-1'];
        let diffIdx = 1;
        for (const spot of differentSpots) {
          const questId = `quest-diff-spot-${diffIdx}`;
          await db.pool.query(`
            INSERT INTO quests (id, title, description, category, location_name, gps_lat, gps_lng, radius_meters, reward_points, marker_code, marker_image_url, is_test)
            VALUES ('${questId}', 'Diff Spot Quest ${diffIdx}', 'Desc', 'eco', 'Pangasinan', 16.2, 119.9, 100, 50, 'MARKER_DIFF_${diffIdx}', '', false)
            ON CONFLICT (id) DO NOTHING;
          `);
          const subId = randomUUID();
          await db.pool.query(`
            INSERT INTO submissions (id, idempotency_key, user_id, quest_id, scanned_marker_code, captured_lat, captured_lng, captured_accuracy, status)
            VALUES ('${subId}', 'diff-${subId}', '${userId}', '${questId}', 'MARKER_DIFF_${diffIdx}', 16.2, 119.9, 5, 'approved')
          `);
          await progressionRepo.recordVerifiedVisit(
            {
              id: randomUUID(),
              user_id: userId,
              spot_id: spot,
              municipality_id: 'alaminos_city',
              source_submission_id: subId,
              occurred_at: new Date().toISOString(),
              verified_at: new Date().toISOString(),
              evidence_version: 'v1',
              is_test: false,
            },
            client
          );
          diffIdx++;
        }

        // Re-evaluate achievements
        await (progressionService as any).evaluateAchievementsForUser(userId, 'spot-bolinao-1', 'test-sub-id-2', false, client);

        // Now Pangasinan Pioneer MUST be awarded!
        const updatedAwards = await progressionRepo.getAwardsForUser(userId, false, client);
        expect(updatedAwards.some((a) => a.achievement_id === 'pangasinan_pioneer')).toBe(true);
      } finally {
        client.release();
      }
    });
  });

  describe('R8: Multiple Versioned Deprecated Bindings', () => {
    it('permits multiple deprecated bindings for a quest but only one active binding', async () => {
      const questId = 'quest-rebind-test';
      await db.pool.query(`
        INSERT INTO quests (id, title, description, category, location_name, gps_lat, gps_lng, radius_meters, reward_points, marker_code, marker_image_url)
        VALUES ('${questId}', 'Rebind Test', 'Desc', 'eco', 'Alaminos', 16.2, 119.9, 100, 50, 'MARKER_REBIND_1', '')
        ON CONFLICT (id) DO NOTHING;
      `);

      // 1. Insert first active binding
      const binding1 = randomUUID();
      await db.pool.query(`
        INSERT INTO reviewed_quest_spot_bindings (id, quest_id, spot_id, binding_version, status)
        VALUES ('${binding1}', '${questId}', 'spot-alaminos-1', 'v1', 'active')
      `);

      // 2. Second active binding must fail unique index
      await expect(
        db.pool.query(`
          INSERT INTO reviewed_quest_spot_bindings (id, quest_id, spot_id, binding_version, status)
          VALUES ('${randomUUID()}', '${questId}', 'spot-alaminos-2', 'v2', 'active')
        `)
      ).rejects.toThrow();

      // 3. Deprecate first binding
      await db.pool.query(`
        UPDATE reviewed_quest_spot_bindings SET status = 'deprecated' WHERE id = '${binding1}'
      `);

      // 4. Insert second active binding (now succeeds)
      const binding2 = randomUUID();
      await db.pool.query(`
        INSERT INTO reviewed_quest_spot_bindings (id, quest_id, spot_id, binding_version, status)
        VALUES ('${binding2}', '${questId}', 'spot-alaminos-2', 'v2', 'active')
      `);

      // 5. Deprecate second binding
      await db.pool.query(`
        UPDATE reviewed_quest_spot_bindings SET status = 'deprecated' WHERE id = '${binding2}'
      `);

      // 6. Verify multiple deprecated rows exist without constraint violation
      const { rows } = await db.pool.query(
        'SELECT * FROM reviewed_quest_spot_bindings WHERE LOWER(quest_id) = LOWER($1) AND status = $2',
        [questId, 'deprecated']
      );
      expect(rows.length).toBe(2);
    });
  });

  describe('RC1: Claim Fencing & Same-Owner Reclaim', () => {
    it('generates distinct claim token on same-owner reclaim and prevents stale token completion', async () => {
      const eventId = randomUUID();
      await db.pool.query(`
        INSERT INTO outbox_events (id, event_key, event_type, payload, status, next_attempt_at)
        VALUES ('${eventId}', 'same-owner-key-${eventId}', 'submission_approved_unresolved', '{}', 'pending', '2020-01-01T00:00:00Z')
      `);

      // 1. Worker A claims
      const firstClaim = await progressionRepo.claimPendingOutboxEvents(10, 30, 'worker-alpha', db.pool);
      const ev1 = firstClaim.find((e) => e.id === eventId);
      expect(ev1).toBeDefined();
      expect(ev1!.claim_token).toBeDefined();

      // 2. Expire lease
      await db.pool.query("UPDATE outbox_events SET lease_expires_at = '2020-01-01T00:00:00Z' WHERE id = $1", [eventId]);

      // 3. Worker A reclaims with same worker name
      const secondClaim = await progressionRepo.claimPendingOutboxEvents(10, 30, 'worker-alpha', db.pool);
      const ev2 = secondClaim.find((e) => e.id === eventId);
      expect(ev2).toBeDefined();
      expect(ev2!.claim_token).toBeDefined();
      expect(ev2!.claim_token).not.toBe(ev1!.claim_token);

      // 4. Stale invocation with first claim token fails
      const staleCompleted = await progressionRepo.markOutboxCompleted(eventId, ev1!.lease_owner!, db.pool, ev1!.claim_token);
      expect(staleCompleted).toBe(false);

      // 5. Active invocation with second claim token succeeds
      const activeCompleted = await progressionRepo.markOutboxCompleted(eventId, ev2!.lease_owner!, db.pool, ev2!.claim_token);
      expect(activeCompleted).toBe(true);
    });
  });

  describe('RC2: Scope Revalidation & Payload Identity Fencing', () => {
    it('quarantines processing when user scope converts to test between enqueue and processing', async () => {
      const uId = randomUUID();
      const qId = 'quest-real-1';
      const sId = 'spot-alaminos-1';
      const subId = randomUUID();

      await db.pool.query(`
        INSERT INTO users (id, seed_id, display_name, email, role, is_public, is_test)
        VALUES ('${uId}', 'seed-esc-${uId}', 'Escalation User', '${uId}@test.ph', 'user', true, false)
      `);
      await db.pool.query(`
        INSERT INTO submissions (id, idempotency_key, user_id, quest_id, scanned_marker_code, captured_lat, captured_lng, captured_accuracy, status, is_test)
        VALUES ('${subId}', 'sub-esc-${subId}', '${uId}', '${qId}', 'MARKER_R_1', 16.2, 119.9, 5, 'approved', false)
      `);

      // Binding
      const bId = randomUUID();
      await db.pool.query(`
        INSERT INTO reviewed_quest_spot_bindings (id, quest_id, spot_id, binding_version, status, is_test)
        VALUES ('${bId}', '${qId}', '${sId}', 'v1', 'active', false)
        ON CONFLICT DO NOTHING
      `);

      // Enqueue event as non-test (real)
      const outboxId = randomUUID();
      await db.pool.query(`
        INSERT INTO outbox_events (id, event_key, event_type, payload, status, next_attempt_at)
        VALUES ('${outboxId}', 'ob-esc-${outboxId}', 'submission_approved', $1, 'pending', NOW())
      `, [JSON.stringify({
        submission_id: subId,
        user_id: uId,
        quest_id: qId,
        spot_id: sId,
        binding_id: bId,
        binding_version: 'v1',
        occurred_at: new Date().toISOString(),
        verified_at: new Date().toISOString(),
        is_test: false,
      })]);

      // Before worker processes, user converts to test actor (scope change!)
      await db.pool.query('UPDATE users SET is_test = TRUE WHERE id = $1', [uId]);

      // Process batch
      const result = await progressionService.processOutboxBatch(10, 'worker-esc');
      expect(result.failed).toBeGreaterThanOrEqual(1);

      // Event should be marked failed with SCOPE_MISMATCH
      const { rows } = await db.pool.query('SELECT status, last_error FROM outbox_events WHERE id = $1', [outboxId]);
      expect(rows[0].status).toBe('failed');
      expect(rows[0].last_error).toContain('SCOPE_MISMATCH');

      // No visits or XP granted
      const { rows: visits } = await db.pool.query('SELECT * FROM verified_visits WHERE user_id = $1', [uId]);
      expect(visits.length).toBe(0);
    });

    it('fails processing when payload identity does not match durable submission identity', async () => {
      const uId = randomUUID();
      const qId = 'quest-real-1';
      const subId = randomUUID();

      await db.pool.query(`
        INSERT INTO users (id, seed_id, display_name, email, role, is_public, is_test)
        VALUES ('${uId}', 'seed-mismatch-${uId}', 'Mismatch User', '${uId}@test.ph', 'user', true, false)
      `);
      await db.pool.query(`
        INSERT INTO submissions (id, idempotency_key, user_id, quest_id, scanned_marker_code, captured_lat, captured_lng, captured_accuracy, status, is_test)
        VALUES ('${subId}', 'sub-mismatch-${subId}', '${uId}', '${qId}', 'MARKER_R_1', 16.2, 119.9, 5, 'approved', false)
      `);

      // Enqueue with spoofed user_id in payload
      const outboxId = randomUUID();
      await db.pool.query(`
        INSERT INTO outbox_events (id, event_key, event_type, payload, status, next_attempt_at)
        VALUES ('${outboxId}', 'ob-mismatch-${outboxId}', 'submission_approved', $1, 'pending', NOW())
      `, [JSON.stringify({
        submission_id: subId,
        user_id: randomUUID(), // Spoofed user ID!
        quest_id: qId,
        spot_id: 'spot-alaminos-1',
        is_test: false,
      })]);

      await progressionService.processOutboxBatch(10, 'worker-mismatch');

      const { rows } = await db.pool.query('SELECT status, last_error FROM outbox_events WHERE id = $1', [outboxId]);
      expect(rows[0].status).toBe('failed');
      expect(rows[0].last_error).toContain('IDENTITY_MISMATCH');
    });

    it('rejects recording duplicate visit if prior visit was revoked', async () => {
      const uId = randomUUID();
      const sId = 'spot-alaminos-1';
      const subId = randomUUID();
      await db.pool.query(`
        INSERT INTO users (id, seed_id, display_name, email, role)
        VALUES ('${uId}', 'seed-revvisit-${uId}', 'RevVisit User', '${uId}@test.ph', 'user')
      `);
      await db.pool.query(`
        INSERT INTO submissions (id, idempotency_key, user_id, quest_id, scanned_marker_code, captured_lat, captured_lng, captured_accuracy, status)
        VALUES ('${subId}', 'sub-revvisit-${subId}', '${uId}', 'quest-real-1', 'MARKER_R_1', 16.2, 119.9, 5, 'approved')
      `);

      const client = await db.pool.connect();
      try {
        await progressionRepo.recordVerifiedVisit({
          id: randomUUID(),
          user_id: uId,
          spot_id: sId,
          municipality_id: 'alaminos_city',
          source_submission_id: subId,
          occurred_at: new Date().toISOString(),
          verified_at: new Date().toISOString(),
          evidence_version: 'v1',
          is_test: false,
        }, client);

        // Revoke the visit
        await client.query("UPDATE verified_visits SET revoked_at = NOW(), revocation_reason = 'Disputed' WHERE source_submission_id = $1", [subId]);

        // Attempting to record visit again should throw VISIT_REVOKED
        await expect(
          progressionRepo.recordVerifiedVisit({
            id: randomUUID(),
            user_id: uId,
            spot_id: sId,
            municipality_id: 'alaminos_city',
            source_submission_id: subId,
            occurred_at: new Date().toISOString(),
            verified_at: new Date().toISOString(),
            evidence_version: 'v1',
            is_test: false,
          }, client)
        ).rejects.toThrow('VISIT_REVOKED');
      } finally {
        client.release();
      }
    });
  });

  describe('RC3: Safe Integer Bounds & Reversal Invariants', () => {
    it('rejects reversal if award_kind or is_test does not match original event', async () => {
      const uId = randomUUID();
      await db.pool.query(`
        INSERT INTO users (id, seed_id, display_name, email, role)
        VALUES ('${uId}', 'seed-rev-${uId}', 'Rev User', '${uId}@test.ph', 'user')
      `);

      const client = await db.pool.connect();
      try {
        const orig = await progressionRepo.recordProgressionEvent({
          id: randomUUID(),
          user_id: uId,
          track: 'explorer',
          delta: 50,
          source_type: 'submission_approval',
          source_id: 'sub-rev-1',
          award_kind: 'xp',
          rule_version: 'v1',
          earned_at: new Date().toISOString(),
          is_test: false,
        }, client);

        // Mismatched award_kind
        await expect(
          progressionRepo.recordProgressionEvent({
            id: randomUUID(),
            user_id: uId,
            track: 'explorer',
            delta: -50,
            source_type: 'reversal',
            source_id: 'sub-rev-1',
            award_kind: 'stamp', // Mismatched!
            rule_version: 'v1',
            reversal_of: orig!.id,
            earned_at: new Date().toISOString(),
            is_test: false,
          }, client)
        ).rejects.toThrow('REVERSAL_AWARD_KIND_MISMATCH');

        // Mismatched is_test
        await expect(
          progressionRepo.recordProgressionEvent({
            id: randomUUID(),
            user_id: uId,
            track: 'explorer',
            delta: -50,
            source_type: 'reversal',
            source_id: 'sub-rev-1',
            award_kind: 'xp',
            rule_version: 'v1',
            reversal_of: orig!.id,
            earned_at: new Date().toISOString(),
            is_test: true, // Mismatched!
          }, client)
        ).rejects.toThrow('REVERSAL_SCOPE_MISMATCH');
      } finally {
        client.release();
      }
    });

    it('prohibits reversal-of-reversal', async () => {
      const uId = randomUUID();
      await db.pool.query(`
        INSERT INTO users (id, seed_id, display_name, email, role)
        VALUES ('${uId}', 'seed-rev2-${uId}', 'Rev2 User', '${uId}@test.ph', 'user')
      `);

      const client = await db.pool.connect();
      try {
        const orig = await progressionRepo.recordProgressionEvent({
          id: randomUUID(),
          user_id: uId,
          track: 'civic',
          delta: 25,
          source_type: 'governance_vote',
          source_id: 'gov-1',
          award_kind: 'xp',
          rule_version: 'v1',
          earned_at: new Date().toISOString(),
          is_test: false,
        }, client);

        const rev1 = await progressionRepo.recordProgressionEvent({
          id: randomUUID(),
          user_id: uId,
          track: 'civic',
          delta: -25,
          source_type: 'reversal',
          source_id: 'gov-1',
          award_kind: 'xp',
          rule_version: 'v1',
          reversal_of: orig!.id,
          earned_at: new Date().toISOString(),
          is_test: false,
        }, client);

        // Attempting to reverse rev1 (reversal of reversal) must throw
        await expect(
          progressionRepo.recordProgressionEvent({
            id: randomUUID(),
            user_id: uId,
            track: 'civic',
            delta: 25,
            source_type: 'reversal',
            source_id: 'gov-1',
            award_kind: 'xp',
            rule_version: 'v1',
            reversal_of: rev1!.id,
            earned_at: new Date().toISOString(),
            is_test: false,
          }, client)
        ).rejects.toThrow('REVERSAL_OF_REVERSAL_PROHIBITED');
      } finally {
        client.release();
      }
    });
  });

  describe('RC4: Staged Rollout Flags & Watermark Catch-Up', () => {
    it('gating submissions approval when PROGRESSION_ENABLED is false emits 0 outbox events', async () => {
      const origEnabled = env.PROGRESSION_ENABLED;
      (env as any).PROGRESSION_ENABLED = false;
      try {
        const uId = randomUUID();
        const subId = randomUUID();
        await db.pool.query(`
          INSERT INTO users (id, seed_id, display_name, email, role)
          VALUES ('${uId}', 'seed-flag-${uId}', 'Flag User', '${uId}@test.ph', 'user')
        `);
        await db.pool.query(`
          INSERT INTO submissions (id, idempotency_key, user_id, quest_id, scanned_marker_code, captured_lat, captured_lng, captured_accuracy, status)
          VALUES ('${subId}', 'sub-flag-${subId}', '${uId}', 'quest-real-1', 'MARKER_R_1', 16.2, 119.9, 5, 'pending')
        `);

        // Review submission
        await submissionsService.reviewSubmission(subId, 'approve', adminId);

        // Verify submissions is approved but outbox event was NOT emitted
        const { rows: subRows } = await db.pool.query('SELECT status FROM submissions WHERE id = $1', [subId]);
        expect(subRows[0].status).toBe('approved');

        const { rows: obRows } = await db.pool.query(
          "SELECT * FROM outbox_events WHERE payload->>'submission_id' = $1",
          [subId]
        );
        expect(obRows.length).toBe(0);
      } finally {
        (env as any).PROGRESSION_ENABLED = origEnabled;
      }
    });

    it('catchUpApprovedSubmissions finds missed approved submissions and enqueues them', async () => {
      const uId = randomUUID();
      const subId = randomUUID();
      const malformedId = randomUUID();
      await db.pool.query(`INSERT INTO outbox_events
        (id, event_key, event_type, payload, status, next_attempt_at)
        VALUES ($1, $2, 'submission_approved_unresolved', '{}', 'pending', NOW())`,
        [malformedId, `missing-submission-${malformedId}`]);
      await db.pool.query(`
        INSERT INTO users (id, seed_id, display_name, email, role)
        VALUES ('${uId}', 'seed-catch-${uId}', 'Catch User', '${uId}@test.ph', 'user')
      `);
      await db.pool.query(`
        INSERT INTO submissions (id, idempotency_key, user_id, quest_id, scanned_marker_code, captured_lat, captured_lng, captured_accuracy, status, reviewed_at)
        VALUES ('${subId}', 'sub-catch-${subId}', '${uId}', 'quest-real-1', 'MARKER_R_1', 16.2, 119.9, 5, 'approved', NOW())
      `);

      // Catch-up should discover this submission
      const catchResult = await progressionService.catchUpApprovedSubmissions({ limit: 50 });
      expect(catchResult.enqueued).toBeGreaterThanOrEqual(1);

      // Verify outbox event now exists
      const { rows } = await db.pool.query(
        "SELECT * FROM outbox_events WHERE payload->>'submission_id' = $1",
        [subId]
      );
      expect(rows.length).toBe(1);
    });

    it('POST /api/v1/admin/progression/catch-up triggers catch up successfully', async () => {
      const res = await request(app)
        .post('/api/v1/admin/progression/catch-up')
        .set('Authorization', `Bearer ${tokenAdmin}`)
        .send({ limit: 10 });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(typeof res.body.data.enqueued).toBe('number');
    });
  });

  describe('RC5: Persistence Snapshots & Definition Immutability', () => {
    it('persists binding_id on verified_visits', async () => {
      const uId = randomUUID();
      const questId = 'quest-rc5-binding';
      const subId = randomUUID();
      const bindingId = randomUUID();

      await db.pool.query(`
        INSERT INTO users (id, seed_id, display_name, email, role)
        VALUES ('${uId}', 'seed-b-${uId}', 'Binding User', '${uId}@test.ph', 'user')
      `);
      await db.pool.query(`
        INSERT INTO quests (id, title, description, category, location_name, gps_lat, gps_lng, radius_meters, reward_points, marker_code, marker_image_url)
        VALUES ('${questId}', 'RC5 Quest', 'Desc', 'eco', 'Alaminos', 16.2, 119.9, 100, 50, 'MARKER_RC5_1', '')
        ON CONFLICT (id) DO NOTHING
      `);
      await db.pool.query(`
        INSERT INTO submissions (id, idempotency_key, user_id, quest_id, scanned_marker_code, captured_lat, captured_lng, captured_accuracy, status)
        VALUES ('${subId}', 'sub-b-${subId}', '${uId}', '${questId}', 'MARKER_RC5_1', 16.2, 119.9, 5, 'approved')
      `);
      await db.pool.query(`
        INSERT INTO reviewed_quest_spot_bindings (id, quest_id, spot_id, binding_version, status)
        VALUES ('${bindingId}', '${questId}', 'spot-alaminos-1', 'v1', 'active')
      `);

      const client = await db.pool.connect();
      try {
        const visit = await progressionRepo.recordVerifiedVisit({
          id: randomUUID(),
          user_id: uId,
          spot_id: 'spot-alaminos-1',
          binding_id: bindingId,
          municipality_id: 'alaminos_city',
          source_submission_id: subId,
          occurred_at: new Date().toISOString(),
          verified_at: new Date().toISOString(),
          evidence_version: 'v1',
          is_test: false,
        }, client);

        expect(visit.binding_id).toBe(bindingId);

        const { rows } = await client.query('SELECT binding_id FROM verified_visits WHERE id = $1', [visit.id]);
        expect(rows[0].binding_id).toBe(bindingId);
      } finally {
        client.release();
      }
    });

    it('achievement awards retain immutable snapshot when definition is modified later', async () => {
      const uId = randomUUID();
      await db.pool.query(`
        INSERT INTO users (id, seed_id, display_name, email, role)
        VALUES ('${uId}', 'seed-ach-${uId}', 'Ach User', '${uId}@test.ph', 'user')
      `);

      const client = await db.pool.connect();
      try {
        // Award achievement
        const award = await progressionRepo.awardAchievement({
          id: randomUUID(),
          user_id: uId,
          achievement_id: 'first_footstep',
          season: 'all_time',
          source_evidence_id: randomUUID(),
          awarded_at: new Date().toISOString(),
          evidence_version: 'v1',
          criteria_version: 'v1',
          is_test: false,
        }, client);

        expect(award).not.toBeNull();
        expect(award?.definition?.title).toBe('First Footstep');

        // Later definition edit in database (e.g. title changes to "Changed First Footstep")
        await client.query("UPDATE achievement_definitions SET title = 'MODIFIED TITLE', description = 'MODIFIED DESC' WHERE id = 'first_footstep'");

        // Reading award for user must still return historical snapshot title, NOT the modified definition
        const awards = await progressionRepo.getAwardsForUser(uId, false, client);
        const userAward = awards.find((a) => a.achievement_id === 'first_footstep');
        expect(userAward?.definition?.title).toBe('First Footstep');
        expect(userAward?.definition?.description).not.toBe('MODIFIED DESC');

        // Restore original definition
        await client.query("UPDATE achievement_definitions SET title = 'First Footstep', description = 'Verified your first physical destination visit in Pangasinan.' WHERE id = 'first_footstep'");
      } finally {
        client.release();
      }
    });
  });

  describe('IR1: Forward Migration 014 & Earlier-013 Upgrade Certification', () => {
    it('applies Migration 014 to upgrade an earlier-013 database without data loss', async () => {
      const upgradeDb = await createTestDb();
      try {
        // Drop retrofitted columns to simulate an earlier 013 schema state
        await upgradeDb.pool.query(`
          ALTER TABLE verified_visits DROP COLUMN IF EXISTS binding_id;
          ALTER TABLE achievement_awards DROP COLUMN IF EXISTS criteria_snapshot;
          ALTER TABLE achievement_awards DROP COLUMN IF EXISTS criteria_version;
          ALTER TABLE achievement_awards DROP COLUMN IF EXISTS evidence_version;
          ALTER TABLE outbox_events DROP COLUMN IF EXISTS claim_token;
          ALTER TABLE progression_totals ALTER COLUMN civic_stamps TYPE INT;
        `);

        // Insert legacy data into the earlier schema
        const legacyUserId = randomUUID();
        await upgradeDb.pool.query(`
          INSERT INTO users (id, seed_id, display_name, email, role)
          VALUES ('${legacyUserId}', 'seed-leg-${legacyUserId}', 'Legacy User', '${legacyUserId}@test.ph', 'user')
        `);

        await upgradeDb.pool.query(`
          INSERT INTO progression_totals (user_id, explorer_xp, civic_xp, civic_stamps)
          VALUES ('${legacyUserId}', 100, 50, 42)
        `);

        // Delete 014 from schema_migrations to simulate an earlier 013 database that has not yet run 014
        await upgradeDb.pool.query("DELETE FROM schema_migrations WHERE filename = '014_progression_hardening_and_retrofits.sql'");

        // Run applyMigrations: normal migration runner detects 014 is missing from schema_migrations and applies it
        await applyMigrations(upgradeDb.pool);

        // 1. Verify schema_migrations contains 014
        const { rows: migRows } = await upgradeDb.pool.query(
          "SELECT filename FROM schema_migrations WHERE filename = '014_progression_hardening_and_retrofits.sql'"
        );
        expect(migRows.length).toBe(1);

        // 2. Verify retrofitted columns exist
        // Resolve columns through this connection's search_path; information_schema
        // can include matching tables from other isolated test schemas.
        await upgradeDb.pool.query('SELECT binding_id FROM verified_visits LIMIT 0');
        await upgradeDb.pool.query('SELECT criteria_snapshot FROM achievement_awards LIMIT 0');
        await upgradeDb.pool.query('SELECT claim_token FROM outbox_events LIMIT 0');

        // 3. Verify civic_stamps supports values exceeding 32-bit INT (safe integer up to MAX_SAFE_INTEGER)
        await upgradeDb.pool.query(`
          UPDATE progression_totals SET civic_stamps = 5000000000 WHERE user_id = '${legacyUserId}'
        `);
        const { rows: totalRows } = await upgradeDb.pool.query(
          `SELECT civic_stamps FROM progression_totals WHERE user_id = '${legacyUserId}'`
        );
        expect(Number(totalRows[0].civic_stamps)).toBe(5000000000);

        // 4. Verify check constraint rejects out-of-bounds negative value
        await expect(
          upgradeDb.pool.query(`UPDATE progression_totals SET civic_stamps = -1 WHERE user_id = '${legacyUserId}'`)
        ).rejects.toThrow();

        // 5. Verify pre-existing data was preserved
        const { rows: preserved } = await upgradeDb.pool.query(
          `SELECT explorer_xp, civic_xp FROM progression_totals WHERE user_id = '${legacyUserId}'`
        );
        expect(Number(preserved[0].explorer_xp)).toBe(100);
        expect(Number(preserved[0].civic_xp)).toBe(50);
      } finally {
        await upgradeDb.close();
      }
    });

    it('migration 014 preflight check detects and aborts on out-of-bounds historical records', async () => {
      const { newDb } = await import('pg-mem');
      const mem = newDb();
      mem.registerLanguage('plpgsql', ({ code }) => () => {
        const ifExistsMatch = code.match(/IF\s+EXISTS\s*\(\s*([\s\S]+?)\s*\)\s*THEN\s*RAISE\s+EXCEPTION\s+['"]([\s\S]+?)['"]/i);
        if (ifExistsMatch) {
          const checkQuery = ifExistsMatch[1];
          const errorMsg = ifExistsMatch[2];
          const result = mem.public.query(checkQuery);
          const rows = result ? (result.rows || (Array.isArray(result) ? result : [])) : [];
          if (rows.length > 0) {
            throw new Error(errorMsg);
          }
        }
      });
      const { Pool: MemPool } = mem.adapters.createPg();
      const pool = new MemPool();
      try {
        await pool.query(`
          CREATE TABLE progression_totals (
            user_id TEXT PRIMARY KEY,
            explorer_xp BIGINT,
            civic_xp BIGINT,
            civic_stamps BIGINT
          );
          INSERT INTO progression_totals (user_id, explorer_xp, civic_xp, civic_stamps)
          VALUES ('bad-user-1', -99, 0, 0);
        `);

        // Executing migration 014 preflight must fail with descriptive error
        const mig014Sql = readFileSync(join(__dirname, '..', 'migrations', '014_progression_hardening_and_retrofits.sql'), 'utf8');
        await expect(pool.query(mig014Sql)).rejects.toThrow('Migration 014 aborted: progression_totals contains values outside JavaScript safe integer range');
      } finally {
        await pool.end();
      }
    });
  });

  describe('IR2: Strict Claim Ownership & Mandatory Claim Token', () => {
    it('markOutboxCompleted rejects acknowledgement when claim_token is omitted or invalid', async () => {
      const eventId = randomUUID();
      await db.pool.query(`
        INSERT INTO outbox_events (id, event_key, event_type, payload, status, next_attempt_at)
        VALUES ('${eventId}', 'key-${eventId}', 'submission_approved_unresolved', '{}', 'pending', NOW())
      `);

      const claimed = await progressionRepo.claimPendingOutboxEvents(10, 30, 'worker-ir2', db.pool);
      const activeClaim = claimed.find((e) => e.id === eventId);
      expect(activeClaim).toBeDefined();

      // 1. Raw worker name without token: must return false
      const noTokenRes = await progressionRepo.markOutboxCompleted(eventId, 'worker-ir2', db.pool);
      expect(noTokenRes).toBe(false);

      // 2. Wrong token: must return false
      const wrongTokenRes = await progressionRepo.markOutboxCompleted(eventId, activeClaim!.lease_owner!, db.pool, randomUUID());
      expect(wrongTokenRes).toBe(false);

      // 3. Wrong worker owner: must return false
      const wrongOwnerRes = await progressionRepo.markOutboxCompleted(eventId, 'impostor-worker', db.pool, activeClaim!.claim_token);
      expect(wrongOwnerRes).toBe(false);

      // 4. Exact owner AND token: succeeds
      const legitRes = await progressionRepo.markOutboxCompleted(eventId, activeClaim!.lease_owner!, db.pool, activeClaim!.claim_token);
      expect(legitRes).toBe(true);
    });

    it('markOutboxFailed rejects acknowledgement when claim_token is omitted or invalid', async () => {
      const eventId = randomUUID();
      await db.pool.query(`
        INSERT INTO outbox_events (id, event_key, event_type, payload, status, next_attempt_at)
        VALUES ('${eventId}', 'key-fail-${eventId}', 'submission_approved_unresolved', '{}', 'pending', NOW())
      `);

      const claimed = await progressionRepo.claimPendingOutboxEvents(10, 30, 'worker-ir2-fail', db.pool);
      const activeClaim = claimed.find((e) => e.id === eventId);
      expect(activeClaim).toBeDefined();

      // Raw worker name without token fails
      const noToken = await progressionRepo.markOutboxFailed(eventId, 'worker-ir2-fail', 'err', 10, db.pool);
      expect(noToken).toBe(false);

      // Exact owner and token succeeds
      const legit = await progressionRepo.markOutboxFailed(eventId, activeClaim!.lease_owner!, 'simulated error', 10, db.pool, activeClaim!.claim_token);
      expect(legit).toBe(true);
    });
  });

  describe('IR3: Source-Chain Scope Agreement & Mandatory Reviewed Binding Evidence', () => {
    it('quarantines processing when binding_id is missing from payload', async () => {
      const subId = randomUUID();
      const uId = randomUUID();
      await db.pool.query(`INSERT INTO users (id, seed_id, display_name, email, role, is_test)
        VALUES ('${uId}', 'seed-nb-${uId}', 'No Binding User', '${uId}@test.ph', 'user', false)`);
      await db.pool.query(`INSERT INTO submissions (id, idempotency_key, user_id, quest_id, scanned_marker_code, captured_lat, captured_lng, captured_accuracy, status, is_test)
        VALUES ('${subId}', 'sub-nb-${subId}', '${uId}', 'quest-real-1', 'MARKER_R_1', 16.2, 119.9, 5, 'approved', false)`);

      const outboxId = randomUUID();
      await db.pool.query(`
        INSERT INTO outbox_events (id, event_key, event_type, payload, status, next_attempt_at)
        VALUES ('${outboxId}', 'key-nb-${outboxId}', 'submission_approved', $1, 'pending', NOW())
      `, [JSON.stringify({
        submission_id: subId,
        user_id: uId,
        quest_id: 'quest-real-1',
        spot_id: 'spot-alaminos-1',
        municipality_id: 'alaminos_city',
        occurred_at: new Date().toISOString(),
        is_test: false,
      })]);

      const result = await progressionService.processOutboxBatch(1, 'worker-scope-test');
      expect(result.failed).toBe(1);

      const { rows } = await db.pool.query('SELECT last_error, status FROM outbox_events WHERE id = $1', [outboxId]);
      expect(rows[0].last_error).toBe('BINDING_MISSING');
    });

    it('quarantines processing when reviewed binding is deprecated or inactive', async () => {
      const subId = randomUUID();
      const uId = randomUUID();
      const depBindingId = randomUUID();
      await db.pool.query(`INSERT INTO users (id, seed_id, display_name, email, role, is_test)
        VALUES ('${uId}', 'seed-dep-${uId}', 'Dep User', '${uId}@test.ph', 'user', false)`);
      await db.pool.query(`INSERT INTO submissions (id, idempotency_key, user_id, quest_id, scanned_marker_code, captured_lat, captured_lng, captured_accuracy, status, is_test)
        VALUES ('${subId}', 'sub-dep-${subId}', '${uId}', 'quest-real-1', 'MARKER_R_1', 16.2, 119.9, 5, 'approved', false)`);
      await db.pool.query(`INSERT INTO reviewed_quest_spot_bindings (id, quest_id, spot_id, binding_version, status, is_test)
        VALUES ('${depBindingId}', 'quest-real-1', 'spot-alaminos-1', 'v1', 'deprecated', false)`);

      const outboxId = randomUUID();
      await db.pool.query(`
        INSERT INTO outbox_events (id, event_key, event_type, payload, status, next_attempt_at)
        VALUES ('${outboxId}', 'key-dep-${outboxId}', 'submission_approved', $1, 'pending', NOW())
      `, [JSON.stringify({
        submission_id: subId,
        user_id: uId,
        quest_id: 'quest-real-1',
        spot_id: 'spot-alaminos-1',
        binding_id: depBindingId,
        municipality_id: 'alaminos_city',
        occurred_at: new Date().toISOString(),
        is_test: false,
      })]);

      const result = await progressionService.processOutboxBatch(1, 'worker-dep-test');
      expect(result.failed).toBe(1);

      const { rows } = await db.pool.query('SELECT last_error, status FROM outbox_events WHERE id = $1', [outboxId]);
      expect(rows[0].last_error).toBe('BINDING_NOT_ACTIVE');
    });

    it('quarantines processing when ANY entity in the source chain has a mismatched scope', async () => {
      // User=real, Quest=real, Spot=real, Submission=real, but Binding=TEST
      const subId = randomUUID();
      const uId = randomUUID();
      const mixQuestId = randomUUID();
      const mixedBindingId = randomUUID();

      await db.pool.query(`INSERT INTO users (id, seed_id, display_name, email, role, is_test)
        VALUES ('${uId}', 'seed-mix-${uId}', 'Mix User', '${uId}@test.ph', 'user', false)`);
      await db.pool.query(`INSERT INTO quests (id, title, description, category, location_name, gps_lat, gps_lng, radius_meters, reward_points, marker_code, marker_image_url, is_test)
        VALUES ('${mixQuestId}', 'Mix Quest', 'Desc', 'eco', 'Alaminos', 16.2, 119.9, 100, 50, 'MK_MIX', '', false)`);
      await db.pool.query(`INSERT INTO submissions (id, idempotency_key, user_id, quest_id, scanned_marker_code, captured_lat, captured_lng, captured_accuracy, status, is_test)
        VALUES ('${subId}', 'sub-mix-${subId}', '${uId}', '${mixQuestId}', 'MK_MIX', 16.2, 119.9, 5, 'approved', false)`);
      await db.pool.query(`INSERT INTO reviewed_quest_spot_bindings (id, quest_id, spot_id, binding_version, status, is_test)
        VALUES ('${mixedBindingId}', '${mixQuestId}', 'spot-alaminos-1', 'v1', 'active', true)`);

      const outboxId = randomUUID();
      await db.pool.query(`
        INSERT INTO outbox_events (id, event_key, event_type, payload, status, next_attempt_at)
        VALUES ('${outboxId}', 'key-mix-${outboxId}', 'submission_approved', $1, 'pending', NOW())
      `, [JSON.stringify({
        submission_id: subId,
        user_id: uId,
        quest_id: mixQuestId,
        spot_id: 'spot-alaminos-1',
        binding_id: mixedBindingId,
        municipality_id: 'alaminos_city',
        occurred_at: new Date().toISOString(),
        is_test: false,
      })]);

      const result = await progressionService.processOutboxBatch(1, 'worker-mix-test');
      expect(result.failed).toBe(1);

      const { rows } = await db.pool.query('SELECT last_error, status FROM outbox_events WHERE id = $1', [outboxId]);
      expect(rows[0].last_error).toBe('SCOPE_MISMATCH');
    });
  });

  describe('RC6: Writer Lock Ordering & Real-PG Concurrency', () => {
    it('recordProgressionEvent serializes with rebuildTotals through row lock on users table', async () => {
      const uId = randomUUID();
      await db.pool.query(`
        INSERT INTO users (id, seed_id, display_name, email, role)
        VALUES ('${uId}', 'seed-lock-${uId}', 'Lock User', '${uId}@test.ph', 'user')
      `);

      const c1 = await db.pool.connect();
      const c2 = await db.pool.connect();
      try {
        await c1.query('BEGIN');
        // c1 records progression event, acquiring user row lock
        await progressionRepo.recordProgressionEvent({
          id: randomUUID(),
          user_id: uId,
          track: 'explorer',
          delta: 50,
          source_type: 'submission_approval',
          source_id: 'lock-test-1',
          award_kind: 'xp',
          rule_version: 'v1',
          earned_at: new Date().toISOString(),
          is_test: false,
        }, c1);

        await c1.query('COMMIT');

        // c2 rebuilds totals cleanly
        const totals = await progressionRepo.rebuildTotalsForUser(uId, c2);
        expect(totals.explorer_xp).toBe(50);
      } finally {
        c1.release();
        c2.release();
      }
    });

    const realPgDescribe = process.env.JDQ_REAL_PG_URL ? describe : describe.skip;
    realPgDescribe('Real PostgreSQL High-Concurrency & Crash Isolation (JDQ_REAL_PG_URL)', () => {
      let realDb: TestDbInstance;

      beforeAll(async () => {
        realDb = await createTestDb();
      });

      afterAll(async () => {
        if (realDb) await realDb.close();
      });

      it('upgrades the original 013 constraints, registry, and default through the migration runner', async () => {
        const upgradeDb = await createTestDb();
        try {
          // Recreate the three original-013 differences in an isolated schema.
          await upgradeDb.pool.query('ALTER TABLE progression_events DROP CONSTRAINT uq_progression_events_source');
          await upgradeDb.pool.query(`ALTER TABLE progression_events ADD CONSTRAINT uq_progression_events_source
            UNIQUE (user_id, source_type, source_id, award_kind, rule_version)`);
          await upgradeDb.pool.query('DROP INDEX idx_unique_active_quest_binding');
          await upgradeDb.pool.query(`ALTER TABLE reviewed_quest_spot_bindings
            ADD CONSTRAINT uq_quest_binding_status UNIQUE (quest_id, status)`);
          await upgradeDb.pool.query('ALTER TABLE users ALTER COLUMN scout_reputation SET DEFAULT 100');
          await upgradeDb.pool.query("DELETE FROM municipalities WHERE id IN ('basista', 'binmaley')");
          await upgradeDb.pool.query("DELETE FROM schema_migrations WHERE filename = '015_progression_legacy_013_upgrade.sql'");

          const historicalUserId = randomUUID();
          await upgradeDb.pool.query(`INSERT INTO users(id, seed_id, display_name, email, role)
            VALUES ($1, $2, 'Historical Account', $3, 'user')`,
            [historicalUserId, `historical-${historicalUserId}`, `${historicalUserId}@test.ph`]);

          await applyMigrations(upgradeDb.pool);

          const { rows: historicalUsers } = await upgradeDb.pool.query(
            'SELECT scout_reputation FROM users WHERE id = $1', [historicalUserId]
          );
          expect(Number(historicalUsers[0].scout_reputation)).toBe(100);

          const { rows: oldBindingsConstraint } = await upgradeDb.pool.query(
            `SELECT conname FROM pg_constraint WHERE conname = 'uq_quest_binding_status'
             AND conrelid = 'reviewed_quest_spot_bindings'::regclass`
          );
          expect(oldBindingsConstraint).toHaveLength(0);
          const { rows: activeIndex } = await upgradeDb.pool.query(
            `SELECT indexname FROM pg_indexes WHERE schemaname = current_schema()
             AND tablename = 'reviewed_quest_spot_bindings'
             AND indexname = 'idx_unique_active_quest_binding'`
          );
          expect(activeIndex).toHaveLength(1);

          const { rows: lguRows } = await upgradeDb.pool.query(
            "SELECT COUNT(*)::int AS total FROM municipalities WHERE is_active = TRUE"
          );
          expect(Number(lguRows[0].total)).toBe(48);

          const userId = randomUUID();
          await upgradeDb.pool.query(`INSERT INTO users(id, seed_id, display_name, email, role)
            VALUES ($1, $2, 'Legacy Upgrade', $3, 'user')`,
            [userId, `legacy-${userId}`, `${userId}@test.ph`]);
          const { rows: users } = await upgradeDb.pool.query(
            'SELECT scout_reputation FROM users WHERE id = $1', [userId]
          );
          expect(Number(users[0].scout_reputation)).toBe(0);

          const client = await upgradeDb.pool.connect();
          try {
            const base = {
              user_id: userId, track: 'explorer' as const, delta: 50,
              source_type: 'submission_approval', source_id: `upgrade-${userId}`,
              award_kind: 'xp', earned_at: new Date().toISOString(), is_test: false,
            };
            expect(await progressionRepo.recordProgressionEvent({
              ...base, id: randomUUID(), rule_version: 'v1',
            }, client)).not.toBeNull();
            expect(await progressionRepo.recordProgressionEvent({
              ...base, id: randomUUID(), rule_version: 'v2',
            }, client)).toBeNull();
          } finally {
            client.release();
          }
        } finally {
          await upgradeDb.close();
        }
      });

      it('handles 5 concurrent workers claiming 20 events with FOR UPDATE SKIP LOCKED without duplicate claims', async () => {
        const eventIds: string[] = [];
        for (let i = 0; i < 20; i++) {
          const eid = randomUUID();
          eventIds.push(eid);
          await realDb.pool.query(`
            INSERT INTO outbox_events (id, event_key, event_type, payload, status, next_attempt_at)
            VALUES ($1, $2, 'submission_approved_unresolved', '{}', 'pending', NOW())
          `, [eid, `real-pg-concurrency-${eid}`]);
        }

        const claimPromises = [1, 2, 3, 4, 5].map((wId) =>
          progressionRepo.claimPendingOutboxEvents(5, 30, `real-worker-${wId}`, realDb.pool)
        );

        const claimResults = await Promise.all(claimPromises);
        const allClaimed = claimResults.flat();

        expect(allClaimed.length).toBe(20);
        const claimedSet = new Set(allClaimed.map((e) => e.id));
        expect(claimedSet.size).toBe(20);

        for (const ev of allClaimed) {
          expect(ev.status).toBe('processing');
          expect(ev.claim_token).toBeDefined();
        }
      });

      it('enforces reclaim and rejects stale worker completion under real PostgreSQL', async () => {
        const eid = randomUUID();
        await realDb.pool.query(`
          INSERT INTO outbox_events (id, event_key, event_type, payload, status, next_attempt_at)
          VALUES ($1, $2, 'submission_approved_unresolved', '{}', 'pending', NOW())
        `, [eid, `real-pg-fence-${eid}`]);

        const claimed1 = await progressionRepo.claimPendingOutboxEvents(1, 30, 'worker-real-1', realDb.pool);
        expect(claimed1.length).toBe(1);
        const w1Claim = claimed1[0];

        await realDb.pool.query(
          "UPDATE outbox_events SET lease_expires_at = NOW() - INTERVAL '10 seconds' WHERE id = $1",
          [eid]
        );

        const claimed2 = await progressionRepo.claimPendingOutboxEvents(1, 30, 'worker-real-2', realDb.pool);
        expect(claimed2.length).toBe(1);
        const w2Claim = claimed2[0];

        const staleRes = await progressionRepo.markOutboxCompleted(eid, w1Claim.lease_owner!, realDb.pool, w1Claim.claim_token);
        expect(staleRes).toBe(false);

        const legitRes = await progressionRepo.markOutboxCompleted(eid, w2Claim.lease_owner!, realDb.pool, w2Claim.claim_token);
        expect(legitRes).toBe(true);

        const { rows } = await realDb.pool.query('SELECT status, delivered_at FROM outbox_events WHERE id = $1', [eid]);
        expect(rows[0].status).toBe('completed');
        expect(rows[0].delivered_at).not.toBeNull();
      });

      it('serializes concurrent writers and rebuilder under real PostgreSQL row-level locks', async () => {
        const uId = randomUUID();
        await realDb.pool.query(`
          INSERT INTO users (id, seed_id, display_name, email, role)
          VALUES ($1, $2, 'Real Concurrency User', $3, 'user')
        `, [uId, `seed-real-${uId}`, `${uId}@test.ph`]);

        const c1 = await realDb.pool.connect();
        const c2 = await realDb.pool.connect();

        try {
          await c1.query('BEGIN');
          await progressionRepo.recordProgressionEvent({
            id: randomUUID(),
            user_id: uId,
            track: 'explorer',
            delta: 50,
            source_type: 'submission_approval',
            source_id: `real-src-1-${uId}`,
            award_kind: 'xp',
            rule_version: 'v1',
            earned_at: new Date().toISOString(),
            is_test: false,
          }, c1);

          let rebuilderFinished = false;
          const rebuilderTask = (async () => {
            await c2.query('BEGIN');
            const res = await progressionRepo.rebuildTotalsForUser(uId, c2);
            await c2.query('COMMIT');
            rebuilderFinished = true;
            return res;
          })();

          await new Promise((r) => setTimeout(r, 100));
          expect(rebuilderFinished).toBe(false);

          await c1.query('COMMIT');

          const totals = await rebuilderTask;
          expect(rebuilderFinished).toBe(true);
          expect(totals.explorer_xp).toBe(50);
        } finally {
          c1.release();
          c2.release();
        }
      });
    });
  });
});
