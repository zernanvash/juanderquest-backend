import request from 'supertest';
import jwt from 'jsonwebtoken';
import { app } from '../src/app.js';
import { db, QuestRow, UserRow, withinRadius } from '../src/db/index.js';
import { env } from '../src/config/env.js';

const auditUserId = 'qa-audit-traveler-20261016';
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
    db.users = db.users.filter((item) => item.id !== auditUserId);
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
});
