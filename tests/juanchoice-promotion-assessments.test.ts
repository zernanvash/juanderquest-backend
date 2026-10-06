import { randomUUID } from 'crypto';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { app } from '../src/app.js';
import { env } from '../src/config/env.js';
import { setPool } from '../src/db/pool.js';
import { db as domainDb } from '../src/db/index.js';
import { createTestDb, TestDbInstance } from '../src/db/testHarness.js';
import {
  recordPromotionAssessment,
  getLatestPromotionAssessment,
  evaluateCandidatePromotionEligibility,
} from '../src/juanchoice/promotion-safety.js';
import { getPublicSpotlight, claimSupporterQuest, getSupporterQuest } from '../src/juanchoice/service.js';

describe('JuanChoice Promotion Assessments & Safety Invariants', () => {
  let db: TestDbInstance;
  const adminId = 'admin-assessor';
  const normalUserId = 'traveler-user';
  const testAdminId = 'admin-qa-synthetic';

  const campaignId = randomUUID();
  const candidate1 = randomUUID();
  const candidate2 = randomUUID();
  const spot1 = 'spot-assessment-1';
  const spot2 = 'spot-assessment-2';

  beforeAll(async () => {
    db = await createTestDb();
    setPool(db.pool);
    domainDb.usersRepo.setPool(db.pool);

    (env as any).JUANCHOICE_ENABLED = true;
    (env as any).JUANCHOICE_WRITES_ENABLED = true;
    (env as any).JUANCHOICE_PROMOTION_ENABLED = true;
    (env as any).PROGRESSION_ENABLED = true;

    // Users
    await db.pool.query(
      `INSERT INTO users (id, seed_id, display_name, email, role, is_test) VALUES
       ($1, $2, 'Admin', 'admin@example.test', 'admin', false),
       ($3, $4, 'User', 'user@example.test', 'user', false),
       ($5, $6, 'QA Admin', 'qa-admin@example.test', 'admin', true)`,
      [adminId, adminId, normalUserId, normalUserId, testAdminId, testAdminId]
    );

    // Spots
    for (const [id, slug] of [
      [spot1, 'spot-1-slug'],
      [spot2, 'spot-2-slug'],
    ]) {
      await db.pool.query(
        `INSERT INTO spots (id, slug, name, description, category, subcategory, municipality, address, gps_lat, gps_lng, source_type, source_name, is_test, status, recommendation_suppressed, crowd_capacity_band)
         VALUES ($1, $2, $3, 'Description', 'nature_outdoors', 'beach', 'Bolinao', 'Pangasinan', 16.3, 119.8, 'lgu', 'LGU', false, 'published', false, 'low')`,
        [id, slug, slug]
      );
    }

    // Campaign
    await db.pool.query(
      `INSERT INTO juanchoice_campaigns (id, slug, region, theme, status, opens_at, closes_at, finalized_at, is_test)
       VALUES ($1, 'campaign-assessments', 'Pangasinan', 'Beaches', 'finalized', NOW() - INTERVAL '2 days', NOW() - INTERVAL '1 day', NOW() - INTERVAL '1 hour', false)`,
      [campaignId]
    );

    // Candidates
    await db.pool.query(
      `INSERT INTO juanchoice_candidates (id, campaign_id, spot_id, status, is_test) VALUES
       ($1, $2, $3, 'eligible', false),
       ($4, $2, $5, 'eligible', false)`,
      [candidate1, campaignId, spot1, candidate2, spot2]
    );

    // Results (tied co-winners)
    await db.pool.query(
      `INSERT INTO juanchoice_results (campaign_id, standings, co_winner_ids, valid_ballots, policy_version, finalized_at)
       VALUES ($1, $2::jsonb, $3::jsonb, 10, 'juanchoice-pilot-v1', NOW() - INTERVAL '1 hour')`,
      [
        campaignId,
        JSON.stringify([
          { candidate_id: candidate1, spot_id: spot1, votes: 5 },
          { candidate_id: candidate2, spot_id: spot2, votes: 5 },
        ]),
        JSON.stringify([candidate1, candidate2]),
      ]
    );
  }, 30_000);

  afterAll(async () => {
    setPool(null);
    domainDb.usersRepo.setPool(null);
    await db.close();
    (env as any).JUANCHOICE_ENABLED = false;
    (env as any).JUANCHOICE_WRITES_ENABLED = false;
    (env as any).JUANCHOICE_PROMOTION_ENABLED = false;
  });

  it('default without review hides spotlight (all co-winners must have active cleared assessment)', async () => {
    const spotlight = await getPublicSpotlight();
    expect(spotlight).toBeNull();

    const eligibility = await evaluateCandidatePromotionEligibility(campaignId, candidate1, false, db.pool);
    expect(eligibility.eligible).toBe(false);
    expect(eligibility.reason).toBe('NO_PROMOTION_ASSESSMENT');
  });

  it('rejects assessment with invalid validity window (> 7 days or in past)', async () => {
    // Past date
    await expect(
      recordPromotionAssessment({
        campaignId,
        candidateId: candidate1,
        adminId,
        decision: 'cleared',
        reason: 'Valid reasoning for promotion',
        validUntil: new Date(Date.now() - 1000).toISOString(),
        expectedRevision: 0,
      })
    ).rejects.toMatchObject({ code: 'INVALID_VALIDITY_WINDOW' });

    // > 7 days in future
    await expect(
      recordPromotionAssessment({
        campaignId,
        candidateId: candidate1,
        adminId,
        decision: 'cleared',
        reason: 'Valid reasoning for promotion',
        validUntil: new Date(Date.now() + 8 * 86_400_000).toISOString(),
        expectedRevision: 0,
      })
    ).rejects.toMatchObject({ code: 'INVALID_VALIDITY_WINDOW' });
  });

  it('records initial cleared assessment (revision 1) and enforces expected_revision conflict', async () => {
    const validUntil = new Date(Date.now() + 5 * 86_400_000).toISOString();
    const assessment = await recordPromotionAssessment({
      campaignId,
      candidateId: candidate1,
      adminId,
      decision: 'cleared',
      reason: 'Capacity and access road inspected, cleared for promotion',
      validUntil,
      expectedRevision: 0,
    });

    expect(assessment.revision).toBe(1);
    expect(assessment.decision).toBe('cleared');

    // Concurrency conflict: trying to write with expectedRevision = 0 again
    await expect(
      recordPromotionAssessment({
        campaignId,
        candidateId: candidate1,
        adminId,
        decision: 'restricted',
        reason: 'Trying a stale revision write',
        validUntil,
        expectedRevision: 0,
      })
    ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  });

  it('multi-winner all-or-none: spotlight remains hidden when only 1 of 2 co-winners is cleared', async () => {
    const spotlight = await getPublicSpotlight();
    expect(spotlight).toBeNull();
  });

  it('explicit cleared unknown becomes visible once all co-winners qualify', async () => {
    const validUntil = new Date(Date.now() + 5 * 86_400_000).toISOString();
    await recordPromotionAssessment({
      campaignId,
      candidateId: candidate2,
      adminId,
      decision: 'cleared',
      reason: 'Candidate 2 safety and trail condition cleared by moderator',
      validUntil,
      expectedRevision: 0,
    });

    const spotlight = await getPublicSpotlight();
    expect(spotlight).not.toBeNull();
    expect(spotlight?.winners).toHaveLength(2);
    expect(spotlight?.winners.map((w: any) => w.candidate_id).sort()).toEqual(
      [candidate1, candidate2].sort()
    );
  });

  it('later restriction (revision 2) supersedes old clearance and hides spotlight immediately', async () => {
    const validUntil = new Date(Date.now() + 4 * 86_400_000).toISOString();
    const updated = await recordPromotionAssessment({
      campaignId,
      candidateId: candidate1,
      adminId,
      decision: 'restricted',
      reason: 'Sudden landslide hazard on access road, restricting promotion',
      validUntil,
      expectedRevision: 1,
    });

    expect(updated.revision).toBe(2);
    expect(updated.decision).toBe('restricted');

    const spotlight = await getPublicSpotlight();
    expect(spotlight).toBeNull();

    const eligibility = await evaluateCandidatePromotionEligibility(campaignId, candidate1, false, db.pool);
    expect(eligibility.eligible).toBe(false);
    expect(eligibility.reason).toBe('ASSESSMENT_RESTRICTED');
  });

  it('later restriction never revives older clearance even after expiration', async () => {
    // Manually backdate revision 2 assessed_at and valid_until to past so valid_until > assessed_at constraint holds
    await db.pool.query(
      "UPDATE juanchoice_promotion_assessments SET assessed_at = NOW() - INTERVAL '2 days', valid_until = NOW() - INTERVAL '1 hour' WHERE candidate_id = $1 AND revision = 2",
      [candidate1]
    );

    const eligibility = await evaluateCandidatePromotionEligibility(campaignId, candidate1, false, db.pool);
    expect(eligibility.eligible).toBe(false);
    // Revision 2 governs: it is expired, never revives revision 1 clearance
    expect(eligibility.reason).toBe('ASSESSMENT_RESTRICTED');
  });

  it('estimated_busy overrides any active clearance', async () => {
    // Re-clear candidate 1 with revision 3
    const validUntil = new Date(Date.now() + 5 * 86_400_000).toISOString();
    await recordPromotionAssessment({
      campaignId,
      candidateId: candidate1,
      adminId,
      decision: 'cleared',
      reason: 'Road repaired and crowd levels monitored',
      validUntil,
      expectedRevision: 2,
    });

    // Spot 1 has low capacity band (thresholds [3, 8])
    // Insert valid user for activity event
    const activeUser = 'user-active-crowd';
    await db.pool.query(
      `INSERT INTO users (id, seed_id, display_name, email, role, is_test) VALUES ($1, $2, 'Active', 'active@example.test', 'user', false)`,
      [activeUser, activeUser]
    );

    // Insert activity events: 2 visits (5 * 2 = 10 >= 8) -> estimated_busy
    await db.pool.query(
      `INSERT INTO spot_activity_events (id, user_id, spot_id, activity_type, created_at, is_test) VALUES
       ($1, $2, $3, 'visit', NOW() - INTERVAL '1 minute', false),
       ($4, $5, $3, 'visit', NOW() - INTERVAL '1 minute', false)`,
      [randomUUID(), activeUser, spot1, randomUUID(), normalUserId]
    );

    const eligibility = await evaluateCandidatePromotionEligibility(campaignId, candidate1, false, db.pool);
    expect(eligibility.crowd_status).toBe('estimated_busy');
    expect(eligibility.eligible).toBe(false);
    expect(eligibility.reason).toBe('ESTIMATED_BUSY');

    // Spotlight suppressed due to estimated_busy
    const spotlight = await getPublicSpotlight();
    expect(spotlight).toBeNull();
  });

  it('enforces scope isolation: synthetic admin cannot assess real candidate', async () => {
    await expect(
      recordPromotionAssessment({
        campaignId,
        candidateId: candidate1,
        adminId: testAdminId,
        decision: 'cleared',
        reason: 'Synthetic admin assessing real candidate',
        validUntil: new Date(Date.now() + 86_400_000).toISOString(),
        expectedRevision: 3,
      })
    ).rejects.toMatchObject({ code: 'SCOPE_MISMATCH' });
  });

  it('admin REST API endpoints: GET and POST /promotion-assessment', async () => {
    const adminToken = jwt.sign({ id: adminId, role: 'admin' }, env.JWT_SECRET);
    const userToken = jwt.sign({ id: normalUserId, role: 'user' }, env.JWT_SECRET);

    // 1. Unauthorized for non-admin
    const unauthorized = await request(app)
      .get(`/api/v1/juanchoice/admin/campaigns/${campaignId}/candidates/${candidate1}/promotion-assessment`)
      .set('Authorization', `Bearer ${userToken}`);
    expect(unauthorized.status).toBe(403);

    // 2. GET returns latest record and operator reason
    const getRes = await request(app)
      .get(`/api/v1/juanchoice/admin/campaigns/${campaignId}/candidates/${candidate1}/promotion-assessment`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(getRes.status).toBe(200);
    expect(getRes.header['cache-control']).toBe('private, no-store');
    expect(getRes.body.data.latest_assessment.revision).toBe(3);
    expect(getRes.body.data.crowd_status).toBe('estimated_busy');
    expect(getRes.body.data.eligibility_reason).toBe('ESTIMATED_BUSY');

    // 3. POST writes new revision 4
    const validUntil = new Date(Date.now() + 3 * 86_400_000).toISOString();
    const postRes = await request(app)
      .post(`/api/v1/juanchoice/admin/campaigns/${campaignId}/candidates/${candidate1}/promotion-assessment`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        decision: 'restricted',
        reason: 'Administrative restriction via REST API',
        valid_until: validUntil,
        expected_revision: 3,
      });

    expect(postRes.status).toBe(201);
    expect(postRes.header['cache-control']).toBe('private, no-store');
    expect(postRes.body.data.revision).toBe(4);
    expect(postRes.body.data.decision).toBe('restricted');

    // 4. Stale expected revision returns 409
    const conflictRes = await request(app)
      .post(`/api/v1/juanchoice/admin/campaigns/${campaignId}/candidates/${candidate1}/promotion-assessment`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        decision: 'cleared',
        reason: 'Concurrent edit attempt with stale revision',
        valid_until: validUntil,
        expected_revision: 3,
      });
    expect(conflictRes.status).toBe(409);
    expect(conflictRes.body.error.code).toBe('REVISION_CONFLICT');
  });

  it('supporter quest: new claim denied after restriction, committed claim replay retained', async () => {
    // Create single winner campaign for supporter quest
    const sqCampaign = randomUUID();
    const sqCandidate = randomUUID();
    const sqSpot = 'spot-sq-test';
    const questId = 'quest-sq-test';
    const bindingId = randomUUID();

    await db.pool.query(
      `INSERT INTO spots (id, slug, name, description, category, subcategory, municipality, address, gps_lat, gps_lng, source_type, source_name, is_test, status, recommendation_suppressed, crowd_capacity_band)
       VALUES ($1, 'sq-spot', 'SQ Spot', 'Desc', 'nature_outdoors', 'beach', 'Bolinao', 'Pangasinan', 16.3, 119.8, 'lgu', 'LGU', false, 'published', false, 'high')`,
      [sqSpot]
    );

    await db.pool.query(
      `INSERT INTO juanchoice_campaigns (id, slug, region, theme, status, opens_at, closes_at, finalized_at, is_test)
       VALUES ($1, 'campaign-sq', 'Pangasinan', 'Hidden Gems', 'finalized', NOW() - INTERVAL '3 days', NOW() - INTERVAL '1 day', NOW() - INTERVAL '2 hours', false)`,
      [sqCampaign]
    );

    await db.pool.query(
      `INSERT INTO juanchoice_candidates (id, campaign_id, spot_id, status, is_test)
       VALUES ($1, $2, $3, 'eligible', false)`,
      [sqCandidate, sqCampaign, sqSpot]
    );

    await db.pool.query(
      `INSERT INTO juanchoice_results (campaign_id, standings, co_winner_ids, valid_ballots, policy_version, finalized_at)
       VALUES ($1, $2::jsonb, $3::jsonb, 5, 'juanchoice-pilot-v1', NOW() - INTERVAL '2 hours')`,
      [sqCampaign, JSON.stringify([{ candidate_id: sqCandidate, spot_id: sqSpot, votes: 5 }]), JSON.stringify([sqCandidate])]
    );

    await db.pool.query(
      `INSERT INTO quests (id, title, description, category, location_name, gps_lat, gps_lng, radius_meters, reward_points, marker_code, marker_image_url)
       VALUES ($1, 'SQ Quest', 'Desc', 'eco', 'Bolinao', 16.3, 119.8, 100, 0, 'marker-sq', 'https://example.test/sq.png')`,
      [questId]
    );

    await db.pool.query(
      `INSERT INTO reviewed_quest_spot_bindings (id, quest_id, spot_id, binding_version, status, is_test)
       VALUES ($1, $2, $3, 'supporter-v1', 'active', false)`,
      [bindingId, questId, sqSpot]
    );

    // Initial cleared assessment
    await recordPromotionAssessment({
      campaignId: sqCampaign,
      candidateId: sqCandidate,
      adminId,
      decision: 'cleared',
      reason: 'Initial safe assessment for supporter quest',
      validUntil: new Date(Date.now() + 5 * 86_400_000).toISOString(),
      expectedRevision: 0,
    });

    // Verified visit for user
    const visitId = randomUUID();
    const submissionId = randomUUID();
    await db.pool.query(
      `INSERT INTO submissions (id, idempotency_key, user_id, quest_id, scanned_marker_code, captured_lat, captured_lng, captured_accuracy, status, reviewed_at)
       VALUES ($1, $2, $3, $4, 'marker-sq', 16.3, 119.8, 5, 'approved', NOW() - INTERVAL '1 hour')`,
      [submissionId, randomUUID(), normalUserId, questId]
    );
    await db.pool.query(
      `INSERT INTO verified_visits (id, user_id, spot_id, binding_id, source_submission_id, occurred_at, verified_at, evidence_version, is_test)
       VALUES ($1, $2, $3, $4, $5, NOW() - INTERVAL '1 hour', NOW() - INTERVAL '1 hour', 'supporter-v1', false)`,
      [visitId, normalUserId, sqSpot, bindingId, submissionId]
    );

    // Initial claim succeeds
    const initialClaim = await claimSupporterQuest(sqCampaign, normalUserId);
    expect(initialClaim.replayed).toBe(false);

    // Later restriction applied
    await recordPromotionAssessment({
      campaignId: sqCampaign,
      candidateId: sqCandidate,
      adminId,
      decision: 'restricted',
      reason: 'Trail damaged, restricting promotion',
      validUntil: new Date(Date.now() + 4 * 86_400_000).toISOString(),
      expectedRevision: 1,
    });

    // Supporter quest exposure is now null
    const questView = await getSupporterQuest(normalUserId, false);
    expect(questView).toBeNull();

    // Committed claim replay is preserved!
    const replayedClaim = await claimSupporterQuest(sqCampaign, normalUserId);
    expect(replayedClaim.replayed).toBe(true);

    // New traveler claiming is denied (SUPPORTER_QUEST_NOT_FOUND because quest is no longer promoted)
    const anotherUser = 'traveler-user-2';
    await db.pool.query(
      `INSERT INTO users (id, seed_id, display_name, email, role, is_test) VALUES ($1, $2, 'User 2', 'u2@example.test', 'user', false)`,
      [anotherUser, anotherUser]
    );
    await expect(claimSupporterQuest(sqCampaign, anotherUser)).rejects.toMatchObject({
      code: 'SUPPORTER_QUEST_NOT_FOUND',
    });
  });

  it('historical campaign results stay intact regardless of promotion assessment changes', async () => {
    const resultsRow = (
      await db.pool.query('SELECT * FROM juanchoice_results WHERE campaign_id = $1', [campaignId])
    ).rows[0];
    expect(resultsRow).toBeDefined();
    expect(Number(resultsRow.valid_ballots)).toBe(10);
  });

  describe('Iteration 03 Review Regression Suite', () => {
    const qaCampaignId = randomUUID();
    const qaCandidateId = randomUUID();
    const qaSpotId = 'spot-qa-iteration03';

    beforeAll(async () => {
      // Create QA Spot, Campaign, and Candidate
      await db.pool.query(
        `INSERT INTO spots (id, slug, name, description, category, subcategory, municipality, address, gps_lat, gps_lng, source_type, source_name, is_test, status, recommendation_suppressed, crowd_capacity_band)
         VALUES ($1, 'qa-iter03-spot', 'QA Iter03 Spot', 'Desc', 'nature_outdoors', 'beach', 'Bolinao', 'Pangasinan', 16.3, 119.8, 'lgu', 'LGU', true, 'published', false, 'low')`,
        [qaSpotId]
      );
      await db.pool.query(
        `INSERT INTO juanchoice_campaigns (id, slug, region, theme, status, opens_at, closes_at, finalized_at, is_test)
         VALUES ($1, 'campaign-qa-iter03', 'Pangasinan', 'QA Beaches', 'finalized', NOW() - INTERVAL '2 days', NOW() - INTERVAL '1 day', NOW() - INTERVAL '1 hour', true)`,
        [qaCampaignId]
      );
      await db.pool.query(
        `INSERT INTO juanchoice_candidates (id, campaign_id, spot_id, status, is_test)
         VALUES ($1, $2, $3, 'eligible', true)`,
        [qaCandidateId, qaCampaignId, qaSpotId]
      );
    });

    it('real admin can assess QA campaign; QA candidate derives is_test server-side', async () => {
      const validUntil = new Date(Date.now() + 2 * 86_400_000).toISOString();
      const assessed = await recordPromotionAssessment({
        campaignId: qaCampaignId,
        candidateId: qaCandidateId,
        adminId, // Real admin assessing QA candidate
        decision: 'cleared',
        reason: 'Real admin QA assessment verified',
        validUntil,
        expectedRevision: 0,
      });

      expect(assessed.revision).toBe(1);
      expect(assessed.is_test).toBe(true);
      expect(assessed.decision).toBe('cleared');
    });

    it('QA busy suppression and opposite-scope event exclusion', async () => {
      // Insert REAL activity events for qaSpotId -> should NOT affect QA crowd metrics!
      const realUser = 'user-real-isolation';
      await db.pool.query(
        `INSERT INTO users (id, seed_id, display_name, email, role, is_test) VALUES ($1, $2, 'Real', 'real@example.test', 'user', false) ON CONFLICT DO NOTHING`,
        [realUser, realUser]
      );
      await db.pool.query(
        `INSERT INTO spot_activity_events (id, user_id, spot_id, activity_type, created_at, is_test) VALUES
         ($1, $2, $3, 'visit', NOW() - INTERVAL '5 minutes', false),
         ($4, $5, $3, 'visit', NOW() - INTERVAL '5 minutes', false)`,
        [randomUUID(), realUser, qaSpotId, randomUUID(), normalUserId]
      );

      // QA evaluation should STILL be eligible because opposite-scope real events are excluded from QA evaluation
      const preQACrowd = await evaluateCandidatePromotionEligibility(qaCampaignId, qaCandidateId, true, db.pool);
      expect(preQACrowd.crowd_status).toBe('unknown');
      expect(preQACrowd.eligible).toBe(true);

      // Now insert QA activity events -> should trigger QA estimated_busy
      const qaUser1 = 'user-qa-crowd-1';
      const qaUser2 = 'user-qa-crowd-2';
      await db.pool.query(
        `INSERT INTO users (id, seed_id, display_name, email, role, is_test) VALUES
         ($1, $2, 'QA1', 'qa1@example.test', 'user', true),
         ($3, $4, 'QA2', 'qa2@example.test', 'user', true) ON CONFLICT DO NOTHING`,
        [qaUser1, qaUser1, qaUser2, qaUser2]
      );
      await db.pool.query(
        `INSERT INTO spot_activity_events (id, user_id, spot_id, activity_type, created_at, is_test) VALUES
         ($1, $2, $3, 'visit', NOW() - INTERVAL '2 minutes', true),
         ($4, $5, $3, 'visit', NOW() - INTERVAL '2 minutes', true)`,
        [randomUUID(), qaUser1, qaSpotId, randomUUID(), qaUser2]
      );

      const postQACrowd = await evaluateCandidatePromotionEligibility(qaCampaignId, qaCandidateId, true, db.pool);
      expect(postQACrowd.crowd_status).toBe('estimated_busy');
      expect(postQACrowd.eligible).toBe(false);
      expect(postQACrowd.reason).toBe('ESTIMATED_BUSY');
    });

    it('wrong campaign GET returns 404 with no unrelated assessment leak', async () => {
      const adminToken = jwt.sign({ id: adminId, role: 'admin' }, env.JWT_SECRET);
      const wrongCampaignId = randomUUID();

      const res = await request(app)
        .get(`/api/v1/juanchoice/admin/campaigns/${wrongCampaignId}/candidates/${candidate1}/promotion-assessment`)
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
      expect(res.body.data).toBeUndefined();
    });

    it('scope drift after clearance suppresses promotion eligibility', async () => {
      // Candidate 2 is currently cleared and real. Mutate spot to is_test = true
      await db.pool.query(`UPDATE spots SET is_test = true WHERE id = $1`, [spot2]);

      const drifted = await evaluateCandidatePromotionEligibility(campaignId, candidate2, true, db.pool);
      expect(drifted.eligible).toBe(false);
      expect(drifted.reason).toBe('SCOPE_MISMATCH');

      // Revert spot back to false
      await db.pool.query(`UPDATE spots SET is_test = false WHERE id = $1`, [spot2]);
    });

    it('future-dated assessed_at and exact valid_until boundary fail closed', async () => {
      const spotFuture = 'spot-future-boundary';
      const spotExpired = 'spot-expired-boundary';
      for (const s of [spotFuture, spotExpired]) {
        await db.pool.query(
          `INSERT INTO spots (id, slug, name, description, category, subcategory, municipality, address, gps_lat, gps_lng, source_type, source_name, is_test, status, recommendation_suppressed, crowd_capacity_band)
           VALUES ($1, $2, $3, 'Desc', 'nature_outdoors', 'beach', 'Bolinao', 'Pangasinan', 16.3, 119.8, 'lgu', 'LGU', false, 'published', false, 'low')`,
          [s, s, s]
        );
      }

      const testCand = randomUUID();
      await db.pool.query(
        `INSERT INTO juanchoice_candidates (id, campaign_id, spot_id, status, is_test) VALUES ($1, $2, $3, 'eligible', false)`,
        [testCand, campaignId, spotFuture]
      );

      // Future-dated assessed_at
      await db.pool.query(
        `INSERT INTO juanchoice_promotion_assessments (id, candidate_id, assessed_by, revision, decision, reason, assessed_at, valid_until, is_test)
         VALUES ($1, $2, $3, 1, 'cleared', 'Future dated reason', NOW() + INTERVAL '1 hour', NOW() + INTERVAL '2 days', false)`,
        [randomUUID(), testCand, adminId]
      );

      const futureEval = await evaluateCandidatePromotionEligibility(campaignId, testCand, false, db.pool);
      expect(futureEval.eligible).toBe(false);
      expect(futureEval.reason).toBe('ASSESSMENT_FUTURE_DATED');

      // Exact expiry boundary: valid_until = NOW() -> expired!
      const exactCand = randomUUID();
      await db.pool.query(
        `INSERT INTO juanchoice_candidates (id, campaign_id, spot_id, status, is_test) VALUES ($1, $2, $3, 'eligible', false)`,
        [exactCand, campaignId, spotExpired]
      );
      await db.pool.query(
        `INSERT INTO juanchoice_promotion_assessments (id, candidate_id, assessed_by, revision, decision, reason, assessed_at, valid_until, is_test)
         VALUES ($1, $2, $3, 1, 'cleared', 'Exact expiry reason', NOW() - INTERVAL '1 hour', NOW() - INTERVAL '1 second', false)`,
        [randomUUID(), exactCand, adminId]
      );

      const expiredEval = await evaluateCandidatePromotionEligibility(campaignId, exactCand, false, db.pool);
      expect(expiredEval.eligible).toBe(false);
      expect(expiredEval.reason).toBe('ASSESSMENT_EXPIRED');
    });

    it('revision > 2^31 without truncation and rejects unsafe revision inputs', async () => {
      const spotBigRev = 'spot-big-rev';
      await db.pool.query(
        `INSERT INTO spots (id, slug, name, description, category, subcategory, municipality, address, gps_lat, gps_lng, source_type, source_name, is_test, status, recommendation_suppressed, crowd_capacity_band)
         VALUES ($1, $2, $3, 'Desc', 'nature_outdoors', 'beach', 'Bolinao', 'Pangasinan', 16.3, 119.8, 'lgu', 'LGU', false, 'published', false, 'low')`,
        [spotBigRev, spotBigRev, spotBigRev]
      );

      const bigRevCand = randomUUID();
      await db.pool.query(
        `INSERT INTO juanchoice_candidates (id, campaign_id, spot_id, status, is_test) VALUES ($1, $2, $3, 'eligible', false)`,
        [bigRevCand, campaignId, spotBigRev]
      );

      const largeRev = 3_000_000_000; // > 2^31 - 1 (2,147,483,647)
      await db.pool.query(
        `INSERT INTO juanchoice_promotion_assessments (id, candidate_id, assessed_by, revision, decision, reason, assessed_at, valid_until, is_test)
         VALUES ($1, $2, $3, $4, 'cleared', 'Large revision test', NOW() - INTERVAL '10 minutes', NOW() + INTERVAL '2 days', false)`,
        [randomUUID(), bigRevCand, adminId, largeRev]
      );

      const latest = await getLatestPromotionAssessment(bigRevCand, db.pool);
      expect(latest?.revision).toBe(largeRev);

      // Successfully increments to largeRev + 1 without int32 overflow/truncation
      const nextAssessed = await recordPromotionAssessment({
        campaignId,
        candidateId: bigRevCand,
        adminId,
        decision: 'restricted',
        reason: 'Incrementing beyond int32 capacity safely',
        validUntil: new Date(Date.now() + 86_400_000).toISOString(),
        expectedRevision: largeRev,
      });
      expect(nextAssessed.revision).toBe(largeRev + 1);

      // Unsafe revision inputs rejected before write
      await expect(
        recordPromotionAssessment({
          campaignId,
          candidateId: bigRevCand,
          adminId,
          decision: 'cleared',
          reason: 'Testing negative revision rejection',
          validUntil: new Date(Date.now() + 86_400_000).toISOString(),
          expectedRevision: -1,
        })
      ).rejects.toMatchObject({ code: 'INVALID_REVISION' });

      await expect(
        recordPromotionAssessment({
          campaignId,
          candidateId: bigRevCand,
          adminId,
          decision: 'cleared',
          reason: 'Testing NaN revision rejection',
          validUntil: new Date(Date.now() + 86_400_000).toISOString(),
          expectedRevision: NaN,
        })
      ).rejects.toMatchObject({ code: 'INVALID_REVISION' });
    });

    it('genuine concurrent same-revision race: exactly 1 winner, 1 loser with 409 REVISION_CONFLICT', async () => {
      const spotRace = 'spot-concurrent-race';
      await db.pool.query(
        `INSERT INTO spots (id, slug, name, description, category, subcategory, municipality, address, gps_lat, gps_lng, source_type, source_name, is_test, status, recommendation_suppressed, crowd_capacity_band)
         VALUES ($1, $2, $3, 'Desc', 'nature_outdoors', 'beach', 'Bolinao', 'Pangasinan', 16.3, 119.8, 'lgu', 'LGU', false, 'published', false, 'low')`,
        [spotRace, spotRace, spotRace]
      );

      const raceCand = randomUUID();
      await db.pool.query(
        `INSERT INTO juanchoice_candidates (id, campaign_id, spot_id, status, is_test) VALUES ($1, $2, $3, 'eligible', false)`,
        [raceCand, campaignId, spotRace]
      );

      const validUntil = new Date(Date.now() + 86_400_000).toISOString();

      // Launch two truly concurrent promises competing for expectedRevision: 0
      const promiseA = recordPromotionAssessment({
        campaignId,
        candidateId: raceCand,
        adminId,
        decision: 'cleared',
        reason: 'Client A assessment in concurrent write race',
        validUntil,
        expectedRevision: 0,
      });

      const promiseB = recordPromotionAssessment({
        campaignId,
        candidateId: raceCand,
        adminId,
        decision: 'restricted',
        reason: 'Client B assessment in concurrent write race',
        validUntil,
        expectedRevision: 0,
      });

      const results = await Promise.allSettled([promiseA, promiseB]);
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);

      const winner = (fulfilled[0] as PromiseFulfilledResult<any>).value;
      expect(winner.revision).toBe(1);

      const loserError = (rejected[0] as PromiseRejectedResult).reason;
      expect(loserError.code).toBe('REVISION_CONFLICT');
      expect(loserError.status).toBe(409);

      // Verify database state: exactly ONE assessment record and ONE audit log entry created
      const assessmentsCount = (
        await db.pool.query(`SELECT COUNT(*)::int AS count FROM juanchoice_promotion_assessments WHERE candidate_id = $1`, [raceCand])
      ).rows[0].count;
      expect(assessmentsCount).toBe(1);

      const auditsCount = (
        await db.pool.query(`SELECT COUNT(*)::int AS count FROM juanchoice_campaign_audit WHERE campaign_id = $1 AND action LIKE $2`, [campaignId, `%${raceCand}%`])
      ).rows[0].count;
      expect(auditsCount).toBe(1);
    });
  });
});
