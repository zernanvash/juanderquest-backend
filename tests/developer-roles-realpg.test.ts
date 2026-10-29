import { randomUUID } from 'crypto';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { app } from '../src/app.js';
import { env } from '../src/config/env.js';
import { db } from '../src/db/index.js';
import { setPool } from '../src/db/pool.js';
import { createTestDb, type TestDbInstance } from '../src/db/testHarness.js';
import { verifySessionToken, signSessionToken } from '../src/auth/tokens.js';
import { isPlatformStaff } from '../src/juanchoice/perk-controls.js';

const realPg = process.env.JDQ_REAL_PG_URL ? describe : describe.skip;
jest.setTimeout(180_000);

// Developer role (owner 2026-10-29): developers can do everything admins can, are JuanChoice
// platform staff, and are the only accounts that may change roles. Every change is audited.
realPg('developer roles (real PostgreSQL)', () => {
  let fixture: TestDbInstance;
  const dev = `dev-${randomUUID()}`;
  const admin = `adm-${randomUUID()}`;
  const traveler = `trv-${randomUUID()}`;
  const token = (id: string, role: string) => jwt.sign({ id, seed_id: id, role }, env.JWT_SECRET, { expiresIn: '1h' });
  const as = (id: string, role: string) => ({ Authorization: `Bearer ${token(id, role)}` });

  beforeAll(async () => {
    fixture = await createTestDb({ poolMax: 10 });
    setPool(fixture.pool);
    db.attachDurabilityPool(fixture.pool);
    db.usersRepo.setPool(fixture.pool);
    await fixture.pool.query(`INSERT INTO users(id,seed_id,display_name,email,role,admin_scope,wallet_address,is_test) VALUES
      ($1::text,$1::text,'Zernan Dev',$1::text||'@example.test','admin','developer','0xFAdD476C10B6A93Bc26a226f9b7d8e8c556F9671',FALSE),
      ($2::text,$2::text,'Plain Admin',$2::text||'@example.test','admin',NULL,NULL,FALSE),
      ($3::text,$3::text,'Traveler Ana',$3::text||'@example.test','user',NULL,NULL,FALSE)`, [dev, admin, traveler]);
  });

  afterAll(async () => {
    await fixture?.close();
  });

  it('tells each account whether it is a developer', async () => {
    expect((await request(app).get('/api/v1/admin/developer/access').set(as(dev, 'admin'))).body.data.developer).toBe(true);
    expect((await request(app).get('/api/v1/admin/developer/access').set(as(admin, 'admin'))).body.data.developer).toBe(false);
    // Travelers never reach admin paths at all.
    expect((await request(app).get('/api/v1/admin/developer/access').set(as(traveler, 'user'))).body.data?.developer ?? false).toBe(false);
  });

  it('keeps role management away from ordinary admins and travelers', async () => {
    const byAdmin = await request(app).get('/api/v1/admin/developer/users').set(as(admin, 'admin'));
    expect(byAdmin.status).toBe(403);
    expect(byAdmin.body.error.code).toBe('DEVELOPER_ONLY');
    expect((await request(app).get('/api/v1/admin/developer/users').set(as(traveler, 'user'))).status).toBe(403);
    const change = await request(app).put(`/api/v1/admin/developer/users/${traveler}/role`).set(as(admin, 'admin'))
      .send({ role: 'admin', admin_scope: 'developer', reason: 'Self-promotion attempt' });
    expect(change.status).toBe(403);
  });

  it('developers count as JuanChoice platform staff', async () => {
    expect(await isPlatformStaff(dev, fixture.pool)).toBe(true);
    expect(await isPlatformStaff(admin, fixture.pool)).toBe(false);
  });

  it('lists and searches accounts, including by wallet', async () => {
    const all = await request(app).get('/api/v1/admin/developer/users').set(as(dev, 'admin'));
    expect(all.status).toBe(200);
    expect(all.body.data.map((u: { id: string }) => u.id)).toEqual(expect.arrayContaining([dev, admin, traveler]));
    const byWallet = await request(app).get('/api/v1/admin/developer/users')
      .query({ q: '0xfadd476c10b6a93bc26a226f9b7d8e8c556f9671' }).set(as(dev, 'admin'));
    expect(byWallet.body.data.map((u: { id: string }) => u.id)).toEqual([dev]);
    const staff = await request(app).get('/api/v1/admin/developer/users').query({ role: 'staff', q: 'Traveler Ana' }).set(as(dev, 'admin'));
    expect(staff.body.data).toEqual([]);
  });

  it('changes a role with a reason, audits it, and the new admin passes admin checks', async () => {
    const res = await request(app).put(`/api/v1/admin/developer/users/${traveler}/role`).set(as(dev, 'admin'))
      .send({ role: 'admin', admin_scope: 'platform', reason: 'Joins the tourism office team' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ id: traveler, role: 'admin', admin_scope: 'platform' });
    expect(await isPlatformStaff(traveler, fixture.pool)).toBe(true);
    // A fresh session for the promoted account reaches admin-only routes.
    const adminOnly = await request(app).get('/api/v1/admin/developer/users').set(as(traveler, 'admin'));
    expect(adminOnly.status).toBe(403); // admin, but not a developer
    const audit = await request(app).get('/api/v1/admin/developer/role-audit').set(as(dev, 'admin'));
    expect(audit.body.data[0]).toMatchObject({ old_role: 'user', new_role: 'admin', new_scope: 'platform', reason: 'Joins the tourism office team', actor_name: 'Zernan Dev', target_name: 'Traveler Ana' });

    // Scopes only apply to admins: demoting clears the scope.
    const back = await request(app).put(`/api/v1/admin/developer/users/${traveler}/role`).set(as(dev, 'admin'))
      .send({ role: 'user', admin_scope: 'platform', reason: 'Left the team' });
    expect(back.body.data).toMatchObject({ role: 'user', admin_scope: null });
  });

  it('refuses self-changes, short reasons and unknown accounts', async () => {
    const self = await request(app).put(`/api/v1/admin/developer/users/${dev}/role`).set(as(dev, 'admin'))
      .send({ role: 'user', admin_scope: null, reason: 'Stepping down now' });
    expect(self.status).toBe(409);
    expect(self.body.error.code).toBe('CANNOT_CHANGE_SELF');
    const short = await request(app).put(`/api/v1/admin/developer/users/${admin}/role`).set(as(dev, 'admin'))
      .send({ role: 'user', admin_scope: null, reason: 'no' });
    expect(short.status).toBe(400);
    const missing = await request(app).put('/api/v1/admin/developer/users/nobody-here/role').set(as(dev, 'admin'))
      .send({ role: 'user', admin_scope: null, reason: 'Cleanup of accounts' });
    expect(missing.status).toBe(404);
  });
});

describe('SESSIONS_VALID_AFTER signs everyone out', () => {
  const original = env.SESSIONS_VALID_AFTER;
  afterEach(() => Reflect.set(env, 'SESSIONS_VALID_AFTER', original));
  const user = { id: 'u-1', seed_id: 'u-1', role: 'user' };

  it('rejects sessions issued before the cutoff and accepts newer ones', () => {
    const old = jwt.sign({ ...user, typ: 'session', iat: Math.floor(Date.now() / 1000) - 3600 }, env.JWT_SECRET, { expiresIn: '7d' });
    expect(verifySessionToken(old)).not.toBeNull();
    Reflect.set(env, 'SESSIONS_VALID_AFTER', new Date(Date.now() - 60_000).toISOString());
    expect(verifySessionToken(old)).toBeNull();
    expect(verifySessionToken(signSessionToken(user))).toMatchObject({ id: 'u-1' });
  });

  it('ignores an empty or invalid cutoff', () => {
    Reflect.set(env, 'SESSIONS_VALID_AFTER', 'not-a-date');
    expect(verifySessionToken(signSessionToken(user))).not.toBeNull();
  });
});
