import { randomUUID } from 'crypto';
import { createTestDb, type TestDbInstance } from '../src/db/testHarness.js';
import { runRetention } from '../src/jobs/retention.js';

// Plan 116 §6.5: the retention job deletes only old, finished rows.
const realPg = process.env.JDQ_REAL_PG_URL ? describe : describe.skip;

realPg('retention job (isolated real PostgreSQL)', () => {
  let fixture: TestDbInstance;
  const userId = `ret-${randomUUID()}`;

  beforeAll(async () => {
    fixture = await createTestDb();
    const q = (sql: string, params: unknown[] = []) => fixture.pool.query(sql, params);
    await q('INSERT INTO users(id,seed_id,display_name,email,role) VALUES($1,$2,$3,$4,$5)', [
      userId,
      userId,
      'Ret',
      `${userId}@example.test`,
      'user',
    ]);
    const push = (id: string, status: string, ageDays: number) =>
      q(
        `INSERT INTO push_deliveries(id,user_id,category,collapse_key,title,body,href,status,created_at)
         VALUES($1,$2,'social',$1,'t','b','/',$3,now() - make_interval(days => $4))`,
        [id, userId, status, ageDays],
      );
    await push('p-old-sent', 'sent', 120);
    await push('p-old-queued', 'queued', 120);
    await push('p-new-sent', 'sent', 10);
    const challenge = (id: string, expiredDaysAgo: number) =>
      q(
        `INSERT INTO auth_challenges(id,purpose,target_identifier,code_hash,expires_at)
         VALUES($1,'signup_verify','x@example.test','h',now() - make_interval(days => $2))`,
        [id, expiredDaysAgo],
      );
    await challenge('c-old', 40);
    await challenge('c-recent', 5);
    const mail = (id: string, status: string, ageDays: number) =>
      q(
        `INSERT INTO auth_mail_outbox(id,recipient_email,template_type,status,created_at)
         VALUES($1,'x@example.test','signup_otp',$2,now() - make_interval(days => $3))`,
        [id, status, ageDays],
      );
    await mail('m-old-sent', 'sent', 40);
    await mail('m-old-pending', 'pending', 40);
    await mail('m-new-failed', 'failed', 3);
  });

  afterAll(async () => {
    await fixture?.close();
  });

  test('dry run counts without deleting, then a real run removes exactly the due rows', async () => {
    const dry = await runRetention(fixture.pool, { dryRun: true });
    expect(dry).toEqual([
      { table: 'push_deliveries', due: 1, deleted: 0 },
      { table: 'auth_challenges', due: 1, deleted: 0 },
      { table: 'auth_mail_outbox', due: 1, deleted: 0 },
    ]);
    const live = await runRetention(fixture.pool);
    expect(live.map((r) => r.deleted)).toEqual([1, 1, 1]);
    const ids = async (table: string) =>
      (await fixture.pool.query(`SELECT id FROM ${table} ORDER BY id`)).rows.map((r) => r.id);
    expect(await ids('push_deliveries')).toEqual(['p-new-sent', 'p-old-queued']);
    expect(await ids('auth_challenges')).toEqual(['c-recent']);
    expect(await ids('auth_mail_outbox')).toEqual(['m-new-failed', 'm-old-pending']);
    expect((await runRetention(fixture.pool)).map((r) => r.due)).toEqual([0, 0, 0]);
  });
});
