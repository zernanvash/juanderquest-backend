import request from 'supertest';
import jwt from 'jsonwebtoken';
import { app } from '../src/app.js';
import { db, QuestRow, UserRow, withinRadius } from '../src/db/index.js';
import { env } from '../src/config/env.js';
import { submissionsService } from '../src/services/submissions.js';
import { createTestDb } from '../src/db/testHarness.js';
import { applyMigrations } from '../src/db/migrations.js';

const auditUserId = 'qa-audit-traveler-20261016';
const auditSelfReviewerId = 'qa-audit-self-reviewer-20261016';
const auditQuestId = 'qa-audit-quest-20261016';
const auditStepQr = 'JDQ-STEP-AUDIT-SECRET-20261016';
const auditToken = jwt.sign({ id: auditUserId, seed_id: 'qa-audit-traveler', role: 'user' }, env.JWT_SECRET);

describe('2026-10-16 QA logic audit regression coverage', () => {
  beforeAll(() => {
    const now = new Date().toISOString();
    const user: UserRow = {
      id: auditUserId,
      seed_id: 'qa-audit-traveler',
      display_name: 'QA Audit Traveler',
      email: 'qa-audit-traveler@example.test',
      avatar_url: '',
      role: 'user',
      demo_points: 0,
      mjdq_balance: 0,
      jdq_governance_balance: 0,
      scout_reputation: 0,
      is_public: false,
      created_at: now,
      updated_at: now,
    };
    const quest: QuestRow = {
      id: auditQuestId,
      author_id: 'qa-audit-author',
      status: 'published',
      version: 1,
      title: 'QA Audit Checkpoint',
      description: 'A dedicated fixture for QA logic remediation tests.',
      category: 'eco',
      location_name: 'Lingayen',
      gps_lat: 16.0219,
      gps_lng: 120.2312,
      radius_meters: 150,
      base_reward_php: 25,
      difficulty_factor: 1,
      geo_multiplier: 1,
      reward_points: 10,
      marker_code: 'AUDIT_QUEST_MARKER',
      marker_image_url: '',
      is_active: true,
      is_test: false,
      steps: [
        {
          step_order: 1,
          title: 'Reach the checkpoint',
          description: 'Stand near the fixture coordinate.',
          checkpoint_type: 'location',
          required: true,
          gps_lat: 16.0219,
          gps_lng: 120.2312,
          radius_meters: 150,
        },
        {
          step_order: 2,
          title: 'Scan the fixture QR',
          description: 'Use the dedicated marker secret.',
          checkpoint_type: 'qr',
          required: true,
          hint: 'Public human-readable hint, not a secret.',
          marker_code: auditStepQr,
        },
      ],
      created_at: now,
      updated_at: now,
    };
    db.users.push(user);
    db.quests.push(quest);
  });

  afterAll(() => {
    db.quest_step_evidence = db.quest_step_evidence.filter((item) => item.quest_id !== auditQuestId);
    db.quest_attempts = db.quest_attempts.filter((item) => item.quest_id !== auditQuestId);
    db.submissions = db.submissions.filter((item) => item.quest_id !== auditQuestId);
    db.quests = db.quests.filter((item) => item.id !== auditQuestId);
    db.users = db.users.filter((item) => ![auditUserId, auditSelfReviewerId].includes(item.id));
  });

  it('rejects non-numeric and blank step GPS without verifying the checkpoint', async () => {
    const attempt = await request(app)
      .post(`/api/v1/quests/${auditQuestId}/attempts`)
      .set('Authorization', `Bearer ${auditToken}`);
    expect([200, 201]).toContain(attempt.status);

    const invalid = await request(app)
      .post(`/api/v1/quests/${auditQuestId}/steps/1/evidence`)
      .set('Authorization', `Bearer ${auditToken}`)
      .send({ idempotency_key: 'qa-audit-invalid-gps', captured_lat: 'nowhere', captured_lng: 'nowhere' });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.code).toBe('VALIDATION_ERROR');

    const blank = await request(app)
      .post(`/api/v1/quests/${auditQuestId}/steps/1/evidence`)
      .set('Authorization', `Bearer ${auditToken}`)
      .send({ idempotency_key: 'qa-audit-blank-gps', captured_lat: '', captured_lng: '' });
    expect(blank.status).toBe(400);
    expect(blank.body.error.code).toBe('MISSING_GPS_COORDINATES');
    expect(db.getStepEvidence(attempt.body.data.id)[0].status).toBe('ready');
  });

  it('accepts multipart-compatible numeric strings and validates the whole step order', async () => {
    const valid = await request(app)
      .post(`/api/v1/quests/${auditQuestId}/steps/1/evidence`)
      .set('Authorization', `Bearer ${auditToken}`)
      .send({ idempotency_key: 'qa-audit-numeric-string', captured_lat: '16.0219', captured_lng: '120.2312' });
    expect(valid.status).toBe(200);
    expect(valid.body.data.step.status).toBe('verified');
    expect(typeof valid.body.data.step.evidence_payload.gps.lat).toBe('number');

    const malformedOrder = await request(app)
      .post(`/api/v1/quests/${auditQuestId}/steps/1abc/evidence`)
      .set('Authorization', `Bearer ${auditToken}`)
      .send({});
    expect(malformedOrder.status).toBe(400);
    expect(malformedOrder.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('fails radius checks closed when the computed GPS distance is not finite', () => {
    expect(withinRadius(Number.NaN, 120, 16, 120, 100).ok).toBe(false);
    expect(withinRadius(16, 120, 16, 120, 100).ok).toBe(true);
  });

  it('hides per-step QR secrets from public quest and attempt projections', async () => {
    const list = await request(app).get('/api/v1/quests');
    const listed = list.body.data.find((quest: any) => quest.id === auditQuestId);
    expect(list.status).toBe(200);
    expect(listed.steps[1].hint).toBe('Public human-readable hint, not a secret.');
    expect(listed.steps[1].marker_code).toBeUndefined();

    const detail = await request(app).get(`/api/v1/quests/${auditQuestId}`);
    expect(detail.status).toBe(200);
    expect(detail.body.data.steps[1].marker_code).toBeUndefined();

    const attempt = await request(app)
      .post(`/api/v1/quests/${auditQuestId}/attempts`)
      .set('Authorization', `Bearer ${auditToken}`);
    expect([200, 201]).toContain(attempt.status);
    expect(attempt.body.data.steps_snapshot[1].marker_code).toBeUndefined();
  });

  it('rejects a public QR hint and accepts only the configured private step marker', async () => {
    db.quest_step_evidence = db.quest_step_evidence.filter((item) => item.quest_id !== auditQuestId);
    db.quest_attempts = db.quest_attempts.filter((item) => item.quest_id !== auditQuestId);
    const started = await request(app)
      .post(`/api/v1/quests/${auditQuestId}/attempts`)
      .set('Authorization', `Bearer ${auditToken}`);
    const initial = await request(app)
      .post(`/api/v1/quests/${auditQuestId}/steps/1/evidence`)
      .set('Authorization', `Bearer ${auditToken}`)
      .send({ idempotency_key: 'qa-audit-qr-prerequisite', captured_lat: '16.0219', captured_lng: '120.2312' });
    expect(initial.status).toBe(200);
    expect(started.body.data.id).toBeTruthy();

    const hint = await request(app)
      .post(`/api/v1/quests/${auditQuestId}/steps/2/evidence`)
      .set('Authorization', `Bearer ${auditToken}`)
      .send({ idempotency_key: 'qa-audit-public-hint', captured_lat: '16.0219', captured_lng: '120.2312', qr_code: 'Public human-readable hint, not a secret.' });
    expect(hint.status).toBe(400);
    expect(hint.body.error.code).toBe('INVALID_QR_CODE');

    const valid = await request(app)
      .post(`/api/v1/quests/${auditQuestId}/steps/2/evidence`)
      .set('Authorization', `Bearer ${auditToken}`)
      .send({ idempotency_key: 'qa-audit-private-step-code', captured_lat: '16.0219', captured_lng: '120.2312', qr_code: auditStepQr });
    expect(valid.status).toBe(200);
    expect(valid.body.data.step.status).toBe('verified');
  });

  it('allows only one pending submission and reopens the slot after rejection', async () => {
    db.submissions = db.submissions.filter((item) => item.quest_id !== auditQuestId);
    const pending = db.createSubmission({
      idempotency_key: 'qa-audit-pending-original', user_id: auditUserId, quest_id: auditQuestId,
      scanned_marker_code: 'CHALLENGE:pending-original', captured_lat: 16.0219, captured_lng: 120.2312,
      captured_accuracy: 5, status: 'pending', is_test: false,
    });
    const blocked = await request(app)
      .post('/api/v1/submissions')
      .set('Authorization', `Bearer ${auditToken}`)
      .send({ idempotency_key: '0f713893-6307-4bbd-8e0e-745013b7415e', quest_id: auditQuestId,
        challenge_token: 'not-even-a-valid-token', captured_lat: 16.0219, captured_lng: 120.2312, captured_accuracy: 5 });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('SUBMISSION_PENDING');

    db.reviewSubmission(pending.id, 'reject', 'qa-audit-reviewer', 'Proof needs correction.');
    const challenge = jwt.sign({ sub: 'quest_challenge', user_id: auditUserId, quest_id: auditQuestId, nonce: 'qa-audit-after-rejection' }, env.JWT_SECRET, { expiresIn: '10m' });
    const retried = await request(app)
      .post('/api/v1/submissions')
      .set('Authorization', `Bearer ${auditToken}`)
      .send({ idempotency_key: 'e48ed53d-3a64-4a23-8588-c737d3b8f43f', quest_id: auditQuestId,
        challenge_token: challenge, captured_lat: 16.0219, captured_lng: 120.2312, captured_accuracy: 5 });
    expect(retried.status).toBe(201);
    expect(retried.body.data.status).toBe('pending');
  });

  it('rejects a second approval for the same traveler and quest without a second reward', async () => {
    db.submissions = db.submissions.filter((item) => item.quest_id !== auditQuestId);
    const first = db.createSubmission({
      idempotency_key: 'qa-audit-approval-first', user_id: auditUserId, quest_id: auditQuestId,
      scanned_marker_code: 'CHALLENGE:first', captured_lat: 16.0219, captured_lng: 120.2312,
      captured_accuracy: 5, status: 'pending', is_test: false,
    });
    const second = db.createSubmission({
      idempotency_key: 'qa-audit-approval-second', user_id: auditUserId, quest_id: auditQuestId,
      scanned_marker_code: 'CHALLENGE:second', captured_lat: 16.0219, captured_lng: 120.2312,
      captured_accuracy: 5, status: 'pending', is_test: false,
    });
    const pointsBefore = db.findUserById(auditUserId)!.demo_points;

    const approved = await submissionsService.reviewSubmission(first.id, 'approve', 'qa-audit-admin');
    const duplicate = await submissionsService.reviewSubmission(second.id, 'approve', 'qa-audit-admin');

    expect(approved.success).toBe(true);
    expect(approved.data?.awarded_points).toBe(10);
    expect(duplicate.success).toBe(false);
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.error?.code).toBe('ALREADY_COMPLETED');
    expect(db.findUserById(auditUserId)!.demo_points).toBe(pointsBefore + 10);
  });

  it('forbids self-approval and self-rejection, while allowing a different reviewer', async () => {
    const selfReviewer = { ...db.findUserById(auditUserId)!, id: auditSelfReviewerId,
      seed_id: 'qa-audit-self-reviewer-seed', display_name: 'Self Review Admin',
      email: 'qa-audit-self-reviewer@example.test', role: 'admin' as const, demo_points: 0 };
    db.users.push(selfReviewer);
    const ownSubmission = db.createSubmission({
      idempotency_key: 'qa-audit-self-review-proof', user_id: auditSelfReviewerId, quest_id: auditQuestId,
      scanned_marker_code: 'CHALLENGE:self-review', captured_lat: 16.0219, captured_lng: 120.2312,
      captured_accuracy: 5, status: 'pending', is_test: false,
    });
    const pointsBefore = selfReviewer.demo_points;

    const selfApprove = await submissionsService.reviewSubmission(ownSubmission.id, 'approve', auditSelfReviewerId);
    const selfReject = await submissionsService.reviewSubmission(ownSubmission.id, 'reject', auditSelfReviewerId, 'Self reject');
    expect(selfApprove.statusCode).toBe(403);
    expect(selfApprove.error?.code).toBe('SELF_REVIEW_FORBIDDEN');
    expect(selfReject.statusCode).toBe(403);
    expect(selfReject.error?.code).toBe('SELF_REVIEW_FORBIDDEN');
    expect(ownSubmission.status).toBe('pending');
    expect(selfReviewer.demo_points).toBe(pointsBefore);

    const independent = await submissionsService.reviewSubmission(ownSubmission.id, 'approve', 'qa-audit-independent-admin');
    expect(independent.success).toBe(true);
    expect(independent.data?.awarded_points).toBe(10);
  });

  const realPostgresTest = process.env.JDQ_REAL_PG_URL ? it : it.skip;
  realPostgresTest('rotates exposed step QR codes and reconciles duplicate pending rows on disposable PostgreSQL', async () => {
    const fixture = await createTestDb();
    try {
      await fixture.pool.query('DROP INDEX IF EXISTS idx_submissions_unique_pending');
      await fixture.pool.query("DELETE FROM schema_migrations WHERE filename IN ('045_quest_step_marker_codes.sql', '046_submissions_single_pending.sql')");
      const userA = `qa-migration-a-${Date.now()}`;
      const userB = `qa-migration-b-${Date.now()}`;
      const questId = `qa-migration-quest-${Date.now()}`;
      await fixture.pool.query(
        `INSERT INTO users(id, seed_id, display_name, email, role, is_test)
         VALUES ($1,$2,'Migration A',$3,'user',false), ($4,$5,'Migration B',$6,'user',false)`,
        [userA, `${userA}-seed`, `${userA}@example.test`, userB, `${userB}-seed`, `${userB}@example.test`]
      );
      await fixture.pool.query(
        `INSERT INTO quests(id,title,description,category,location_name,gps_lat,gps_lng,marker_code,marker_image_url,steps)
         VALUES ($1,'Migration fixture','Migration fixture quest','eco','Test',16,120,'MIGRATION-MARKER','',
           $2::jsonb)`,
        [questId, JSON.stringify([{ step_order: 1, checkpoint_type: 'qr', marker_code: 'EXPOSED_OLD_QR', hint: 'find the painted post' }])]
      );
      const submissions = [
        ['migration-approved', userA, 'approved', '2026-10-01T00:00:00Z'],
        ['migration-older-pending', userA, 'pending', '2026-10-02T00:00:00Z'],
        ['migration-newer-pending', userA, 'pending', '2026-10-03T00:00:00Z'],
        ['migration-older-only', userB, 'pending', '2026-10-01T00:00:00Z'],
        ['migration-newer-only', userB, 'pending', '2026-10-04T00:00:00Z'],
      ] as const;
      for (const [id, userId, status, createdAt] of submissions) {
        await fixture.pool.query(
          `INSERT INTO submissions(id,idempotency_key,user_id,quest_id,scanned_marker_code,captured_lat,captured_lng,captured_accuracy,status,created_at,updated_at,is_test)
           VALUES ($1,$2,$3,$4,$5,16,120,5,$6,$7,$7,false)`,
          [id, `${id}-key`, userId, questId, `CHALLENGE:${id}`, status, createdAt]
        );
      }

      await applyMigrations(fixture.pool);
      const step = (await fixture.pool.query('SELECT steps FROM quests WHERE id = $1', [questId])).rows[0].steps[0];
      expect(step.marker_code).toMatch(/^JDQ-STEP-[A-F0-9]{32}$/);
      expect(step.marker_code).not.toBe('EXPOSED_OLD_QR');
      expect(step.hint).toBe('find the painted post');
      const statuses = (await fixture.pool.query(
        'SELECT id,status,reviewed_by,rejection_reason FROM submissions WHERE id LIKE $1 ORDER BY id', ['migration-%']
      )).rows;
      expect(statuses.find((row: any) => row.id === 'migration-older-pending')).toMatchObject({
        status: 'rejected', reviewed_by: null,
        rejection_reason: 'system: duplicate of an approved submission (QA 2026-10-16)',
      });
      expect(statuses.find((row: any) => row.id === 'migration-newer-pending')?.status).toBe('rejected');
      expect(statuses.find((row: any) => row.id === 'migration-older-only')?.status).toBe('rejected');
      expect(statuses.find((row: any) => row.id === 'migration-newer-only')?.status).toBe('pending');
    } finally {
      await fixture.close();
    }
  });
});
