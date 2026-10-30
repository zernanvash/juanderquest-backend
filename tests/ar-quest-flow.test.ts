import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import { app } from '../src/app.js';
import { db } from '../src/db/index.js';
import { setPool } from '../src/db/pool.js';
import { createTestDb, type TestDbInstance } from '../src/db/testHarness.js';
import { env } from '../src/config/env.js';
import { spotStore } from '../src/spots/store.js';

// AR + multi-task quests: AR, traveler-scanned QR, host-scanned traveler pass and an in-app action.
// Owner 2026-10-30: instant rewards only for official quests (admin author, no author, or sponsor funding)
// when every step was verified by the server and the traveler is not the author; everything else is reviewed.
const realPgDescribe = process.env.JDQ_REAL_PG_URL ? describe : describe.skip;

realPgDescribe('AR quest flow: multi-task creation, host-scan QR pass, completion and rewards (real PostgreSQL)', () => {
  let fixture: TestDbInstance;
  const suffix = randomUUID().slice(0, 8);
  const authorId = `ar-author-${suffix}`;
  const adminId = `ar-admin-${suffix}`;
  const travelerId = `ar-traveler-${suffix}`;
  const spotAdderId = `ar-spot-adder-${suffix}`;
  // Only a destination's creator may attach quests to it, so each author gets their own destination.
  const spotIds: Record<string, string> = { [authorId]: `spot-ar-author-${suffix}`, [adminId]: `spot-ar-admin-${suffix}` };
  const LAT = 16.3068;
  const LNG = 119.7824;
  const here = { captured_lat: LAT, captured_lng: LNG, captured_accuracy: 5 };
  const token = (id: string, role: 'user' | 'admin') => jwt.sign({ id, seed_id: id, role, typ: 'session' }, env.JWT_SECRET);
  const authorToken = token(authorId, 'user');
  const adminToken = token(adminId, 'admin');
  const travelerToken = token(travelerId, 'user');

  const questBody = (title: string, spotId: string) => ({
    title,
    description: 'Collect the gem in AR, scan the placard, show your pass to the host, and bookmark the spot.',
    category: 'cultural',
    radius_meters: 120,
    reward_points: 75,
    step_order_mode: 'sequential',
    status: 'published',
    tasks: [
      { title: 'Collect the gem in AR', description: 'Within 80 m of the lighthouse.', required: true, checkpoint_type: 'ar',
        verification: { type: 'ar', fence: { lat: LAT, lng: LNG, radius_meters: 80 }, object: 'gem', color: '#2D6A4F' } },
      { title: 'Scan the trailhead placard', description: 'Printed QR at the gate.', required: true, checkpoint_type: 'qr',
        verification: { type: 'qr', fence: { lat: LAT, lng: LNG, radius_meters: 100 }, scan_mode: 'traveler_scans' } },
      { title: 'Show your pass to the host', description: 'The host scans your quest pass.', required: true, checkpoint_type: 'qr',
        verification: { type: 'qr', fence: { lat: LAT, lng: LNG, radius_meters: 100 }, scan_mode: 'host_scans_traveler' } },
      { title: 'Save the lighthouse', description: 'Bookmark this destination.', required: true, checkpoint_type: 'action',
        verification: { type: 'action', task: { kind: 'save_spot', spot_id: spotId } } },
    ],
  });

  /** Creates the quest through the API as `asToken` and returns its id and QR marker codes. */
  async function createQuest(asToken: string, ownerId: string, title: string) {
    const spotId = spotIds[ownerId];
    const res = await request(app).post(`/api/v1/spots/${spotId}/quests`).set('Authorization', `Bearer ${asToken}`).send(questBody(title, spotId));
    expect(res.status).toBe(201);
    // The route persists the quest (and its destination binding) in PostgreSQL itself.
    const q = { id: res.body.data.id as string };
    const sheet = await request(app).get(`/api/v1/quests/${q.id}/qr-sheet`).set('Authorization', `Bearer ${asToken}`);
    expect(sheet.status).toBe(200);
    expect(sheet.body.data.qr_tasks.map((t: { scan_mode: string }) => t.scan_mode)).toEqual(['traveler_scans', 'host_scans_traveler']);
    return { spotId, id: q.id as string, placardMarker: sheet.body.data.qr_tasks[0].marker_code as string, hostMarker: sheet.body.data.qr_tasks[1].marker_code as string };
  }

  /** Plays steps 1–4 as the traveler; the host (`hostToken`) scans the pass for step 3. */
  async function playAllSteps(quest: { spotId: string; id: string; placardMarker: string; hostMarker: string }, hostToken: string) {
    const as = (path: string, t = travelerToken) => request(app).post(`/api/v1/quests/${quest.id}${path}`).set('Authorization', `Bearer ${t}`);
    expect((await as('/attempts')).status).toBe(201);

    const challenge = await as('/steps/1/ar-challenge').send(here);
    expect(challenge.status).toBe(200);
    const ar = await as('/steps/1/evidence').send({ challenge_token: challenge.body.data.challenge_token, ...here });
    expect(ar.status).toBe(200);
    expect(ar.body.data.step.status).toBe('verified');

    // A pass is only for host-scan tasks.
    expect((await as('/steps/2/qr-pass')).body.error?.code).toBe('NOT_HOST_SCAN_TASK');
    const placard = await as('/steps/2/evidence').send({ qr_code: quest.placardMarker, ...here });
    expect(placard.status).toBe(200);
    expect(placard.body.data.step.status).toBe('verified');

    // Holding the host task's marker code does not let the traveler skip the host.
    const bypass = await as('/steps/3/evidence').send({ qr_code: quest.hostMarker, ...here });
    expect(bypass.status).toBe(400);
    expect(bypass.body.error.code).toBe('HOST_SCAN_REQUIRED');

    const pass = await as('/steps/3/qr-pass');
    expect(pass.status).toBe(200);
    expect(pass.body.data.qr_payload).toMatch(/^JDQPASS:/);
    const passToken = pass.body.data.qr_payload;
    // A stranger cannot host-verify; the host must be on site.
    expect((await as('/steps/3/host-verify-qr', token(spotAdderId, 'user')).send({ qr_pass_token: passToken, ...here })).status).toBe(403);
    expect((await as('/steps/3/host-verify-qr', hostToken).send({ qr_pass_token: passToken })).body.error?.code).toBe('MISSING_GPS_COORDINATES');
    const hostScan = await as('/steps/3/host-verify-qr', hostToken).send({ qr_pass_token: passToken, ...here });
    expect(hostScan.status).toBe(200);
    expect(hostScan.body.data.step.status).toBe('verified');
    expect(hostScan.body.data.traveler_id).toBe(travelerId);

    await fixture.pool.query(`INSERT INTO spot_interactions (user_id, spot_id, interaction_type) VALUES ($1, $2, 'save') ON CONFLICT DO NOTHING`, [travelerId, quest.spotId]);
    const action = await as('/steps/4/evidence').send({ action_name: 'save_spot' });
    expect(action.status).toBe(200);
    expect(action.body.data.step.status).toBe('verified');
    return as;
  }

  const balance = async () => Number((await fixture.pool.query('SELECT demo_points FROM users WHERE id = $1', [travelerId])).rows[0].demo_points);

  beforeAll(async () => {
    fixture = await createTestDb();
    setPool(fixture.pool);
    db.usersRepo.setPool(fixture.pool);
    const now = new Date().toISOString();
    for (const [id, role] of [[authorId, 'user'], [adminId, 'admin'], [travelerId, 'user'], [spotAdderId, 'user']] as const) {
      await fixture.pool.query(
        `INSERT INTO users (id, seed_id, display_name, email, role, demo_points, is_test, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, 0, true, $6, $7) ON CONFLICT (id) DO NOTHING`, [id, id, id, `${id}@example.com`, role, now, now]);
      if (!db.users.find((x) => x.id === id)) db.users.push({ id, seed_id: id, display_name: id, email: `${id}@example.com`, role, demo_points: 0, is_test: true, created_at: now, updated_at: now } as any);
    }
    for (const [owner, spotId] of Object.entries(spotIds)) {
      await fixture.pool.query(
        `INSERT INTO spots(id,slug,name,description,category,subcategory,municipality,address,gps_lat,gps_lng,price_level,source_type,source_name,trust_level,status,created_by,is_test)
         VALUES ($1,$2,'Bolinao Lighthouse','Test destination.','nature_outdoors','beach','Bolinao','',$3,$4,1,'community','test','community','published',$5,FALSE)`,
        [spotId, spotId, LAT, LNG, owner]);
      spotStore.spots.push({
        id: spotId, slug: spotId, name: 'Bolinao Lighthouse', municipality: 'Bolinao', description: 'Test destination.', category: 'nature',
        gps_lat: LAT, gps_lng: LNG, image_url: '', quest_id: null, created_by: owner, is_test: false, created_at: now, updated_at: now,
      } as any);
    }
  });

  afterAll(async () => {
    spotStore.spots = spotStore.spots.filter((spot) => !Object.values(spotIds).includes(spot.id));
    setPool(null);
    db.usersRepo.setPool(null);
    if (fixture) await fixture.close();
  });

  it('keeps the scan mode public but the marker codes private', async () => {
    const quest = await createQuest(authorToken, authorId, 'Public view check');
    const res = await request(app).get(`/api/v1/quests/${quest.id}`).set('Authorization', `Bearer ${travelerToken}`);
    expect(res.status).toBe(200);
    const steps = res.body.data.steps;
    expect(steps).toHaveLength(4);
    expect(steps[0].verification.object).toBe('gem');
    expect(steps[1].verification.scan_mode).toBe('traveler_scans');
    expect(steps[1].verification.marker_code).toBeUndefined();
    expect(steps[2].verification.scan_mode).toBe('host_scans_traveler');
    expect(steps[2].verification.marker_code).toBeUndefined();
  });

  it('sends a community quest to review even when every step was server-verified', async () => {
    const quest = await createQuest(authorToken, authorId, 'Community AR trail');
    const as = await playAllSteps(quest, authorToken);
    const done = await as('/complete');
    expect(done.status).toBe(200);
    expect(done.body.data.reward_awarded).toBe(false);
    expect(done.body.data.status).toBe('submitted');
    expect(await balance()).toBe(0);
  });

  it('pays an official (admin-authored) quest at once when every step was server-verified', async () => {
    const quest = await createQuest(adminToken, adminId, 'Official AR trail');
    const as = await playAllSteps(quest, adminToken);
    // Older clients that submit for review are never paid instantly, even with the old claim flag.
    const done = await as('/complete');
    expect(done.status).toBe(200);
    expect(done.body.data.status).toBe('completed');
    expect(done.body.data.reward_awarded).toBe(true);
    expect(done.body.data.awarded_points).toBe(75);
    expect(await balance()).toBe(75);
    expect((await as('/complete')).status).not.toBe(200);
  });
});
