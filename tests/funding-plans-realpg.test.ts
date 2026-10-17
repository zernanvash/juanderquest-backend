import { randomUUID } from 'crypto';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { app } from '../src/app.js';
import { db } from '../src/db/index.js';
import { env } from '../src/config/env.js';
import { setPool } from '../src/db/pool.js';
import { createTestDb, type TestDbInstance } from '../src/db/testHarness.js';
import { FundingPlansService } from '../src/funding/plans.js';
import { startFundedAttempt } from '../src/funding/holds.js';
import { runFundingScheduler } from '../src/funding/scheduler.js';
import { submissionsService } from '../src/services/submissions.js';

const realPg = process.env.JDQ_REAL_PG_URL ? describe : describe.skip;
realPg('author-funded Eco-Quest lifecycle (disposable PostgreSQL)', () => {
  let fixture: TestDbInstance;
  let service: FundingPlansService;
  const originalFlag = env.QUEST_FUNDING_ENABLED;
  const originalMarkerFlag = env.ALLOW_LEGACY_MARKER_PROOF;
  const adminId = `funding-admin-${randomUUID()}`;
  const token = (id: string, role = 'user') => `Bearer ${jwt.sign({ id, seed_id: id, role }, env.JWT_SECRET)}`;

  async function user(id: string, points = 0, role = 'user') {
    await fixture.pool.query('INSERT INTO users(id,seed_id,display_name,email,role,demo_points) VALUES($1,$2,$3,$4,$5,$6)', [id,id,id,`${id}@example.test`,role,points]);
    db.users.push({ id, seed_id: id, display_name: id, email: `${id}@example.test`, role, demo_points: points, is_test: false } as any);
  }
  async function setup(mode: 'budget' | 'window', completions: number, contribution: number) {
    const id = randomUUID(), authorId = `author-${id}`, questId = `quest-${id}`;
    await user(authorId, 1000);
    const steps = [{ step_order: 1, title: 'Arrive', description: 'Visit the place.', checkpoint_type: 'location', required: true }];
    await fixture.pool.query(
      `INSERT INTO quests(id,title,description,category,location_name,gps_lat,gps_lng,radius_meters,reward_points,
        marker_code,marker_image_url,author_id,status,version,steps,is_active)
       VALUES($1,'Funded quest','Visit the place','eco','Test destination',16,120,100,50,$2,'',$3,'draft',1,$4::jsonb,false)`,
      [questId, `marker-${id}`, authorId, JSON.stringify(steps)]);
    db.quests.push({ id: questId, title: 'Funded quest', description: 'Visit', category: 'eco', location_name: 'Test',
      gps_lat: 16, gps_lng: 120, radius_meters: 100, reward_points: 50, marker_code: `marker-${id}`,
      marker_image_url: '', author_id: authorId, status: 'draft', version: 1, steps, is_active: false, is_test: false } as any);
    const travelers = Array.from({ length: 5 }, (_, i) => `traveler-${id}-${i}`);
    for (const traveler of travelers) await user(traveler);
    const plan = await service.create(authorId, questId, { mode, planned_completions: completions,
      starts_at: new Date(Date.now()-60_000).toISOString(), ends_at: new Date(Date.now()+2*86_400_000).toISOString() }, randomUUID());
    await service.contribute(authorId, plan.id, contribution, randomUUID());
    const submitted = await service.submit(authorId, plan.id, randomUUID());
    return { plan: submitted, authorId, questId, travelers };
  }
  async function submitAttempt(questId: string, travelerId: string, attemptId: string) {
    await fixture.pool.query("UPDATE quest_step_evidence SET status='verified' WHERE attempt_id=$1", [attemptId]);
    const result = await request(app).post(`/api/v1/quests/${questId}/submit-for-review`).set('Authorization',token(travelerId));
    expect(result.status).toBe(200);
  }
  beforeAll(async () => {
    fixture = await createTestDb();
    setPool(fixture.pool); db.usersRepo.setPool(fixture.pool);
    env.QUEST_FUNDING_ENABLED = true; env.ALLOW_LEGACY_MARKER_PROOF = true;
    service = new FundingPlansService(fixture.pool);
    await user(adminId, 0, 'admin');
  });
  afterAll(async () => {
    env.QUEST_FUNDING_ENABLED = originalFlag; env.ALLOW_LEGACY_MARKER_PROOF = originalMarkerFlag;
    setPool(null); db.usersRepo.setPool(null);
    if (fixture) await fixture.close();
  });

  it('locks a fixed budget, pays three completions without issuance, and refunds the exact remainder', async () => {
    const { plan, authorId, questId, travelers } = await setup('budget', 4, 212);
    expect(plan.status).toBe('active');
    for (const travelerId of travelers.slice(0,3)) {
      const started = await request(app).post(`/api/v1/quests/${questId}/attempts`).set('Authorization',token(travelerId));
      expect(started.status).toBe(201);
      await submitAttempt(questId, travelerId, started.body.data.id);
      const approved = await request(app).patch(`/api/v1/admin/quest-attempts/${started.body.data.id}`)
        .set('Authorization',token(adminId,'admin')).send({ action: 'approve' });
      expect(approved.status).toBe(200);
      expect(approved.body.data.awarded_points).toBe(50);
    }
    const closed = await service.close(authorId, plan.id, randomUUID());
    expect(closed.status).toBe('closed');
    const balance = await fixture.pool.query('SELECT demo_points FROM users WHERE id=$1', [authorId]);
    expect(balance.rows[0].demo_points).toBe(841);
    const contribution = await fixture.pool.query('SELECT * FROM quest_funding_contributions WHERE plan_id=$1', [plan.id]);
    expect(contribution.rows[0]).toMatchObject({ paid_reward_points:'150', paid_fee_points:'9', refunded_points:'53', remaining_points:'0', held_points:'0' });
    const issuance = await fixture.pool.query("SELECT 1 FROM governance_ledger WHERE account='reward_issuance' AND metadata->>'quest_id'=$1", [questId]);
    expect(issuance.rows).toHaveLength(0);
    const retry = await request(app).post(`/api/v1/quests/${questId}/attempts`).set('Authorization',token(travelers[0]));
    expect(retry.status).toBe(409); expect(retry.body.error.code).toBe('ALREADY_COMPLETED');
  });

  it('reserves the last fixed-budget slot exactly once across concurrent travelers', async () => {
    const { plan, questId, travelers } = await setup('budget',1,53);
    const results = await Promise.allSettled(travelers.map(id => startFundedAttempt(fixture.pool,questId,id)));
    expect(results.filter(row => row.status === 'fulfilled')).toHaveLength(1);
    const holds = await fixture.pool.query("SELECT COUNT(*)::int AS count FROM quest_funding_holds WHERE plan_id=$1 AND status='held'", [plan.id]);
    expect(holds.rows[0].count).toBe(1);
  });

  it('holds from live balances in window mode and refuses a start after the funder spends its balance', async () => {
    const { plan, authorId, questId, travelers } = await setup('window',2,106);
    const before = await fixture.pool.query('SELECT demo_points FROM users WHERE id=$1', [authorId]);
    expect(before.rows[0].demo_points).toBe(1000);
    await startFundedAttempt(fixture.pool,questId,travelers[0]);
    const after = await fixture.pool.query('SELECT demo_points FROM users WHERE id=$1', [authorId]);
    expect(after.rows[0].demo_points).toBe(947);
    await fixture.pool.query('UPDATE users SET demo_points=0 WHERE id=$1', [authorId]);
    await expect(startFundedAttempt(fixture.pool,questId,travelers[1])).rejects.toMatchObject({ code:'QUEST_FUNDING_UNAVAILABLE' });
    expect((await service.get(authorId,plan.id)).status).toBe('active');
  });

  it('releases expired unsubmitted holds but retains submitted holds until review', async () => {
    const { plan, authorId, questId, travelers } = await setup('budget',2,106);
    const first = await startFundedAttempt(fixture.pool,questId,travelers[0]);
    const second = await startFundedAttempt(fixture.pool,questId,travelers[1]);
    await submitAttempt(questId,travelers[1],second!.attempt.id);
    await fixture.pool.query("UPDATE quest_funding_holds SET expires_at=NOW()-INTERVAL '1 hour' WHERE plan_id=$1", [plan.id]);
    await runFundingScheduler(fixture.pool);
    const holds = await fixture.pool.query('SELECT attempt_id,status FROM quest_funding_holds WHERE plan_id=$1', [plan.id]);
    expect(holds.rows.find(row => row.attempt_id===first!.attempt.id).status).toBe('released');
    expect(holds.rows.find(row => row.attempt_id===second!.attempt.id).status).toBe('held');
    const approved = await request(app).patch(`/api/v1/admin/quest-attempts/${second!.attempt.id}`)
      .set('Authorization',token(adminId,'admin')).send({action:'approve'});
    expect(approved.status).toBe(200);
    expect((await service.get(authorId,plan.id)).status).toBe('closed');
  });

  it('keeps a rejected proof hold for resubmission and settles the legacy proof review path only once', async () => {
    const { plan, questId, travelers } = await setup('budget',1,53);
    const started = await startFundedAttempt(fixture.pool,questId,travelers[0]);
    const quest = db.quests.find(q=>q.id===questId)!;
    const proof = () => submissionsService.createSubmission({ quest_id:questId,user_id:travelers[0],idempotency_key:randomUUID(),
      scanned_marker_code:quest.marker_code,captured_lat:16,captured_lng:120,captured_accuracy:5 });
    const first = await proof(); expect(first.success).toBe(true);
    const rejected = await request(app).patch(`/api/v1/admin/submissions/${first.data!.id}`)
      .set('Authorization',token(adminId,'admin')).send({action:'reject',rejection_reason:'Please capture a clearer proof.'});
    expect(rejected.status).toBe(200);
    const held = await fixture.pool.query('SELECT status FROM quest_funding_holds WHERE attempt_id=$1',[started!.attempt.id]);
    expect(held.rows[0].status).toBe('held');
    const second = await proof(); expect(second.success).toBe(true);
    const approved = await request(app).patch(`/api/v1/admin/submissions/${second.data!.id}`)
      .set('Authorization',token(adminId,'admin')).send({action:'approve'});
    expect(approved.status).toBe(200); expect(approved.body.data.awarded_points).toBe(50);
    const balance = await fixture.pool.query('SELECT demo_points FROM users WHERE id=$1',[travelers[0]]);
    expect(balance.rows[0].demo_points).toBe(50);
    expect((await fixture.pool.query('SELECT status FROM quest_funding_holds WHERE plan_id=$1',[plan.id])).rows[0].status).toBe('paid');
  });

  it('expires an underfunded pending round and refunds its locked contribution', async () => {
    const { plan, authorId } = await setup('budget',2,53);
    expect(plan.status).toBe('pending_sponsors');
    await fixture.pool.query("UPDATE quest_funding_plans SET sponsorship_deadline=NOW()-INTERVAL '1 hour' WHERE id=$1",[plan.id]);
    await runFundingScheduler(fixture.pool);
    expect((await service.get(authorId,plan.id)).status).toBe('expired');
    expect((await fixture.pool.query('SELECT demo_points FROM users WHERE id=$1',[authorId])).rows[0].demo_points).toBe(1000);
  });
});
