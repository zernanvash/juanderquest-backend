import request from 'supertest';
import jwt from 'jsonwebtoken';
import { app } from '../src/app.js';
import { db } from '../src/db/index.js';
import { env } from '../src/config/env.js';
import { spotStore } from '../src/spots/store.js';

describe('Durable Quest Step Evidence & Attempt State Contract (Phase 1-3)', () => {
  const authorUserId = 'author-scout-991';
  const travelerUserId = 'traveler-scout-992';
  const otherAdminId = 'admin-scout-993';

  const authorToken = jwt.sign(
    { id: authorUserId, seed_id: 'author-01', role: 'user' },
    env.JWT_SECRET
  );

  const travelerToken = jwt.sign(
    { id: travelerUserId, seed_id: 'traveler-01', role: 'user' },
    env.JWT_SECRET
  );

  const adminToken = jwt.sign(
    { id: otherAdminId, seed_id: 'admin-01', role: 'admin' },
    env.JWT_SECRET
  );

  const testQuestId = `quest-evidence-test-${Date.now()}`;
  const testSpotId = `spot-evidence-test-${Date.now()}`;

  beforeAll(() => {
    // Add users
    db.users.push({
      id: authorUserId,
      seed_id: 'author-01',
      display_name: 'Author User',
      email: 'author@juanderquest.test',
      avatar_url: '',
      role: 'user',
      demo_points: 0,
      mjdq_balance: 0,
      jdq_governance_balance: 0,
      scout_reputation: 100,
      is_public: false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    db.users.push({
      id: travelerUserId,
      seed_id: 'traveler-01',
      display_name: 'Traveler User',
      email: 'traveler@juanderquest.test',
      avatar_url: '',
      role: 'user',
      demo_points: 0,
      mjdq_balance: 0,
      jdq_governance_balance: 0,
      scout_reputation: 100,
      is_public: false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    db.users.push({
      id: otherAdminId,
      seed_id: 'admin-01',
      display_name: 'Admin Moderator',
      email: 'admin@juanderquest.test',
      avatar_url: '',
      role: 'admin',
      demo_points: 0,
      mjdq_balance: 0,
      jdq_governance_balance: 0,
      scout_reputation: 500,
      is_public: false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    // Add spot
    spotStore.spots.push({
      id: testSpotId,
      slug: `spot-${testSpotId}`,
      name: 'Cape Bolinao Lighthouse Sanctuary',
      description: 'Historical lighthouse perched on Punta Piedra Point.',
      category: 'nature_outdoors',
      subcategory: 'viewpoint',
      tags: ['heritage', 'viewpoint'],
      municipality: 'Bolinao',
      address: 'Punta Piedra Point, Bolinao, Pangasinan',
      gps_lat: 16.3072,
      gps_lng: 119.7891,
      price_level: 1,
      hours: { daily: '06:00-18:00' },
      amenities: ['parking'],
      image_url: 'https://images.unsplash.com/photo-1507525428034-b723cf961d3e',
      source_type: 'community',
      source_name: 'Author User',
      trust_level: 'community',
      status: 'published',
      quest_id: testQuestId,
      created_by: authorUserId,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    // Add multi-step quest
    db.quests.push({
      id: testQuestId,
      author_id: authorUserId,
      status: 'published',
      version: 1,
      title: 'Cape Bolinao Heritage & Eco Trail',
      description: 'Explore Cape Bolinao Lighthouse, verify physical plaque, and document coastline conservation.',
      category: 'eco',
      location_name: 'Bolinao, Pangasinan',
      gps_lat: 16.3072,
      gps_lng: 119.7891,
      radius_meters: 150,
      base_reward_php: 50,
      difficulty_factor: 1,
      geo_multiplier: 1.5,
      reward_points: 100,
      marker_code: 'BOLINAO_LIGHTHOUSE_QR_2026',
      marker_image_url: '',
      is_active: true,
      steps: [
        {
          step_order: 1,
          title: 'Arrive at Cape Bolinao',
          description: 'Check in within 150m of the lighthouse.',
          checkpoint_type: 'location',
          required: true,
          gps_lat: 16.3072,
          gps_lng: 119.7891,
          radius_meters: 150,
        },
        {
          step_order: 2,
          title: 'Scan Heritage Plaque QR',
          description: 'Locate the historical marker on the stone tower and scan its code.',
          checkpoint_type: 'qr',
          required: true,
          hint: 'BOLINAO_LIGHTHOUSE_QR_2026',
        },
        {
          step_order: 3,
          title: 'Eco Cleanup Photo',
          description: 'Capture a photo of the coastal area cleanup.',
          checkpoint_type: 'photo',
          required: true,
        },
      ],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
  });

  afterAll(() => {
    spotStore.spots = spotStore.spots.filter((s) => s.id !== testSpotId);
    db.quests = db.quests.filter((q) => q.id !== testQuestId);
    db.users = db.users.filter((u) => ![authorUserId, travelerUserId, otherAdminId].includes(u.id));
    db.quest_attempts = db.quest_attempts.filter((a) => a.quest_id !== testQuestId);
    db.quest_step_evidence = db.quest_step_evidence.filter((e) => e.quest_id !== testQuestId);
  });

  let attemptId = '';

  it('enrolls traveler and initializes per-step evidence with step 1 ready and steps 2-3 locked', async () => {
    const res = await request(app)
      .post(`/api/v1/quests/${testQuestId}/attempts`)
      .set('Authorization', `Bearer ${travelerToken}`);

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.status).toBe('in_progress');
    expect(res.body.data.current_step).toBe(1);
    expect(res.body.data.total_steps).toBe(3);
    expect(res.body.data.verified_steps).toBe(0);
    expect(res.body.data.required_steps).toBe(3);
    attemptId = res.body.data.id;

    // Verify progress returns per-step evidence
    const progressRes = await request(app)
      .get(`/api/v1/quests/${testQuestId}/progress`)
      .set('Authorization', `Bearer ${travelerToken}`);

    expect(progressRes.status).toBe(200);
    expect(progressRes.body.data.has_completed).toBe(false);
    const steps = progressRes.body.data.active_attempt.steps;
    expect(steps).toHaveLength(3);
    expect(steps[0].step_order).toBe(1);
    expect(steps[0].status).toBe('ready');
    expect(steps[1].step_order).toBe(2);
    expect(steps[1].status).toBe('not_started');
    expect(steps[2].step_order).toBe(3);
    expect(steps[2].status).toBe('not_started');
  });

  it('rejects attempt to complete step 2 while step 1 is still not_started/ready', async () => {
    const res = await request(app)
      .post(`/api/v1/quests/${testQuestId}/steps/2/evidence`)
      .set('Authorization', `Bearer ${travelerToken}`)
      .send({
        idempotency_key: 'idemp-step2-premature',
        qr_code: 'BOLINAO_LIGHTHOUSE_QR_2026',
        captured_lat: 16.3072,
        captured_lng: 119.7891,
      });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('STEP_NOT_READY');
  });

  it('rejects location check-in when GPS coordinates exceed allowed radius', async () => {
    // 50km away in Dagupan (16.0433, 120.3334)
    const res = await request(app)
      .post(`/api/v1/quests/${testQuestId}/steps/1/evidence`)
      .set('Authorization', `Bearer ${travelerToken}`)
      .send({
        idempotency_key: 'idemp-step1-distant',
        captured_lat: 16.0433,
        captured_lng: 120.3334,
      });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('GPS_RADIUS_EXCEEDED');
  });

  it('verifies location step when GPS is within 150m, unlocking step 2', async () => {
    const res = await request(app)
      .post(`/api/v1/quests/${testQuestId}/steps/1/evidence`)
      .set('Authorization', `Bearer ${travelerToken}`)
      .send({
        idempotency_key: 'idemp-step1-valid',
        captured_lat: 16.30725,
        captured_lng: 119.78915,
        captured_accuracy: 5,
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.step.status).toBe('verified');
    expect(res.body.data.step.verified_at).toBeDefined();

    // Verify step 2 is now ready
    const progressRes = await request(app)
      .get(`/api/v1/quests/${testQuestId}/progress`)
      .set('Authorization', `Bearer ${travelerToken}`);

    expect(progressRes.body.data.active_attempt.verified_steps).toBe(1);
    const steps = progressRes.body.data.active_attempt.steps;
    expect(steps[0].status).toBe('verified');
    expect(steps[1].status).toBe('ready');
    expect(steps[2].status).toBe('not_started');
  });

  it('idempotently replays step 1 verification without error', async () => {
    const res = await request(app)
      .post(`/api/v1/quests/${testQuestId}/steps/1/evidence`)
      .set('Authorization', `Bearer ${travelerToken}`)
      .send({
        idempotency_key: 'idemp-step1-valid',
        captured_lat: 16.30725,
        captured_lng: 119.78915,
      });

    expect(res.status).toBe(200);
    expect(res.body.data.step.status).toBe('verified');
  });

  it('rejects QR verification when fresh GPS reading is missing or out of radius', async () => {
    const noGpsRes = await request(app)
      .post(`/api/v1/quests/${testQuestId}/steps/2/evidence`)
      .set('Authorization', `Bearer ${travelerToken}`)
      .send({
        idempotency_key: 'idemp-step2-no-gps',
        qr_code: 'BOLINAO_LIGHTHOUSE_QR_2026',
      });

    expect(noGpsRes.status).toBe(400);
    expect(noGpsRes.body.error.code).toBe('MISSING_GPS_COORDINATES');

    const outRadiusRes = await request(app)
      .post(`/api/v1/quests/${testQuestId}/steps/2/evidence`)
      .set('Authorization', `Bearer ${travelerToken}`)
      .send({
        idempotency_key: 'idemp-step2-out-gps',
        qr_code: 'BOLINAO_LIGHTHOUSE_QR_2026',
        captured_lat: 16.0,
        captured_lng: 120.0,
      });

    expect(outRadiusRes.status).toBe(400);
    expect(outRadiusRes.body.error.code).toBe('GPS_RADIUS_EXCEEDED');
  });

  it('rejects QR verification with invalid QR payload', async () => {
    const res = await request(app)
      .post(`/api/v1/quests/${testQuestId}/steps/2/evidence`)
      .set('Authorization', `Bearer ${travelerToken}`)
      .send({
        idempotency_key: 'idemp-step2-fake-qr',
        qr_code: 'FAKE_RANDOM_CODE_9999',
        captured_lat: 16.3072,
        captured_lng: 119.7891,
      });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_QR_CODE');
  });

  it('verifies QR step with valid marker code and fresh GPS, unlocking step 3', async () => {
    const res = await request(app)
      .post(`/api/v1/quests/${testQuestId}/steps/2/evidence`)
      .set('Authorization', `Bearer ${travelerToken}`)
      .send({
        idempotency_key: 'idemp-step2-valid-qr',
        qr_code: 'BOLINAO_LIGHTHOUSE_QR_2026',
        captured_lat: 16.3072,
        captured_lng: 119.7891,
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.step.status).toBe('verified');

    const progressRes = await request(app)
      .get(`/api/v1/quests/${testQuestId}/progress`)
      .set('Authorization', `Bearer ${travelerToken}`);

    expect(progressRes.body.data.active_attempt.verified_steps).toBe(2);
    const steps = progressRes.body.data.active_attempt.steps;
    expect(steps[1].status).toBe('verified');
    expect(steps[2].status).toBe('ready');
  });

  it('submits photo evidence with SHA-256 fingerprint into pending_review', async () => {
    // 1x1 transparent PNG buffer
    const pngBuffer = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

    const res = await request(app)
      .post(`/api/v1/quests/${testQuestId}/steps/3/evidence`)
      .set('Authorization', `Bearer ${travelerToken}`)
      .field('idempotency_key', 'idemp-step3-photo')
      .field('gallery_opt_in', 'false')
      .attach('photo', pngBuffer, 'clean_coast.png');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.step.status).toBe('pending_review');
    expect(res.body.data.step.evidence_payload.sha256).toBeDefined();
    expect(res.body.data.step.evidence_payload.gallery_opt_in).toBe(false);

    // Private evidence access check: traveler can access, stranger cannot
    const evidenceId = res.body.data.step.id;
    const travelerFileRes = await request(app)
      .get(`/api/v1/quests/evidence/${evidenceId}/file`)
      .set('Authorization', `Bearer ${travelerToken}`);
    expect(travelerFileRes.status).toBe(200);

    const strangerToken = jwt.sign({ id: 'stranger-999', seed_id: 'stranger', role: 'user' }, env.JWT_SECRET);
    const strangerFileRes = await request(app)
      .get(`/api/v1/quests/evidence/${evidenceId}/file`)
      .set('Authorization', `Bearer ${strangerToken}`);
    expect(strangerFileRes.status).toBe(403);
  });

  it('submits quest attempt for independent review', async () => {
    const res = await request(app)
      .post(`/api/v1/quests/${testQuestId}/submit-for-review`)
      .set('Authorization', `Bearer ${travelerToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.status).toBe('submitted');
  });

  it('rejects author self-approval of their own quest attempt', async () => {
    const res = await request(app)
      .patch(`/api/v1/admin/quest-attempts/${attemptId}`)
      .set('Authorization', `Bearer ${authorToken}`)
      .send({ action: 'approve' });

    // authorToken has role 'user', so 403 by admin middleware
    expect(res.status).toBe(403);
  });

  it('rejects traveler self-approval even if granted admin role', async () => {
    const traveler = db.users.find((u) => u.id === travelerUserId);
    if (traveler) traveler.role = 'admin';

    const travelerAdminToken = jwt.sign(
      { id: travelerUserId, seed_id: 'traveler-01', role: 'admin' },
      env.JWT_SECRET
    );

    const res = await request(app)
      .patch(`/api/v1/admin/quest-attempts/${attemptId}`)
      .set('Authorization', `Bearer ${travelerAdminToken}`)
      .send({ action: 'approve' });

    if (traveler) traveler.role = 'user';

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CANNOT_REVIEW_OWN_ATTEMPT');
  });

  it('allows independent administrator to approve attempt, awarding points and verifying all steps', async () => {
    const travelerBefore = db.users.find((u) => u.id === travelerUserId);
    expect(travelerBefore?.demo_points).toBe(0);

    const res = await request(app)
      .patch(`/api/v1/admin/quest-attempts/${attemptId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ action: 'approve' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.attempt.status).toBe('completed');
    expect(res.body.data.awarded_points).toBe(100);

    const travelerAfter = db.users.find((u) => u.id === travelerUserId);
    expect(travelerAfter?.demo_points).toBe(100);

    // Progress endpoint now shows completed
    const progressRes = await request(app)
      .get(`/api/v1/quests/${testQuestId}/progress`)
      .set('Authorization', `Bearer ${travelerToken}`);

    expect(progressRes.status).toBe(200);
    // After completion, all steps are verified
    const steps = db.getStepEvidence(attemptId);
    expect(steps.every((s) => s.status === 'verified')).toBe(true);
  });

  it('is idempotent on duplicate approval and does not award points twice', async () => {
    const res = await request(app)
      .patch(`/api/v1/admin/quest-attempts/${attemptId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ action: 'approve' });

    expect(res.status).toBe(200);
    expect(res.body.data.awarded_points).toBe(0);

    const traveler = db.users.find((u) => u.id === travelerUserId);
    expect(traveler?.demo_points).toBe(100);
  });

  it('blocks every repeat-completion path after an attempt approval', async () => {
    const start = await request(app)
      .post(`/api/v1/quests/${testQuestId}/attempts`)
      .set('Authorization', `Bearer ${travelerToken}`);
    expect(start.status).toBe(409);
    expect(start.body.error.code).toBe('ALREADY_COMPLETED');

    const challenge = await request(app)
      .post(`/api/v1/quests/${testQuestId}/challenge`)
      .set('Authorization', `Bearer ${travelerToken}`);
    expect(challenge.status).toBe(409);
    expect(challenge.body.error.code).toBe('ALREADY_COMPLETED');

    const progress = await request(app)
      .get(`/api/v1/quests/${testQuestId}/progress`)
      .set('Authorization', `Bearer ${travelerToken}`);
    expect(progress.status).toBe(200);
    expect(progress.body.data.has_completed).toBe(true);

    expect(db.hasCompletedQuest(travelerUserId, testQuestId)).toBe(true);
    expect(db.users.find((u) => u.id === travelerUserId)?.demo_points).toBe(100);
  });

  it('refuses a second attempt approval even if that attempt was created before the first payout', async () => {
    const secondAttempt = db.createAttempt({
      id: `attempt-repeat-${Date.now()}`,
      quest_id: testQuestId,
      user_id: travelerUserId,
      version: 1,
      current_step: 3,
      total_steps: 3,
      status: 'submitted',
      steps_snapshot: [],
    });

    const response = await request(app)
      .patch(`/api/v1/admin/quest-attempts/${secondAttempt.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ action: 'approve' });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('ALREADY_COMPLETED');
    expect(db.users.find((u) => u.id === travelerUserId)?.demo_points).toBe(100);
    expect(secondAttempt.status).toBe('submitted');
  });
});
