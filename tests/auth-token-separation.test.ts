import request from 'supertest';
import jwt from 'jsonwebtoken';
import { app } from '../src/app.js';
import { db } from '../src/db/index.js';
import { env } from '../src/config/env.js';
import { signQuestChallenge, signSessionToken, verifySessionToken } from '../src/auth/tokens.js';

describe('session and quest challenge token boundaries', () => {
  const user = db.users[0];

  it('accepts a valid legacy session token without typ during migration compatibility window', async () => {
    const legacy = jwt.sign({ id: user.id, seed_id: user.seed_id, role: user.role }, env.JWT_SECRET);
    expect(verifySessionToken(legacy)?.id).toBe(user.id);
    const response = await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${legacy}`);
    expect(response.status).toBe(200);
  });

  it('rejects challenge bearer tokens on required and optional session paths', async () => {
    const challenge = signQuestChallenge({ user_id: user.id, quest_id: 'token-boundary-quest', nonce: 'nonce-1' });
    const required = await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${challenge}`);
    expect(required.status).toBe(401);
    expect(required.body.error.code).toBe('UNAUTHORIZED');

    const optional = await request(app).get('/api/v1/quests?include_test=true').set('Authorization', `Bearer ${challenge}`);
    expect(optional.status).toBe(403);
    expect(optional.body.error.code).toBe('UNAUTHORIZED_QA_MODE');
  });

  it('rejects session tokens presented as quest challenge tokens', async () => {
    const session = signSessionToken(user);
    const baseQuest = db.quests.find((item) => item.status !== 'draft')!;
    const quest = { ...baseQuest, id: 'token-boundary-quest', marker_code: 'TOKEN-BOUNDARY-MARKER' };
    db.quests.push(quest);
    const result = await request(app).post('/api/v1/submissions')
      .set('Authorization', `Bearer ${session}`)
      .send({ idempotency_key: 'd54f2f5b-ccdb-4f6b-a4cd-811c44b342fe', quest_id: quest.id,
        challenge_token: session, captured_lat: quest.gps_lat, captured_lng: quest.gps_lng, captured_accuracy: 5 });
    expect(result.status).toBe(401);
    expect(result.body.error.code).toBe('INVALID_CHALLENGE');
    db.quests = db.quests.filter((item) => item.id !== quest.id);
  });

  it('rejects non-HS256 and alg:none tokens', () => {
    const noneToken = `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify({
      id: user.id, seed_id: user.seed_id, role: user.role,
    })).toString('base64url')}.`;
    const wrongAlgorithm = jwt.sign({ id: user.id, seed_id: user.seed_id, role: user.role }, 'unused-secret', { algorithm: 'HS384' });
    expect(verifySessionToken(noneToken)).toBeNull();
    expect(verifySessionToken(wrongAlgorithm)).toBeNull();
  });
});
