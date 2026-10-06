import { randomUUID } from 'crypto';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { app } from '../src/app.js';
import { env } from '../src/config/env.js';
import { setPool } from '../src/db/pool.js';
import { db as domainDb } from '../src/db/index.js';
import { createTestDb, TestDbInstance } from '../src/db/testHarness.js';
import { getPresentationOverview } from '../src/juanchoice/presentation-overview.js';
import { getMonthlyOverview } from '../src/juanchoice/monthly-overview.js';

describe('JuanChoice presentation overview contract', () => {
  let fixture: TestDbInstance;
  const presentationCampaignId = '33333333-3333-4333-8333-333333333333';
  const otherCampaignId = '44444444-4444-4444-8444-444444444444';
  const spotId1 = 'demo-spot-1';
  const spotId2 = 'demo-spot-2';
  const candidateId1 = randomUUID();
  const candidateId2 = randomUUID();

  beforeAll(async () => {
    fixture = await createTestDb();
    setPool(fixture.pool);
    domainDb.usersRepo.setPool(fixture.pool);

    // Seed test spots
    await fixture.pool.query(
      `INSERT INTO spots(id,slug,name,description,category,subcategory,municipality,address,gps_lat,gps_lng,source_type,source_name,is_test)
       VALUES ($1,$1,'Demo Spot 1','Desc','nature_outdoors','beach','Bolinao','Bolinao',16,120,'lgu','LGU',false),
              ($2,$2,'Demo Spot 2','Desc','nature_outdoors','beach','Bolinao','Bolinao',16,120,'lgu','LGU',false)`,
      [spotId1, spotId2]
    );
  });

  afterAll(async () => {
    setPool(null);
    domainDb.usersRepo.setPool(null);
    await fixture.close();
    env.JUANCHOICE_PRESENTATION_MODE = false;
    env.JUANCHOICE_ENABLED = false;
    env.JUANCHOICE_WRITES_ENABLED = false;
  });

  beforeEach(async () => {
    // Reset flags
    env.JUANCHOICE_ENABLED = true;
    env.JUANCHOICE_WRITES_ENABLED = true;
    env.PROGRESSION_ENABLED = true;
    env.JUANCHOICE_PRESENTATION_MODE = false;
    env.ALLOW_IN_MEMORY_FALLBACK = false;
    env.JUANCHOICE_PRESENTATION_CAMPAIGN_ID = presentationCampaignId;
    env.JUANCHOICE_PRESENTATION_DB_NAME = 'juanderquest_presentation_test';
    env.DATABASE_URL = 'postgres://localhost:5432/juanderquest_presentation_test';

    // Clean campaign / results rows
    await fixture.pool.query('DELETE FROM juanchoice_results');
    await fixture.pool.query('DELETE FROM juanchoice_candidates');
    await fixture.pool.query('DELETE FROM juanchoice_schedule_periods');
    await fixture.pool.query('DELETE FROM juanchoice_campaigns');
    await fixture.pool.query('DELETE FROM juanchoice_schedules');
  });

  it('preserves default-off ordinary monthly response unchanged without demo discriminator', async () => {
    env.JUANCHOICE_PRESENTATION_MODE = false;

    const res = await request(app).get('/api/v1/juanchoice/overview');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.environment).toBeUndefined();
    expect(res.body.data.current).toBeNull();
    expect(res.body.data.next).toBeNull();
    expect(res.body.data.previous).toBeNull();
    expect(res.body.data.availability.voting_enabled).toBe(false);
    expect(res.body.data.availability.reason).toBe('NO_SCHEDULE');
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.headers['x-robots-tag']).toBeUndefined();
  });

  it('returns active demo current campaign with environment discriminator, no-store, and noindex headers', async () => {
    // Seed one-off active campaign (no schedule, series_key=null, counts_for_streak=false)
    await fixture.pool.query(
      `INSERT INTO juanchoice_campaigns(id, slug, region, theme, status, opens_at, closes_at, is_test, series_key, round_number, counts_for_streak)
       VALUES ($1, 'demo-presentation-round', 'Pangasinan', 'Coastal Heritage', 'voting', NOW() - INTERVAL '1 hour', NOW() + INTERVAL '2 hours', false, NULL, NULL, false)`,
      [presentationCampaignId]
    );

    env.JUANCHOICE_PRESENTATION_MODE = true;

    const res = await request(app).get('/api/v1/juanchoice/overview');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.headers['x-robots-tag']).toBe('noindex, nofollow');

    const data = res.body.data;
    expect(data.environment).toBe('presentation_demo');
    expect(data.view).toBe('open');
    expect(data.availability.voting_enabled).toBe(true);
    expect(data.availability.reason).toBeNull();
    expect(data.current).not.toBeNull();
    expect(data.current.id).toBe(presentationCampaignId);
    expect(data.current.slug).toBe('demo-presentation-round');
    expect(data.next).toBeNull();
    expect(data.previous).toBeNull();
  });

  it('returns next when presentation campaign is scheduled in the future', async () => {
    await fixture.pool.query(
      `INSERT INTO juanchoice_campaigns(id, slug, region, theme, status, opens_at, closes_at, is_test, series_key, round_number, counts_for_streak)
       VALUES ($1, 'demo-future-round', 'Pangasinan', 'Culinary Flavors', 'scheduled', NOW() + INTERVAL '2 hours', NOW() + INTERVAL '10 hours', false, NULL, NULL, false)`,
      [presentationCampaignId]
    );

    env.JUANCHOICE_PRESENTATION_MODE = true;

    const res = await request(app).get('/api/v1/juanchoice/overview');
    expect(res.status).toBe(200);
    const data = res.body.data;
    expect(data.environment).toBe('presentation_demo');
    expect(data.view).toBe('between');
    expect(data.availability.voting_enabled).toBe(false);
    expect(data.availability.reason).toBe('ROUND_NOT_OPEN');
    expect(data.current).toBeNull();
    expect(data.next).not.toBeNull();
    expect(data.next.theme).toBe('Culinary Flavors');
    expect(data.previous).toBeNull();
  });

  it('does not publish a draft presentation campaign as an upcoming round', async () => {
    await fixture.pool.query(
      `INSERT INTO juanchoice_campaigns(id, slug, region, theme, status, opens_at, closes_at, is_test, series_key, round_number, counts_for_streak)
       VALUES ($1, 'demo-unreviewed-round', 'Pangasinan', 'Unreviewed', 'draft', NOW() + INTERVAL '2 hours', NOW() + INTERVAL '10 hours', false, NULL, NULL, false)`,
      [presentationCampaignId]
    );
    env.JUANCHOICE_PRESENTATION_MODE = true;
    const res = await request(app).get('/api/v1/juanchoice/overview');
    expect(res.status).toBe(200);
    expect(res.body.data.environment).toBe('presentation_demo');
    expect(res.body.data.availability.voting_enabled).toBe(false);
    expect(res.body.data.current).toBeNull();
    expect(res.body.data.next).toBeNull();
    expect(res.body.data.previous).toBeNull();
  });

  it('returns previous with demo results when presentation campaign is finalized', async () => {
    await fixture.pool.query(
      `INSERT INTO juanchoice_campaigns(id, slug, region, theme, status, opens_at, closes_at, is_test, series_key, round_number, counts_for_streak)
       VALUES ($1, 'demo-past-round', 'Pangasinan', 'Island Wonders', 'finalized', NOW() - INTERVAL '5 hours', NOW() - INTERVAL '1 hour', false, NULL, NULL, false)`,
      [presentationCampaignId]
    );
    await fixture.pool.query(
      `INSERT INTO juanchoice_candidates(id, campaign_id, spot_id, is_test) VALUES ($1, $2, $3, false)`,
      [candidateId1, presentationCampaignId, spotId1]
    );
    await fixture.pool.query(
      `INSERT INTO juanchoice_results(campaign_id, standings, co_winner_ids, valid_ballots, policy_version)
       VALUES ($1, $2::jsonb, $3::jsonb, 5, 'juanchoice-pilot-v1')`,
      [
        presentationCampaignId,
        JSON.stringify([{ candidate_id: candidateId1, spot_id: spotId1, spot_name: 'Demo Spot 1', votes: 5 }]),
        JSON.stringify([candidateId1]),
      ]
    );

    env.JUANCHOICE_PRESENTATION_MODE = true;

    const res = await request(app).get('/api/v1/juanchoice/overview');
    expect(res.status).toBe(200);
    const data = res.body.data;
    expect(data.environment).toBe('presentation_demo');
    expect(data.view).toBe('between');
    expect(data.availability.voting_enabled).toBe(false);
    expect(data.availability.reason).toBe('ROUND_CLOSED');
    expect(data.current).toBeNull();
    expect(data.next).toBeNull();
    expect(data.previous).not.toBeNull();
    expect(data.previous.campaign_id).toBe(presentationCampaignId);
    expect(data.previous.valid_ballots).toBe(5);
  });

  it('does not publish a result while the campaign is merely closed', async () => {
    await fixture.pool.query(
      `INSERT INTO juanchoice_campaigns(id, slug, region, theme, status, opens_at, closes_at, is_test, series_key, round_number, counts_for_streak)
       VALUES ($1, 'demo-closed-round', 'Pangasinan', 'Closed Demo', 'closed', NOW() - INTERVAL '5 hours', NOW() - INTERVAL '1 hour', false, NULL, NULL, false)`,
      [presentationCampaignId]
    );
    await fixture.pool.query(
      `INSERT INTO juanchoice_results(campaign_id, standings, co_winner_ids, valid_ballots, policy_version)
       VALUES ($1, '[]'::jsonb, '[]'::jsonb, 0, 'juanchoice-pilot-v1')`,
      [presentationCampaignId]
    );
    env.JUANCHOICE_PRESENTATION_MODE = true;
    const res = await request(app).get('/api/v1/juanchoice/overview');
    expect(res.status).toBe(200);
    expect(res.body.data.previous).toBeNull();
    expect(res.body.data.availability.voting_enabled).toBe(false);
    expect(res.body.data.notice?.code).toBe('RESULTS_PENDING');
  });

  it('disables voting when writes are disabled even if the campaign is active', async () => {
    await fixture.pool.query(
      `INSERT INTO juanchoice_campaigns(id, slug, region, theme, status, opens_at, closes_at, is_test, series_key, round_number, counts_for_streak)
       VALUES ($1, 'demo-presentation-round', 'Pangasinan', 'Coastal Heritage', 'voting', NOW() - INTERVAL '1 hour', NOW() + INTERVAL '2 hours', false, NULL, NULL, false)`,
      [presentationCampaignId]
    );

    env.JUANCHOICE_PRESENTATION_MODE = true;
    env.JUANCHOICE_WRITES_ENABLED = false;

    const res = await request(app).get('/api/v1/juanchoice/overview');
    expect(res.status).toBe(200);
    const data = res.body.data;
    expect(data.environment).toBe('presentation_demo');
    expect(data.view).toBe('open');
    expect(data.current?.id).toBe(presentationCampaignId);
    expect(data.availability.voting_enabled).toBe(false);
    expect(data.availability.reason).toBe('WRITES_DISABLED');
  });

  it('fails closed when connected to an ordinary non-presentation database', async () => {
    await fixture.pool.query(
      `INSERT INTO juanchoice_campaigns(id, slug, region, theme, status, opens_at, closes_at, is_test, series_key, round_number, counts_for_streak)
       VALUES ($1, 'demo-round', 'Pangasinan', 'Heritage', 'voting', NOW() - INTERVAL '1 hour', NOW() + INTERVAL '2 hours', false, NULL, NULL, false)`,
      [presentationCampaignId]
    );

    env.JUANCHOICE_PRESENTATION_MODE = true;
    env.JUANCHOICE_PRESENTATION_DB_NAME = 'juanderquest_alpha'; // not presentation DB
    env.DATABASE_URL = 'postgres://localhost:5432/juanderquest_alpha';

    const res = await request(app).get('/api/v1/juanchoice/overview');
    expect(res.status).toBe(200);
    const data = res.body.data;
    expect(data.environment).toBe('presentation_demo');
    expect(data.availability.voting_enabled).toBe(false);
    expect(data.availability.reason).toBe('INVALID_PRESENTATION_DATABASE');
    expect(data.current).toBeNull();
  });

  it('fails closed and never enumerates arbitrary campaigns when campaign ID does not match allowlist', async () => {
    // Seed another campaign in the DB
    await fixture.pool.query(
      `INSERT INTO juanchoice_campaigns(id, slug, region, theme, status, opens_at, closes_at, is_test, series_key, round_number, counts_for_streak)
       VALUES ($1, 'other-round', 'Pangasinan', 'Heritage', 'voting', NOW() - INTERVAL '1 hour', NOW() + INTERVAL '2 hours', false, NULL, NULL, false)`,
      [otherCampaignId]
    );

    env.JUANCHOICE_PRESENTATION_MODE = true;
    env.JUANCHOICE_PRESENTATION_CAMPAIGN_ID = presentationCampaignId; // allowlisted is not the seeded one

    const res = await request(app).get('/api/v1/juanchoice/overview');
    expect(res.status).toBe(200);
    const data = res.body.data;
    expect(data.environment).toBe('presentation_demo');
    expect(data.availability.voting_enabled).toBe(false);
    expect(data.availability.reason).toBe('CAMPAIGN_NOT_FOUND');
    expect(data.current).toBeNull();
    // Prove non-leakage of otherCampaignId
    expect(JSON.stringify(data)).not.toContain(otherCampaignId);
  });

  it('fails closed if campaign has is_test=true', async () => {
    await fixture.pool.query(
      `INSERT INTO juanchoice_campaigns(id, slug, region, theme, status, opens_at, closes_at, is_test, series_key, round_number, counts_for_streak)
       VALUES ($1, 'test-round', 'Pangasinan', 'Heritage', 'voting', NOW() - INTERVAL '1 hour', NOW() + INTERVAL '2 hours', true, NULL, NULL, false)`,
      [presentationCampaignId]
    );

    env.JUANCHOICE_PRESENTATION_MODE = true;

    const res = await request(app).get('/api/v1/juanchoice/overview');
    expect(res.status).toBe(200);
    const data = res.body.data;
    expect(data.environment).toBe('presentation_demo');
    expect(data.availability.voting_enabled).toBe(false);
    expect(data.availability.reason).toBe('CAMPAIGN_NOT_FOUND');
    expect(data.current).toBeNull();
  });

  it('fails closed if campaign has official series_key or round_number or counts_for_streak=true', async () => {
    await fixture.pool.query(
      `INSERT INTO juanchoice_campaigns(id, slug, region, theme, status, opens_at, closes_at, is_test, series_key, round_number, counts_for_streak)
       VALUES ($1, 'official-round', 'Pangasinan', 'Heritage', 'voting', NOW() - INTERVAL '1 hour', NOW() + INTERVAL '2 hours', false, 'pangasinan-primary', 1, true)`,
      [presentationCampaignId]
    );

    env.JUANCHOICE_PRESENTATION_MODE = true;

    const res = await request(app).get('/api/v1/juanchoice/overview');
    expect(res.status).toBe(200);
    const data = res.body.data;
    expect(data.environment).toBe('presentation_demo');
    expect(data.availability.voting_enabled).toBe(false);
    expect(data.availability.reason).toBe('OFFICIAL_SERIES_NOT_PERMITTED');
    expect(data.current).toBeNull();
  });

  it('fails closed if campaign is related to a monthly schedule period', async () => {
    await fixture.pool.query(
      `INSERT INTO juanchoice_campaigns(id, slug, region, theme, status, opens_at, closes_at, is_test, series_key, round_number, counts_for_streak)
       VALUES ($1, 'scheduled-round', 'Pangasinan', 'Heritage', 'voting', NOW() - INTERVAL '1 hour', NOW() + INTERVAL '2 hours', false, NULL, NULL, false)`,
      [presentationCampaignId]
    );
    const scheduleRes = await fixture.pool.query(
      `INSERT INTO juanchoice_schedules(id, schedule_key, region_key, display_region, timezone, enabled, effective_period, themes, is_test)
       VALUES ($1, 'pangasinan-monthly', 'pangasinan', 'Pangasinan', 'Asia/Manila', true, '2026-10-01', '[]'::jsonb, false) RETURNING id`,
      [randomUUID()]
    );
    await fixture.pool.query(
      `INSERT INTO juanchoice_schedule_periods(id, schedule_id, period_start, opens_at, closes_at, campaign_id, status)
       VALUES ($1, $2, '2026-10-01', NOW() - INTERVAL '1 hour', NOW() + INTERVAL '2 hours', $3, 'prepared')`,
      [randomUUID(), scheduleRes.rows[0].id, presentationCampaignId]
    );

    env.JUANCHOICE_PRESENTATION_MODE = true;

    const res = await request(app).get('/api/v1/juanchoice/overview');
    expect(res.status).toBe(200);
    const data = res.body.data;
    expect(data.environment).toBe('presentation_demo');
    expect(data.availability.voting_enabled).toBe(false);
    expect(data.availability.reason).toBe('SCHEDULE_RELATION_NOT_PERMITTED');
    expect(data.current).toBeNull();
  });

  it('routes QA scope=test through the authorized monthly route even when presentation mode is true', async () => {
    env.JUANCHOICE_PRESENTATION_MODE = true;

    // Unauthorized QA request
    const unauth = await request(app).get('/api/v1/juanchoice/overview?scope=test');
    expect(unauth.status).toBe(403);

    // Seed a QA user in database
    const qaUserId = randomUUID();
    await fixture.pool.query(
      `INSERT INTO users(id, seed_id, display_name, email, role, is_test)
       VALUES ($1, $1, 'QA Tester', 'qa@juanderquest.test', 'qa', false)`,
      [qaUserId]
    );

    const token = jwt.sign({ id: qaUserId, seed_id: qaUserId, role: 'qa' }, env.JWT_SECRET);

    // Authorized QA request
    const authRes = await request(app)
      .get('/api/v1/juanchoice/overview?scope=test')
      .set('Authorization', `Bearer ${token}`);
    expect(authRes.status).toBe(200);
    // Should NOT have environment: presentation_demo because it traversed getMonthlyOverview(region, true)
    expect(authRes.body.data.environment).toBeUndefined();
    expect(authRes.headers['x-robots-tag']).toBe('noindex, nofollow');
  });
});
