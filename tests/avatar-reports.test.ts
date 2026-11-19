import { createTestDb, TestDbInstance } from '../src/db/testHarness.js';
import { setPool } from '../src/db/pool.js';
import { db } from '../src/db/index.js';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { app } from '../src/app.js';
import { env } from '../src/config/env.js';

/** v0.3.10 (owner): report another explorer's profile picture; admins reset or dismiss. */
describe('Avatar reports (migration 107)', () => {
  let testDb: TestDbInstance;
  const owner = { id: 'a7a70001-1111-4111-8111-111111111111', seed: 'seed_av_owner', handle: 'avowner' };
  const viewer = { id: 'a7a70002-1111-4111-8111-111111111111', seed: 'seed_av_viewer', handle: 'avviewer' };
  const plain = { id: 'a7a70003-1111-4111-8111-111111111111', seed: 'seed_av_plain', handle: 'avplain' };
  const admin = { id: 'a7a70004-1111-4111-8111-111111111111', seed: 'seed_av_admin', handle: 'avadmin' };
  const token = (u: { id: string; seed: string }, role = 'user') =>
    `Bearer ${jwt.sign({ id: u.id, seed_id: u.seed, role, typ: 'session' }, env.JWT_SECRET, { expiresIn: '1h' })}`;
  const picture = '/api/v1/uploads/spot-photos/spot_photo_owner.jpg';

  beforeAll(async () => {
    testDb = await createTestDb();
    setPool(testDb.pool);
    const rows: [typeof owner, string, string][] = [
      [owner, picture, 'user'],
      [viewer, 'https://api.dicebear.com/7.x/identicon/svg?seed=v', 'user'],
      [plain, 'https://api.dicebear.com/7.x/identicon/svg?seed=p', 'user'],
      [admin, 'https://api.dicebear.com/7.x/identicon/svg?seed=a', 'admin'],
    ];
    for (const [u, avatar, role] of rows) {
      await testDb.pool.query(
        `INSERT INTO users (id, seed_id, display_name, email, handle, is_public, role, avatar_url)
         VALUES ($1, $2, $3, $4, $5, true, $6, $7) ON CONFLICT (id) DO NOTHING`,
        [u.id, u.seed, u.handle, `${u.handle}@test.com`, u.handle, role, avatar],
      );
    }
    await db.hydrateFromPg(testDb.pool);
  }, 30000);

  afterAll(async () => {
    setPool(null);
    if (testDb) await testDb.close();
  }, 30000);

  const report = (target: string, auth?: string, reason = 'inappropriate') => {
    const r = request(app).post(`/api/v1/users/${target}/avatar/report`);
    return (auth ? r.set('Authorization', auth) : r).send({ reason });
  };

  it('requires a session and a valid reason', async () => {
    expect((await report(owner.id)).status).toBe(401);
    expect((await report(owner.id, token(viewer), 'boring')).status).toBe(400);
  });

  it('cannot report yourself or a default identicon', async () => {
    const self = await report(owner.id, token(owner));
    expect(self.status).toBe(400);
    expect(self.body.error.code).toBe('CANNOT_REPORT_SELF');
    const none = await report(plain.id, token(viewer));
    expect(none.status).toBe(400);
    expect(none.body.error.code).toBe('NO_PICTURE');
  });

  it('records one report per viewer per picture (by id or handle); a repeat is 409', async () => {
    const first = await report(owner.id, token(viewer));
    expect(first.status).toBe(201);
    const again = await report(`@${owner.handle}`, token(viewer), 'spam');
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('ALREADY_REPORTED');
    const { rows } = await testDb.pool.query('SELECT reason, status, avatar_url FROM avatar_reports');
    expect(rows).toEqual([{ reason: 'inappropriate', status: 'pending', avatar_url: picture }]);
  });

  it('admin list is admin-only and groups open reports by picture', async () => {
    expect((await request(app).get('/api/v1/admin/avatar-reports').set('Authorization', token(viewer))).status).toBe(
      403,
    );
    const res = await request(app).get('/api/v1/admin/avatar-reports').set('Authorization', token(admin, 'admin'));
    expect(res.status).toBe(200);
    expect(res.body.data.items).toHaveLength(1);
    expect(res.body.data.items[0]).toMatchObject({
      user_id: owner.id,
      avatar_url: picture,
      report_count: 1,
      is_current: true,
    });
  });

  it('admin Reset restores the identicon and closes the reports', async () => {
    const res = await request(app)
      .post(`/api/v1/admin/avatar-reports/${owner.id}/resolve`)
      .set('Authorization', token(admin, 'admin'))
      .send({ action: 'reset' });
    expect(res.status).toBe(200);
    expect(res.body.data.resolved).toBe(1);
    const user = await testDb.pool.query('SELECT avatar_url FROM users WHERE id = $1', [owner.id]);
    expect(user.rows[0].avatar_url).toBe(
      `https://api.dicebear.com/7.x/identicon/svg?seed=${encodeURIComponent(owner.seed)}`,
    );
    const open = await request(app).get('/api/v1/admin/avatar-reports').set('Authorization', token(admin, 'admin'));
    expect(open.body.data.items).toHaveLength(0);
  });

  it('admin Dismiss closes reports and keeps the picture', async () => {
    await testDb.pool.query('UPDATE users SET avatar_url = $2 WHERE id = $1', [owner.id, picture + '2']);
    await db.hydrateFromPg(testDb.pool);
    expect((await report(owner.id, token(viewer), 'other')).status).toBe(201);
    const res = await request(app)
      .post(`/api/v1/admin/avatar-reports/${owner.id}/resolve`)
      .set('Authorization', token(admin, 'admin'))
      .send({ action: 'dismiss' });
    expect(res.body.data.resolved).toBe(1);
    const user = await testDb.pool.query('SELECT avatar_url FROM users WHERE id = $1', [owner.id]);
    expect(user.rows[0].avatar_url).toBe(picture + '2');
  });
});
