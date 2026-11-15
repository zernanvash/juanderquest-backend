import jwt from 'jsonwebtoken';
import request from 'supertest';
import { app } from '../src/app.js';
import { env } from '../src/config/env.js';
import { db } from '../src/db/index.js';
import { setPool } from '../src/db/pool.js';
import { createTestDb, type TestDbInstance } from '../src/db/testHarness.js';

const realPg = process.env.JDQ_REAL_PG_URL ? describe : describe.skip;

// Plan 94: staff enter festivals with exact dates; the app reads them; each festival chooses whether it boosts voting.
realPg('Plan 94 festival calendar', () => {
  let fixture: TestDbInstance;
  const admin = 'p94-admin';
  const traveler = 'p94-traveler';
  const tester = 'p94-tester';
  const token = (id: string, role: string) =>
    jwt.sign({ id, seed_id: id, role, typ: 'session' }, env.JWT_SECRET, { expiresIn: '1h' });
  const asAdmin = (req: request.Test) => req.set('Authorization', `Bearer ${token(admin, 'admin')}`);
  const saved = { enabled: env.JUANCHOICE_ENABLED, writes: env.JUANCHOICE_WRITES_ENABLED };

  beforeAll(async () => {
    fixture = await createTestDb({ poolMax: 5 });
    setPool(fixture.pool);
    db.attachDurabilityPool(fixture.pool);
    db.usersRepo.setPool(fixture.pool);
    Object.assign(env, { JUANCHOICE_ENABLED: true, JUANCHOICE_WRITES_ENABLED: true });
    await fixture.pool.query(
      `INSERT INTO users(id,seed_id,display_name,email,role,is_test) VALUES
      ($1::text,$1::text,'Admin',$1::text||'@example.test','admin',FALSE),
      ($2::text,$2::text,'Traveler',$2::text||'@example.test','user',FALSE),
      ($3::text,$3::text,'Tester',$3::text||'@example.test','user',TRUE)`,
      [admin, traveler, tester],
    );
  });

  afterAll(async () => {
    Object.assign(env, { JUANCHOICE_ENABLED: saved.enabled, JUANCHOICE_WRITES_ENABLED: saved.writes });
    setPool(null);
    await fixture.close();
  });

  const create = (body: Record<string, unknown>) =>
    asAdmin(request(app).post('/api/v1/juanchoice/admin/festivals')).send(body);

  it('creates festivals with the voting boost switch (default on) and lists it for staff', async () => {
    const boosted = await create({
      name: 'Bangus Festival',
      municipality: 'Dagupan',
      starts_on: '2027-04-20',
      ends_on: '2027-04-30',
    });
    expect(boosted.status).toBe(201);
    expect(boosted.body.data.boosts_voting).toBe(true);
    const quiet = await create({
      name: 'Pista Dayat',
      municipality: 'Lingayen',
      starts_on: '2027-05-01',
      ends_on: '2027-05-01',
      boosts_voting: false,
    });
    expect(quiet.status).toBe(201);
    expect(quiet.body.data.boosts_voting).toBe(false);
    const list = await asAdmin(request(app).get('/api/v1/juanchoice/admin/festivals'));
    expect(list.status).toBe(200);
    expect(list.body.data.find((f: { name: string }) => f.name === 'Pista Dayat').boosts_voting).toBe(false);
  });

  it('edits a festival with PATCH and rejects an end before the start', async () => {
    const created = await create({
      name: 'Mango Festival',
      municipality: 'San Carlos',
      starts_on: '2027-04-10',
      ends_on: '2027-04-12',
    });
    const id = created.body.data.id;
    const moved = await asAdmin(request(app).patch(`/api/v1/juanchoice/admin/festivals/${id}`)).send({
      starts_on: '2027-04-11',
      ends_on: '2027-04-13',
      boosts_voting: false,
    });
    expect(moved.status).toBe(200);
    expect(moved.body.data).toMatchObject({
      name: 'Mango Festival',
      municipality: 'San Carlos',
      starts_on: '2027-04-11',
      ends_on: '2027-04-13',
      boosts_voting: false,
    });
    const bad = await asAdmin(request(app).patch(`/api/v1/juanchoice/admin/festivals/${id}`)).send({
      ends_on: '2027-04-01',
    });
    expect(bad.status).toBe(400);
    const empty = await asAdmin(request(app).patch(`/api/v1/juanchoice/admin/festivals/${id}`)).send({});
    expect(empty.status).toBe(400);
    const travelerTry = await request(app)
      .patch(`/api/v1/juanchoice/admin/festivals/${id}`)
      .set('Authorization', `Bearer ${token(traveler, 'user')}`)
      .send({ name: 'Hijacked' });
    expect(travelerTry.status).toBe(403);
  });

  it('serves the public list by year, spanning New Year, with test festivals only for test accounts', async () => {
    await create({ name: 'New Year Lights', starts_on: '2027-12-30', ends_on: '2028-01-02' });
    await create({ name: 'QA Fiesta', starts_on: '2027-06-01', ends_on: '2027-06-02', is_test: true });

    const names = async (year: number, auth?: string) => {
      const req = request(app).get(`/api/v1/calendar/festivals?year=${year}`);
      if (auth) req.set('Authorization', `Bearer ${auth}`);
      const res = await req;
      expect(res.status).toBe(200);
      return res.body.data.map((f: { name: string }) => f.name);
    };

    const public2027 = await names(2027);
    expect(public2027).toEqual(
      expect.arrayContaining(['Bangus Festival', 'Pista Dayat', 'Mango Festival', 'New Year Lights']),
    );
    expect(public2027).not.toContain('QA Fiesta');
    expect(await names(2028)).toEqual(['New Year Lights']);
    expect(await names(2027, token(traveler, 'user'))).not.toContain('QA Fiesta');
    expect(await names(2027, token(tester, 'user'))).toEqual(['QA Fiesta']);

    const one = (await request(app).get('/api/v1/calendar/festivals?year=2027')).body.data.find(
      (f: { name: string }) => f.name === 'Bangus Festival',
    );
    expect(one).toEqual({
      id: expect.any(String),
      name: 'Bangus Festival',
      municipality: 'Dagupan',
      starts_on: '2027-04-20',
      ends_on: '2027-04-30',
    });
    expect((await request(app).get('/api/v1/calendar/festivals?year=abc')).status).toBe(400);
  });
});
