import request from 'supertest';
import { randomUUID } from 'crypto';
import { app } from '../src/app.js';
import { env } from '../src/config/env.js';
import { db } from '../src/db/index.js';
import { setPool } from '../src/db/pool.js';
import { createTestDb, TestDbInstance } from '../src/db/testHarness.js';
import { submissionsService } from '../src/services/submissions.js';
import { resetRateLimits } from '../src/middleware/rateLimit.js';

describe('guest user sessions', () => {
  let database: TestDbInstance;
  const oldFlag = env.GUEST_LOGIN_ENABLED;
  beforeEach(() => resetRateLimits());
  beforeAll(async () => {
    database = await createTestDb();
    setPool(database.pool);
    await database.pool.query(`INSERT INTO users(id,seed_id,display_name,email,role) VALUES('guest-reviewer','guest-reviewer','Reviewer','reviewer@guest.invalid','admin')`);
    await database.pool.query(`INSERT INTO quests(id,title,description,category,location_name,gps_lat,gps_lng,radius_meters,reward_points,marker_code,marker_image_url,is_active)
      VALUES('guest-quest','Guest test quest','Test proof','cultural','Dagupan',16,120,100,50,'GUEST-TEST','',true)`);
    await db.hydrateFromPg(database.pool);
    Reflect.set(env, 'GUEST_LOGIN_ENABLED', true);
  }, 30000);
  afterAll(async () => {
    Reflect.set(env, 'GUEST_LOGIN_ENABLED', oldFlag);
    setPool(null); db.usersRepo.setPool(null);
    await database.close();
  });

  it('creates distinct durable ordinary accounts, persists cookie sessions and permits user writes', async () => {
    const agent = request.agent(app);
    const first = await agent.post('/api/v1/auth/guest-login').send({ remember_me: true });
    expect(first.status).toBe(200);
    const user = first.body.data.user;
    expect(user.seed_id).toMatch(/^guest:/);
    expect(user.role).toBe('user');
    expect(user.demo_points).toBe(0);
    expect(user.jdq_governance_balance).toBe(0);
    expect(user.scout_reputation).toBe(0);
    expect(user.is_public).toBe(false);
    expect(first.body.data.token).toBeUndefined();
    expect(first.headers['set-cookie'][0]).toContain('HttpOnly');
    expect(first.headers['set-cookie'][0]).toContain('Max-Age=604800');
    expect((await agent.get('/api/v1/auth/me')).body.data.id).toBe(user.id);
    const again = await agent.post('/api/v1/auth/guest-login').set('Origin', 'http://localhost:3000').send({});
    expect(again.status).toBe(200);
    expect(again.body.data.user.id).toBe(user.id);
    const other = await request(app).post('/api/v1/auth/guest-login').send({});
    expect(other.status).toBe(200);
    expect(other.body.data.user.id).not.toBe(user.id);
    const profile = await agent.patch('/api/v1/users/me/profile').set('Origin', 'http://localhost:3000').send({ bio: 'Guest traveler testing the app' });
    expect(profile.status).toBe(200);
    expect((await db.usersRepo.findById(user.id))?.bio).toBe('Guest traveler testing the app');
    expect((await agent.get('/api/v1/qa/capabilities')).status).toBe(403);
    expect((await agent.get('/api/v1/admin/submissions')).status).toBe(403);
    const quest = db.quests.find(q => q.is_active && !q.is_test)!;
    expect(quest).toBeDefined();
    const submission = await agent.post('/api/v1/submissions').set('Origin', 'http://localhost:3000').send({
      idempotency_key: randomUUID(), quest_id: quest.id, scanned_marker_code: quest.marker_code,
      captured_lat: quest.gps_lat, captured_lng: quest.gps_lng, captured_accuracy: 5,
    });
    expect(submission.status).toBe(201);
    expect(submission.body.data.user_id).toBe(user.id);
    const admin = db.users.find(u => u.role === 'admin')!;
    const approved = await submissionsService.reviewSubmission(submission.body.data.id, 'approve', admin.id);
    expect(approved.success).toBe(true);
    expect((await db.usersRepo.findById(user.id))?.demo_points).toBe(quest.reward_points);
    await agent.post('/api/v1/auth/logout').set('Origin', 'http://localhost:3000');
    expect((await agent.get('/api/v1/auth/me')).status).toBe(401);
  });

  it('rejects client-selected identity or role', async () => {
    const response = await request(app).post('/api/v1/auth/guest-login').send({ seed_id: 'admin-1', role: 'admin' });
    expect(response.status).toBe(400);
  });

  it('fails closed when disabled and advertises availability', async () => {
    Reflect.set(env, 'GUEST_LOGIN_ENABLED', false);
    expect((await request(app).get('/api/v1/auth/wallet/config')).body.data.guest_login_enabled).toBe(false);
    expect((await request(app).post('/api/v1/auth/guest-login').send({})).status).toBe(403);
    Reflect.set(env, 'GUEST_LOGIN_ENABLED', true);
  });

  it('does not issue a session when durable storage fails', async () => {
    const fail = jest.spyOn(db, 'findOrCreateUserDurable').mockRejectedValueOnce(new Error('offline'));
    try {
      const response = await request(app).post('/api/v1/auth/guest-login').send({});
      expect(response.status).toBe(503);
      expect(response.headers['set-cookie']).toBeUndefined();
    } finally { fail.mockRestore(); }
  });

  it('rate limits account creation', async () => {
    for (let i = 0; i < 5; i++) expect((await request(app).post('/api/v1/auth/guest-login').send({})).status).toBe(200);
    const blocked = await request(app).post('/api/v1/auth/guest-login').send({});
    expect(blocked.status).toBe(429);
    expect(blocked.headers['retry-after']).toBeDefined();
  });

  it('allows eligible guest ballots and retains the new-account anti-farming rule', async () => {
    const oldChoice = env.JUANCHOICE_ENABLED, oldWrites = env.JUANCHOICE_WRITES_ENABLED;
    Reflect.set(env, 'JUANCHOICE_ENABLED', true); Reflect.set(env, 'JUANCHOICE_WRITES_ENABLED', true);
    try {
      const agent = request.agent(app);
      const signed = await agent.post('/api/v1/auth/guest-login').send({});
      expect(signed.status).toBe(200);
      const campaign = randomUUID(), candidate = randomUUID();
      await database.pool.query(`INSERT INTO spots(id,slug,name,description,category,subcategory,municipality,address,gps_lat,gps_lng,source_type,source_name)
        VALUES('guest-vote-spot','guest-vote-spot','Vote spot','Testing','nature','beach','Bolinao','Bolinao',16,120,'lgu','Test')`);
      await database.pool.query(`INSERT INTO juanchoice_campaigns(id,slug,region,theme,status,opens_at,closes_at)
        VALUES($1,'guest-vote','Pangasinan','Beaches','voting',NOW() - INTERVAL '1 day',NOW() + INTERVAL '1 day')`, [campaign]);
      await database.pool.query('INSERT INTO juanchoice_candidates(id,campaign_id,spot_id) VALUES($1,$2,$3)', [candidate,campaign,'guest-vote-spot']);
      const cast = () => agent.put(`/api/v1/juanchoice/campaigns/${campaign}/ballot`).set('Origin','http://localhost:3000')
        .set('Idempotency-Key',randomUUID()).send({candidate_id:candidate,expected_version:0});
      expect((await cast()).body.error.code).toBe('NOT_ELIGIBLE');
      await database.pool.query("UPDATE users SET created_at=NOW() - INTERVAL '4 days' WHERE id=$1", [signed.body.data.user.id]);
      expect((await cast()).status).toBe(200);
      const totals = (await database.pool.query('SELECT civic_xp,civic_stamps FROM progression_totals WHERE user_id=$1', [signed.body.data.user.id])).rows[0];
      expect(Number(totals.civic_xp)).toBe(25);
      expect(Number(totals.civic_stamps)).toBe(1);
    } finally {
      Reflect.set(env, 'JUANCHOICE_ENABLED', oldChoice); Reflect.set(env, 'JUANCHOICE_WRITES_ENABLED', oldWrites);
    }
  });
});
