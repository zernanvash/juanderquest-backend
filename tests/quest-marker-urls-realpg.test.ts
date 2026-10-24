import { readFileSync } from 'fs';
import { join } from 'path';
import { createTestDb, TestDbInstance } from '../src/db/testHarness.js';

const realPg = process.env.JDQ_REAL_PG_URL ? describe : describe.skip;

realPg('migration 065 quest marker URL cleanup (real PostgreSQL)', () => {
  let fixture: TestDbInstance;

  beforeAll(async () => {
    fixture = await createTestDb();
  }, 120_000);

  afterAll(async () => {
    if (fixture) await fixture.close();
  }, 30_000);

  it('runs twice and nulls only URLs under the dead JuanderQuest assets path', async () => {
    const prefix = `marker-065-${Date.now()}`;
    const deadUrl = 'https://raw.githubusercontent.com/JuanderQuest/assets/main/markers/test.png';
    const otherOwnerUrl = 'https://raw.githubusercontent.com/OtherOrg/assets/main/markers/test.png';
    const validUrl = 'https://images.example.test/marker.png';

    await fixture.pool.query(
      `INSERT INTO quests
         (id, title, description, category, location_name, gps_lat, gps_lng, marker_code, marker_image_url)
       VALUES
         ($1, 'Dead marker', 'test', 'eco', 'Test place', 15, 120, $2, $3),
         ($4, 'Other repository', 'test', 'eco', 'Test place', 15, 120, $5, $6),
         ($7, 'Valid marker', 'test', 'eco', 'Test place', 15, 120, $8, $9)`,
      [
        `${prefix}-dead`, `${prefix}-dead-code`, deadUrl,
        `${prefix}-other`, `${prefix}-other-code`, otherOwnerUrl,
        `${prefix}-valid`, `${prefix}-valid-code`, validUrl,
      ],
    );

    const migration = readFileSync(join(process.cwd(), 'migrations', '065_quest_marker_urls.sql'), 'utf8');
    await fixture.pool.query(migration);
    await fixture.pool.query(migration);

    const { rows } = await fixture.pool.query(
      'SELECT id, marker_image_url FROM quests WHERE id = ANY($1::text[]) ORDER BY id',
      [[`${prefix}-dead`, `${prefix}-other`, `${prefix}-valid`]],
    );
    expect(rows).toEqual([
      { id: `${prefix}-dead`, marker_image_url: null },
      { id: `${prefix}-other`, marker_image_url: otherOwnerUrl },
      { id: `${prefix}-valid`, marker_image_url: validUrl },
    ]);
  });
});
