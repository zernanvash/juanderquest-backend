import { createTestDb, type TestDbInstance } from '../src/db/testHarness.js';
import { loadWeeklyTrendFacts, runWeeklyTrailTrends } from '../src/trails/jobs/weeklyTrends.js';

const describeRealPg = process.env.JDQ_REAL_PG_URL ? describe : describe.skip;

describeRealPg('Weekly trail trend job (isolated real PostgreSQL schema; mocked/no NIM)', () => {
  let fixture: TestDbInstance;
  const runAt = new Date('2026-10-18T17:05:00.000Z'); // Monday 01:05 Manila.
  const eventAt = new Date('2026-10-18T16:00:00.000Z');
  const actorId = 'trail-weekly-actor';
  const spotIds = Array.from({ length: 20 }, (_value, index) => `trail-weekly-${index + 1}`);

  beforeAll(async () => {
    fixture = await createTestDb();
    await fixture.pool.query(`INSERT INTO admin_areas
      (id,level,name,display_name,label_lat,label_lng,bbox,has_boundary)
      VALUES ('trail-weekly-province','province','Test Province','Test Province',16,120,ARRAY[119,15,121,17],FALSE),
             ('trail-weekly-town','town','Lingayen','Lingayen, Test Province',16,120,ARRAY[119,15,121,17],FALSE)`);
    await fixture.pool.query(`UPDATE admin_areas SET parent_id='trail-weekly-province' WHERE id='trail-weekly-town'`);
    await fixture.pool.query(`INSERT INTO users (id,seed_id,display_name,email,role,is_test)
      VALUES ($1,'trail-weekly-actor','Trail Weekly Actor','trail-weekly-actor@example.test','user',FALSE)`, [actorId]);
    const spotDetails = [
      ['beach', 'coast'], ['heritage', 'culture'], ['food', 'culinary'], ['nature', 'outdoors'],
    ];
    await fixture.pool.query(`INSERT INTO spots
      (id,slug,name,description,category,subcategory,municipality,address,gps_lat,gps_lng,source_type,source_name,status,is_test,good_for,best_time,town_area_id)
      SELECT 'trail-weekly-'||i,'trail-weekly-'||i,'Weekly Place '||i,
        'A verified Pangasinan place with useful visitor details.',
        'weekly-category-'||i,
        'weekly-subcategory-'||i,
        'Lingayen','Lingayen, Test Province',16.0,120+i*0.001,'editorial','Fixture','published',FALSE,
        '["families"]'::jsonb,'[]'::jsonb,'trail-weekly-town'
      FROM generate_series(1,20) i`);
    for (const spotId of spotIds) {
      await fixture.pool.query(`INSERT INTO spot_interactions(user_id,spot_id,interaction_type,created_at) VALUES ($1,$2,'save',$3)`, [actorId, spotId, eventAt]);
    }
    await fixture.pool.query(`INSERT INTO trails
      (id,slug,title,tier,theme,municipalities,unlock_rule,total_minutes,total_km,story,status,source,is_test)
      VALUES ('trail-weekly-source','trail-weekly-source','Weekly Source','starter','mixed',ARRAY['Lingayen'],'{"type":"free"}'::jsonb,60,1,'{}'::jsonb,'published','curated',FALSE)`);
    await fixture.pool.query(`INSERT INTO trail_stops(trail_id,position,spot_id,arrive_offset_min,dwell_min)
      VALUES ('trail-weekly-source',1,$1,0,45)`, [spotIds[0]]);
    await fixture.pool.query(`INSERT INTO trail_checkins(trail_id,user_id,position,verified_at,distance_m)
      VALUES ('trail-weekly-source',$1,1,$2,12)`, [actorId, eventAt]);
    await fixture.pool.query(`INSERT INTO social_activities
      (id,event_key,actor_id,verb,subject_type,subject_id,subject_title,subject_href,is_test,created_at)
      VALUES ('trail-weekly-activity','trail-weekly-activity-key',$1,'spot_posted','spot',$2,'Weekly Place 1','/spots/trail-weekly-1',FALSE,$3)`,
    [actorId, spotIds[0], eventAt]);
    await fixture.pool.query(`INSERT INTO social_cheers(activity_id,user_id,is_test,created_at) VALUES ('trail-weekly-activity',$1,FALSE,$2)`, [actorId, eventAt]);
    await fixture.pool.query(`INSERT INTO social_comments(id,activity_id,author_id,body,idempotency_key,is_test,created_at)
      VALUES ('trail-weekly-comment','trail-weekly-activity',$1,'A useful place.','trail-weekly-comment-1',FALSE,$2)`, [actorId, eventAt]);
    const fromIds: string[] = [], toIds: string[] = [], seconds: number[] = [], meters: number[] = [];
    for (const from of spotIds) for (const to of spotIds) {
      fromIds.push(from); toIds.push(to); seconds.push(from === to ? 0 : 60); meters.push(from === to ? 0 : 100);
    }
    await fixture.pool.query(`INSERT INTO travel_time_matrix(costing,from_spot,to_spot,seconds,meters,approximate,graph_label)
      SELECT 'auto',from_spot,to_spot,seconds,meters,FALSE,'mock-realpg'
      FROM UNNEST($1::text[],$2::text[],$3::int[],$4::int[]) AS x(from_spot,to_spot,seconds,meters)
      ON CONFLICT DO NOTHING`, [fromIds,toIds,seconds,meters]);
  }, 120_000);

  afterAll(async () => { if (fixture) await fixture.close(); }, 30_000);

  test('aggregates only eligible non-test saves, check-ins, cheers and comments from the 14-day window', async () => {
    const facts = await loadWeeklyTrendFacts(fixture.pool, '2026-W43', runAt);
    expect(facts.period_start).toBe('2026-10-04T17:05:00.000Z');
    expect(facts.top_spots[0]).toMatchObject({ name: 'Weekly Place 1', count: 4 });
    expect(facts.top_categories.length).toBe(20);
    expect(facts.calendar_hint).toContain('2026-10');
    expect(JSON.stringify(facts)).not.toContain(actorId);
  });

  test('runs once per Manila week and creates review-only candidates', async () => {
    const first = await runWeeklyTrailTrends(fixture.pool, runAt);
    expect(first).toMatchObject({ weekId: '2026-W43', digestAiUsed: false, generated: 4, alreadyGenerated: 0, infeasible: 0 });
    expect(first.areasProcessed).toBe(1);
    const pending = await fixture.pool.query(`SELECT status,tier,available_from,available_until FROM trails WHERE source='engine' ORDER BY tier`);
    expect(pending.rows).toHaveLength(4);
    expect(pending.rows.every(row => row.status === 'pending_review')).toBe(true);
    const legendary = pending.rows.find(row => row.tier === 'legendary');
    expect(new Date(legendary.available_until).getTime() - new Date(legendary.available_from).getTime()).toBe(14 * 24 * 60 * 60 * 1000);
    const digest = await fixture.pool.query('SELECT ai_used FROM trend_digests WHERE week_id=$1', ['2026-W43']);
    expect(digest.rows[0].ai_used).toBe(false);

    const second = await runWeeklyTrailTrends(fixture.pool, runAt);
    expect(second.skippedReason).toBe('already_run');
    expect((await fixture.pool.query(`SELECT count(*)::int AS n FROM trails WHERE source='engine'`)).rows[0].n).toBe(4);
  }, 120_000);
});
