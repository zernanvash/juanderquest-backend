import { randomUUID } from 'crypto';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { app } from '../src/app.js';
import { env, validatePresentationModeConfig, extractDatabaseName } from '../src/config/env.js';
import { setPool } from '../src/db/pool.js';
import { db as domainDb } from '../src/db/index.js';
import { createTestDb, TestDbInstance } from '../src/db/testHarness.js';
import { evaluateVoterEligibility, castBallot, JuanChoiceError } from '../src/juanchoice/service.js';

describe('JuanChoice Presentation Mode Voter Eligibility Predicate & Service', () => {
  const allowedCampaignId = '11111111-1111-4111-8111-111111111111';
  const otherCampaignId = '22222222-2222-4222-8222-222222222222';
  const presentationDbName = 'juanderquest_presentation';

  describe('env configuration & extractDatabaseName validation', () => {
    it('extracts database name from valid PostgreSQL connection URLs', () => {
      expect(extractDatabaseName('postgres://postgres:postgres@localhost:5432/juanderquest')).toBe('juanderquest');
      expect(extractDatabaseName('postgres://user:pass@127.0.0.1:5432/juanderquest_presentation?sslmode=disable')).toBe('juanderquest_presentation');
      expect(extractDatabaseName('invalid-url')).toBeNull();
      expect(extractDatabaseName('https://localhost/juanderquest_presentation')).toBeNull();
    });

    it('passes validation when presentation mode is disabled regardless of allowlists', () => {
      const mockEnv = {
        ...env,
        JUANCHOICE_PRESENTATION_MODE: false,
        JUANCHOICE_PRESENTATION_CAMPAIGN_ID: '',
        JUANCHOICE_PRESENTATION_DB_NAME: '',
      } as any;
      expect(() => validatePresentationModeConfig(mockEnv)).not.toThrow();
    });

    it('fails closed when presentation mode is enabled but ALLOW_IN_MEMORY_FALLBACK is true', () => {
      const mockEnv = {
        ...env,
        JUANCHOICE_PRESENTATION_MODE: true,
        ALLOW_IN_MEMORY_FALLBACK: true,
        JUANCHOICE_PRESENTATION_CAMPAIGN_ID: allowedCampaignId,
        JUANCHOICE_PRESENTATION_DB_NAME: presentationDbName,
        DATABASE_URL: `postgres://localhost:5432/${presentationDbName}`,
      } as any;
      expect(() => validatePresentationModeConfig(mockEnv)).toThrow('ALLOW_IN_MEMORY_FALLBACK is true');
    });

    it('fails closed when campaign UUID is missing or malformed', () => {
      const mockEnv = {
        ...env,
        JUANCHOICE_PRESENTATION_MODE: true,
        ALLOW_IN_MEMORY_FALLBACK: false,
        JUANCHOICE_PRESENTATION_CAMPAIGN_ID: 'not-a-uuid',
        JUANCHOICE_PRESENTATION_DB_NAME: presentationDbName,
        DATABASE_URL: `postgres://localhost:5432/${presentationDbName}`,
      } as any;
      expect(() => validatePresentationModeConfig(mockEnv)).toThrow('valid UUID');
    });

    it('fails closed when database allowlist name is missing or differs from DATABASE_URL', () => {
      const mockEnvWrongDb = {
        ...env,
        JUANCHOICE_PRESENTATION_MODE: true,
        ALLOW_IN_MEMORY_FALLBACK: false,
        JUANCHOICE_PRESENTATION_CAMPAIGN_ID: allowedCampaignId,
        JUANCHOICE_PRESENTATION_DB_NAME: presentationDbName,
        DATABASE_URL: 'postgres://localhost:5432/juanderquest_alpha',
      } as any;
      expect(() => validatePresentationModeConfig(mockEnvWrongDb)).toThrow('database mismatch');
    });

    it('rejects an ordinary database even when the configured name matches the URL', () => {
      const mockEnvOrdinaryDb = {
        ...env,
        NODE_ENV: 'production',
        HOST: '127.0.0.1',
        PORT: 4200,
        CORS_ORIGIN: 'http://127.0.0.1:3200',
        WALLET_AUTH_MODE: 'signature',
        JUANCHOICE_PRESENTATION_MODE: true,
        ALLOW_IN_MEMORY_FALLBACK: false,
        JUANCHOICE_PRESENTATION_CAMPAIGN_ID: allowedCampaignId,
        JUANCHOICE_PRESENTATION_DB_NAME: 'juanderquest_alpha',
        DATABASE_URL: 'postgres://localhost:5432/juanderquest_alpha',
      } as any;
      expect(() => validatePresentationModeConfig(mockEnvOrdinaryDb)).toThrow('dedicated presentation database');
    });

    it('fails closed in production if wallet auth mode is local', () => {
      const mockEnvProd = {
        ...env,
        NODE_ENV: 'production',
        WALLET_AUTH_MODE: 'local',
        JUANCHOICE_PRESENTATION_MODE: true,
        ALLOW_IN_MEMORY_FALLBACK: false,
        JUANCHOICE_PRESENTATION_CAMPAIGN_ID: allowedCampaignId,
        JUANCHOICE_PRESENTATION_DB_NAME: presentationDbName,
        DATABASE_URL: `postgres://localhost:5432/${presentationDbName}`,
      } as any;
      expect(() => validatePresentationModeConfig(mockEnvProd)).toThrow('signature wallet authentication');
    });

    it('passes validation when all presentation requirements match exactly', () => {
      const mockEnvValid = {
        ...env,
        NODE_ENV: 'development',
        WALLET_AUTH_MODE: 'signature',
        JUANCHOICE_PRESENTATION_MODE: true,
        ALLOW_IN_MEMORY_FALLBACK: false,
        JUANCHOICE_PRESENTATION_CAMPAIGN_ID: allowedCampaignId,
        JUANCHOICE_PRESENTATION_DB_NAME: presentationDbName,
        DATABASE_URL: `postgres://localhost:5432/${presentationDbName}`,
      } as any;
      expect(() => validatePresentationModeConfig(mockEnvValid)).not.toThrow();
    });
  });

  describe('evaluateVoterEligibility pure predicate', () => {
    const baseNow = new Date('2026-10-04T12:00:00Z');
    const freshGuestCreated = new Date('2026-10-04T11:00:00Z'); // 1 hour old
    const agedGuestCreated = new Date('2026-10-01T11:00:00Z'); // 73 hours old

    let savedEnv: {
      presentationMode: boolean;
      campaignId: string;
      dbName: string;
      dbUrl: string;
      allowFallback: boolean;
      walletAuthMode: string;
      nodeEnv: string;
    };

    beforeEach(() => {
      savedEnv = {
        presentationMode: env.JUANCHOICE_PRESENTATION_MODE,
        campaignId: env.JUANCHOICE_PRESENTATION_CAMPAIGN_ID,
        dbName: env.JUANCHOICE_PRESENTATION_DB_NAME,
        dbUrl: env.DATABASE_URL,
        allowFallback: env.ALLOW_IN_MEMORY_FALLBACK,
        walletAuthMode: env.WALLET_AUTH_MODE,
        nodeEnv: env.NODE_ENV,
      };
    });

    afterEach(() => {
      env.JUANCHOICE_PRESENTATION_MODE = savedEnv.presentationMode;
      env.JUANCHOICE_PRESENTATION_CAMPAIGN_ID = savedEnv.campaignId;
      env.JUANCHOICE_PRESENTATION_DB_NAME = savedEnv.dbName;
      env.DATABASE_URL = savedEnv.dbUrl;
      env.ALLOW_IN_MEMORY_FALLBACK = savedEnv.allowFallback;
      env.WALLET_AUTH_MODE = savedEnv.walletAuthMode as any;
      env.NODE_ENV = savedEnv.nodeEnv as any;
    });

    it('qualifies an account >= 72 hours old unconditionally under standard rules', () => {
      env.JUANCHOICE_PRESENTATION_MODE = false;
      const result = evaluateVoterEligibility({
        actorCreatedAt: agedGuestCreated,
        actorIsTest: false,
        campaignId: otherCampaignId,
        campaignIsTest: false,
        hasVerifiedVisit: false,
        now: baseNow,
      });
      expect(result.eligible).toBe(true);
      expect(result.reason).toBeNull();
      expect(result.isPresentationException).toBe(false);
    });

    it('qualifies a fresh account that has a verified visit unconditionally under standard rules', () => {
      env.JUANCHOICE_PRESENTATION_MODE = false;
      const result = evaluateVoterEligibility({
        actorCreatedAt: freshGuestCreated,
        actorIsTest: false,
        campaignId: otherCampaignId,
        campaignIsTest: false,
        hasVerifiedVisit: true,
        now: baseNow,
      });
      expect(result.eligible).toBe(true);
      expect(result.reason).toBeNull();
      expect(result.isPresentationException).toBe(false);
    });

    it('rejects a fresh guest when presentation mode is disabled', () => {
      env.JUANCHOICE_PRESENTATION_MODE = false;
      const result = evaluateVoterEligibility({
        actorCreatedAt: freshGuestCreated,
        actorIsTest: false,
        campaignId: allowedCampaignId,
        campaignIsTest: false,
        hasVerifiedVisit: false,
        now: baseNow,
      });
      expect(result.eligible).toBe(false);
      expect(result.reason).toBe('ACCOUNT_TOO_NEW');
      expect(result.isPresentationException).toBe(false);
      expect(result.eligibleAt).toEqual(new Date(freshGuestCreated.getTime() + 72 * 3600000));
    });

    it('rejects when presentation mode is on but ALLOW_IN_MEMORY_FALLBACK is true', () => {
      env.JUANCHOICE_PRESENTATION_MODE = true;
      env.ALLOW_IN_MEMORY_FALLBACK = true;
      env.JUANCHOICE_PRESENTATION_CAMPAIGN_ID = allowedCampaignId;
      env.JUANCHOICE_PRESENTATION_DB_NAME = presentationDbName;
      env.DATABASE_URL = `postgres://localhost:5432/${presentationDbName}`;

      const result = evaluateVoterEligibility({
        actorCreatedAt: freshGuestCreated,
        actorIsTest: false,
        campaignId: allowedCampaignId,
        campaignIsTest: false,
        hasVerifiedVisit: false,
        now: baseNow,
      });
      expect(result.eligible).toBe(false);
      expect(result.reason).toBe('ACCOUNT_TOO_NEW');
    });

    it('rejects when the campaign ID does not match the allowlisted campaign UUID', () => {
      env.JUANCHOICE_PRESENTATION_MODE = true;
      env.ALLOW_IN_MEMORY_FALLBACK = false;
      env.JUANCHOICE_PRESENTATION_CAMPAIGN_ID = allowedCampaignId;
      env.JUANCHOICE_PRESENTATION_DB_NAME = presentationDbName;
      env.DATABASE_URL = `postgres://localhost:5432/${presentationDbName}`;

      const result = evaluateVoterEligibility({
        actorCreatedAt: freshGuestCreated,
        actorIsTest: false,
        campaignId: otherCampaignId, // Different campaign in the same presentation database
        campaignIsTest: false,
        hasVerifiedVisit: false,
        now: baseNow,
      });
      expect(result.eligible).toBe(false);
      expect(result.reason).toBe('ACCOUNT_TOO_NEW');
    });

    it('rejects when DATABASE_URL does not match the configured presentation DB name', () => {
      env.JUANCHOICE_PRESENTATION_MODE = true;
      env.ALLOW_IN_MEMORY_FALLBACK = false;
      env.JUANCHOICE_PRESENTATION_CAMPAIGN_ID = allowedCampaignId;
      env.JUANCHOICE_PRESENTATION_DB_NAME = presentationDbName;
      env.DATABASE_URL = 'postgres://localhost:5432/juanderquest_alpha'; // Wrong DB

      const result = evaluateVoterEligibility({
        actorCreatedAt: freshGuestCreated,
        actorIsTest: false,
        campaignId: allowedCampaignId,
        campaignIsTest: false,
        hasVerifiedVisit: false,
        now: baseNow,
      });
      expect(result.eligible).toBe(false);
      expect(result.reason).toBe('ACCOUNT_TOO_NEW');
    });

    it('rejects QA / test entities (actorIsTest = true or campaignIsTest = true) from presentation exception', () => {
      env.JUANCHOICE_PRESENTATION_MODE = true;
      env.ALLOW_IN_MEMORY_FALLBACK = false;
      env.JUANCHOICE_PRESENTATION_CAMPAIGN_ID = allowedCampaignId;
      env.JUANCHOICE_PRESENTATION_DB_NAME = presentationDbName;
      env.DATABASE_URL = `postgres://localhost:5432/${presentationDbName}`;

      const qaActorResult = evaluateVoterEligibility({
        actorCreatedAt: freshGuestCreated,
        actorIsTest: true,
        campaignId: allowedCampaignId,
        campaignIsTest: false,
        hasVerifiedVisit: false,
        now: baseNow,
      });
      expect(qaActorResult.eligible).toBe(false);

      const qaCampaignResult = evaluateVoterEligibility({
        actorCreatedAt: freshGuestCreated,
        actorIsTest: false,
        campaignId: allowedCampaignId,
        campaignIsTest: true,
        hasVerifiedVisit: false,
        now: baseNow,
      });
      expect(qaCampaignResult.eligible).toBe(false);
    });

    it('grants presentation exception for fresh guest in correct demo combination', () => {
      env.JUANCHOICE_PRESENTATION_MODE = true;
      env.ALLOW_IN_MEMORY_FALLBACK = false;
      env.JUANCHOICE_PRESENTATION_CAMPAIGN_ID = allowedCampaignId;
      env.JUANCHOICE_PRESENTATION_DB_NAME = presentationDbName;
      env.DATABASE_URL = `postgres://localhost:5432/${presentationDbName}`;

      const result = evaluateVoterEligibility({
        actorCreatedAt: freshGuestCreated,
        actorIsTest: false,
        campaignId: allowedCampaignId,
        campaignIsTest: false,
        hasVerifiedVisit: false,
        now: baseNow,
      });
      expect(result.eligible).toBe(true);
      expect(result.reason).toBeNull();
      expect(result.isPresentationException).toBe(true);
    });
  });

  describe('Integration with castBallot and getMyJuanChoiceCampaignState', () => {
    let db: TestDbInstance;
    const freshUser = 'fresh-guest-uuid';
    const cand1 = randomUUID();
    const cand2 = randomUUID();

    beforeAll(async () => {
      db = await createTestDb();
      setPool(db.pool);
      domainDb.usersRepo.setPool(db.pool);

      env.JUANCHOICE_ENABLED = true;
      env.JUANCHOICE_WRITES_ENABLED = true;
      env.PROGRESSION_ENABLED = true;

      // Seed fresh guest created 10 minutes ago
      await db.pool.query(
        "INSERT INTO users(id,seed_id,display_name,email,created_at,is_test) VALUES($1,$2,'Fresh Guest','fresh@example.test',NOW() - INTERVAL '10 minutes',false)",
        [freshUser, freshUser]
      );
      // Seed spots
      await db.pool.query(`INSERT INTO spots(id,slug,name,description,category,subcategory,municipality,address,gps_lat,gps_lng,source_type,source_name,is_test)
        VALUES('spot-demo-1','spot-demo-1','Demo Spot 1','Desc','nature','beach','Alaminos','Alaminos',16,120,'lgu','LGU',false),
              ('spot-demo-2','spot-demo-2','Demo Spot 2','Desc','nature','beach','Alaminos','Alaminos',16,120,'lgu','LGU',false)`);

      // Seed allowed presentation campaign and another second campaign
      await db.pool.query(
        `INSERT INTO juanchoice_campaigns(id,slug,region,theme,status,opens_at,closes_at,is_test) VALUES
        ($1,'demo-campaign','Pangasinan','Presentation','voting',NOW() - INTERVAL '1 day',NOW() + INTERVAL '1 day',false),
        ($2,'normal-campaign','Pangasinan','Normal','voting',NOW() - INTERVAL '1 day',NOW() + INTERVAL '1 day',false)`,
        [allowedCampaignId, otherCampaignId]
      );

      // Seed candidates
      await db.pool.query(
        'INSERT INTO juanchoice_candidates(id,campaign_id,spot_id,status,is_test) VALUES($1,$2,$3,\'eligible\',false)',
        [cand1, allowedCampaignId, 'spot-demo-1']
      );
      await db.pool.query(
        'INSERT INTO juanchoice_candidates(id,campaign_id,spot_id,status,is_test) VALUES($1,$2,$3,\'eligible\',false)',
        [cand2, allowedCampaignId, 'spot-demo-2']
      );
    });

    afterAll(async () => {
      setPool(null);
      domainDb.usersRepo.setPool(null);
      await db.close();
      env.JUANCHOICE_ENABLED = false;
      env.JUANCHOICE_WRITES_ENABLED = false;
    });

    it('blocks fresh guest on both projection and castBallot when presentation mode is OFF', async () => {
      env.JUANCHOICE_PRESENTATION_MODE = false;

      const token = jwt.sign({ id: freshUser, role: 'user' }, env.JWT_SECRET);
      const res = await request(app)
        .get(`/api/v1/juanchoice/campaigns/${allowedCampaignId}/me`)
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.data.eligibility.eligible).toBe(false);
      expect(res.body.data.eligibility.reason).toBe('ACCOUNT_TOO_NEW');
      expect(res.body.data.can_vote_now).toBe(false);

      await expect(
        castBallot({
          campaignId: allowedCampaignId,
          userId: freshUser,
          candidateId: cand1,
          expectedVersion: 0,
          idempotencyKey: randomUUID(),
        })
      ).rejects.toMatchObject({ code: 'NOT_ELIGIBLE', status: 403 });
    });

    it('allows fresh guest on allowed campaign when presentation mode is properly configured', async () => {
      env.JUANCHOICE_PRESENTATION_MODE = true;
      env.ALLOW_IN_MEMORY_FALLBACK = false;
      env.JUANCHOICE_PRESENTATION_CAMPAIGN_ID = allowedCampaignId;
      env.JUANCHOICE_PRESENTATION_DB_NAME = 'juanderquest_presentation_test';
      env.DATABASE_URL = 'postgres://postgres:postgres@localhost:5432/juanderquest_presentation_test';

      const token = jwt.sign({ id: freshUser, role: 'user' }, env.JWT_SECRET);
      const res = await request(app)
        .get(`/api/v1/juanchoice/campaigns/${allowedCampaignId}/me`)
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.data.eligibility.eligible).toBe(true);
      expect(res.body.data.eligibility.reason).toBeNull();
      expect(res.body.data.can_vote_now).toBe(true);

      const idempotencyKey = randomUUID();
      const ballotResult = await castBallot({
        campaignId: allowedCampaignId,
        userId: freshUser,
        candidateId: cand1,
        expectedVersion: 0,
        idempotencyKey,
      });

      expect(ballotResult.ballot.candidate_id).toBe(cand1);
      expect(ballotResult.ballot.version).toBe(1);

      // Verify idempotent replay
      const replay = await castBallot({
        campaignId: allowedCampaignId,
        userId: freshUser,
        candidateId: cand1,
        expectedVersion: 0,
        idempotencyKey,
      });
      expect(replay.replayed).toBe(true);
      expect(replay.ballot.candidate_id).toBe(cand1);

      // Verify ballot edit
      const editKey = randomUUID();
      const edited = await castBallot({
        campaignId: allowedCampaignId,
        userId: freshUser,
        candidateId: cand2,
        expectedVersion: 1,
        idempotencyKey: editKey,
      });
      expect(edited.ballot.candidate_id).toBe(cand2);
      expect(edited.ballot.version).toBe(2);

      // Direct links to a second campaign in the demo database are hidden.
      const secondRes = await request(app)
        .get(`/api/v1/juanchoice/campaigns/${otherCampaignId}/me`)
        .set('Authorization', `Bearer ${token}`);
      expect(secondRes.status).toBe(404);
      await expect(castBallot({
        campaignId: otherCampaignId, userId: freshUser, candidateId: cand1,
        expectedVersion: 0, idempotencyKey: randomUUID(),
      })).rejects.toMatchObject({ code: 'CAMPAIGN_NOT_FOUND', status: 404 });
    });

    it('blocks even an old account from voting outside the presentation allowlist', async () => {
      env.JUANCHOICE_PRESENTATION_MODE = true;
      env.JUANCHOICE_PRESENTATION_CAMPAIGN_ID = allowedCampaignId;
      await db.pool.query(
        "INSERT INTO users(id,seed_id,display_name,email,created_at,is_test) VALUES('old-guest','old-guest','Old Guest','old@example.test',NOW() - INTERVAL '5 days',false)"
      );
      await expect(castBallot({
        campaignId: otherCampaignId, userId: 'old-guest', candidateId: cand1,
        expectedVersion: 0, idempotencyKey: randomUUID(),
      })).rejects.toMatchObject({ code: 'CAMPAIGN_NOT_FOUND', status: 404 });
    });

    it('rejects an allowlisted round after it gains official-series metadata', async () => {
      env.JUANCHOICE_PRESENTATION_MODE = true;
      await db.pool.query(
        "UPDATE juanchoice_campaigns SET series_key='pangasinan-primary', round_number=1, counts_for_streak=true WHERE id=$1",
        [allowedCampaignId]
      );
      try {
        await expect(castBallot({
          campaignId: allowedCampaignId, userId: freshUser, candidateId: cand1,
          expectedVersion: 2, idempotencyKey: randomUUID(),
        })).rejects.toMatchObject({ code: 'CAMPAIGN_NOT_FOUND', status: 404 });
      } finally {
        await db.pool.query(
          'UPDATE juanchoice_campaigns SET series_key=NULL, round_number=NULL, counts_for_streak=false WHERE id=$1',
          [allowedCampaignId]
        );
      }
    });
  });
});
