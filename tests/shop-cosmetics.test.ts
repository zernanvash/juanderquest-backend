import { createTestDb, type TestDbInstance } from '../src/db/testHarness.js';
import { validateAsset } from '../src/shop/cosmetics.js';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { app } from '../src/app.js';
import { db } from '../src/db/index.js';
import { setPool } from '../src/db/pool.js';
import { signSessionToken } from '../src/auth/tokens.js';
import { env } from '../src/config/env.js';
import { purchaseCosmetic, listCosmetics, grantAchievementCosmetics } from '../src/shop/cosmetics.js';
import { reconcileFunding } from '../src/funding/reconcile.js';

describe('Shop v1 cosmetics', () => {
  let fixture: TestDbInstance;
  beforeAll(async () => { fixture = await createTestDb(); }, 120_000);
  afterAll(async () => { await fixture?.close(); }, 120_000);

  it('validates the self-describing asset shapes for each slot', () => {
    expect(validateAsset('banner', { style: 'gradient', colors: ['#f4a261', '#e76f51'], angle: 135, pattern: 'sun' })).toBe(true);
    expect(validateAsset('banner', { style: 'gradient', colors: ['#fff'], angle: 135, pattern: 'sun' })).toBe(false);
    expect(validateAsset('frame', { style: 'ring', colors: ['#95d5b2'], width: 3, animated: false })).toBe(true);
    expect(validateAsset('frame', { style: 'ring', colors: ['#95d5b2'], width: 1, animated: false })).toBe(false);
    expect(validateAsset('title', { text: 'Island Hopper' })).toBe(true);
    expect(validateAsset('title', { text: 'x'.repeat(25) })).toBe(false);
    expect(validateAsset('name_color', { color: '#2d6a4f' })).toBe(true);
    expect(validateAsset('name_color', { color: '#ffffff' })).toBe(false);
  });

  it('migrates and seeds the catalog, preview offers and teaser cards', async () => {
    const [items, previews, teasers] = await Promise.all([
      fixture.pool.query('SELECT count(*)::int AS count FROM cosmetic_items'),
      fixture.pool.query("SELECT count(*)::int AS count FROM vouchers WHERE availability='preview'"),
      fixture.pool.query('SELECT count(*)::int AS count FROM shop_teasers'),
    ]);
    expect(items.rows[0].count).toBe(20);
    expect(previews.rows[0].count).toBe(8);
    expect(teasers.rows[0].count).toBe(4);
  });
});

const realPg = process.env.JDQ_REAL_PG_URL ? describe : describe.skip;
realPg('Shop v1 against disposable PostgreSQL (Plan 52 §7)', () => {
  let fixture: TestDbInstance;
  const suffix = () => randomUUID().replace(/-/g, '').slice(0, 12);
  const bearer = (id: string, role = 'user') => `Bearer ${signSessionToken({ id, seed_id: `seed-${id}`, role })}`;
  async function addUser(opts: { points?: number; test?: boolean; role?: string } = {}) {
    const id = `shop-${suffix()}`;
    await fixture.pool.query(`INSERT INTO users(id,seed_id,display_name,email,role,demo_points,is_test) VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [id,`seed-${id}`,id,`${id}@shop.test`,opts.role??'user',opts.points??1000,opts.test??false]);
    return id;
  }
  async function addItem(opts: { kind?: string; price?: number | null; active?: boolean; test?: boolean; badge?: string | null; starts?: string | null } = {}) {
    const id = `item-${suffix()}`;
    const kind = opts.kind ?? 'banner';
    const asset = kind === 'banner' ? {style:'gradient',colors:['#112233','#445566'],angle:90,pattern:'sun'} : kind === 'frame' ? {style:'ring',colors:['#112233'],width:3,animated:false} : kind === 'title' ? {text:'Test Title'} : {color:'#2d6a4f'};
    await fixture.pool.query(`INSERT INTO cosmetic_items(id,kind,name,price_points,unlock_achievement_id,asset,is_active,is_test,available_from) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9)`,
      [id,kind,'Shop test item',opts.price===undefined?10:opts.price,opts.badge??null,JSON.stringify(asset),opts.active??true,opts.test??false,opts.starts??null]);
    return id;
  }
  beforeEach(async () => {
    fixture = await createTestDb({ poolMax: 10 });
    setPool(fixture.pool);
    db.usersRepo.setPool(fixture.pool);
  }, 120_000);
  afterEach(async () => { await fixture?.close(); }, 120_000);

  it('deducts once, writes a balanced ledger group and reconciles treasury balances', async () => {
    const user=await addUser({points:100}); const item=await addItem({price:25});
    const result=await purchaseCosmetic(user,item,'shop-key-0001');
    expect(result.pointsBalance).toBe(75);
    expect((await fixture.pool.query('SELECT demo_points FROM users WHERE id=$1',[user])).rows[0].demo_points).toBe(75);
    const group=(await fixture.pool.query(`SELECT transaction_group_id,count(*)::int n,sum(amount_mjdq)::int net FROM governance_ledger WHERE idempotency_key=$1 GROUP BY transaction_group_id`,['shop-key-0001'])).rows[0];
    expect(group).toMatchObject({n:2,net:0});
    expect(Number((await fixture.pool.query(`SELECT balance_points FROM points_accounts WHERE id='treasury'`)).rows[0].balance_points)).toBe(25);
    expect((await reconcileFunding(fixture.pool)).ok).toBe(true);
  });

  it('replays idempotently and rejects a key reused for another item', async () => {
    const user=await addUser({points:100}); const a=await addItem({price:10}); const b=await addItem({price:11});
    expect((await purchaseCosmetic(user,a,'shop-key-replay')).replayed).toBe(false);
    expect((await purchaseCosmetic(user,a,'shop-key-replay')).replayed).toBe(true);
    await expect(purchaseCosmetic(user,b,'shop-key-replay')).rejects.toThrow('IDEMPOTENCY_CONFLICT');
    const conflict=await request(app).post(`/api/v1/shop/cosmetics/${b}/purchase`).set({Authorization:bearer(user)}).send({idempotency_key:'shop-key-replay'});
    expect(conflict.status).toBe(409); expect(conflict.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    expect((await fixture.pool.query('SELECT demo_points FROM users WHERE id=$1',[user])).rows[0].demo_points).toBe(90);
    expect((await fixture.pool.query('SELECT count(*)::int n FROM governance_ledger WHERE idempotency_key=$1',['shop-key-replay'])).rows[0].n).toBe(2);
  });

  it('serializes concurrent purchases of one item so only one succeeds', async () => {
    const user=await addUser({points:100}); const item=await addItem({price:25});
    const results=await Promise.allSettled([purchaseCosmetic(user,item,'shop-concurrent-1'),purchaseCosmetic(user,item,'shop-concurrent-2')]);
    expect(results.filter(x=>x.status==='fulfilled')).toHaveLength(1);
    expect((await fixture.pool.query('SELECT demo_points FROM users WHERE id=$1',[user])).rows[0].demo_points).toBe(75);
  });

  it('rejects unavailable and financially disallowed purchases without moving points', async () => {
    const user=await addUser({points:5});
    const poor=await addItem({price:10}); const notForSale=await addItem({price:null});
    const badge=await addItem({price:null,badge:'coastal_conqueror'}); const inactive=await addItem({price:10,active:false});
    const future=await addItem({price:10,starts:'2099-01-01T00:00:00Z'}); const alreadyOwned=await addItem({price:10});
    await fixture.pool.query(`INSERT INTO user_cosmetics(user_id,item_id,source) VALUES($1,$2,'grant')`,[user,alreadyOwned]);
    for(const [id,code] of [[poor,'INSUFFICIENT_POINTS'],[notForSale,'NOT_FOR_SALE'],[badge,'BADGE_REQUIRED'],[inactive,'NOT_AVAILABLE'],[future,'NOT_AVAILABLE'],[alreadyOwned,'ALREADY_OWNED']] as const)
      await expect(purchaseCosmetic(user,id,`shop-negative-${code}`)).rejects.toThrow(code);
    const before=await fixture.pool.query('SELECT demo_points FROM users WHERE id=$1',[user]);
    await fixture.pool.query(`UPDATE governance_snapshot SET data=jsonb_set(data,'{controls,pause_all_financial}','true'::jsonb,true) WHERE id=1`);
    await expect(purchaseCosmetic(user,poor,'shop-paused-key')).rejects.toThrow('FINANCIAL_ACTIVITY_PAUSED');
    expect((await fixture.pool.query('SELECT demo_points FROM users WHERE id=$1',[user])).rows[0].demo_points).toBe(before.rows[0].demo_points);
    expect((await fixture.pool.query('SELECT count(*)::int n FROM governance_ledger WHERE actor_id=$1 AND type=$2',[user,'shop_cosmetic_purchase'])).rows[0].n).toBe(0);
  });

  it('hides test inventory from live users and charges test purchases to treasury:test', async () => {
    const live=await addUser(); const test=await addUser({test:true}); const item=await addItem({price:10,test:true});
    expect((await listCosmetics(live)).some(x=>x.id===item)).toBe(false);
    await expect(purchaseCosmetic(live,item,'shop-live-test-item')).rejects.toThrow('NOT_AVAILABLE');
    await purchaseCosmetic(test,item,'shop-test-purchase');
    expect(Number((await fixture.pool.query(`SELECT balance_points FROM points_accounts WHERE id='treasury:test'`)).rows[0].balance_points)).toBe(10);
  });

  it('validates loadout ownership and slots, then supports null unequip', async () => {
    const user=await addUser(); const banner=await addItem({kind:'banner'}); const frame=await addItem({kind:'frame'});
    const auth={Authorization:bearer(user)};
    const notOwned=await request(app).put('/api/v1/me/cosmetics/loadout').set(auth).send({banner_id:banner});
    expect(notOwned.status).toBe(400); expect(notOwned.body.error.code).toBe('NOT_OWNED');
    await fixture.pool.query(`INSERT INTO user_cosmetics(user_id,item_id,source) VALUES($1,$2,'grant'),($1,$3,'grant')`,[user,banner,frame]);
    const wrong=await request(app).put('/api/v1/me/cosmetics/loadout').set(auth).send({banner_id:frame});
    expect(wrong.body.error.code).toBe('WRONG_SLOT');
    expect((await request(app).put('/api/v1/me/cosmetics/loadout').set(auth).send({banner_id:banner})).status).toBe(200);
    const unequip=await request(app).put('/api/v1/me/cosmetics/loadout').set(auth).send({banner_id:null});
    expect(unequip.body.data.loadout.banner_id).toBeNull();
  });

  it('exposes only render data in public cosmetics shapes', async () => {
    const user=await addUser(); const item=await addItem({kind:'banner'});
    await fixture.pool.query(`INSERT INTO user_cosmetics(user_id,item_id,source) VALUES($1,$2,'grant')`,[user,item]);
    await fixture.pool.query(`INSERT INTO user_cosmetic_loadout(user_id,banner_id) VALUES($1,$2)`,[user,item]);
    const auth={Authorization:bearer(user)};
    const response=await request(app).get('/api/v1/leaderboard');
    expect(response.status).toBe(200);
    const json=JSON.stringify(response.body);
    expect(json).not.toContain('points_spent'); expect(json).not.toContain('idempotency_key'); expect(json).not.toContain('ledger_group_id');
    expect(JSON.stringify(response.body.data)).not.toContain('email');
    const me=await request(app).get('/api/v1/auth/me').set(auth);
    expect(me.status).toBe(200); expect(me.body.data.cosmetics.banner).toMatchObject({id:item,kind:'banner',asset:expect.any(Object)});
    expect(me.body.data.cosmetics.banner).not.toHaveProperty('price_points');
    await fixture.pool.query('UPDATE users SET is_public=TRUE,is_test=FALSE WHERE id=$1',[user]);
    db.usersRepo.setPool(fixture.pool);
    const profile=await request(app).get(`/api/v1/users/${user}/profile`);
    expect(profile.status).toBe(200); expect(profile.body.data.cosmetics.banner).toMatchObject({id:item,kind:'banner'});
    expect(Object.keys(profile.body.data.cosmetics).sort()).toEqual(['banner','frame','nameColor','title']);
    expect(Object.keys(profile.body.data.cosmetics.banner).sort()).toEqual(['asset','id','kind']);
    expect(profile.body.data.cosmetics.banner).not.toHaveProperty('price_points');
  });

  it('unlocks achievements on award and lazily, but never grants revoked badges', async () => {
    const user=await addUser();
    await fixture.pool.query(`INSERT INTO achievement_awards(id,user_id,achievement_id,season,is_test) VALUES($1,$2,'coastal_conqueror','all_time',false)`,[randomUUID(),user]);
    await grantAchievementCosmetics(fixture.pool,user);
    expect((await fixture.pool.query(`SELECT source FROM user_cosmetics WHERE user_id=$1 AND item_id='frame-coastal-conqueror'`,[user])).rows[0].source).toBe('achievement');
    const lazyUser=await addUser();
    await fixture.pool.query(`INSERT INTO achievement_awards(id,user_id,achievement_id,season,is_test) VALUES($1,$2,'heritage_seeker','all_time',false)`,[randomUUID(),lazyUser]);
    await listCosmetics(lazyUser);
    expect((await fixture.pool.query(`SELECT 1 FROM user_cosmetics WHERE user_id=$1 AND item_id='frame-heritage-seeker'`,[lazyUser])).rowCount).toBe(1);
    const revokedUser=await addUser();
    await fixture.pool.query(`INSERT INTO achievement_awards(id,user_id,achievement_id,season,is_test,revoked_at,revocation_reason) VALUES($1,$2,'coastal_conqueror','all_time',false,now(),'test revoke')`,[randomUUID(),revokedUser]);
    await listCosmetics(revokedUser);
    expect((await fixture.pool.query(`SELECT 1 FROM user_cosmetics WHERE user_id=$1 AND item_id='frame-coastal-conqueror'`,[revokedUser])).rowCount).toBe(0);
  });

  it('keeps previews non-redeemable with marketplace on and off, and gates live vouchers', async () => {
    const user=await addUser({points:1000}); const original=env.MARKETPLACE_ENABLED;
    const auth={Authorization:bearer(user)};
    const liveId=`live-${suffix()}`;
    await fixture.pool.query(`INSERT INTO merchants(id,name,location,description) VALUES($1,'Real Partner','Test','Test')`,[`merchant-${liveId}`]);
    await fixture.pool.query(`INSERT INTO vouchers(id,merchant_id,title,description,cost_points,is_active,availability) VALUES($1,$2,'Live','Live test',10,true,'live')`,[liveId,`merchant-${liveId}`]);
    try {
      for(const enabled of [true,false]) {
        env.MARKETPLACE_ENABLED=enabled;
        const catalog=await request(app).get('/api/v1/vouchers');
        expect(catalog.status).toBe(200);
        expect(catalog.body.data.filter((v:any)=>v.availability==='preview')).toHaveLength(8);
        expect(catalog.body.data.filter((v:any)=>v.availability==='preview').every((v:any)=>v.redeemable===false)).toBe(true);
        expect(catalog.body.data.some((v:any)=>v.id===liveId)).toBe(enabled);
        const preview=await request(app).post('/api/v1/vouchers/pv-boat-tour/redeem').set(auth).send({idempotency_key:`voucher-preview-${enabled}`});
        expect(preview.status).toBe(409); expect(preview.body.error.code).toBe('NOT_REDEEMABLE');
        expect((await fixture.pool.query('SELECT demo_points FROM users WHERE id=$1',[user])).rows[0].demo_points).toBe(1000);
      }
      env.MARKETPLACE_ENABLED=false;
      const disabled=await request(app).post(`/api/v1/vouchers/${liveId}/redeem`).set(auth).send({idempotency_key:'voucher-live-disabled'});
      expect(disabled.status).toBe(503); expect(disabled.body.error.code).toBe('FEATURE_UNAVAILABLE');
      expect((await fixture.pool.query('SELECT demo_points FROM users WHERE id=$1',[user])).rows[0].demo_points).toBe(1000);
    } finally { env.MARKETPLACE_ENABLED=original; }
  });

  it('requires admin authority, validates assets, grants transactionally and blocks SAMPLE_MERCHANT offers', async () => {
    const admin=await addUser({role:'admin'}); const user=await addUser();
    const adminAuth={Authorization:bearer(admin,'admin')};
    expect((await request(app).post('/api/v1/admin/shop/cosmetics').set({Authorization:bearer(user)}).send({})).status).toBe(403);
    const invalid=await request(app).post('/api/v1/admin/shop/cosmetics').set(adminAuth).send({id:'bad-asset',kind:'banner',name:'Invalid Asset',asset:{style:'ring'}});
    expect(invalid.status).toBe(400); expect(invalid.body.error.code).toBe('INVALID_ASSET');
    const palette=await request(app).post('/api/v1/admin/shop/cosmetics').set(adminAuth).send({id:'bad-palette',kind:'name_color',name:'Bad Palette',asset:{color:'#ffffff'}});
    expect(palette.status).toBe(400); expect(palette.body.error.code).toBe('INVALID_ASSET');
    const item=await addItem();
    const grant=await request(app).post(`/api/v1/admin/shop/cosmetics/${item}/grant`).set(adminAuth).send({user_id:user,reason:'Reviewed support grant'});
    expect(grant.status).toBe(201);
    expect((await fixture.pool.query(`SELECT source FROM user_cosmetics WHERE user_id=$1 AND item_id=$2`,[user,item])).rows[0].source).toBe('grant');
    expect((await fixture.pool.query(`SELECT count(*)::int n FROM cosmetic_audit WHERE actor_user_id=$1 AND action='grant' AND item_id=$2`,[admin,item])).rows[0].n).toBe(1);
    const sample=await request(app).patch('/api/v1/admin/vouchers/pv-boat-tour/availability').set(adminAuth).send({availability:'live'});
    expect(sample.status).toBe(409); expect(sample.body.error.code).toBe('SAMPLE_MERCHANT');
  });
});
