import { randomUUID } from 'crypto';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { app } from '../src/app.js';
import { db } from '../src/db/index.js';
import { env } from '../src/config/env.js';
import { setPool } from '../src/db/pool.js';
import { createTestDb, type TestDbInstance } from '../src/db/testHarness.js';
import { notify } from '../src/social/notify.js';

// v0.3.10 team review: "some notif persists they cant be updated". Social and
// Plaza notifications are stored with `notif_<uuid>` ids, which the MARK READ
// route rejected (UUID-only param check), so they stayed unread forever.
const realPg = process.env.JDQ_REAL_PG_URL ? describe : describe.skip;
realPg('notification read state for every id shape (disposable PostgreSQL)', () => {
  let fixture: TestDbInstance;
  const token = (id: string) => `Bearer ${jwt.sign({ id, seed_id: id, role: 'user', typ: 'session' }, env.JWT_SECRET)}`;

  async function user(id: string) {
    await fixture.pool.query('INSERT INTO users(id,seed_id,display_name,email,role) VALUES($1,$2,$3,$4,$5)', [
      id,
      id,
      id,
      `${id}@example.test`,
      'user',
    ]);
    db.users.push({ id, seed_id: id, display_name: id, email: `${id}@example.test`, role: 'user', is_test: false } as any);
  }

  beforeAll(async () => {
    fixture = await createTestDb();
    setPool(fixture.pool);
    db.usersRepo.setPool(fixture.pool);
  });
  afterAll(async () => {
    setPool(null);
    db.usersRepo.setPool(null);
    if (fixture) await fixture.close();
  });

  it('marks a social notification (notif_ id) read, and only for its owner', async () => {
    const suffix = randomUUID().slice(0, 8);
    const owner = `nf-${suffix}`;
    const other = `nx-${suffix}`;
    await user(owner);
    await user(other);
    const id = await notify(fixture.pool, {
      userId: owner,
      kind: 'cheer',
      eventKey: `cheer:${suffix}`,
      title: 'Someone cheered you',
      message: 'Nice spot!',
      href: '/plaza',
      isTest: false,
    });
    expect(id).toMatch(/^notif_/);

    const foreign = await request(app).patch(`/api/v1/notifications/${id}/read`).set('Authorization', token(other));
    expect(foreign.status).toBe(404);

    const marked = await request(app).patch(`/api/v1/notifications/${id}/read`).set('Authorization', token(owner));
    expect(marked.status).toBe(200);
    expect(marked.body.data.id).toBe(id);

    const list = await request(app).get('/api/v1/notifications').set('Authorization', token(owner));
    expect(list.body.data).toMatchObject({ unread_count: 0, items: [expect.objectContaining({ id, read: true })] });
  });

  it('still rejects an empty or oversized id', async () => {
    const owner = `nv-${randomUUID().slice(0, 8)}`;
    await user(owner);
    const long = await request(app)
      .patch(`/api/v1/notifications/${'x'.repeat(129)}/read`)
      .set('Authorization', token(owner));
    expect(long.status).toBe(400);
  });
});
