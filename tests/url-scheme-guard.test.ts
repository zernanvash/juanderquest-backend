import request from 'supertest';
import jwt from 'jsonwebtoken';
import { app } from '../src/app.js';
import { db } from '../src/db/index.js';
import { createTestDb, TestDbInstance } from '../src/db/testHarness.js';
import { setPool } from '../src/db/pool.js';
import { env } from '../src/config/env.js';
import { httpUrl } from '../src/utils/http-url.js';

const buildQuestions = () =>
  Array.from({ length: 5 }, (_, index) => ({
    ordinal: index + 1,
    question_text: `Question ${index + 1}?`,
    explanation: `Explanation ${index + 1}`,
    source_url: 'https://example.com/source',
    options: [
      { ordinal: 1, option_text: 'Option A', is_correct: true },
      { ordinal: 2, option_text: 'Option B', is_correct: false },
      { ordinal: 3, option_text: 'Option C', is_correct: false },
      { ordinal: 4, option_text: 'Option D', is_correct: false },
    ],
  }));

const buildDraftPayload = (destinationId: string, title: string) => ({
  destination_id: destinationId,
  title,
  description: 'A test cultural quiz draft for admin authoring acceptance.',
  language: 'en',
  radius_meters: 250,
  xp_reward: 25,
  time_limit_minutes: 30,
  cooldown_hours: 24,
  questions: buildQuestions(),
});

describe('httpUrl: only http(s) links pass', () => {
  it.each([
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
    'ftp://example.com/x',
    'not a url',
  ])('rejects %s', (value) => {
    expect(httpUrl().safeParse(value).success).toBe(false);
  });

  it.each(['https://example.com/source', 'http://example.com/a?b=1'])('accepts %s', (value) => {
    expect(httpUrl().safeParse(value).success).toBe(true);
  });

  it('keeps a length limit when one is given', () => {
    expect(httpUrl(20).safeParse('https://example.com/a-very-long-path').success).toBe(false);
  });
});

describe('Admin quiz source_url rejects non-http(s) schemes (real PG)', () => {
  let testDb: TestDbInstance;

  const adminUserId = 'admin-url-guard-1';
  const travelerUserId = 'traveler-url-guard-1';

  const adminToken = jwt.sign(
    { id: adminUserId, seed_id: 'admin-url-guard-seed', role: 'admin', typ: 'session' },
    env.JWT_SECRET,
  );

  const destinationId = 'spot-url-guard-test';

  beforeAll(async () => {
    testDb = await createTestDb();
    setPool(testDb.pool);
    await db.hydrateFromPg(testDb.pool);

    await testDb.pool.query(
      `INSERT INTO users (id, seed_id, display_name, email, role)
       VALUES
         ($1, 'admin-url-guard-seed', 'Admin Author', 'url-guard-admin@juanderquest.app', 'admin'),
         ($2, 'traveler-url-guard-seed', 'Traveler One', 'url-guard-traveler@juanderquest.app', 'user')
       ON CONFLICT (id) DO NOTHING`,
      [adminUserId, travelerUserId],
    );

    await testDb.pool.query(
      `INSERT INTO spots (
         id, slug, name, description, category, subcategory, municipality, address,
         gps_lat, gps_lng, price_level, source_type, source_name, trust_level, status
       ) VALUES (
         $1, 'url-guard-spot', 'Authoring Test Beach', 'Beach used for authoring tests',
         'nature_outdoors', 'beach', 'Bolinao', 'Test Road, Bolinao, Pangasinan',
         16.32, 119.78, 1, 'lgu', 'Bolinao Tourism', 'lgu_verified', 'published'
       ) ON CONFLICT (id) DO NOTHING`,
      [destinationId],
    );
  });

  afterAll(async () => {
    setPool(null);
    await testDb.close();
  });

  it('refuses a javascript: source_url and stores nothing', async () => {
    const payload = buildDraftPayload(destinationId, 'Scheme Guard Draft');
    payload.questions[2].source_url = 'javascript:alert(1)';
    const res = await request(app)
      .post('/api/v1/admin/quizzes')
      .set('Authorization', `Bearer ${adminToken}`)
      .send(payload);
    expect(res.status).toBe(400);
    const stored = await testDb.pool.query(
      `SELECT COUNT(*)::int AS n FROM cultural_quiz_questions WHERE source_url ILIKE 'javascript:%'`,
    );
    expect(stored.rows[0].n).toBe(0);
  });

  it('still accepts an https source_url', async () => {
    const res = await request(app)
      .post('/api/v1/admin/quizzes')
      .set('Authorization', `Bearer ${adminToken}`)
      .send(buildDraftPayload(destinationId, 'Scheme Guard Draft OK'));
    expect(res.status).toBe(201);
  });
});
