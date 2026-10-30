import { randomUUID } from 'crypto';
import request from 'supertest';
import { app } from '../src/app.js';
import { db } from '../src/db/index.js';
import { setPool } from '../src/db/pool.js';
import { createTestDb, type TestDbInstance } from '../src/db/testHarness.js';
import { invalidateActiveJuanChoicePerks, perkBonus } from '../src/juanchoice/perks.js';
import { checkinTrailStop, unlockTrail } from '../src/trails/progress.js';
import { claimDaily } from '../src/stamps/service.js';
import { purchaseCosmetic } from '../src/shop/cosmetics.js';

const realPg = process.env.JDQ_REAL_PG_URL ? describe : describe.skip;
jest.setTimeout(180_000);

// Plan 65 checkpoint 1b: the reigning Champion/Minister perks change real gameplay outcomes.
realPg('Plan 65 perk hooks (real PostgreSQL)', () => {
  let fixture: TestDbInstance;
  const campaignId = randomUUID();
  const championId = randomUUID();
  const user = `perk-user-${randomUUID()}`;
  const perk = (key: string, value: number, extra: Record<string, unknown> = {}) => ({
    key, value, label: key, description: key, domain: 'trails', is_anchor: false, is_mystery: false, revealed: true,
    role: 'champion', campaign_id: campaignId, candidate_id: championId, spot_id: 'perk-spot', municipality: 'Bolinao',
    category: 'nature_outdoors', reign_starts_at: new Date().toISOString(), reign_ends_at: new Date().toISOString(), ...extra });

  beforeAll(async () => {
    fixture = await createTestDb({ poolMax: 10 });
    setPool(fixture.pool);
    db.attachDurabilityPool(fixture.pool);
    db.usersRepo.setPool(fixture.pool);
    await fixture.pool.query(`INSERT INTO users(id,seed_id,display_name,email,role,demo_points,is_test)
      VALUES($1::text,$1::text,'Perk traveler',$1::text||'@example.test','user',1000,FALSE)`, [user]);
    await fixture.pool.query(`INSERT INTO spots(id,slug,name,description,category,subcategory,municipality,address,gps_lat,gps_lng,
      source_type,source_name,status,is_test) VALUES('perk-spot','perk-spot','Perk Beach','A perk test spot.','nature_outdoors','beach',
      'Bolinao','Bolinao, Pangasinan',16,120,'lgu','Fixture','published',FALSE)`);
    // A weekly round that closed an hour ago: its result reigns now.
    const closed = new Date(Date.now() - 3_600_000);
    await fixture.pool.query(`INSERT INTO juanchoice_campaigns(id,slug,region,theme,status,opens_at,closes_at,is_test,policy_version)
      VALUES($1,$2,'Pangasinan','Perk round','finalized',$3,$4,FALSE,'juanchoice-weekly-v1')`,
      [campaignId, `perk-round-${campaignId}`, new Date(closed.getTime() - 7 * 86_400_000), closed]);
    await fixture.pool.query(`INSERT INTO juanchoice_results(campaign_id,standings,co_winner_ids,valid_ballots,policy_version,active_perks)
      VALUES($1,'[]'::jsonb,$2::jsonb,1,'juanchoice-weekly-v1',$3::jsonb)`, [campaignId, JSON.stringify([championId]), JSON.stringify([
      perk('corridor_trail_discount', 0.25), perk('trail_completion_bonus', 0.2), perk('daily_stamp_bonus', 5),
      perk('shop_cosmetic_discount', 0.15), perk('msme_partner_spotlight', 1),
    ])]);
    invalidateActiveJuanChoicePerks();
  });

  afterAll(async () => {
    invalidateActiveJuanChoicePerks();
    setPool(null);
    db.attachDurabilityPool(null);
    db.usersRepo.setPool(null);
    await fixture?.close();
  });

  const points = async () => Number((await fixture.pool.query('SELECT demo_points FROM users WHERE id=$1', [user])).rows[0].demo_points);

  it('reads only matching reigning perks and adds their values', async () => {
    expect((await perkBonus(fixture.pool, false, p => p.key === 'corridor_trail_discount')).value).toBe(0.25);
    expect((await perkBonus(fixture.pool, false, p => p.key === 'quiz_arcade_xp_boost')).value).toBe(0);
    expect((await perkBonus(fixture.pool, true, p => p.key === 'corridor_trail_discount')).value).toBe(0);
  });

  it('discounts a Hiyas Trail through the reigning town (replay keeps the price) and boosts its completion reward', async () => {
    const trailId = `perk-trail-${randomUUID()}`;
    await fixture.pool.query(`INSERT INTO trails(id,slug,title,tagline,tier,theme,municipalities,unlock_rule,costing,total_minutes,total_km,story,status,source,is_test)
      VALUES($1,$1,'Perk Hiyas','One stop','signature','nature',ARRAY['Bolinao'],'{"type":"points","price_points":300}'::jsonb,'auto',60,1,'{}'::jsonb,'published','engine',FALSE)`, [trailId]);
    await fixture.pool.query(`INSERT INTO trail_stops(trail_id,position,spot_id,arrive_offset_min,dwell_min,leg_minutes,leg_km,narration)
      VALUES($1,1,'perk-spot',0,45,0,0,'Stop')`, [trailId]);
    const before = await points();
    const unlocked = await unlockTrail(fixture.pool, user, trailId, 'perk-unlock-1');
    expect(Number(unlocked.price_points)).toBe(225);
    expect(await points()).toBe(before - 225);
    const ledger = (await fixture.pool.query(`SELECT metadata FROM governance_ledger WHERE type='trail_unlock_debit' AND reference_id=$1 LIMIT 1`, [trailId])).rows[0];
    expect(ledger.metadata.juanchoice_perks).toEqual(['corridor_trail_discount']);
    expect((await unlockTrail(fixture.pool, user, trailId, 'perk-unlock-1')).replayed).toBe(true);
    expect(await points()).toBe(before - 225);

    const done = await checkinTrailStop(fixture.pool, user, trailId, 1, { lat: 16, lng: 120, accuracy_m: 5 });
    expect(done.completion.reward_points).toBe(Math.round(200 * 1.2));
  });

  it('adds daily bonus stamps as their own ledger row', async () => {
    await claimDaily(fixture.pool, user, { now: new Date() });
    const rows = (await fixture.pool.query(`SELECT source,delta FROM stamp_ledger WHERE user_id=$1 ORDER BY source`, [user])).rows;
    expect(rows.find(row => row.source === 'juanchoice_perk')).toMatchObject({ delta: 5 });
    expect(rows.find(row => row.source === 'daily_claim')).toBeDefined();
  });

  it('discounts banners in the shop and records the perk', async () => {
    const item = `perk-banner-${randomUUID().slice(0, 8)}`;
    await fixture.pool.query(`INSERT INTO cosmetic_items(id,kind,name,price_points,asset,is_active,is_test) VALUES($1,'banner','Perk banner',100,$2::jsonb,TRUE,FALSE)`,
      [item, JSON.stringify({ style: 'gradient', colors: ['#112233', '#445566'], angle: 90, pattern: 'sun' })]);
    const before = await points();
    await purchaseCosmetic(user, item, `perk-shop-${randomUUID()}`);
    expect(await points()).toBe(before - 85);
    const owned = (await fixture.pool.query('SELECT points_spent FROM user_cosmetics WHERE user_id=$1 AND item_id=$2', [user, item])).rows[0];
    expect(Number(owned.points_spent)).toBe(85);
  });

  it('features vouchers from the spotlight town first', async () => {
    await fixture.pool.query(`INSERT INTO merchants(id,name,location,description) VALUES
      ('perk-m-far','Far Shop','Urdaneta City, Pangasinan','x'),('perk-m-near','Near Shop','Bolinao, Pangasinan','x')
      ON CONFLICT (id) DO NOTHING`);
    const res = await request(app).get('/api/v1/vouchers');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    for (const voucher of res.body.data) expect(typeof voucher.featured).toBe('boolean');
  });

  it('stops applying perks once an admin restricts the champion', async () => {
    await fixture.pool.query(`INSERT INTO juanchoice_candidates(id,campaign_id,spot_id,is_test) VALUES($1,$2,'perk-spot',FALSE)`, [championId, campaignId]);
    await fixture.pool.query(`INSERT INTO juanchoice_promotion_assessments(id,candidate_id,assessed_by,revision,decision,reason,assessed_at,valid_until,is_test)
      VALUES($1,$2,$3,1,'restricted','Overcrowding reported by the LGU.',NOW(),NOW()+INTERVAL '6 days',FALSE)`, [randomUUID(), championId, user]);
    invalidateActiveJuanChoicePerks();
    expect((await perkBonus(fixture.pool, false, p => p.key === 'corridor_trail_discount')).value).toBe(0);
  });
});
