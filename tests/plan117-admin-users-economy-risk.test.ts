import { randomUUID } from 'crypto';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { app } from '../src/app.js';
import { env } from '../src/config/env.js';
import { db } from '../src/db/index.js';
import { setPool } from '../src/db/pool.js';
import { createTestDb, type TestDbInstance } from '../src/db/testHarness.js';
import { invalidateSessionScopeCache } from '../src/middleware/auth.js';
import { resetRateLimits } from '../src/middleware/rateLimit.js';
import { runRiskScan } from '../src/jobs/risk-scan.js';

const realPg = process.env.JDQ_REAL_PG_URL ? describe : describe.skip;
jest.setTimeout(180_000);

realPg('Plan 117: Admin User Management, Economy Monitor, and Risk Detection (real PostgreSQL)', () => {
  let fixture: TestDbInstance;
  const suffix = randomUUID().slice(0, 8);
  const adminA = `p117-adm-a-${suffix}`;
  const adminB = `p117-adm-b-${suffix}`;
  const devId = `p117-dev-${suffix}`;
  const areaAdminId = `p117-area-${suffix}`;
  const userNormal = `p117-usr-1-${suffix}`;
  const userAccent = `p117-usr-acc-${suffix}`;
  const userRich = `p117-usr-rich-${suffix}`;
  const userTest = `p117-usr-test-${suffix}`;

  const token = (id: string, role: string, sep = 0) =>
    jwt.sign({ id, seed_id: id, role, typ: 'session', sep }, env.JWT_SECRET, { expiresIn: '1h' });
  const as = (id: string, role: string, sep = 0) => ({ Authorization: `Bearer ${token(id, role, sep)}` });

  beforeAll(async () => {
    fixture = await createTestDb({ poolMax: 10 });
    setPool(fixture.pool);
    db.attachDurabilityPool(fixture.pool);
    invalidateSessionScopeCache();
    resetRateLimits();

    await fixture.pool.query(
      `INSERT INTO users (id, seed_id, display_name, email, handle, role, admin_scope, demo_points, scout_reputation, is_test, session_epoch)
       VALUES
         ($1::text, $1::text, 'Admin Alpha', $1::text || '@example.test', 'adm_alpha', 'admin', 'platform', 100, 500, FALSE, 0),
         ($2::text, $2::text, 'Admin Beta', $2::text || '@example.test', 'adm_beta', 'admin', 'platform', 50, 400, FALSE, 0),
         ($3::text, $3::text, 'Dev Reader', $3::text || '@example.test', 'dev_reader', 'admin', 'developer', 10, 300, FALSE, 0),
         ($4::text, $4::text, 'Area Officer', $4::text || '@example.test', 'area_off', 'area_admin', NULL, 20, 200, FALSE, 0),
         ($5::text, $5::text, 'Juan Dela Cruz', 'juan@gmail.com', 'juand_traveler', 'user', NULL, 150, 250, FALSE, 0),
         ($6::text, $6::text, 'María José Santos', 'maria.jose@example.test', 'maria_explorer', 'user', NULL, 400, 300, FALSE, 0),
         ($7::text, $7::text, 'Pedro High Points', 'pedro@example.test', 'pedro_rich', 'user', NULL, 2500, 350, FALSE, 0),
         ($8::text, $8::text, 'Hidden QA User', 'qa.hidden@example.test', 'qa_hidden', 'user', NULL, 9999, 999, TRUE, 0)`,
      [adminA, adminB, devId, areaAdminId, userNormal, userAccent, userRich, userTest],
    );

    // Email + password credentials for userNormal so unsuspend + re-login can be verified via HTTP /auth/login
    await db.identityService.linkIdentity(userNormal, 'email', 'juan@gmail.com');
    await db.identityService.recordAccountEmail(userNormal, 'juan@gmail.com', true);
    await db.identityService.setPassword(userNormal, 'SecretPass123!');

    // Push device + XP + stamps for detail and list checks
    await fixture.pool.query(
      `INSERT INTO user_devices (id, user_id, token, platform, last_seen_at)
       VALUES ($1, $2, $3, 'android', NOW())`,
      [`dev_${randomUUID()}`, userNormal, 'fcm-token-long-enough-for-constraint-check-' + suffix],
    );
    await fixture.pool.query(
      `INSERT INTO progression_totals (user_id, explorer_xp, civic_xp, last_event_at)
       VALUES ($1, 1200, 40, NOW()), ($2, 5000, 80, NOW())
       ON CONFLICT (user_id) DO UPDATE SET explorer_xp = EXCLUDED.explorer_xp, last_event_at = EXCLUDED.last_event_at`,
      [userAccent, userRich],
    );
  });

  afterAll(async () => {
    invalidateSessionScopeCache();
    await fixture?.close();
  });

  it('enforces the guard matrix across all Plan 117 endpoints', async () => {
    const readEndpoints = [
      '/api/v1/admin/users',
      `/api/v1/admin/users/${userNormal}`,
      '/api/v1/admin/economy/monitor?days=7',
      '/api/v1/admin/economy/ledger?kind=points',
      '/api/v1/admin/badges',
      '/api/v1/admin/risk/flags',
    ];
    for (const path of readEndpoints) {
      expect((await request(app).get(path)).status).toBe(401);
      expect((await request(app).get(path).set(as(userNormal, 'user'))).status).toBe(403);
      expect((await request(app).get(path).set(as(areaAdminId, 'area_admin'))).status).toBe(403);
      expect((await request(app).get(path).set(as(devId, 'admin'))).status).toBe(200);
      expect((await request(app).get(path).set(as(adminA, 'admin'))).status).toBe(200);
    }

    const writeEndpoints = [
      { path: `/api/v1/admin/users/${userNormal}/suspend`, body: { reason: 'Guard test check' } },
      { path: `/api/v1/admin/users/${userNormal}/unsuspend`, body: { reason: 'Guard test check' } },
      { path: `/api/v1/admin/users/${userNormal}/sign-out`, body: { reason: 'Guard test check' } },
      { path: '/api/v1/admin/risk/flags/nonexistent/review', body: { status: 'dismissed', note: 'Guard check' } },
      { path: '/api/v1/admin/risk/scan', body: {} },
    ];
    for (const { path, body } of writeEndpoints) {
      expect((await request(app).post(path).send(body)).status).toBe(401);
      expect((await request(app).post(path).set(as(userNormal, 'user')).send(body)).status).toBe(403);
      expect((await request(app).post(path).set(as(areaAdminId, 'area_admin')).send(body)).status).toBe(403);
      expect((await request(app).post(path).set(as(devId, 'admin')).send(body)).status).toBe(403);
    }
  });

  it('masks emails in list, supports accent/case/partial-handle search, keyset paging, and audits detail view', async () => {
    // List excludes is_test by default and masks email
    const listRes = await request(app).get('/api/v1/admin/users?limit=50').set(as(adminA, 'admin'));
    expect(listRes.status).toBe(200);
    const ids = listRes.body.data.items.map((u: any) => u.id);
    expect(ids).toContain(userNormal);
    expect(ids).not.toContain(userTest);
    const juanRow = listRes.body.data.items.find((u: any) => u.id === userNormal);
    expect(juanRow.masked_email).toBe('ju***@gmail.com');
    expect(juanRow.email).toBeUndefined();

    // ?include_test=1 includes test accounts
    const withTestRes = await request(app).get('/api/v1/admin/users?include_test=1&limit=50').set(as(adminA, 'admin'));
    expect(withTestRes.body.data.items.some((u: any) => u.id === userTest)).toBe(true);

    // Search: accent-insensitive ("Jose" matches "María José Santos"), case-insensitive ("MARIA"), partial handle ("@maria_ex")
    for (const q of ['Jose', 'MARIA', '@maria_ex']) {
      const sRes = await request(app).get('/api/v1/admin/users').query({ q }).set(as(adminA, 'admin'));
      expect(sRes.status).toBe(200);
      expect(sRes.body.data.items.map((u: any) => u.id)).toContain(userAccent);
    }

    // Keyset pagination (limit=2 sorted by points desc)
    const p1 = await request(app).get('/api/v1/admin/users?sort=points&limit=2').set(as(adminA, 'admin'));
    expect(p1.status).toBe(200);
    expect(p1.body.data.items).toHaveLength(2);
    expect(p1.body.data.has_more).toBe(true);
    expect(p1.body.data.items[0].id).toBe(userRich);
    const p2 = await request(app)
      .get('/api/v1/admin/users')
      .query({ sort: 'points', limit: 2, cursor: p1.body.data.next_cursor })
      .set(as(adminA, 'admin'));
    expect(p2.status).toBe(200);
    expect(p2.body.data.items[0].id).not.toBe(p1.body.data.items[1].id);

    // Detail returns full email + writes user.view audit row
    const detailRes = await request(app).get(`/api/v1/admin/users/${userNormal}`).set(as(adminA, 'admin'));
    expect(detailRes.status).toBe(200);
    expect(detailRes.body.data.profile.email).toBe('juan@gmail.com');
    expect(detailRes.body.data.profile.sign_in_methods.providers).toContain('email');
    expect(detailRes.body.data.profile.sign_in_methods.has_password).toBe(true);

    const auditRows = (
      await fixture.pool.query(
        `SELECT action, actor_id FROM admin_audit_log WHERE subject_type='user' AND subject_id=$1 AND action='user.view'`,
        [userNormal],
      )
    ).rows;
    expect(auditRows.length).toBeGreaterThanOrEqual(1);
    expect(auditRows[0].actor_id).toBe(adminA);
  });

  it('enforces suspend, refuses self/admin/double-suspend, blocks API/login/push, supports sign-out and unsuspend', async () => {
    // Refusals: self, other admin
    expect(
      (
        await request(app)
          .post(`/api/v1/admin/users/${adminA}/suspend`)
          .set(as(adminA, 'admin'))
          .send({ reason: 'Self' })
      ).status,
    ).toBe(409);
    expect(
      (
        await request(app)
          .post(`/api/v1/admin/users/${adminB}/suspend`)
          .set(as(adminA, 'admin'))
          .send({ reason: 'Other admin' })
      ).status,
    ).toBe(409);

    // Sign-out invalidates old bearer tokens without suspending
    const sOut = await request(app)
      .post(`/api/v1/admin/users/${userAccent}/sign-out`)
      .set(as(adminA, 'admin'))
      .send({ reason: 'Reset device sessions' });
    expect(sOut.status).toBe(200);
    expect(sOut.body.data.session_epoch).toBe(1);
    invalidateSessionScopeCache(userAccent);
    expect(
      (
        await request(app)
          .get('/api/v1/auth/me')
          .set(as(userAccent, 'user', 0))
      ).status,
    ).toBe(401);
    expect(
      (
        await request(app)
          .get('/api/v1/auth/me')
          .set(as(userAccent, 'user', 1))
      ).status,
    ).toBe(200);

    // Suspend userNormal
    const susRes = await request(app)
      .post(`/api/v1/admin/users/${userNormal}/suspend`)
      .set(as(adminA, 'admin'))
      .send({ reason: 'Confirmed abuse during beta test' });
    expect(susRes.status).toBe(200);
    expect(susRes.body.data.session_epoch).toBe(1);

    // Double suspend -> 409
    expect(
      (
        await request(app)
          .post(`/api/v1/admin/users/${userNormal}/suspend`)
          .set(as(adminA, 'admin'))
          .send({ reason: 'Already suspended test' })
      ).status,
    ).toBe(409);

    // Existing token blocked with 403 ACCOUNT_SUSPENDED
    const meSuspended = await request(app)
      .get('/api/v1/auth/me')
      .set(as(userNormal, 'user', 0));
    expect(meSuspended.status).toBe(403);
    expect(meSuspended.body.error.code).toBe('ACCOUNT_SUSPENDED');
    expect(meSuspended.body.error.message).toBe('This account is suspended. Contact support@juanderquest.app.');

    // Sign-in blocked with 403 ACCOUNT_SUSPENDED
    const loginBlocked = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'juan@gmail.com', password: 'SecretPass123!' });
    expect(loginBlocked.status).toBe(403);
    expect(loginBlocked.body.error.code).toBe('ACCOUNT_SUSPENDED');

    // Push device disabled
    const devRow = (
      await fixture.pool.query('SELECT disabled_at, disabled_reason FROM user_devices WHERE user_id=$1', [userNormal])
    ).rows[0];
    expect(devRow.disabled_at).toBeTruthy();
    expect(devRow.disabled_reason).toBe('suspended');

    // Unauthenticated public reads remain unaffected
    expect((await request(app).get('/api/v1/spots?limit=5')).status).toBe(200);

    // Unsuspend -> audit row + login succeeds
    const unRes = await request(app)
      .post(`/api/v1/admin/users/${userNormal}/unsuspend`)
      .set(as(adminA, 'admin'))
      .send({ reason: 'Appeal approved after review' });
    expect(unRes.status).toBe(200);

    const loginOk = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'juan@gmail.com', password: 'SecretPass123!' });
    expect(loginOk.status).toBe(200);
    expect(loginOk.body.data.token).toBeTruthy();
    expect(
      (await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${loginOk.body.data.token}`)).status,
    ).toBe(200);

    // Check every admin write created an admin_audit_log entry
    const audits = (
      await fixture.pool.query(`SELECT action FROM admin_audit_log WHERE subject_id = $1`, [userNormal])
    ).rows.map((r) => r.action);
    expect(audits).toEqual(expect.arrayContaining(['user.view', 'user.suspend', 'user.unsuspend']));
  });

  it('reconciles economy monitor totals against daily series, sources, and ledger rows', async () => {
    const defId = `ach-p117-${suffix}`;
    const awardId1 = randomUUID();
    const awardId2 = randomUUID();
    const cmdId = `cmd-${randomUUID()}`;
    const manilaToday = new Date().toISOString().slice(0, 10);

    await fixture.pool.query(
      `INSERT INTO achievement_definitions (id, track, title, description, badge_icon, threshold)
       VALUES ($1, 'explorer', 'Plan 117 Explorer Badge', 'Test badge', 'compass', 1)`,
      [defId],
    );
    await fixture.pool.query(
      `INSERT INTO achievement_awards (id, user_id, achievement_id, season, is_test)
       VALUES ($1, $2, $3, 'all_time', FALSE), ($4, $5, $3, 's-rev', FALSE)`,
      [awardId1, userNormal, defId, awardId2, userAccent],
    );
    await fixture.pool.query(
      `UPDATE achievement_awards SET revoked_at = NOW(), revocation_reason = 'Test revoke' WHERE id = $1`,
      [awardId2],
    );
    await fixture.pool.query(
      `INSERT INTO chain_commands (id, chain_id, entitlement_id, operation, recipient_address, source_award_id, status, expected_token_id)
       VALUES ($1, $2, $3, 'badge_claim', '0x1111111111111111111111111111111111111111', $4, 'finalized', 42)`,
      [cmdId, env.CHAIN_ID, '0x' + 'a'.repeat(64), awardId1],
    );

    // Seed points (+120 issued, -30 spent for real user + 999 test user excluded by default)
    await fixture.pool.query(
      `INSERT INTO governance_ledger (id, transaction_group_id, type, account, amount_mjdq, reference_type, reference_id, actor_id, metadata)
       VALUES
         ($1::text, $1::text, 'quest_reward_credit', $2::text, 120000, 'quest', 'q1', $2::text, '{"reason":"Quest done"}'::jsonb),
         ($3::text, $3::text, 'voucher_redemption_debit', $2::text, -30000, 'voucher', 'v1', $2::text, '{"reason":"Voucher redeem"}'::jsonb),
         ($4::text, $4::text, 'quest_reward_credit', $5::text, 999000, 'quest', 'q1', $5::text, '{"reason":"Test row"}'::jsonb)`,
      [`gl-1-${suffix}`, userNormal, `gl-2-${suffix}`, `gl-t-${suffix}`, userTest],
    );

    // Seed stamps (+12 issued, -4 spent + test excluded)
    await fixture.pool.query(
      `INSERT INTO stamp_ledger (user_id, delta, source, source_key, manila_date, week_id, reason, is_test)
       VALUES
         ($1, 12, 'daily_login', $2, $3::date, '2026-W47', 'Daily reward', FALSE),
         ($1, -4, 'raffle_entry', $4, $3::date, '2026-W47', 'Raffle', FALSE),
         ($5, 77, 'daily_login', $6, $3::date, '2026-W47', 'Test stamp', TRUE)`,
      [userNormal, `sk-1-${suffix}`, manilaToday, `sk-2-${suffix}`, userTest, `sk-t-${suffix}`],
    );

    // Seed XP (+350 explorer XP)
    await fixture.pool.query(
      `INSERT INTO progression_events (id, user_id, track, delta, source_type, source_id, award_kind, rule_version, is_test)
       VALUES ($1, $2, 'explorer', 350, 'verified_visit', $3, 'xp', 'v1', FALSE),
              ($4, $5, 'explorer', 888, 'verified_visit', $6, 'xp', 'v1', TRUE)`,
      [randomUUID(), userNormal, `vs-${suffix}`, randomUUID(), userTest, `vt-${suffix}`],
    );

    // Seed admin point grant
    await fixture.pool.query(
      `INSERT INTO admin_point_grants (id, user_id, points, reason, admin_id, idempotency_key, ledger_group_id, balance_after, anchor_hash, is_test)
       VALUES ($1, $2, 250, 'Monitor grant test', $3, $4, $4, 400, $5, FALSE)`,
      [`apg-${suffix}`, userNormal, adminA, `ik-${suffix}`, '0x' + '1'.repeat(64)],
    );

    const monRes = await request(app).get('/api/v1/admin/economy/monitor?days=7').set(as(adminA, 'admin'));
    expect(monRes.status).toBe(200);
    const { totals, daily_series, issuance_by_source, window } = monRes.body.data;

    expect(totals.points_issued).toBe(120);
    expect(totals.points_spent).toBe(30);
    expect(totals.stamps_issued).toBe(12);
    expect(totals.stamps_spent).toBe(4);
    expect(totals.explorer_xp_awarded).toBe(350);
    expect(totals.badges_awarded).toBe(2);
    expect(totals.badges_revoked).toBe(1);
    expect(totals.admin_point_grants_count).toBe(1);
    expect(totals.admin_point_grants_sum).toBe(250);

    // Daily series sum equals totals
    expect(daily_series.reduce((s: number, d: any) => s + d.points_issued, 0)).toBe(totals.points_issued);
    expect(daily_series.reduce((s: number, d: any) => s + d.stamps_issued, 0)).toBe(totals.stamps_issued);
    expect(daily_series.reduce((s: number, d: any) => s + d.explorer_xp_awarded, 0)).toBe(totals.explorer_xp_awarded);
    expect(daily_series.reduce((s: number, d: any) => s + d.badges_awarded, 0)).toBe(totals.badges_awarded);
    expect(daily_series.reduce((s: number, d: any) => s + d.badges_revoked, 0)).toBe(totals.badges_revoked);

    // Issuance by source sum equals totals
    expect(issuance_by_source.points.reduce((s: number, r: any) => s + r.issued, 0)).toBe(totals.points_issued);
    expect(issuance_by_source.stamps.reduce((s: number, r: any) => s + r.issued, 0)).toBe(totals.stamps_issued);

    // Ledger sum in exact window equals totals
    const pointsLedg = await request(app)
      .get('/api/v1/admin/economy/ledger')
      .query({ kind: 'points', from: window.from, to: window.to, limit: 100 })
      .set(as(adminA, 'admin'));
    expect(pointsLedg.status).toBe(200);
    const ptsIn = pointsLedg.body.data.items
      .filter((i: any) => i.delta > 0)
      .reduce((s: number, i: any) => s + i.delta, 0);
    const ptsOut = pointsLedg.body.data.items
      .filter((i: any) => i.delta < 0)
      .reduce((s: number, i: any) => s + -i.delta, 0);
    expect(ptsIn).toBe(totals.points_issued);
    expect(ptsOut).toBe(totals.points_spent);

    // Badges summary shows award/revoked/minted_on_chain_count
    const badgesRes = await request(app).get('/api/v1/admin/badges').set(as(adminA, 'admin'));
    expect(badgesRes.status).toBe(200);
    const badgeRow = badgesRes.body.data.items.find((b: any) => b.id === defId);
    expect(badgeRow).toMatchObject({ award_count: 1, revoked_count: 1, minted_on_chain_count: 1 });
  });

  it('triggers each of the 8 risk rules at threshold (and not at threshold-1), prevents duplicates, enforces advisory lock, and audits review/scan', async () => {
    const fixedNow = new Date('2026-11-23T12:00:00.000Z');
    const createUser = async (tag: string, createdAt = new Date('2026-11-01T00:00:00Z')) => {
      const id = `r117-${tag}-${suffix}`;
      await fixture.pool.query(
        `INSERT INTO users (id, seed_id, display_name, email, role, created_at)
         VALUES ($1::text, $1::text, $2::text, $1::text || '@risk.test', 'user', $3::timestamptz)`,
        [id, `Risk ${tag}`, createdAt],
      );
      return id;
    };

    // 1. stamp_spike: below (49 with 0 median OR 50 with 10 median), vs hit (51 with 10 median -> medium, 200 -> high)
    const uStampLow = await createUser('st-low');
    const uStampHit = await createUser('st-hit');
    for (let d = 1; d <= 3; d++) {
      const ts = new Date(fixedNow.getTime() - (d + 2) * 86_400_000);
      await fixture.pool.query(
        `INSERT INTO stamp_ledger (user_id, delta, source, source_key, manila_date, week_id, created_at)
         VALUES ($1::text, 10, 'quest', $2::text, $3::date, 'w', $4::timestamptz), ($5::text, 10, 'quest', $6::text, $3::date, 'w', $4::timestamptz)`,
        [uStampLow, `b-l-${d}`, ts.toISOString().slice(0, 10), ts, uStampHit, `b-h-${d}`],
      );
    }
    await fixture.pool.query(
      `INSERT INTO stamp_ledger (user_id, delta, source, source_key, manila_date, week_id, created_at)
       VALUES ($1::text, 50, 'quest', 'now-l', '2026-11-23', 'w', $3::timestamptz), ($2::text, 200, 'quest', 'now-h', '2026-11-23', 'w', $3::timestamptz)`,
      [uStampLow, uStampHit, new Date(fixedNow.getTime() - 3600_000)],
    );

    // 2. points_spike: 499 vs 500
    const uPtsLow = await createUser('pt-low');
    const uPtsHit = await createUser('pt-hit');
    await fixture.pool.query(
      `INSERT INTO governance_ledger (id, transaction_group_id, type, account, amount_mjdq, reference_type, reference_id, actor_id, created_at)
       VALUES ($1::text, $1::text, 'reward', $2::text, 499000, 'quest', 'q', $2::text, $5::timestamptz),
              ($3::text, $3::text, 'reward', $4::text, 500000, 'quest', 'q', $4::text, $5::timestamptz)`,
      [randomUUID(), uPtsLow, randomUUID(), uPtsHit, new Date(fixedNow.getTime() - 3600_000)],
    );

    // 3. impossible_travel: spot A (16.0, 120.0) & spot B (~100km north: 16.9, 120.0). 10 min -> 600 km/h (fires); 30 min -> 200 km/h (no fire)
    const uTrvLow = await createUser('trv-low');
    const uTrvHit = await createUser('trv-hit');
    const qTravel = `q-trv-${suffix}`;
    const qTravel2 = `q-trv2-${suffix}`;
    const spA = `sp-trv-a-${suffix}`;
    const spB = `sp-trv-b-${suffix}`;
    await fixture.pool.query(
      `INSERT INTO quests (id, title, description, category, location_name, gps_lat, gps_lng, marker_code, marker_image_url)
       VALUES ($1::text, 'Travel Quest', 'Desc', 'eco', 'Loc', 16.0, 120.0, $2::text, 'http://x/m.png'),
              ($3::text, 'Travel Quest 2', 'Desc', 'eco', 'Loc 2', 16.9, 120.0, $4::text, 'http://x/m2.png')`,
      [qTravel, `m-${suffix}`, qTravel2, `m2-${suffix}`],
    );
    await fixture.pool.query(
      `INSERT INTO spots (id, slug, name, description, category, subcategory, municipality, address, gps_lat, gps_lng, source_type, source_name, created_by)
       VALUES
         ($1::text, $1::text, 'Spot A', 'D', 'nature', 'beach', 'Alaminos', 'Addr', 16.0, 120.0, 'community', 'Test', $3::text),
         ($2::text, $2::text, 'Spot B', 'D', 'nature', 'beach', 'Bolinao', 'Addr', 16.9, 120.0, 'community', 'Test', $3::text)`,
      [spA, spB, uTrvLow],
    );
    await fixture.pool.query(
      `INSERT INTO submissions (id, idempotency_key, user_id, quest_id, scanned_marker_code, captured_lat, captured_lng, captured_accuracy, status, created_at)
       VALUES
         ($1::text, $1::text, $5::text, $7::text, 'm', 16.0, 120.0, 5, 'approved', $9::timestamptz),
         ($2::text, $2::text, $5::text, $8::text, 'm2', 16.9, 120.0, 5, 'approved', $10::timestamptz),
         ($3::text, $3::text, $6::text, $7::text, 'm', 16.0, 120.0, 5, 'approved', $9::timestamptz),
         ($4::text, $4::text, $6::text, $8::text, 'm2', 16.9, 120.0, 5, 'approved', $11::timestamptz)`,
      [
        `sub-l1-${suffix}`,
        `sub-l2-${suffix}`,
        `sub-h1-${suffix}`,
        `sub-h2-${suffix}`,
        uTrvLow,
        uTrvHit,
        qTravel,
        qTravel2,
        new Date(fixedNow.getTime() - 40 * 60_000),
        new Date(fixedNow.getTime() - 10 * 60_000), // 30m -> 200 km/h
        new Date(fixedNow.getTime() - 30 * 60_000), // 10m -> 600 km/h
      ],
    );

    // 4. gps_fail_burst: 14 vs 15
    const uGpsLow = await createUser('gps-low');
    const uGpsHit = await createUser('gps-hit');
    const attL = `att-l-${suffix}`;
    const attH = `att-h-${suffix}`;
    await fixture.pool.query(
      `INSERT INTO quest_attempts (id, quest_id, user_id, status) VALUES ($1, $3, $2, 'in_progress'), ($4, $3, $5, 'in_progress')`,
      [attL, uGpsLow, qTravel, attH, uGpsHit],
    );
    await fixture.pool.query(
      `INSERT INTO quest_step_evidence (id, attempt_id, quest_id, user_id, step_order, checkpoint_type, title, failed_tries, updated_at)
       VALUES ($1, $2, $3, $4, 1, 'location', 'Loc Step', 14, $7),
              ($5, $6, $3, $8, 1, 'qr', 'QR Step', 15, $7)`,
      [randomUUID(), attL, qTravel, uGpsLow, randomUUID(), attH, new Date(fixedNow.getTime() - 10 * 60_000), uGpsHit],
    );

    // 5. proof_rejections: 4 vs 5
    const uRejLow = await createUser('rej-low');
    const uRejHit = await createUser('rej-hit');
    for (let i = 0; i < 4; i++) {
      await fixture.pool.query(
        `INSERT INTO submissions (id, idempotency_key, user_id, quest_id, scanned_marker_code, captured_lat, captured_lng, captured_accuracy, status, reviewed_at, created_at)
         VALUES ($1::text, $1::text, $2::text, $3::text, 'm', 16, 120, 5, 'rejected', $4::timestamptz, $4::timestamptz)`,
        [randomUUID(), uRejLow, qTravel, new Date(fixedNow.getTime() - 86_400_000)],
      );
    }
    for (let i = 0; i < 5; i++) {
      await fixture.pool.query(
        `INSERT INTO submissions (id, idempotency_key, user_id, quest_id, scanned_marker_code, captured_lat, captured_lng, captured_accuracy, status, reviewed_at, created_at)
         VALUES ($1::text, $1::text, $2::text, $3::text, 'm', 16, 120, 5, 'rejected', $4::timestamptz, $4::timestamptz)`,
        [randomUUID(), uRejHit, qTravel, new Date(fixedNow.getTime() - 86_400_000)],
      );
    }

    // 6. report_target: 2 distinct reporters vs 3 distinct (6 for high)
    const uRepLow = await createUser('rep-low');
    const uRepMed = await createUser('rep-med');
    const reporters = await Promise.all(Array.from({ length: 5 }, (_, i) => createUser(`repby-${i}`)));
    for (let i = 0; i < 2; i++) {
      await fixture.pool.query(
        `INSERT INTO avatar_reports (avatar_url, user_id, reporter_id, reason, created_at)
         VALUES ('http://x/a.png', $1, $2, 'spam', $3)`,
        [uRepLow, reporters[i], new Date(fixedNow.getTime() - 3600_000)],
      );
    }
    for (let i = 0; i < 3; i++) {
      await fixture.pool.query(
        `INSERT INTO avatar_reports (avatar_url, user_id, reporter_id, reason, created_at)
         VALUES ('http://x/b.png', $1, $2, 'spam', $3)`,
        [uRepMed, reporters[i], new Date(fixedNow.getTime() - 3600_000)],
      );
    }

    // 7. vote_burst: 9 young accounts on candidate A (no fire) vs 10 young accounts on candidate B (fires high per account)
    const campId = randomUUID();
    const candLow = randomUUID();
    const candHit = randomUUID();
    const spCandLow = `sp-cand-l-${suffix}`;
    const spCandHit = `sp-cand-h-${suffix}`;
    await fixture.pool.query(
      `INSERT INTO spots (id, slug, name, description, category, subcategory, municipality, address, gps_lat, gps_lng, source_type, source_name)
       VALUES ($1::text, $1::text, 'Cand Low', 'D', 'nature', 'beach', 'Bolinao', 'A', 16.3, 119.9, 'community', 'T'),
              ($2::text, $2::text, 'Cand Hit', 'D', 'nature', 'beach', 'Bolinao', 'A', 16.4, 119.9, 'community', 'T')`,
      [spCandLow, spCandHit],
    );
    await fixture.pool.query(
      `INSERT INTO juanchoice_campaigns (id, slug, region, theme, status, opens_at, closes_at)
       VALUES ($1, $2, 'Pangasinan', 'Burst Campaign', 'voting', $3, $4)`,
      [campId, `camp-${suffix}`, new Date(fixedNow.getTime() - 86_400_000), new Date(fixedNow.getTime() + 86_400_000)],
    );
    await fixture.pool.query(
      `INSERT INTO juanchoice_candidates (id, campaign_id, spot_id, status)
       VALUES ($1, $3, $4, 'eligible'), ($2, $3, $5, 'eligible')`,
      [candLow, candHit, campId, spCandLow, spCandHit],
    );
    const youngTime = new Date(fixedNow.getTime() - 2 * 3600_000);
    const voteTime = new Date(fixedNow.getTime() - 10 * 60_000);
    for (let i = 0; i < 9; i++) {
      const voter = await createUser(`vl-${i}`, youngTime);
      await fixture.pool.query(
        `INSERT INTO juanchoice_ballots (campaign_id, user_id, candidate_id, created_at) VALUES ($1, $2, $3, $4)`,
        [campId, voter, candLow, voteTime],
      );
    }
    const burstVoters: string[] = [];
    for (let i = 0; i < 10; i++) {
      const voter = await createUser(`vh-${i}`, youngTime);
      burstVoters.push(voter);
      await fixture.pool.query(
        `INSERT INTO juanchoice_ballots (campaign_id, user_id, candidate_id, created_at) VALUES ($1, $2, $3, $4)`,
        [campId, voter, candHit, voteTime],
      );
    }

    // 8. admin_grant_large: 1999 vs 2000 in 7 days
    const uGrantLow = await createUser('gr-low');
    const uGrantHit = await createUser('gr-hit');
    await fixture.pool.query(
      `INSERT INTO admin_point_grants (id, user_id, points, reason, admin_id, idempotency_key, ledger_group_id, balance_after, anchor_hash, created_at)
       VALUES ($1::text, $2::text, 1999, 'Under cap grant', $3::text, $4::text, $4::text, 1999, $5::text, $6::timestamptz),
              ($7::text, $8::text, 1000, 'Grant 1', $3::text, $9::text, $9::text, 1000, $10::text, $6::timestamptz),
              ($11::text, $8::text, 1000, 'Grant 2', $3::text, $12::text, $12::text, 2000, $13::text, $6::timestamptz)`,
      [
        randomUUID(),
        uGrantLow,
        adminA,
        `ik-gl-${suffix}`,
        '0x' + '2'.repeat(64),
        new Date(fixedNow.getTime() - 3600_000),
        randomUUID(),
        uGrantHit,
        `ik-gh1-${suffix}`,
        '0x' + '3'.repeat(64),
        randomUUID(),
        `ik-gh2-${suffix}`,
        '0x' + '4'.repeat(64),
      ],
    );

    // Run scan 1
    const scan1 = await runRiskScan(fixture.pool, { now: fixedNow });
    expect(scan1.acquired).toBe(true);
    expect(scan1.counts_by_rule).toMatchObject({
      stamp_spike: 1,
      points_spike: 1,
      impossible_travel: 1,
      gps_fail_burst: 1,
      proof_rejections: 1,
      report_target: 1,
      vote_burst: 10,
      admin_grant_large: 1,
    });

    // Verify threshold-1 users were NOT flagged
    const flaggedUsers = new Set(
      (await fixture.pool.query('SELECT user_id, rule FROM risk_flags')).rows.map((r) => `${r.rule}:${r.user_id}`),
    );
    expect(flaggedUsers.has(`stamp_spike:${uStampHit}`)).toBe(true);
    expect(flaggedUsers.has(`stamp_spike:${uStampLow}`)).toBe(false);
    expect(flaggedUsers.has(`points_spike:${uPtsHit}`)).toBe(true);
    expect(flaggedUsers.has(`points_spike:${uPtsLow}`)).toBe(false);
    expect(flaggedUsers.has(`impossible_travel:${uTrvHit}`)).toBe(true);
    expect(flaggedUsers.has(`impossible_travel:${uTrvLow}`)).toBe(false);
    expect(flaggedUsers.has(`gps_fail_burst:${uGpsHit}`)).toBe(true);
    expect(flaggedUsers.has(`gps_fail_burst:${uGpsLow}`)).toBe(false);
    expect(flaggedUsers.has(`proof_rejections:${uRejHit}`)).toBe(true);
    expect(flaggedUsers.has(`proof_rejections:${uRejLow}`)).toBe(false);
    expect(flaggedUsers.has(`report_target:${uRepMed}`)).toBe(true);
    expect(flaggedUsers.has(`report_target:${uRepLow}`)).toBe(false);
    for (const v of burstVoters) expect(flaggedUsers.has(`vote_burst:${v}`)).toBe(true);
    expect(flaggedUsers.has(`admin_grant_large:${uGrantHit}`)).toBe(true);
    expect(flaggedUsers.has(`admin_grant_large:${uGrantLow}`)).toBe(false);

    // Run scan 2 -> zero duplicates
    const countBefore = Number((await fixture.pool.query('SELECT COUNT(*)::int AS n FROM risk_flags')).rows[0].n);
    const scan2 = await runRiskScan(fixture.pool, { now: fixedNow });
    expect(scan2.acquired).toBe(true);
    const countAfter = Number((await fixture.pool.query('SELECT COUNT(*)::int AS n FROM risk_flags')).rows[0].n);
    expect(countAfter).toBe(countBefore);

    // Advisory lock prevents concurrent scan
    let concurrentOutcome: boolean | null = null;
    const scanLocked = await runRiskScan(fixture.pool, {
      now: fixedNow,
      beforeUnlockHook: async () => {
        const c = await runRiskScan(fixture.pool, { now: fixedNow });
        concurrentOutcome = c.acquired;
      },
    });
    expect(scanLocked.acquired).toBe(true);
    expect(concurrentOutcome).toBe(false);

    // API list + review + audit log + manual scan rate limit
    const flagsList = await request(app).get('/api/v1/admin/risk/flags').set(as(adminA, 'admin'));
    expect(flagsList.status).toBe(200);
    expect(flagsList.body.data.items.length).toBeGreaterThan(0);
    // Highest severity first
    const sevOrder = flagsList.body.data.items.map((f: any) => f.severity);
    expect(sevOrder[0]).toBe('high');

    const grantFlag = flagsList.body.data.items.find(
      (f: any) => f.user_id === uGrantHit && f.rule === 'admin_grant_large',
    );
    expect(grantFlag).toBeTruthy();
    expect(flagsList.body.data.resolved_entities.users[adminA]).toBe('Admin Alpha');

    const reviewRes = await request(app)
      .post(`/api/v1/admin/risk/flags/${grantFlag.id}/review`)
      .set(as(adminA, 'admin'))
      .send({ status: 'dismissed', note: 'Approved test beta grant' });
    expect(reviewRes.status).toBe(200);
    expect(reviewRes.body.data.status).toBe('dismissed');

    // Second scan keeps reviewed status ('dismissed') intact
    await runRiskScan(fixture.pool, { now: fixedNow });
    const afterReScanStatus = (await fixture.pool.query('SELECT status FROM risk_flags WHERE id = $1', [grantFlag.id]))
      .rows[0].status;
    expect(afterReScanStatus).toBe('dismissed');

    // Audit row written for review
    const revAudit = await fixture.pool.query(
      `SELECT action FROM admin_audit_log WHERE subject_type='risk_flag' AND subject_id=$1 AND action='risk_flag.review'`,
      [grantFlag.id],
    );
    expect(revAudit.rowCount).toBe(1);

    // Manual scan endpoint works once per min then 429
    const manualScan1 = await request(app).post('/api/v1/admin/risk/scan').set(as(adminA, 'admin'));
    expect(manualScan1.status).toBe(200);
    expect(manualScan1.body.data.acquired).toBe(true);
    const manualScan2 = await request(app).post('/api/v1/admin/risk/scan').set(as(adminA, 'admin'));
    expect(manualScan2.status).toBe(429);
  });
});
