import request from 'supertest';
import jwt from 'jsonwebtoken';
import { app } from '../src/app.js';
import { db, QuestRow, UserRow, withinRadius } from '../src/db/index.js';
import { env } from '../src/config/env.js';

const auditUserId = 'qa-audit-traveler-20261016';
const auditQuestId = 'qa-audit-quest-20261016';
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
    expect(attempt.status).toBe(201);

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
});
