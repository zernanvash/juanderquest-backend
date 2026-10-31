import request from 'supertest';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import { app } from '../src/app.js';
import { db } from '../src/db/index.js';
import { spotStore } from '../src/spots/store.js';
import { env } from '../src/config/env.js';
import { submissionsService } from '../src/services/submissions.js';

describe('Phase 1: Quest Truth and Proof-Security Repair (P0)', () => {
  const authorUserId = '11111111-1111-1111-1111-111111111111'; // Juan Dela Cruz
  const travelerUserId = '33333333-3333-3333-3333-333333333333'; // Scout Traveler
  const otherTravelerUserId = '66666666-6666-6666-6666-666666666666'; // Same-scope second traveler
  const qaUserId = '55555555-5555-5555-5555-555555555555'; // QA Evaluator

  const travelerToken = jwt.sign(
    { id: travelerUserId, seed_id: 'demo-traveler-1', role: 'user' },
    env.JWT_SECRET
  );

  const otherTravelerToken = jwt.sign(
    { id: otherTravelerUserId, seed_id: 'proof-security-traveler-2', role: 'user' },
    env.JWT_SECRET
  );

  const qaToken = jwt.sign(
    { id: qaUserId, seed_id: 'qa-evaluator-1', role: 'qa' },
    env.JWT_SECRET
  );

  const authorToken = jwt.sign(
    { id: authorUserId, seed_id: 'demo-author-1', role: 'user' },
    env.JWT_SECRET
  );

  const testSpotId = `spot-security-test-${Date.now()}`;
  const testQuestId = `quest-security-test-${Date.now()}`;
  const otherQuestId = `quest-other-test-${Date.now()}`;
  const secretMarkerCode = `JDQ-SECRET-${randomUUID().slice(0, 8).toUpperCase()}`;

  // Coordinates: Patar Beach Bolinao (16.3204, 119.7847)
  const questLat = 16.3204;
  const questLng = 119.7847;
  const questRadius = 150; // meters

  beforeAll(() => {
    // The legacy 4444 account is synthetic; using it against this live-scope
    // quest now correctly fails at the scope gate before challenge validation.
    // A separate same-scope actor keeps these challenge assertions meaningful.
    db.users.push({ ...db.findUserById(travelerUserId)!, id: otherTravelerUserId,
      seed_id: 'proof-security-traveler-2', display_name: 'Proof Security Traveler',
      email: 'proof-security-traveler@example.invalid', handle: 'proofsecuritytraveler',
      is_test: false });
    db.users.push({ id: qaUserId, seed_id: 'qa-evaluator-1', role: 'qa', display_name: 'QA Evaluator', email: 'qa@example.invalid', is_test: true } as any);
    // Register spot authored by Juan Dela Cruz
    spotStore.spots.push({
      id: testSpotId,
      slug: `security-test-spot-${Date.now()}`,
      name: 'Security Test Destination',
      description: 'Destination for Phase 1 proof security tests.',
      category: 'nature_outdoors',
      subcategory: 'beach',
      tags: ['beach'],
      municipality: 'Bolinao',
      address: 'Patar Beach, Bolinao',
      gps_lat: questLat,
      gps_lng: questLng,
      price_level: 1,
      hours: { daily: '06:00-18:00' },
      amenities: ['parking'],
      image_url: 'https://images.unsplash.com/photo-1507525428034-b723cf961d3e',
      source_type: 'community',
      source_name: 'Juan Dela Cruz',
      trust_level: 'community',
      status: 'published',
      created_by: authorUserId,
      quest_id: testQuestId,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    // Add target quest to in-memory db
    db.quests.push({
      id: testQuestId,
      title: 'Patar Beach Security Quest',
      description: 'Verify your presence at Patar Beach using single-use challenge.',
      category: 'eco',
      location_name: 'Patar Beach',
      gps_lat: questLat,
      gps_lng: questLng,
      radius_meters: questRadius,
      base_reward_php: 50,
      difficulty_factor: 1,
      geo_multiplier: 1,
      reward_points: 75,
      marker_code: secretMarkerCode,
      marker_image_url: '',
      is_active: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    // Add secondary quest to test quest mismatch
    db.quests.push({
      id: otherQuestId,
      title: 'Secondary Quest',
      description: 'Different quest for mismatch test.',
      category: 'cultural',
      location_name: 'Bolinao Town',
      gps_lat: 16.38,
      gps_lng: 119.89,
      radius_meters: 100,
      base_reward_php: 50,
      difficulty_factor: 1,
      geo_multiplier: 1,
      reward_points: 50,
      marker_code: 'JDQ-OTHER-01',
      marker_image_url: '',
      is_active: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
  });

  afterAll(() => {
    db.users = db.users.filter((u) => u.id !== otherTravelerUserId);
    spotStore.spots = spotStore.spots.filter((s) => s.id !== testSpotId);
    db.quests = db.quests.filter((q) => q.id !== testQuestId && q.id !== otherQuestId);
  });

  describe('1. Secret Masking on Public Detail', () => {
    it('strips marker_code from public unauthenticated GET /quests/:id', async () => {
      const res = await request(app).get(`/api/v1/quests/${testQuestId}`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.id).toBe(testQuestId);
      expect(res.body.data.marker_code).toBeUndefined(); // Secret MUST NOT leak
    });

    it('strips marker_code from regular traveler authenticated GET /quests/:id', async () => {
      const res = await request(app)
        .get(`/api/v1/quests/${testQuestId}`)
        .set('Authorization', `Bearer ${travelerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.marker_code).toBeUndefined(); // Secret MUST NOT leak
    });

    it('allows the spot author to view marker_code on GET /quests/:id', async () => {
      const res = await request(app)
        .get(`/api/v1/quests/${testQuestId}`)
        .set('Authorization', `Bearer ${authorToken}`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.marker_code).toBe(secretMarkerCode); // Author allowed
    });

    it('allows QA evaluators to view marker_code on GET /quests/:id', async () => {
      const res = await request(app)
        .get(`/api/v1/quests/${testQuestId}`)
        .set('Authorization', `Bearer ${qaToken}`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.marker_code).toBe(secretMarkerCode); // QA allowed
    });
  });

  describe('2. Challenge Token Generation', () => {
    it('rejects unauthenticated requests to generate challenge token', async () => {
      const res = await request(app).post(`/api/v1/quests/${testQuestId}/challenge`);
      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });

    it('issues a valid signed challenge token to authenticated traveler', async () => {
      const res = await request(app)
        .post(`/api/v1/quests/${testQuestId}/challenge`)
        .set('Authorization', `Bearer ${travelerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.challenge_token).toBeDefined();
      expect(res.body.data.quest_id).toBe(testQuestId);

      const decoded = jwt.verify(res.body.data.challenge_token, env.JWT_SECRET) as any;
      expect(decoded.sub).toBe('quest_challenge');
      expect(decoded.user_id).toBe(travelerUserId);
      expect(decoded.quest_id).toBe(testQuestId);
      expect(decoded.nonce).toBeDefined();
    });
  });

  describe('3. Submission Verification & Fraud Prevention', () => {
    beforeEach(() => {
      // Each proof-policy case starts a fresh review cycle; a pending proof
      // intentionally blocks a second independent submission for that pair.
      db.submissions = db.submissions.filter((submission) => submission.quest_id !== testQuestId);
    });

    it('accepts valid challenge token within GPS radius and creates pending submission', async () => {
      // Obtain challenge token
      const challengeRes = await request(app)
        .post(`/api/v1/quests/${testQuestId}/challenge`)
        .set('Authorization', `Bearer ${travelerToken}`);
      const challengeToken = challengeRes.body.data.challenge_token;

      // Submit proof at 10 meters away from Patar Beach
      const subRes = await request(app)
        .post('/api/v1/submissions')
        .set('Authorization', `Bearer ${travelerToken}`)
        .send({
          idempotency_key: randomUUID(),
          quest_id: testQuestId,
          challenge_token: challengeToken,
          captured_lat: questLat + 0.00005,
          captured_lng: questLng + 0.00005,
          captured_accuracy: 5,
        });

      expect(subRes.status).toBe(201);
      expect(subRes.body.success).toBe(true);
      expect(subRes.body.data.status).toBe('pending'); // Must be pending admin review, not instant reward
    });

    it('rejects forged challenge token with 401 INVALID_CHALLENGE', async () => {
      const forgedToken = jwt.sign(
        { sub: 'quest_challenge', user_id: travelerUserId, quest_id: testQuestId, nonce: randomUUID() },
        'WRONG_FORGED_SECRET'
      );

      const res = await request(app)
        .post('/api/v1/submissions')
        .set('Authorization', `Bearer ${travelerToken}`)
        .send({
          idempotency_key: randomUUID(),
          quest_id: testQuestId,
          challenge_token: forgedToken,
          captured_lat: questLat,
          captured_lng: questLng,
          captured_accuracy: 5,
        });

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('INVALID_CHALLENGE');
    });

    it('rejects expired challenge token with 400 CHALLENGE_EXPIRED', async () => {
      const expiredToken = jwt.sign(
        {
          sub: 'quest_challenge',
          user_id: travelerUserId,
          quest_id: testQuestId,
          nonce: randomUUID(),
          iat: Math.floor(Date.now() / 1000) - 1000,
          exp: Math.floor(Date.now() / 1000) - 100, // expired 100s ago
        },
        env.JWT_SECRET
      );

      const res = await request(app)
        .post('/api/v1/submissions')
        .set('Authorization', `Bearer ${travelerToken}`)
        .send({
          idempotency_key: randomUUID(),
          quest_id: testQuestId,
          challenge_token: expiredToken,
          captured_lat: questLat,
          captured_lng: questLng,
          captured_accuracy: 5,
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('CHALLENGE_EXPIRED');
    });

    it('rejects wrong-actor challenge token with 403 CHALLENGE_ACTOR_MISMATCH', async () => {
      // Challenge issued for travelerUser
      const challengeRes = await request(app)
        .post(`/api/v1/quests/${testQuestId}/challenge`)
        .set('Authorization', `Bearer ${travelerToken}`);
      const challengeToken = challengeRes.body.data.challenge_token;

      // Submitted by otherTravelerUser
      const res = await request(app)
        .post('/api/v1/submissions')
        .set('Authorization', `Bearer ${otherTravelerToken}`)
        .send({
          idempotency_key: randomUUID(),
          quest_id: testQuestId,
          challenge_token: challengeToken,
          captured_lat: questLat,
          captured_lng: questLng,
          captured_accuracy: 5,
        });

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('CHALLENGE_ACTOR_MISMATCH');
    });

    it('rejects wrong-quest challenge token with 400 CHALLENGE_QUEST_MISMATCH', async () => {
      // Challenge issued for testQuestId
      const challengeRes = await request(app)
        .post(`/api/v1/quests/${testQuestId}/challenge`)
        .set('Authorization', `Bearer ${travelerToken}`);
      const challengeToken = challengeRes.body.data.challenge_token;

      // Submitted for otherQuestId
      const res = await request(app)
        .post('/api/v1/submissions')
        .set('Authorization', `Bearer ${travelerToken}`)
        .send({
          idempotency_key: randomUUID(),
          quest_id: otherQuestId,
          challenge_token: challengeToken,
          captured_lat: 16.38,
          captured_lng: 119.89,
          captured_accuracy: 5,
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('CHALLENGE_QUEST_MISMATCH');
    });

    it('reports a consumed challenge after the first proof is rejected', async () => {
      // Issue challenge
      const challengeRes = await request(app)
        .post(`/api/v1/quests/${testQuestId}/challenge`)
        .set('Authorization', `Bearer ${travelerToken}`);
      const challengeToken = challengeRes.body.data.challenge_token;

      // First use succeeds
      const firstRes = await request(app)
        .post('/api/v1/submissions')
        .set('Authorization', `Bearer ${travelerToken}`)
        .send({
          idempotency_key: randomUUID(),
          quest_id: testQuestId,
          challenge_token: challengeToken,
          captured_lat: questLat,
          captured_lng: questLng,
          captured_accuracy: 5,
        });
      expect(firstRes.status).toBe(201);
      db.reviewSubmission(firstRes.body.data.id, 'reject', 'independent-reviewer', 'Proof rejected for test replay.');

      // Replay attempt with different idempotency key fails
      const replayRes = await request(app)
        .post('/api/v1/submissions')
        .set('Authorization', `Bearer ${travelerToken}`)
        .send({
          idempotency_key: randomUUID(),
          quest_id: testQuestId,
          challenge_token: challengeToken,
          captured_lat: questLat,
          captured_lng: questLng,
          captured_accuracy: 5,
        });
      expect(replayRes.status).toBe(409);
      expect(replayRes.body.error.code).toBe('CHALLENGE_ALREADY_USED');
    });

    it('rejects submission with out-of-radius coordinates with 422 OUT_OF_RANGE', async () => {
      const challengeRes = await request(app)
        .post(`/api/v1/quests/${testQuestId}/challenge`)
        .set('Authorization', `Bearer ${travelerToken}`);
      const challengeToken = challengeRes.body.data.challenge_token;

      // Coordinate in Manila (~200 km away)
      const res = await request(app)
        .post('/api/v1/submissions')
        .set('Authorization', `Bearer ${travelerToken}`)
        .send({
          idempotency_key: randomUUID(),
          quest_id: testQuestId,
          challenge_token: challengeToken,
          captured_lat: 14.5995,
          captured_lng: 120.9842,
          captured_accuracy: 5,
        });

      expect(res.status).toBe(422);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('OUT_OF_RANGE');

      const retry = await request(app)
        .post('/api/v1/submissions')
        .set('Authorization', `Bearer ${travelerToken}`)
        .send({
          idempotency_key: randomUUID(),
          quest_id: testQuestId,
          challenge_token: challengeToken,
          captured_lat: questLat,
          captured_lng: questLng,
          captured_accuracy: 5,
        });
      expect(retry.status).toBe(201);
    });

    it('rejects deprecated marker-code proof when the legacy path is disabled', async () => {
      const original = env.ALLOW_LEGACY_MARKER_PROOF;
      env.ALLOW_LEGACY_MARKER_PROOF = false;
      try {
        const res = await request(app)
          .post('/api/v1/submissions')
          .set('Authorization', `Bearer ${otherTravelerToken}`)
          .send({
            idempotency_key: randomUUID(),
            quest_id: testQuestId,
            scanned_marker_code: secretMarkerCode,
            captured_lat: questLat,
            captured_lng: questLng,
            captured_accuracy: 5,
          });

        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
        expect(res.body.error.code).toBe('CHALLENGE_REQUIRED');
      } finally {
        env.ALLOW_LEGACY_MARKER_PROOF = original;
      }
    });

    it('replays idempotently when the same key and challenge token are resubmitted', async () => {
      const challengeRes = await request(app)
        .post(`/api/v1/quests/${testQuestId}/challenge`)
        .set('Authorization', `Bearer ${otherTravelerToken}`);
      const challengeToken = challengeRes.body.data.challenge_token;
      const idempotencyKey = randomUUID();
      const body = {
        idempotency_key: idempotencyKey,
        quest_id: testQuestId,
        challenge_token: challengeToken,
        captured_lat: questLat,
        captured_lng: questLng,
        captured_accuracy: 5,
      };

      const first = await request(app)
        .post('/api/v1/submissions')
        .set('Authorization', `Bearer ${otherTravelerToken}`)
        .send(body);
      expect(first.status).toBe(201);

      const replay = await request(app)
        .post('/api/v1/submissions')
        .set('Authorization', `Bearer ${otherTravelerToken}`)
        .send(body);
      expect(replay.status).toBe(200);
      expect(replay.body.data.id).toBe(first.body.data.id);
    });

    it('rejects a reused idempotency key paired with a different challenge token', async () => {
      const firstChallenge = await request(app)
        .post(`/api/v1/quests/${testQuestId}/challenge`)
        .set('Authorization', `Bearer ${otherTravelerToken}`);
      const idempotencyKey = randomUUID();

      const first = await request(app)
        .post('/api/v1/submissions')
        .set('Authorization', `Bearer ${otherTravelerToken}`)
        .send({
          idempotency_key: idempotencyKey,
          quest_id: testQuestId,
          challenge_token: firstChallenge.body.data.challenge_token,
          captured_lat: questLat,
          captured_lng: questLng,
          captured_accuracy: 5,
        });
      expect(first.status).toBe(201);

      const secondChallenge = await request(app)
        .post(`/api/v1/quests/${testQuestId}/challenge`)
        .set('Authorization', `Bearer ${otherTravelerToken}`);

      const conflict = await request(app)
        .post('/api/v1/submissions')
        .set('Authorization', `Bearer ${otherTravelerToken}`)
        .send({
          idempotency_key: idempotencyKey,
          quest_id: testQuestId,
          challenge_token: secondChallenge.body.data.challenge_token,
          captured_lat: questLat,
          captured_lng: questLng,
          captured_accuracy: 5,
        });

      expect(conflict.status).toBe(409);
      expect(conflict.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    });

    it('admits only one concurrent submission for a quest and traveler', async () => {
      const challengeRes = await request(app)
        .post(`/api/v1/quests/${testQuestId}/challenge`)
        .set('Authorization', `Bearer ${otherTravelerToken}`);
      const challengeToken = challengeRes.body.data.challenge_token;

      const submit = () =>
        request(app)
          .post('/api/v1/submissions')
          .set('Authorization', `Bearer ${otherTravelerToken}`)
          .send({
            idempotency_key: randomUUID(),
            quest_id: testQuestId,
            challenge_token: challengeToken,
            captured_lat: questLat,
            captured_lng: questLng,
            captured_accuracy: 5,
          });

      const results = await Promise.all([submit(), submit()]);
      const statuses = results.map((r) => r.status).sort();
      expect(statuses).toEqual([201, 409]);
      const rejected = results.find((r) => r.status === 409);
      expect(rejected?.body.error.code).toBe('SUBMISSION_PENDING');
    });
  });

  afterAll(() => {
    db.users = db.users.filter((u) => u.id !== otherTravelerUserId && u.id !== qaUserId);
    spotStore.spots = spotStore.spots.filter((s) => s.id !== testSpotId);
  });

  describe('4. Concurrency & Review Double-Award Defense', () => {
    it('prevents double-awarding points when reviewSubmission is called concurrently', async () => {
      // Create a pending submission in memory
      const sub = db.createSubmission({
        idempotency_key: randomUUID(),
        user_id: travelerUserId,
        quest_id: testQuestId,
        scanned_marker_code: 'TEST_MANUAL',
        captured_lat: questLat,
        captured_lng: questLng,
        captured_accuracy: 5,
        status: 'pending',
      });

      // Execute two concurrent approvals
      const [res1, res2] = await Promise.all([
        submissionsService.reviewSubmission(sub.id, 'approve', 'admin-1'),
        submissionsService.reviewSubmission(sub.id, 'approve', 'admin-1'),
      ]);

      expect(res1.success).toBe(true);
      expect(res2.success).toBe(true);

      // Only one award occurs; subsequent review returns existing status without double points
      const awarded1 = res1.data?.awarded_points ?? 0;
      const awarded2 = res2.data?.awarded_points ?? 0;
      expect(awarded1 + awarded2).toBe(75); // Exactly 75 points awarded in total, NOT 150
    });
  });
});
