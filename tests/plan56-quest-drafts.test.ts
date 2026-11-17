import request from 'supertest';
import jwt from 'jsonwebtoken';
import { app } from '../src/app.js';
import { spotStore } from '../src/spots/store.js';
import { env } from '../src/config/env.js';
import { publishChecklist } from '../src/quests/publishChecklist.js';

describe('Plan 56 phase 1: drafts save anything, publish needs the checklist', () => {
  const authorId = '11111111-1111-1111-1111-111111111111';
  const otherId = '22222222-2222-2222-2222-222222222222';
  // Same demo accounts and claims as tests/author-quests.test.ts.
  const seeds: Record<string, string> = { [authorId]: 'demo-user-1', [otherId]: 'demo-admin-1' };
  const token = (id: string) => jwt.sign({ id, seed_id: seeds[id], role: 'user', typ: 'session' }, env.JWT_SECRET);
  const spotId = `spot-plan56-${Date.now()}`;
  let fundingWas: boolean;

  beforeAll(() => {
    fundingWas = env.QUEST_FUNDING_ENABLED;
    env.QUEST_FUNDING_ENABLED = false;
    spotStore.spots.push({
      id: spotId,
      slug: `${spotId}-slug`,
      name: 'Plan 56 Test Spot',
      description: 'A destination for draft tests.',
      category: 'nature_outdoors',
      subcategory: 'beach',
      tags: [],
      municipality: 'Bolinao',
      address: 'Bolinao',
      gps_lat: 16.3204,
      gps_lng: 119.7847,
      price_level: 1,
      hours: {},
      amenities: [],
      image_url: null,
      source_type: 'community',
      source_name: 'Test',
      trust_level: 'community',
      status: 'published',
      created_by: authorId,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    } as any);
  });

  afterAll(() => {
    env.QUEST_FUNDING_ENABLED = fundingWas;
    spotStore.spots = spotStore.spots.filter((s) => s.id !== spotId);
  });

  it('publishChecklist lists what is missing', () => {
    expect(publishChecklist({ title: 'Hi', description: '' })).toEqual(['title', 'description']);
    expect(publishChecklist({ title: 'Bolinao walk', description: 'Walk the cliffs at sunset.' })).toEqual([]);
  });

  let draftId = '';

  it('saves a draft with a one-letter title and no description', async () => {
    const res = await request(app)
      .post(`/api/v1/spots/${spotId}/quests`)
      .set('Authorization', `Bearer ${token(authorId)}`)
      .send({ title: 'B', category: 'eco', status: 'draft' });
    expect(res.status).toBe(201);
    draftId = res.body.data.id ?? res.body.data.quest?.id;
    expect(draftId).toBeTruthy();
  });

  it('refuses to publish an unfinished quest with PUBLISH_CHECKLIST', async () => {
    const create = await request(app)
      .post(`/api/v1/spots/${spotId}/quests`)
      .set('Authorization', `Bearer ${token(authorId)}`)
      .send({ title: 'B', category: 'eco', status: 'published' });
    expect(create.status).toBe(400);
    expect(create.body.error.code).toBe('PUBLISH_CHECKLIST');
    expect(create.body.error.missing).toEqual(['title', 'description']);

    const patch = await request(app)
      .patch(`/api/v1/quests/${draftId}`)
      .set('Authorization', `Bearer ${token(authorId)}`)
      .send({ status: 'published' });
    expect(patch.status).toBe(400);
    expect(patch.body.error.code).toBe('PUBLISH_CHECKLIST');

    const status = await request(app)
      .patch(`/api/v1/quests/${draftId}/status`)
      .set('Authorization', `Bearer ${token(authorId)}`)
      .send({ status: 'published' });
    expect(status.status).toBe(400);
    expect(status.body.error.code).toBe('PUBLISH_CHECKLIST');
  });

  it('publishes once the checklist is complete', async () => {
    const res = await request(app)
      .patch(`/api/v1/quests/${draftId}`)
      .set('Authorization', `Bearer ${token(authorId)}`)
      .send({ title: 'Bolinao cliff walk', description: 'Walk the Bolinao cliffs at sunset.', status: 'published' });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('published');
  });

  it('GET /me/quests lists only my quests and filters by status', async () => {
    const draft = await request(app)
      .post(`/api/v1/spots/${spotId}/quests`)
      .set('Authorization', `Bearer ${token(authorId)}`)
      .send({ title: 'Idea', category: 'cultural', status: 'draft' });
    expect(draft.status).toBe(201);

    const all = await request(app)
      .get('/api/v1/me/quests')
      .set('Authorization', `Bearer ${token(authorId)}`);
    expect(all.status).toBe(200);
    expect(all.headers['cache-control']).toContain('no-store');
    const ids = all.body.data.quests.map((q: any) => q.id);
    expect(ids).toContain(draftId);

    const drafts = await request(app)
      .get('/api/v1/me/quests?status=draft')
      .set('Authorization', `Bearer ${token(authorId)}`);
    expect(drafts.body.data.quests.every((q: any) => q.status === 'draft')).toBe(true);
    expect(drafts.body.data.quests.map((q: any) => q.title)).toContain('Idea');
    // A spot stores one quest_id, so only the linked quest knows its spot
    // until phase 2 adds quest_destinations; the others return spot: null.
    const linked = all.body.data.quests.find((q: any) => q.spot);
    if (linked) expect(linked.spot.id).toBe(spotId);

    const other = await request(app)
      .get('/api/v1/me/quests')
      .set('Authorization', `Bearer ${token(otherId)}`);
    expect(other.body.data.quests.map((q: any) => q.id)).not.toContain(draftId);

    const bad = await request(app)
      .get('/api/v1/me/quests?status=nope')
      .set('Authorization', `Bearer ${token(authorId)}`);
    expect(bad.status).toBe(400);
    expect((await request(app).get('/api/v1/me/quests')).status).toBe(401);
  });
});
