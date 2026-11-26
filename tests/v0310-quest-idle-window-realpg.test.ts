import { randomUUID } from 'crypto';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { app } from '../src/app.js';
import { db } from '../src/db/index.js';
import { env } from '../src/config/env.js';
import { setPool } from '../src/db/pool.js';
import { createTestDb, type TestDbInstance } from '../src/db/testHarness.js';
import { FundingPlansService } from '../src/funding/plans.js';
import { refreshFundingHoldOnProgress } from '../src/funding/holds.js';
import { expireIdleAttempts, sendIdleReminders } from '../src/quests/idleWindow.js';

// v0.3.10 team review: accepted quests expire after `quest_accept_idle_hours` without progress
// (migration 105), and the author's funding page gets a numeric overview (`summary`).
const realPg = process.env.JDQ_REAL_PG_URL ? describe : describe.skip;
realPg('accepted-quest idle window + funding overview (disposable PostgreSQL)', () => {
  let fixture: TestDbInstance;
  let service: FundingPlansService;
  const originalFlag = env.QUEST_FUNDING_ENABLED;
  const token = (id: string) => `Bearer ${jwt.sign({ id, seed_id: id, role: 'user', typ: 'session' }, env.JWT_SECRET)}`;
  const LAT = 16.3072;
  const LNG = 119.7891;

  async function user(id: string, points = 0) {
    await fixture.pool.query(
      "INSERT INTO users(id,seed_id,display_name,email,role,demo_points) VALUES($1,$2,$3,$4,'user',$5)",
      [id, id, id, `${id}@example.test`, points],
    );
    db.users.push({
      id,
      seed_id: id,
      display_name: id,
      email: `${id}@example.test`,
      role: 'user',
      demo_points: points,
      is_test: false,
    } as any);
  }

  async function quest(opts: { status?: string; steps?: any[]; authorId?: string } = {}) {
    const id = randomUUID();
    const questId = `idle-quest-${id}`;
    const authorId = opts.authorId ?? `idle-author-${id}`;
    if (!opts.authorId) await user(authorId, 1000);
    const steps = opts.steps ?? [
      {
        step_order: 1,
        title: 'Arrive',
        description: 'Check in.',
        checkpoint_type: 'location',
        required: true,
        gps_lat: LAT,
        gps_lng: LNG,
        radius_meters: 150,
      },
      {
        step_order: 2,
        title: 'Look around',
        description: 'Check in again.',
        checkpoint_type: 'location',
        required: true,
        gps_lat: LAT,
        gps_lng: LNG,
        radius_meters: 150,
      },
    ];
    const status = opts.status ?? 'published';
    await fixture.pool.query(
      `INSERT INTO quests(id,title,description,category,location_name,gps_lat,gps_lng,radius_meters,reward_points,
        marker_code,marker_image_url,author_id,status,version,steps,is_active)
       VALUES($1,'Idle quest','Visit','eco','Test place',$2,$3,150,50,$4,'',$5,$6,1,$7::jsonb,$8)`,
      [questId, LAT, LNG, `marker-${id}`, authorId, status, JSON.stringify(steps), status === 'published'],
    );
    db.quests.push({
      id: questId,
      title: 'Idle quest',
      description: 'Visit',
      category: 'eco',
      location_name: 'Test place',
      gps_lat: LAT,
      gps_lng: LNG,
      radius_meters: 150,
      reward_points: 50,
      marker_code: `marker-${id}`,
      marker_image_url: '',
      author_id: authorId,
      status,
      version: 1,
      steps,
      is_active: status === 'published',
      is_test: false,
    } as any);
    return { questId, authorId };
  }

  const backdate = (attemptId: string, hours: number) =>
    fixture.pool.query(`UPDATE quest_attempts SET last_progress_at=NOW()-($2::int * INTERVAL '1 hour') WHERE id=$1`, [
      attemptId,
      hours,
    ]);
  const accept = (questId: string, travelerId: string) =>
    request(app).post(`/api/v1/quests/${questId}/attempts`).set('Authorization', token(travelerId));
  const progress = (questId: string, travelerId: string) =>
    request(app).get(`/api/v1/quests/${questId}/progress`).set('Authorization', token(travelerId));

  beforeAll(async () => {
    fixture = await createTestDb();
    setPool(fixture.pool);
    db.usersRepo.setPool(fixture.pool);
    env.QUEST_FUNDING_ENABLED = true;
    service = new FundingPlansService(fixture.pool);
  });
  afterAll(async () => {
    env.QUEST_FUNDING_ENABLED = originalFlag;
    setPool(null);
    db.usersRepo.setPool(null);
    if (fixture) await fixture.close();
  });

  it('migration 105: expired attempt status, progress clock columns, quest_idle notification kind', async () => {
    const labels = await fixture.pool.query(
      "SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid WHERE t.typname='quest_attempt_status'",
    );
    expect(labels.rows.map((r) => r.enumlabel)).toEqual(
      expect.arrayContaining(['in_progress', 'submitted', 'completed', 'abandoned', 'expired']),
    );
    const cols = await fixture.pool.query(
      "SELECT column_name,is_nullable FROM information_schema.columns WHERE table_schema = current_schema() AND table_name='quest_attempts' AND column_name IN ('last_progress_at','expired_at') ORDER BY column_name",
    );
    expect(cols.rows).toEqual([
      { column_name: 'expired_at', is_nullable: 'YES' },
      { column_name: 'last_progress_at', is_nullable: 'NO' },
    ]);
    const ledger = await fixture.pool.query(
      "SELECT checksum FROM schema_migrations WHERE filename='105_quest_accept_idle_window.sql'",
    );
    expect(ledger.rows[0]?.checksum).toBeTruthy();
    const kind = await fixture.pool.query(
      "SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname='user_notifications_kind_check'",
    );
    for (const k of ['suki_reward', 'nearby_quest', 'quest_reward', 'quest_idle'])
      expect(kind.rows[0].def).toContain(k);
  });

  it('expires an idle acceptance, keeps its history, and lets the traveler accept again with a fresh window', async () => {
    const { questId } = await quest();
    const traveler = `idle-traveler-${randomUUID()}`;
    await user(traveler);
    const first = await accept(questId, traveler);
    expect(first.status).toBe(201);
    const attemptId = first.body.data.id;

    const p1 = await progress(questId, traveler);
    expect(p1.body.data.active_attempt.idle_window_hours).toBe(72);
    const expiresIn = Date.parse(p1.body.data.active_attempt.idle_expires_at) - Date.now();
    expect(expiresIn).toBeGreaterThan(71 * 3_600_000);
    expect(expiresIn).toBeLessThanOrEqual(72 * 3_600_000);

    // Progress resets the clock: 70 h idle, then a verified task.
    await backdate(attemptId, 70);
    const step = await request(app)
      .post(`/api/v1/quests/${questId}/steps/1/evidence`)
      .set('Authorization', token(traveler))
      .send({ idempotency_key: randomUUID(), captured_lat: LAT, captured_lng: LNG, captured_accuracy: 5 });
    expect(step.status).toBe(200);
    const reset = await fixture.pool.query(
      'SELECT EXTRACT(EPOCH FROM (NOW()-last_progress_at)) AS idle FROM quest_attempts WHERE id=$1',
      [attemptId],
    );
    expect(Number(reset.rows[0].idle)).toBeLessThan(60);
    expect(await expireIdleAttempts(fixture.pool, { questId })).toBe(0);

    // No further progress for 73 h: the next read expires it.
    await backdate(attemptId, 73);
    const p2 = await progress(questId, traveler);
    expect(p2.status).toBe(200);
    expect(p2.body.data.active_attempt).toBeNull();
    expect(p2.body.data.last_expired_at).toBeTruthy();
    const row = await fixture.pool.query('SELECT status,expired_at FROM quest_attempts WHERE id=$1', [attemptId]);
    expect(row.rows[0].status).toBe('expired');
    expect(row.rows[0].expired_at).toBeTruthy();
    const history = await fixture.pool.query(
      'SELECT step_order,status FROM quest_step_evidence WHERE attempt_id=$1 ORDER BY step_order',
      [attemptId],
    );
    expect(history.rows.map((r) => r.status)).toEqual(['verified', 'ready']);

    const again = await accept(questId, traveler);
    expect(again.status).toBe(201);
    expect(again.body.data.id).not.toBe(attemptId);
    const p3 = await progress(questId, traveler);
    expect(Date.parse(p3.body.data.active_attempt.idle_expires_at) - Date.now()).toBeGreaterThan(71 * 3_600_000);
  });

  it('a quest without authored steps is not subject to the idle window', async () => {
    const { questId } = await quest({ steps: [] });
    const traveler = `idle-traveler-${randomUUID()}`;
    await user(traveler);
    const started = await accept(questId, traveler);
    expect(started.status).toBe(201);
    await backdate(started.body.data.id, 500);
    expect(await expireIdleAttempts(fixture.pool, { questId })).toBe(0);
    const p = await progress(questId, traveler);
    expect(p.body.data.active_attempt.id).toBe(started.body.data.id);
    expect(p.body.data.active_attempt.idle_expires_at).toBeUndefined();
  });

  it('sends one reminder per window about 12 hours before expiry', async () => {
    const { questId } = await quest();
    const traveler = `idle-traveler-${randomUUID()}`;
    await user(traveler);
    const started = await accept(questId, traveler);
    const attemptId = started.body.data.id;
    const count = async () =>
      Number(
        (
          await fixture.pool.query("SELECT COUNT(*) FROM user_notifications WHERE user_id=$1 AND kind='quest_idle'", [
            traveler,
          ])
        ).rows[0].count,
      );
    await backdate(attemptId, 30);
    await sendIdleReminders(fixture.pool);
    expect(await count()).toBe(0);
    await backdate(attemptId, 62);
    await sendIdleReminders(fixture.pool);
    await sendIdleReminders(fixture.pool);
    expect(await count()).toBe(1);
    const note = await fixture.pool.query(
      "SELECT href,title FROM user_notifications WHERE user_id=$1 AND kind='quest_idle'",
      [traveler],
    );
    expect(note.rows[0].href).toBe(`/quests/${encodeURIComponent(questId)}`);
    // A new window (progress happened) may remind again.
    await backdate(attemptId, 61);
    await sendIdleReminders(fixture.pool);
    expect(await count()).toBe(2);
  });

  it('releases the funded reward hold of an idle acceptance and reports the numbers in the funding summary', async () => {
    const { questId, authorId } = await quest({ status: 'draft' });
    const plan = await service.create(
      authorId,
      questId,
      {
        mode: 'budget',
        planned_completions: 4,
        starts_at: new Date(Date.now() - 60_000).toISOString(),
        ends_at: new Date(Date.now() + 2 * 86_400_000).toISOString(),
      },
      randomUUID(),
    );
    await service.contribute(authorId, plan.id, 212, randomUUID());
    const active = await service.submit(authorId, plan.id, randomUUID());
    expect(active.status).toBe('active');
    const traveler = `idle-traveler-${randomUUID()}`;
    await user(traveler);
    const started = await accept(questId, traveler);
    expect(started.status).toBe(201);
    const attemptId = started.body.data.id;

    const during = await service.get(authorId, plan.id);
    expect(during.summary).toMatchObject({
      target_points: 212,
      committed_points: 212,
      held_points: 53,
      remaining_points: 159,
      cost_per_completion: 53,
      completions_left: 3,
      holds: { active: 1, pending_review: 0, paid: 0, released: 0 },
      author: { committed: 212 },
      sponsors: { committed: 0 },
    });

    await backdate(attemptId, 73);
    expect(await expireIdleAttempts(fixture.pool, { userId: traveler })).toBe(1);
    const hold = await fixture.pool.query('SELECT status,release_reason FROM quest_funding_holds WHERE attempt_id=$1', [
      attemptId,
    ]);
    expect(hold.rows[0]).toEqual({ status: 'released', release_reason: 'idle_expired' });
    const attempt = await fixture.pool.query('SELECT status FROM quest_attempts WHERE id=$1', [attemptId]);
    expect(attempt.rows[0].status).toBe('expired');

    const after = await service.get(authorId, plan.id);
    expect(after.summary).toMatchObject({
      held_points: 0,
      remaining_points: 212,
      completions_left: 4,
      holds: { active: 0, released: 1 },
    });

    // Re-accept reserves a fresh hold.
    const again = await accept(questId, traveler);
    expect(again.status).toBe(201);
    const holds = await fixture.pool.query(
      "SELECT COUNT(*) FROM quest_funding_holds WHERE plan_id=$1 AND user_id=$2 AND status='held'",
      [plan.id, traveler],
    );
    expect(Number(holds.rows[0].count)).toBe(1);

    // Progress refreshes the reservation (never shortens it, never past the round + 24 h).
    const againId = again.body.data.id;
    await fixture.pool.query("UPDATE quest_funding_holds SET expires_at=NOW()+INTERVAL '1 hour' WHERE attempt_id=$1", [
      againId,
    ]);
    await refreshFundingHoldOnProgress(fixture.pool, againId);
    const refreshed = await fixture.pool.query(
      "SELECT EXTRACT(EPOCH FROM (expires_at-NOW()))/3600 AS h FROM quest_funding_holds WHERE attempt_id=$1 AND status='held'",
      [againId],
    );
    expect(Number(refreshed.rows[0].h)).toBeGreaterThan(40);
    expect(Number(refreshed.rows[0].h)).toBeLessThanOrEqual(48.1);
  });
});
