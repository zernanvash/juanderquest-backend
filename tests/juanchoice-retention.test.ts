import { randomUUID } from 'crypto';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { app } from '../src/app.js';
import { env } from '../src/config/env.js';
import { createTestDb, TestDbInstance } from '../src/db/testHarness.js';
import { setPool } from '../src/db/pool.js';
import { db as domainDb } from '../src/db/index.js';
import {
  evaluateCommunityGoals,
  evaluateFinalizedCampaignRetention,
  getEngagementSummary,
} from '../src/progression/retention.js';
import { createMerchantOffer, listActiveMerchantOffers } from '../src/juanchoice/partnerships.js';

jest.setTimeout(60_000);

describe('Phase 5: JuanChoice retention and measured conversion', () => {
  let database: TestDbInstance;
  const userId = '51111111-1111-1111-1111-111111111111';
  const adminId = '52222222-2222-2222-2222-222222222222';
  const token = jwt.sign({ id: userId, role: 'user' }, env.JWT_SECRET, { expiresIn: '1h' });
  const campaigns = Array.from({ length: 6 }, () => randomUUID());

  beforeAll(async () => {
    (env as any).JUANCHOICE_ENABLED = true;
    (env as any).JUANCHOICE_WRITES_ENABLED = true;
    database = await createTestDb();
    setPool(database.pool);
    domainDb.usersRepo.setPool(database.pool);
    await database.pool.query(
      `INSERT INTO users(id,seed_id,display_name,email,role,is_public,is_test)
       VALUES($1,'ret-user','Retention Traveler','retention@jdq.ph','user',TRUE,FALSE),
             ($2,'ret-admin','Retention Admin','retention-admin@jdq.ph','admin',TRUE,FALSE)`,
      [userId, adminId],
    );
  });

  afterAll(async () => {
    setPool(null);
    domainDb.usersRepo.setPool(null);
    if (database) await database.close();
  });

  it('uses explicit official rounds, treats cancellation as neutral, and ignores side leagues', async () => {
    await database.pool.query(
      `INSERT INTO juanchoice_campaigns(
         id,slug,region,theme,status,opens_at,closes_at,series_key,round_number,counts_for_streak)
       VALUES
         ($1,'ret-round-1','Pangasinan','Round 1','finalized',NOW()-INTERVAL '30 days',NOW()-INTERVAL '29 days','pangasinan-primary',1,TRUE),
         ($2,'ret-round-2','Pangasinan','Round 2','cancelled',NOW()-INTERVAL '23 days',NOW()-INTERVAL '22 days','pangasinan-primary',2,TRUE),
         ($3,'ret-round-3','Pangasinan','Round 3','finalized',NOW()-INTERVAL '16 days',NOW()-INTERVAL '15 days','pangasinan-primary',3,TRUE),
         ($4,'ret-side-league','Pangasinan','Side League','finalized',NOW()-INTERVAL '16 days',NOW()-INTERVAL '15 days',NULL,NULL,FALSE)`,
      campaigns.slice(0, 4),
    );
    await database.pool.query(
      `INSERT INTO juanchoice_participations(campaign_id,user_id,rewarded_at)
       VALUES($1,$3,NOW()-INTERVAL '29 days'),($2,$3,NOW()-INTERVAL '15 days'),($4,$3,NOW()-INTERVAL '15 days')`,
      [campaigns[0], campaigns[2], userId, campaigns[3]],
    );
    const summary = await getEngagementSummary(userId);
    expect(summary?.streak).toMatchObject({ current: 2, longest: 2, rounds_observed: 2 });
    expect(summary?.impact.finalized_participations).toBe(3);
  });

  it('resets the current streak on a missed official round without changing the longest streak', async () => {
    await database.pool.query(
      `INSERT INTO juanchoice_campaigns(
         id,slug,region,theme,status,opens_at,closes_at,series_key,round_number,counts_for_streak)
       VALUES($1,'ret-round-4','Pangasinan','Round 4','finalized',NOW()-INTERVAL '9 days',NOW()-INTERVAL '8 days','pangasinan-primary',4,TRUE)`,
      [campaigns[4]],
    );
    const summary = await getEngagementSummary(userId);
    expect(summary?.streak.current).toBe(0);
    expect(summary?.streak.longest).toBe(2);
  });

  it('awards a streak milestone only from finalized official history and remains idempotent', async () => {
    await database.pool.query('INSERT INTO juanchoice_participations(campaign_id,user_id) VALUES($1,$2)', [campaigns[4], userId]);
    await database.pool.query(
      `INSERT INTO juanchoice_campaigns(
         id,slug,region,theme,status,opens_at,closes_at,series_key,round_number,counts_for_streak)
       VALUES($1,'ret-round-5','Pangasinan','Round 5','finalized',NOW()-INTERVAL '2 days',NOW()-INTERVAL '1 day','pangasinan-primary',5,TRUE)`,
      [campaigns[5]],
    );
    await database.pool.query('INSERT INTO juanchoice_participations(campaign_id,user_id) VALUES($1,$2)', [campaigns[5], userId]);
    // Round 1, 3, 4, 5 are the four eligible (non-cancelled) official rounds.
    const client = await database.pool.connect();
    try {
      await client.query('BEGIN');
      const first = await evaluateFinalizedCampaignRetention(campaigns[5], [], client);
      const replay = await evaluateFinalizedCampaignRetention(campaigns[5], [], client);
      await client.query('COMMIT');
      expect(first.streak_awards).toBe(1);
      expect(replay.streak_awards).toBe(0);
    } finally {
      client.release();
    }
    expect((await database.pool.query(
      "SELECT COUNT(*)::int AS count FROM achievement_awards WHERE user_id=$1 AND achievement_id='civic_regular_voter'",
      [userId],
    )).rows[0].count).toBe(1);
  });

  it('breaks a streak on an unknown round-number gap while preserving the known longest run', async () => {
    const gapCampaign = randomUUID();
    await database.pool.query(
      `INSERT INTO juanchoice_campaigns(id,slug,region,theme,status,opens_at,closes_at,series_key,round_number,counts_for_streak)
       VALUES($1,'ret-round-8','Pangasinan','Round 8','finalized',NOW()-INTERVAL '1 hour',NOW()-INTERVAL '30 minutes','pangasinan-primary',8,TRUE)`,
      [gapCampaign],
    );
    await database.pool.query('INSERT INTO juanchoice_participations(campaign_id,user_id) VALUES($1,$2)', [gapCampaign, userId]);
    const summary = await getEngagementSummary(userId);
    expect(summary?.streak.current).toBe(1);
    expect(summary?.streak.longest).toBe(4);
  });

  it('unlocks a community goal and emits its outbox notification exactly once', async () => {
    const goalId = randomUUID();
    await database.pool.query(
      `INSERT INTO community_goals(id,title,metric,target,starts_at,ends_at,status)
       VALUES($1,'One Pangasinan Voice','finalized_participants',1,NOW()-INTERVAL '60 days',NOW()+INTERVAL '1 day','active')`,
      [goalId],
    );
    expect((await evaluateCommunityGoals()).unlocked).toBe(1);
    expect((await evaluateCommunityGoals()).unlocked).toBe(0);
    expect((await database.pool.query('SELECT COUNT(*)::int AS count FROM community_goal_unlocks WHERE goal_id=$1', [goalId])).rows[0].count).toBe(1);
    expect((await database.pool.query('SELECT COUNT(*)::int AS count FROM outbox_events WHERE event_key=$1', [`community-goal:${goalId}`])).rows[0].count).toBe(1);
  });

  it('keeps public achievements private by default and exposes them only after owner opt-in', async () => {
    expect((await request(app).get(`/api/v1/users/${userId}/achievements`)).status).toBe(404);
    const preference = await request(app).put('/api/v1/me/engagement/preferences')
      .set('Authorization', `Bearer ${token}`).send({ share_achievements: true });
    expect(preference.status).toBe(200);
    expect((await request(app).get(`/api/v1/users/${userId}/achievements`)).status).toBe(200);
  });

  it('rejects unofficial campaigns that try to claim official series identity at the database boundary', async () => {
    await expect(database.pool.query(
      `INSERT INTO juanchoice_campaigns(
         id,slug,region,theme,status,opens_at,closes_at,series_key,round_number,counts_for_streak)
       VALUES($1,'invalid-official-round','Pangasinan','Invalid','draft',NOW(),NOW()+INTERVAL '1 day','pangasinan-primary',6,FALSE)`,
      [randomUUID()],
    )).rejects.toBeDefined();
  });

  it('keeps admin-created merchant offers in draft without verified partner consent', async () => {
    const draft = await createMerchantOffer({ campaignId: campaigns[0], merchantId: 'm1', voucherId: 'v1',
      termsSnapshot: { label: 'Pilot offer', redemption: 'merchant validates voucher' },
      startsAt: new Date(Date.now() - 60_000).toISOString(), endsAt: new Date(Date.now() + 86_400_000).toISOString(), isTest: false });
    expect(draft.status).toBe('draft');
    expect(draft.partner_consent_at).toBeNull();
    const offers = await listActiveMerchantOffers(campaigns[0]);
    expect(offers).toHaveLength(0);
    await expect(database.pool.query("UPDATE juanchoice_merchant_offers SET status='approved', partner_consent_at=NOW() WHERE id=$1",[draft.id]))
      .rejects.toBeDefined();
    const adminToken = jwt.sign({ id: adminId, role: 'admin' }, env.JWT_SECRET);
    const endpoint = `/api/v1/juanchoice/admin/campaigns/${campaigns[2]}/offers`;
    const body = { merchant_id:'m1', voucher_id:'v1', terms_snapshot:{label:'Pilot offer'},
      starts_at:new Date(Date.now()-60_000).toISOString(), ends_at:new Date(Date.now()+86_400_000).toISOString() };
    const forged = await request(app).post(endpoint).set('Authorization',`Bearer ${adminToken}`)
      .send({...body,partner_consent:true});
    expect(forged.status).toBe(400);
    const created = await request(app).post(endpoint).set('Authorization',`Bearer ${adminToken}`).send(body);
    expect(created.status).toBe(201);
    expect(created.body.data.status).toBe('draft');
    expect((await listActiveMerchantOffers(campaigns[2]))).toHaveLength(0);
    expect((await database.pool.query('SELECT COUNT(*)::int AS count FROM governance_ledger')).rows[0].count).toBe(0);
  });

  it('does not turn an admin reference into a funded promotional budget', async () => {
    const adminToken = jwt.sign({ id: adminId, role: 'admin' }, env.JWT_SECRET);
    const endpoint = `/api/v1/juanchoice/admin/campaigns/${campaigns[0]}/budget`;
    const requestBody = { budget_mjdq: 1_000, request_reference: 'Draft proposal only' };
    expect((await request(app).post(endpoint).set('Authorization',`Bearer ${adminToken}`).send(requestBody)).status).toBe(503);
    const previous = env.JUANCHOICE_ECONOMY_ENABLED;
    (env as any).JUANCHOICE_ECONOMY_ENABLED = true;
    try {
      const falseApproval = await request(app).post(endpoint).set('Authorization',`Bearer ${adminToken}`)
        .send({ budget_mjdq:1_000, approval_reference:'Unverified admin claim' });
      expect(falseApproval.status).toBe(400);
      const created = await request(app).post(endpoint).set('Authorization',`Bearer ${adminToken}`).send(requestBody);
      expect(created.status).toBe(201);
      expect(created.body.data).toMatchObject({status:'draft',request_reference:'Draft proposal only'});
      await expect(database.pool.query("UPDATE juanchoice_promotion_budgets SET status='approved' WHERE id=$1",[created.body.data.id]))
        .rejects.toBeDefined();
      await expect(database.pool.query('UPDATE juanchoice_promotion_budgets SET reserved_mjdq=1 WHERE id=$1',[created.body.data.id]))
        .rejects.toBeDefined();
      expect((await database.pool.query('SELECT COUNT(*)::int AS count FROM governance_ledger')).rows[0].count).toBe(0);
    } finally {
      (env as any).JUANCHOICE_ECONOMY_ENABLED = previous;
    }
  });

  it('falls back safely to default retention engagement and returns 200 without crashing when database pool is null', async () => {
    setPool(null);
    try {
      // In-memory fallback lookup: ensure mock user exists in in-memory db
      const mockUser = domainDb.findUserById(userId);
      if (!mockUser) {
        domainDb.users.push({
          id: userId,
          seed_id: 'ret-user',
          display_name: 'Retention Traveler',
          email: 'retention@jdq.ph',
          avatar_url: '',
          role: 'user',
          demo_points: 100,
          mjdq_balance: 100000,
          jdq_governance_balance: 15,
          scout_reputation: 0,
          is_public: true,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });
      }

      const summary = await getEngagementSummary(userId);
      expect(summary).toBeDefined();
      expect(summary?.streak.current).toBe(0);
      expect(summary?.impact.verified_visits).toBe(0);

      const res = await request(app)
        .get('/api/v1/me/engagement')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.streak.current).toBe(0);

      const prefRes = await request(app)
        .put('/api/v1/me/engagement/preferences')
        .set('Authorization', `Bearer ${token}`)
        .send({ share_achievements: true });
      expect(prefRes.status).toBe(200);
      expect(prefRes.body.success).toBe(true);
      expect(prefRes.body.data.share_achievements).toBe(true);
    } finally {
      setPool(database.pool);
    }
  });
});
