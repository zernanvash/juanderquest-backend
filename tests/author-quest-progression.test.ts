import request from 'supertest';
import { app } from '../src/app.js';
import { db } from '../src/db/index.js';
import { spotStore } from '../src/spots/store.js';
import jwt from 'jsonwebtoken';
import { env } from '../src/config/env.js';

describe('Phase 2: Progressive Destination-Author Quest Slice', () => {
  const authorUserId = '33333333-3333-3333-3333-333333333333';
  const otherUserId = '44444444-4444-4444-4444-444444444444';
  const travelerUserId = '55555555-5555-5555-5555-555555555555';

  const authorToken = jwt.sign(
    { id: authorUserId, seed_id: 'scout-author-01', role: 'user' },
    env.JWT_SECRET
  );

  const otherUserToken = jwt.sign(
    { id: otherUserId, seed_id: 'random-scout-02', role: 'user' },
    env.JWT_SECRET
  );

  const travelerToken = jwt.sign(
    { id: travelerUserId, seed_id: 'traveler-scout-03', role: 'user' },
    env.JWT_SECRET
  );

  const testSpotId = `spot-progression-${Date.now()}`;
  let questId = '';

  beforeAll(() => {
    // Add author user
    db.users.push({
      id: authorUserId,
      seed_id: 'scout-author-01',
      display_name: 'Author Scout',
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

    // Add traveler user
    db.users.push({
      id: travelerUserId,
      seed_id: 'traveler-scout-03',
      display_name: 'Traveler Scout',
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

    // Register a destination authored by authorUserId
    spotStore.spots.push({
      id: testSpotId,
      slug: `spot-slug-${Date.now()}`,
      name: 'San Fabian Coastline Sanctuary',
      description: 'A serene coastline in San Fabian created for progressive quest verification.',
      category: 'nature_outdoors',
      subcategory: 'beach',
      tags: ['beach', 'coastal'],
      municipality: 'San Fabian',
      address: 'San Fabian Coastal Road',
      gps_lat: 16.1250,
      gps_lng: 120.4020,
      price_level: 1,
      hours: { daily: '06:00-18:00' },
      amenities: ['parking'],
      image_url: 'https://images.unsplash.com/photo-1507525428034-b723cf961d3e',
      source_type: 'community',
      source_name: 'Author Scout',
      trust_level: 'community',
      status: 'published',
      created_by: authorUserId,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
  });

  afterAll(() => {
    spotStore.spots = spotStore.spots.filter((s) => s.id !== testSpotId);
    db.users = db.users.filter((u) => u.id !== authorUserId && u.id !== travelerUserId);
    if (questId) {
      db.quests = db.quests.filter((q) => q.id !== questId);
      db.quest_attempts = db.quest_attempts.filter((a) => a.quest_id !== questId);
    }
  });

  describe('1. Author Creation with Ordered Steps and Draft State', () => {
    it('creates a progressive quest in draft state with ordered steps', async () => {
      const res = await request(app)
        .post(`/api/v1/spots/${testSpotId}/quests`)
        .set('Authorization', `Bearer ${authorToken}`)
        .send({
          title: 'Coastal Mangrove Discovery Trail',
          description: 'Follow the coastal checkpoints and discover local marine ecosystems.',
          category: 'eco',
          radius_meters: 150,
          reward_points: 75,
          status: 'draft',
          steps: [
            {
              step_order: 1,
              title: 'San Fabian Coastal Entry',
              description: 'Check in at the community entrance gate.',
              checkpoint_type: 'location',
              required: true,
            },
            {
              step_order: 2,
              title: 'Mangrove Boardwalk Checkpoint',
              description: 'Inspect the conservation signage and verify checkpoint.',
              checkpoint_type: 'action',
              required: true,
              hint: 'Look for the green wooden shelter',
            },
          ],
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.status).toBe('draft');
      expect(res.body.data.steps).toHaveLength(2);
      expect(res.body.data.author_id).toBe(authorUserId);

      questId = res.body.data.id;
    });

    it('hides draft quest from public unauthenticated callers', async () => {
      const res = await request(app).get(`/api/v1/quests/${questId}`);
      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });

    it('allows destination author to view draft quest', async () => {
      const res = await request(app)
        .get(`/api/v1/quests/${questId}`)
        .set('Authorization', `Bearer ${authorToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.id).toBe(questId);
      expect(res.body.data.status).toBe('draft');
    });
  });

  describe('2. Quest Lifecycle Management (PATCH /quests/:id/status)', () => {
    it('rejects status update from unauthorized non-author user with 403', async () => {
      const res = await request(app)
        .patch(`/api/v1/quests/${questId}/status`)
        .set('Authorization', `Bearer ${otherUserToken}`)
        .send({ status: 'published' });

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('FORBIDDEN_NOT_DESTINATION_AUTHOR');
    });

    it('allows author to publish draft quest', async () => {
      const res = await request(app)
        .patch(`/api/v1/quests/${questId}/status`)
        .set('Authorization', `Bearer ${authorToken}`)
        .send({ status: 'published' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.status).toBe('published');
      expect(res.body.data.is_active).toBe(true);
    });

    it('allows public traveler to view published quest without marker_code leak', async () => {
      const res = await request(app)
        .get(`/api/v1/quests/${questId}`)
        .set('Authorization', `Bearer ${travelerToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.status).toBe('published');
      expect(res.body.data.marker_code).toBeUndefined();
    });

    it('allows author to pause quest', async () => {
      const res = await request(app)
        .patch(`/api/v1/quests/${questId}/status`)
        .set('Authorization', `Bearer ${authorToken}`)
        .send({ status: 'paused' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.status).toBe('paused');
      expect(res.body.data.is_active).toBe(false);
    });

    it('rejects attempt start on paused quest with 409 QUEST_PAUSED', async () => {
      const res = await request(app)
        .post(`/api/v1/quests/${questId}/attempts`)
        .set('Authorization', `Bearer ${travelerToken}`);

      expect(res.status).toBe(409);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('QUEST_PAUSED');
    });

    it('rejects challenge request on paused quest with 409 QUEST_PAUSED', async () => {
      const res = await request(app)
        .post(`/api/v1/quests/${questId}/challenge`)
        .set('Authorization', `Bearer ${travelerToken}`);

      expect(res.status).toBe(409);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('QUEST_PAUSED');
    });

    it('allows author to resume paused quest back to published', async () => {
      const res = await request(app)
        .patch(`/api/v1/quests/${questId}/status`)
        .set('Authorization', `Bearer ${authorToken}`)
        .send({ status: 'published' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.status).toBe('published');
    });
  });

  describe('3. Progressive Attempt Tracking & Idempotency', () => {
    it('rejects a quest author attempting their own published quest', async () => {
      const res = await request(app)
        .post(`/api/v1/quests/${questId}/attempts`)
        .set('Authorization', `Bearer ${authorToken}`);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('CREATOR_SELF_ATTEMPT');
    });

    it('starts a new attempt for traveler on published quest (201 Created)', async () => {
      const res = await request(app)
        .post(`/api/v1/quests/${questId}/attempts`)
        .set('Authorization', `Bearer ${travelerToken}`);

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.quest_id).toBe(questId);
      expect(res.body.data.user_id).toBe(travelerUserId);
      expect(res.body.data.status).toBe('in_progress');
      expect(res.body.data.total_steps).toBe(2);
    });

    it('resumes existing attempt idempotently on repeated start (200 OK)', async () => {
      const res = await request(app)
        .post(`/api/v1/quests/${questId}/attempts`)
        .set('Authorization', `Bearer ${travelerToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.status).toBe('in_progress');
      expect(res.body.message).toContain('Resumed existing');
    });

    it('reports progress state via GET /quests/:id/progress', async () => {
      const res = await request(app)
        .get(`/api/v1/quests/${questId}/progress`)
        .set('Authorization', `Bearer ${travelerToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.has_completed).toBe(false);
      expect(res.body.data.active_attempt).not.toBeNull();
      expect(res.body.data.active_attempt.status).toBe('in_progress');
    });

    it('provides aggregated stats to author without private user info', async () => {
      const res = await request(app)
        .get(`/api/v1/quests/${questId}`)
        .set('Authorization', `Bearer ${authorToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data.stats).toBeDefined();
      expect(res.body.data.stats.total_attempts).toBe(1);
      expect(res.body.data.stats.active_attempts).toBe(1);
      expect(res.body.data.stats.completed_attempts).toBe(0);
      // Ensure no raw private traveler records are exposed
      expect(res.body.data.stats.traveler_ids).toBeUndefined();
      expect(res.body.data.stats.gps_traces).toBeUndefined();
    });
  });

  describe('4. Archival and Permanent Deactivation', () => {
    it('allows author to archive quest', async () => {
      const res = await request(app)
        .patch(`/api/v1/quests/${questId}/status`)
        .set('Authorization', `Bearer ${authorToken}`)
        .send({ status: 'archived' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.status).toBe('archived');
    });

    it('rejects unarchiving with 400 CANNOT_UNARCHIVE', async () => {
      const res = await request(app)
        .patch(`/api/v1/quests/${questId}/status`)
        .set('Authorization', `Bearer ${authorToken}`)
        .send({ status: 'published' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('CANNOT_UNARCHIVE');
    });

    it('rejects start on archived quest with 410 QUEST_ARCHIVED', async () => {
      const res = await request(app)
        .post(`/api/v1/quests/${questId}/attempts`)
        .set('Authorization', `Bearer ${travelerToken}`);

      expect(res.status).toBe(410);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('QUEST_ARCHIVED');
    });

    it('rejects challenge token request on archived quest with 410 QUEST_ARCHIVED', async () => {
      const res = await request(app)
        .post(`/api/v1/quests/${questId}/challenge`)
        .set('Authorization', `Bearer ${travelerToken}`);

      expect(res.status).toBe(410);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('QUEST_ARCHIVED');
    });
  });
});
