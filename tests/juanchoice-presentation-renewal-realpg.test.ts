import { randomUUID } from 'crypto';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { app } from '../src/app.js';
import { env } from '../src/config/env.js';
import { db as domainDb } from '../src/db/index.js';
import { setPool } from '../src/db/pool.js';
import { createTestDb, TestDbInstance } from '../src/db/testHarness.js';

describe('JuanChoice presentation round v2 renewal and allowlist cutover regression', () => {
  let fixture: TestDbInstance;
  const guest1Id = `guest-1-${randomUUID()}`;
  const guest2Id = `guest-2-${randomUUID()}`;
  const campaign1Id = randomUUID();
  const campaign2Id = randomUUID();
  let candidate1Id: string;
  let candidate2Id: string;

  const originalFlags = {
    JUANCHOICE_ENABLED: env.JUANCHOICE_ENABLED,
    JUANCHOICE_WRITES_ENABLED: env.JUANCHOICE_WRITES_ENABLED,
    JUANCHOICE_PRESENTATION_MODE: env.JUANCHOICE_PRESENTATION_MODE,
    JUANCHOICE_PRESENTATION_CAMPAIGN_ID: env.JUANCHOICE_PRESENTATION_CAMPAIGN_ID,
    JUANCHOICE_PRESENTATION_DB_NAME: env.JUANCHOICE_PRESENTATION_DB_NAME,
    DATABASE_URL: env.DATABASE_URL,
    ALLOW_IN_MEMORY_FALLBACK: env.ALLOW_IN_MEMORY_FALLBACK,
    PROGRESSION_ENABLED: env.PROGRESSION_ENABLED,
  };

  beforeAll(async () => {
    fixture = await createTestDb();
    setPool(fixture.pool);
    domainDb.usersRepo.setPool(fixture.pool);

    const dbRes = await fixture.pool.query('SELECT current_database() AS db');
    const currentDb = dbRes.rows[0].db;

    Object.assign(env, {
      JUANCHOICE_ENABLED: true,
      JUANCHOICE_WRITES_ENABLED: true,
      JUANCHOICE_PRESENTATION_MODE: true,
      JUANCHOICE_PRESENTATION_CAMPAIGN_ID: campaign1Id,
      JUANCHOICE_PRESENTATION_DB_NAME: currentDb,
      DATABASE_URL: `postgres://localhost:5432/${currentDb}`,
      ALLOW_IN_MEMORY_FALLBACK: false,
      PROGRESSION_ENABLED: true,
    });

    // Seed 4 editorial spots
    const spotIds = ['spot-cabongaoan-beach', 'spot-cape-bolinao-lighthouse', 'spot-tambobong-beach', 'spot-tondol-beach'];
    for (const spotId of spotIds) {
      await fixture.pool.query(
        `INSERT INTO spots(id, slug, name, description, category, subcategory, municipality, address, gps_lat, gps_lng, status, is_test, recommendation_suppressed, source_type, source_name)
         VALUES($1, $1, $1, 'Test spot description', 'nature_outdoors', 'beach', 'Test Muni', 'Test Addr', 16.0, 120.0, 'published', false, false, 'editorial', 'Editorial')
         ON CONFLICT (id) DO NOTHING`,
        [spotId]
      );
    }

    // Provision 2 guest users
    await fixture.pool.query(
      `INSERT INTO users(id, seed_id, display_name, email, role, is_test, created_at)
       VALUES ($1, 'guest-1', 'Guest 1', $2, 'user', false, NOW()),
              ($3, 'guest-2', 'Guest 2', $4, 'user', false, NOW())`,
      [guest1Id, `${guest1Id}@example.test`, guest2Id, `${guest2Id}@example.test`]
    );

    // Seed Round 1
    await fixture.pool.query(
      `INSERT INTO juanchoice_campaigns(id, slug, region, theme, status, opens_at, closes_at, is_test, policy_version)
       VALUES($1, 'juanchoice-coastal-demo-2026-10', 'pangasinan', 'Coastal Discoveries Round 1', 'voting',
              NOW() - INTERVAL '1 day', NOW() + INTERVAL '1 day', false, 'juanchoice-pilot-v1')`,
      [campaign1Id]
    );

    candidate1Id = randomUUID();
    await fixture.pool.query(
      `INSERT INTO juanchoice_candidates(id, campaign_id, spot_id, status, is_test)
       VALUES($1, $2, 'spot-tondol-beach', 'eligible', false)`,
      [candidate1Id, campaign1Id]
    );
  }, 120_000);

  afterAll(async () => {
    if (fixture) {
      setPool(null);
      domainDb.usersRepo.setPool(null);
      Object.assign(env, originalFlags);
      await fixture.close();
    }
  });

  it('allows voting on allowlisted Round 1, closes Round 1 on v2 creation, and redirects allowlist to Round 2', async () => {
    const token1 = jwt.sign({ id: guest1Id, role: 'user' }, env.JWT_SECRET);

    // 1. Overview initially shows round 1 as current
    const overviewRes = await request(app).get('/api/v1/juanchoice/overview');
    expect(overviewRes.status).toBe(200);
    expect(overviewRes.body.data.current.id).toBe(campaign1Id);
    expect(overviewRes.body.data.environment).toBe('presentation_demo');

    // 2. Cast ballot for Guest 1 in Round 1
    const vote1 = await request(app)
      .put(`/api/v1/juanchoice/campaigns/${campaign1Id}/ballot`)
      .set('Authorization', `Bearer ${token1}`)
      .set('Idempotency-Key', randomUUID())
      .send({ candidate_id: candidate1Id, expected_version: 0 });

    expect(vote1.status).toBe(200);
    expect(vote1.body.data.ballot.candidate_id).toBe(candidate1Id);

    // Verify ballot and progression in DB
    const preCount = await fixture.pool.query(
      'SELECT count(*) FROM juanchoice_ballots WHERE campaign_id = $1',
      [campaign1Id]
    );
    expect(parseInt(preCount.rows[0].count, 10)).toBe(1);

    // 3. Simulate seed-presentation-round-v2:
    // Mark Round 1 as closed and insert Round 2
    await fixture.pool.query(
      "UPDATE juanchoice_campaigns SET status = 'closed' WHERE id = $1",
      [campaign1Id]
    );
    await fixture.pool.query(
      `INSERT INTO juanchoice_campaigns(id, slug, region, theme, status, opens_at, closes_at, is_test, policy_version)
       VALUES($1, 'juanchoice-coastal-demo-2026-10-v2', 'pangasinan', 'Coastal Discoveries Round 2', 'voting',
              NOW() - INTERVAL '1 hour', NOW() + INTERVAL '2 days', false, 'juanchoice-pilot-v1')`,
      [campaign2Id]
    );
    candidate2Id = randomUUID();
    await fixture.pool.query(
      `INSERT INTO juanchoice_candidates(id, campaign_id, spot_id, status, is_test)
       VALUES($1, $2, 'spot-cabongaoan-beach', 'eligible', false)`,
      [candidate2Id, campaign2Id]
    );

    // 4. Before allowlist switch, API still points to campaign1Id:
    // Trying to vote on campaign1Id fails with 400 ROUND_CLOSED (or not voting status)
    const voteRound1AfterClose = await request(app)
      .put(`/api/v1/juanchoice/campaigns/${campaign1Id}/ballot`)
      .set('Authorization', `Bearer ${token1}`)
      .set('Idempotency-Key', randomUUID())
      .send({ candidate_id: candidate1Id, expected_version: 1 });
    expect(voteRound1AfterClose.status).toBe(409);
    expect(voteRound1AfterClose.body.error.code).toBe('ROUND_CLOSED');

    // Trying to vote on campaign2Id before allowlist switch fails because it's not the allowlisted presentation campaign
    const token2 = jwt.sign({ id: guest2Id, role: 'user' }, env.JWT_SECRET);
    const voteRound2BeforeSwitch = await request(app)
      .put(`/api/v1/juanchoice/campaigns/${campaign2Id}/ballot`)
      .set('Authorization', `Bearer ${token2}`)
      .set('Idempotency-Key', randomUUID())
      .send({ candidate_id: candidate2Id, expected_version: 0 });
    expect(voteRound2BeforeSwitch.status).toBe(404);
    expect(voteRound2BeforeSwitch.body.error.code).toBe('CAMPAIGN_NOT_FOUND');

    // 5. Atomic allowlist switch: update env.JUANCHOICE_PRESENTATION_CAMPAIGN_ID to campaign2Id
    env.JUANCHOICE_PRESENTATION_CAMPAIGN_ID = campaign2Id;

    // Overview now returns campaign2Id as current
    const overview2 = await request(app).get('/api/v1/juanchoice/overview');
    expect(overview2.status).toBe(200);
    expect(overview2.body.data.current.id).toBe(campaign2Id);

    // Guest 2 casts ballot in Round 2 -> succeeds
    const voteRound2 = await request(app)
      .put(`/api/v1/juanchoice/campaigns/${campaign2Id}/ballot`)
      .set('Authorization', `Bearer ${token2}`)
      .set('Idempotency-Key', randomUUID())
      .send({ candidate_id: candidate2Id, expected_version: 0 });
    expect(voteRound2.status).toBe(200);
    expect(voteRound2.body.data.ballot.candidate_id).toBe(candidate2Id);

    // 6. Verify audit fidelity: Round 1 ballots and events are completely preserved!
    const round1Ballots = await fixture.pool.query(
      'SELECT count(*) FROM juanchoice_ballots WHERE campaign_id = $1',
      [campaign1Id]
    );
    expect(parseInt(round1Ballots.rows[0].count, 10)).toBe(1);

    const round2Ballots = await fixture.pool.query(
      'SELECT count(*) FROM juanchoice_ballots WHERE campaign_id = $1',
      [campaign2Id]
    );
    expect(parseInt(round2Ballots.rows[0].count, 10)).toBe(1);

    // Total ballots is now 2 across both rounds, zero loss
    const totalBallots = await fixture.pool.query('SELECT count(*) FROM juanchoice_ballots');
    expect(parseInt(totalBallots.rows[0].count, 10)).toBe(2);
  });
});
