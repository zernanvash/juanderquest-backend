import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import app from '../src/app.js';
import { db } from '../src/db/index.js';
import { setPool } from '../src/db/pool.js';
import { createTestDb, TestDbFixture } from '../src/db/testHarness.js';
import { env } from '../src/config/env.js';
import { spotStore } from '../src/spots/store.js';

describe('AR + Multi-Task Quest Creation, Reverse Host-Scan QR, and Instant Completion Flow', () => {
  let fixture: TestDbFixture;
  const authorId = `user_ar_author_${randomUUID().slice(0, 8)}`;
  const travelerId = `user_ar_traveler_${randomUUID().slice(0, 8)}`;
  const spotId = `spot-ar-test-${randomUUID().slice(0, 8)}`;
  let authorToken: string;
  let travelerToken: string;
  let createdQuestId: string;
  let qrMarkerStep2: string;

  beforeAll(async () => {
    fixture = await createTestDb();
    setPool(fixture.pool);
    db.usersRepo.setPool(fixture.pool);

    const now = new Date().toISOString();
    for (const u of [
      { id: authorId, seed_id: authorId, display_name: 'Quest Host Maria', email: `${authorId}@example.com`, role: 'user' as const },
      { id: travelerId, seed_id: travelerId, display_name: 'Traveler Juan', email: `${travelerId}@example.com`, role: 'user' as const },
    ]) {
      await fixture.pool.query(
        `INSERT INTO users (id, seed_id, display_name, email, role, demo_points, is_test, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, 0, true, $6, $6)
         ON CONFLICT (id) DO NOTHING`,
        [u.id, u.seed_id, u.display_name, u.email, u.role, now]
      );
      if (!db.users.find((x) => x.id === u.id)) {
        db.users.push({ ...u, demo_points: 0, is_test: true, created_at: now, updated_at: now } as any);
      }
    }

    authorToken = jwt.sign({ id: authorId, seed_id: authorId, role: 'user', typ: 'session' }, env.JWT_SECRET);
    travelerToken = jwt.sign({ id: travelerId, seed_id: travelerId, role: 'user', typ: 'session' }, env.JWT_SECRET);

    spotStore.spots.push({
      id: spotId,
      slug: spotId,
      name: 'Bolinao Enchanted Cave & Lighthouse',
      municipality: 'Bolinao',
      summary: 'Iconic coastal heritage and cave spring destination.',
      description: 'Explore the coral rock formations and historic lighthouse of Bolinao.',
      category: 'nature',
      gps_lat: 16.3068,
      gps_lng: 119.7824,
      image_url: 'https://images.unsplash.com/photo-1518509562904-e7ef99cdcc86?w=800',
      crowd_level: 'low',
      quest_id: null,
      created_by: authorId,
      is_test: true,
      created_at: now,
      updated_at: now,
    } as any);
  });

  afterAll(async () => {
    setPool(null);
    db.usersRepo.setPool(null);
    if (fixture) await fixture.close();
  });

  it('creates a multi-task quest with AR, traveler-scan QR, reverse host-scan QR, and in-app action tasks', async () => {
    const res = await request(app)
      .post(`/api/v1/spots/${spotId}/quests`)
      .set('Authorization', `Bearer ${authorToken}`)
      .send({
        title: 'Bolinao Coastal AR & Heritage Trail',
        description: 'Collect the 3D lighthouse gem in AR, scan the trailhead placard, show your QR pass to the lighthouse host, and bookmark the spot.',
        category: 'cultural',
        radius_meters: 120,
        reward_points: 75,
        step_order_mode: 'sequential',
        status: 'published',
        tasks: [
          {
            title: 'Collect the 3D Lighthouse Gem in AR',
            description: 'Open the AR viewfinder within 80m of the lighthouse and collect the emerald gem.',
            required: true,
            checkpoint_type: 'ar',
            verification: {
              type: 'ar',
              fence: { lat: 16.3068, lng: 119.7824, radius_meters: 80 },
              object: 'gem',
              color: '#2D6A4F',
            },
          },
          {
            title: 'Scan Trailhead QR Placard',
            description: 'Scan the printed QR placard at the entrance gate.',
            required: true,
            checkpoint_type: 'qr',
            verification: {
              type: 'qr',
              fence: { lat: 16.3068, lng: 119.7824, radius_meters: 100 },
              scan_mode: 'traveler_scans',
            },
          },
          {
            title: 'Host Check-in: Show Your QR Pass',
            description: 'Present your personal quest QR pass to the lighthouse host for on-site verification.',
            required: true,
            checkpoint_type: 'qr',
            verification: {
              type: 'qr',
              fence: { lat: 16.3068, lng: 119.7824, radius_meters: 100 },
              scan_mode: 'host_scans_traveler',
            },
          },
          {
            title: 'Save Bolinao Lighthouse to Bookmarks',
            description: 'Save this destination so you can revisit it on your map.',
            required: true,
            checkpoint_type: 'action',
            verification: {
              type: 'action',
              task: { kind: 'save_spot', spot_id: spotId },
            },
          },
        ],
      });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    createdQuestId = res.body.data.id;

    // Persist in PostgreSQL quests table as well for real-PG queries
    const q = db.findQuestById(createdQuestId, true)!;
    await fixture.pool.query(
      `INSERT INTO quests (id, title, description, category, location_name, gps_lat, gps_lng, radius_meters,
         base_reward_php, difficulty_factor, geo_multiplier, reward_points, marker_code, marker_image_url,
         is_active, is_test, author_id, status, version, steps, step_order_mode)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
       ON CONFLICT (id) DO NOTHING`,
      [
        q.id, q.title, q.description, q.category, q.location_name, q.gps_lat, q.gps_lng, q.radius_meters,
        q.base_reward_php, q.difficulty_factor, q.geo_multiplier, q.reward_points, q.marker_code, q.marker_image_url,
        true, true, authorId, 'published', 1, JSON.stringify(q.steps), 'sequential',
      ]
    );

    // Public view keeps scan_mode but strips marker_code
    const publicRes = await request(app)
      .get(`/api/v1/quests/${createdQuestId}`)
      .set('Authorization', `Bearer ${travelerToken}`);
    expect(publicRes.status).toBe(200);
    const publicSteps = publicRes.body.data.steps;
    expect(publicSteps).toHaveLength(4);
    expect(publicSteps[0].verification.object).toBe('gem');
    expect(publicSteps[1].verification.scan_mode).toBe('traveler_scans');
    expect(publicSteps[1].verification.marker_code).toBeUndefined();
    expect(publicSteps[2].verification.scan_mode).toBe('host_scans_traveler');

    // Author QR sheet includes marker_code and scan_mode
    const sheetRes = await request(app)
      .get(`/api/v1/quests/${createdQuestId}/qr-sheet`)
      .set('Authorization', `Bearer ${authorToken}`);
    expect(sheetRes.status).toBe(200);
    expect(sheetRes.body.data.qr_tasks).toHaveLength(2);
    expect(sheetRes.body.data.qr_tasks[0].scan_mode).toBe('traveler_scans');
    expect(sheetRes.body.data.qr_tasks[1].scan_mode).toBe('host_scans_traveler');
    qrMarkerStep2 = sheetRes.body.data.qr_tasks[0].marker_code;
  });

  it('starts attempt, completes Step 1 (AR), Step 2 (Traveler Scans QR), Step 3 (Host Scans Traveler QR), Step 4 (In-App Action), and claims instant reward', async () => {
    // 1. Start attempt
    const startRes = await request(app)
      .post(`/api/v1/quests/${createdQuestId}/attempts`)
      .set('Authorization', `Bearer ${travelerToken}`);
    expect(startRes.status).toBe(201);

    // 2. Step 1: AR Challenge & Evidence
    const arChalRes = await request(app)
      .post(`/api/v1/quests/${createdQuestId}/steps/1/ar-challenge`)
      .set('Authorization', `Bearer ${travelerToken}`)
      .send({ captured_lat: 16.3068, captured_lng: 119.7824, captured_accuracy: 5 });
    expect(arChalRes.status).toBe(200);
    const arToken = arChalRes.body.data.challenge_token;

    const arVerifyRes = await request(app)
      .post(`/api/v1/quests/${createdQuestId}/steps/1/evidence`)
      .set('Authorization', `Bearer ${travelerToken}`)
      .send({
        challenge_token: arToken,
        captured_lat: 16.3068,
        captured_lng: 119.7824,
        captured_accuracy: 5,
      });
    expect(arVerifyRes.status).toBe(200);
    expect(arVerifyRes.body.data.step.status).toBe('verified');

    // 3. Step 2: Traveler scans destination QR placard
    const qrStep2Res = await request(app)
      .post(`/api/v1/quests/${createdQuestId}/steps/2/evidence`)
      .set('Authorization', `Bearer ${travelerToken}`)
      .send({
        qr_code: qrMarkerStep2,
        captured_lat: 16.3068,
        captured_lng: 119.7824,
        captured_accuracy: 5,
      });
    expect(qrStep2Res.status).toBe(200);
    expect(qrStep2Res.body.data.step.status).toBe('verified');

    // 4. Step 3: Reverse QR — Traveler generates QR pass, Host scans and verifies it
    const qrPassRes = await request(app)
      .post(`/api/v1/quests/${createdQuestId}/steps/3/qr-pass`)
      .set('Authorization', `Bearer ${travelerToken}`);
    expect(qrPassRes.status).toBe(200);
    expect(qrPassRes.body.data.qr_payload).toMatch(/^JDQPASS:/);

    // Stranger cannot verify traveler's QR pass
    const strangerToken = jwt.sign({ id: 'stranger-id', seed_id: 'stranger', role: 'user', typ: 'session' }, env.JWT_SECRET);
    const forbiddenHostRes = await request(app)
      .post(`/api/v1/quests/${createdQuestId}/steps/3/host-verify-qr`)
      .set('Authorization', `Bearer ${strangerToken}`)
      .send({ qr_pass_token: qrPassRes.body.data.qr_payload });
    expect(forbiddenHostRes.status).toBe(403);

    // Quest author/host scans and verifies traveler's QR pass
    const hostVerifyRes = await request(app)
      .post(`/api/v1/quests/${createdQuestId}/steps/3/host-verify-qr`)
      .set('Authorization', `Bearer ${authorToken}`)
      .send({
        qr_pass_token: qrPassRes.body.data.qr_payload,
        captured_lat: 16.3068,
        captured_lng: 119.7824,
        captured_accuracy: 5,
      });
    expect(hostVerifyRes.status).toBe(200);
    expect(hostVerifyRes.body.data.step.status).toBe('verified');
    expect(hostVerifyRes.body.data.traveler_id).toBe(travelerId);

    // 5. Step 4: In-app action (save_spot)
    await fixture.pool.query(
      `INSERT INTO spot_interactions (user_id, spot_id, interaction_type)
       VALUES ($1, $2, 'save')
       ON CONFLICT DO NOTHING`,
      [travelerId, spotId]
    );

    const actionVerifyRes = await request(app)
      .post(`/api/v1/quests/${createdQuestId}/steps/4/evidence`)
      .set('Authorization', `Bearer ${travelerToken}`)
      .send({ action_name: 'save_spot' });
    expect(actionVerifyRes.status).toBe(200);
    expect(actionVerifyRes.body.data.step.status).toBe('verified');

    // 6. Complete quest & settle rewards immediately (since all required steps are server-verified!)
    const completeRes = await request(app)
      .post(`/api/v1/quests/${createdQuestId}/complete`)
      .set('Authorization', `Bearer ${travelerToken}`);
    expect(completeRes.status).toBe(200);
    expect(completeRes.body.data.status).toBe('completed');
    expect(completeRes.body.data.reward_awarded).toBe(true);
    expect(completeRes.body.data.awarded_points).toBe(75);
    expect(completeRes.body.data.new_points).toBe(75);

    const balanceRes = await fixture.pool.query('SELECT demo_points FROM users WHERE id = $1', [travelerId]);
    expect(balanceRes.rows[0].demo_points).toBe(75);
  });
});
