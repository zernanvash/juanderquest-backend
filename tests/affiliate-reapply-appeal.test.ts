import request from 'supertest';
import jwt from 'jsonwebtoken';
import { app } from '../src/app.js';
import { db } from '../src/db/index.js';
import { createTestDb, type TestDbInstance } from '../src/db/testHarness.js';
import { setPool } from '../src/db/pool.js';
import { env } from '../src/config/env.js';
import { resetRateLimits } from '../src/middleware/rateLimit.js';

// Owner 2026-11-18: rejected merchant applicants edit and resubmit, or appeal, the same application.
const realPgDescribe = process.env.JDQ_REAL_PG_URL ? describe : describe.skip;

realPgDescribe('Affiliate application resubmit and appeal after rejection (real PostgreSQL)', () => {
  let fixture: TestDbInstance;
  const adminId = 'ra-developer';
  const applicants = ['ra-user-1', 'ra-user-2', 'ra-user-3', 'ra-user-4', 'ra-user-5', 'ra-user-6', 'ra-user-7'];
  const token = (id: string, role = 'user') =>
    jwt.sign({ id, seed_id: `${id}-seed`, role, typ: 'session' }, env.JWT_SECRET);
  const adminToken = token(adminId, 'admin');

  const payload = {
    business_name: 'Dagupan Bangus Grill',
    category: 'dining',
    municipality: 'Dagupan City',
    business_province: 'Pangasinan',
    gps_lat: 16.04,
    gps_lng: 120.33,
    contact_name: 'Owner Name',
    contact_email: 'owner@test.local',
    contact_phone: '09170000000',
    sponsorship_goals: ['voucher_perk'],
    proposal_details: 'Fresh bangus for travelers.',
  };

  const api = (method: 'get' | 'post' | 'patch', path: string, as: string) =>
    request(app)[method](`/api/v1${path}`).set('Authorization', `Bearer ${as}`);
  const decide = (id: string, status: string, feedback?: string) =>
    api('patch', `/admin/affiliate/applications/${id}`, adminToken).send({ status, applicant_feedback: feedback });
  const pgRow = async (id: string) =>
    (await fixture.pool.query('SELECT * FROM merchant_affiliate_applications WHERE id = $1', [id])).rows[0];

  async function rejectedApplication(userId: string, reason = 'The map pin is in the sea.') {
    const created = await api('post', '/affiliate/applications', token(userId)).send(payload);
    expect(created.status).toBe(201);
    const id = created.body.data.id as string;
    expect((await decide(id, 'rejected', reason)).status).toBe(200);
    return id;
  }

  beforeAll(async () => {
    fixture = await createTestDb();
    setPool(fixture.pool);
    await fixture.pool.query(
      `INSERT INTO users(id,seed_id,display_name,email,role,admin_scope) VALUES ($1,$2,'RA Developer','ra-dev@test.local','admin','developer')`,
      [adminId, `${adminId}-seed`],
    );
    for (const id of applicants) {
      await fixture.pool.query(`INSERT INTO users(id,seed_id,display_name,email,role) VALUES ($1,$2,$4,$3,'user')`, [
        id,
        `${id}-seed`,
        `${id}@test.local`,
        id,
      ]);
    }
    await db.hydrateFromPg(fixture.pool);
  });

  beforeEach(() => resetRateLimits());

  afterAll(async () => {
    setPool(null);
    db.usersRepo.setPool(null);
    db.attachDurabilityPool(null);
    if (fixture) await fixture.close();
  });

  it('edits and resubmits the same rejected application, keeping history', async () => {
    const id = await rejectedApplication('ra-user-1');
    const res = await api('post', `/affiliate/applications/${id}/resubmit`, token('ra-user-1')).send({
      ...payload,
      business_name: 'Dagupan Bangus Grill (moved)',
      gps_lat: 16.05,
    });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      id,
      status: 'received',
      business_name: 'Dagupan Bangus Grill (moved)',
      resubmission_count: 1,
      previous_rejection_reason: 'The map pin is in the sea.',
      applicant_feedback: null,
    });
    expect(res.body.data.resubmitted_at).toEqual(expect.any(String));

    const row = await pgRow(id);
    expect(row.status).toBe('received');
    expect(row.business_name).toBe('Dagupan Bangus Grill (moved)');
    expect(Number(row.resubmission_count)).toBe(1);
    expect(row.previous_rejection_reason).toBe('The map pin is in the sea.');
    expect(row.resubmitted_at).not.toBeNull();
    const { rows } = await fixture.pool.query('SELECT id FROM merchant_affiliate_applications WHERE user_id = $1', [
      'ra-user-1',
    ]);
    expect(rows).toHaveLength(1);
    const audits = await fixture.pool.query(
      'SELECT from_status, to_status FROM merchant_application_audits WHERE application_id = $1 ORDER BY created_at',
      [id],
    );
    expect(audits.rows.map((a) => `${a.from_status}>${a.to_status}`)).toEqual([
      'draft>received',
      'received>rejected',
      'rejected>received',
    ]);

    const me = await api('get', '/affiliate/applications/me', token('ra-user-1'));
    expect(me.body.data.id).toBe(id);
    expect(me.body.data.status).toBe('received');
  });

  it('appeals a rejection, shows it in the review queue and approves it', async () => {
    const id = await rejectedApplication('ra-user-2', 'Business could not be verified.');
    const short = await api('post', `/affiliate/applications/${id}/appeal`, token('ra-user-2')).send({
      message: 'pls',
    });
    expect(short.status).toBe(400);

    const message = 'We registered with the LGU last week; permit number 2026-123.';
    const res = await api('post', `/affiliate/applications/${id}/appeal`, token('ra-user-2')).send({ message });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      id,
      status: 'appealed',
      appeal_message: message,
      resubmission_count: 1,
      previous_rejection_reason: 'Business could not be verified.',
    });
    const row = await pgRow(id);
    expect(row.status).toBe('appealed');
    expect(row.appeal_message).toBe(message);
    expect(row.appealed_at).not.toBeNull();

    const queue = await api('get', '/admin/affiliate/applications?status=appealed', adminToken);
    expect(queue.status).toBe(200);
    expect(queue.body.data.find((a: { id: string }) => a.id === id)?.appeal_message).toBe(message);
    const detail = await api('get', `/admin/affiliate/applications/${id}`, adminToken);
    expect(detail.body.data.audits.at(-1)).toMatchObject({ from_status: 'rejected', to_status: 'appealed' });
    expect(detail.body.data.audits.at(-1).notes).toContain(message);

    const me = await api('get', '/affiliate/applications/me', token('ra-user-2'));
    expect(me.body.data.status).toBe('appealed');

    const approved = await decide(id, 'approved');
    expect(approved.status).toBe(200);
    expect(approved.body.data.status).toBe('approved');
    expect((await pgRow(id)).status).toBe('approved');
    const merchants = await fixture.pool.query('SELECT id FROM merchants WHERE source_application_id = $1', [id]);
    expect(merchants.rows).toHaveLength(1);
  });

  it('allows at most 3 resubmissions or appeals in total', async () => {
    const user = 'ra-user-3';
    const id = await rejectedApplication(user);
    const resubmit = () => api('post', `/affiliate/applications/${id}/resubmit`, token(user)).send(payload);
    const appeal = () =>
      api('post', `/affiliate/applications/${id}/appeal`, token(user)).send({ message: 'Please look again at us.' });

    expect((await resubmit()).status).toBe(200);
    expect((await decide(id, 'rejected', 'Still no.')).status).toBe(200);
    expect((await appeal()).status).toBe(200);
    expect((await decide(id, 'rejected', 'Appeal denied.')).status).toBe(200);
    expect((await resubmit()).status).toBe(200);
    expect((await decide(id, 'rejected', 'Final.')).status).toBe(200);

    const blockedResubmit = await resubmit();
    expect(blockedResubmit.status).toBe(409);
    expect(blockedResubmit.body.error.code).toBe('REAPPLY_LIMIT_REACHED');
    const blockedAppeal = await appeal();
    expect(blockedAppeal.status).toBe(409);
    expect(blockedAppeal.body.error.code).toBe('REAPPLY_LIMIT_REACHED');
    const row = await pgRow(id);
    expect(row.status).toBe('rejected');
    expect(Number(row.resubmission_count)).toBe(3);
    expect(row.previous_rejection_reason).toBe('Appeal denied.');
  });

  it('rate-limits resubmit and appeal attempts per actor', async () => {
    const user = 'ra-user-4';
    const id = await rejectedApplication(user);
    const statuses: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      statuses.push(
        (await api('post', `/affiliate/applications/${id}/appeal`, token(user)).send({ message: 'short' })).status,
      );
    }
    expect(statuses).toEqual([400, 400, 400, 400, 400, 429]);
  });

  it('forbids a different user from resubmitting or appealing', async () => {
    const id = await rejectedApplication('ra-user-5');
    const stranger = token('ra-user-6');
    expect((await api('post', `/affiliate/applications/${id}/resubmit`, stranger).send(payload)).status).toBe(403);
    expect(
      (await api('post', `/affiliate/applications/${id}/appeal`, stranger).send({ message: 'I am not the owner.' }))
        .status,
    ).toBe(403);
    expect((await pgRow(id)).status).toBe('rejected');
  });

  it('cannot resubmit or appeal a pending or approved application, nor start a new one after a rejection', async () => {
    const user = 'ra-user-7';
    const as = token(user);
    const created = await api('post', '/affiliate/applications', as).send(payload);
    const id = created.body.data.id as string;
    const appealBody = { message: 'Please reconsider our shop.' };

    const pendingResubmit = await api('post', `/affiliate/applications/${id}/resubmit`, as).send(payload);
    expect(pendingResubmit.status).toBe(400);
    expect(pendingResubmit.body.error.code).toBe('INVALID_STATE_TRANSITION');
    expect((await api('post', `/affiliate/applications/${id}/appeal`, as).send(appealBody)).status).toBe(400);

    expect((await decide(id, 'rejected', 'No.')).status).toBe(200);
    // Owner 2026-11-18: no new application while the rejected one can be re-opened.
    const second = await api('post', '/affiliate/applications', as).send({ ...payload, business_name: 'Second Shop' });
    expect(second.status).toBe(409);
    expect(second.body.error).toMatchObject({ code: 'REAPPLY_EXISTING_APPLICATION', application_id: id });

    expect((await api('post', `/affiliate/applications/${id}/resubmit`, as).send(payload)).status).toBe(200);
    expect((await decide(id, 'approved')).status).toBe(200);
    expect((await api('post', `/affiliate/applications/${id}/resubmit`, as).send(payload)).status).toBe(400);
    expect((await api('post', `/affiliate/applications/${id}/appeal`, as).send(appealBody)).status).toBe(400);
  });
});
