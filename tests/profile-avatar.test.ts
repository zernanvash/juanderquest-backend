import { createTestDb, TestDbInstance } from '../src/db/testHarness.js';
import { setPool } from '../src/db/pool.js';
import { db } from '../src/db/index.js';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { app } from '../src/app.js';
import { env } from '../src/config/env.js';

/** v0.3.10 team review: take or upload a profile picture, or remove it. */
describe('Profile picture upload (PUT/DELETE /users/me/avatar)', () => {
  let testDb: TestDbInstance;
  const user = { id: 'a7a7a7a7-1111-4111-8111-111111111111', seed_id: 'seed_avatar_user' };
  const token = jwt.sign({ id: user.id, seed_id: user.seed_id, role: 'user', typ: 'session' }, env.JWT_SECRET, {
    expiresIn: '1h',
  });

  const jpeg = Buffer.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x01, 0x00, 0x60, 0x00, 0x60, 0x00,
    0x00, 0xff, 0xd9,
  ]);
  const mp4 = Buffer.from([
    0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02, 0x00, 0x69, 0x73, 0x6f,
    0x6d, 0x69, 0x73, 0x6f, 0x32,
  ]);

  beforeAll(async () => {
    testDb = await createTestDb();
    setPool(testDb.pool);
    await testDb.pool.query(
      `INSERT INTO users (id, seed_id, display_name, email, handle, is_public, role, avatar_url)
       VALUES ($1, $2, 'Avatar Tester', 'avatar@test.com', 'avatartester', true, 'user', 'https://api.dicebear.com/7.x/identicon/svg?seed=x')
       ON CONFLICT (id) DO NOTHING`,
      [user.id, user.seed_id],
    );
    await db.hydrateFromPg(testDb.pool);
  }, 30000);

  afterAll(async () => {
    setPool(null);
    if (testDb) await testDb.close();
  }, 30000);

  const storedAvatar = async () =>
    (await testDb.pool.query('SELECT avatar_url FROM users WHERE id = $1', [user.id])).rows[0].avatar_url as string;

  it('requires a session', async () => {
    const res = await request(app).put('/api/v1/users/me/avatar').attach('photo', jpeg, 'me.jpg');
    expect(res.status).toBe(401);
  });

  it('stores a JPEG and saves its URL on the account', async () => {
    const res = await request(app)
      .put('/api/v1/users/me/avatar')
      .set('Authorization', `Bearer ${token}`)
      .attach('photo', jpeg, 'me.jpg');
    expect(res.status).toBe(200);
    expect(res.body.data.avatar_url).toMatch(/^\/api\/v1\/uploads\/spot-photos\/spot_photo_.+\.jpg$/);
    expect(await storedAvatar()).toBe(res.body.data.avatar_url);

    const me = await request(app).get('/api/v1/users/me/profile').set('Authorization', `Bearer ${token}`);
    expect(me.body.data.avatar_url).toBe(res.body.data.avatar_url);
  });

  it('rejects a video, a fake image and a missing file without changing the avatar', async () => {
    const before = await storedAvatar();
    const video = await request(app)
      .put('/api/v1/users/me/avatar')
      .set('Authorization', `Bearer ${token}`)
      .attach('photo', mp4, 'clip.mp4');
    expect(video.status).toBe(400);
    expect(video.body.error.code).toBe('INVALID_IMAGE_CONTENT');

    const fake = await request(app)
      .put('/api/v1/users/me/avatar')
      .set('Authorization', `Bearer ${token}`)
      .attach('photo', Buffer.from('<html>not an image</html>'), 'x.jpg');
    expect(fake.status).toBe(400);

    const none = await request(app).put('/api/v1/users/me/avatar').set('Authorization', `Bearer ${token}`);
    expect(none.status).toBe(400);
    expect(await storedAvatar()).toBe(before);
  });

  it('rejects photos over 8 MB', async () => {
    const big = Buffer.alloc(8 * 1024 * 1024 + 100);
    jpeg.copy(big, 0);
    const res = await request(app)
      .put('/api/v1/users/me/avatar')
      .set('Authorization', `Bearer ${token}`)
      .attach('photo', big, 'big.jpg');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('FILE_TOO_LARGE');
  });

  it('DELETE resets to the default identicon', async () => {
    const res = await request(app).delete('/api/v1/users/me/avatar').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.avatar_url).toBe(
      `https://api.dicebear.com/7.x/identicon/svg?seed=${encodeURIComponent(user.seed_id)}`,
    );
    expect(await storedAvatar()).toBe(res.body.data.avatar_url);
  });
});
