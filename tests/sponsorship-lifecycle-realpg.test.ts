import { randomUUID } from 'crypto';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { app } from '../src/app.js';
import { db } from '../src/db/index.js';
import { env } from '../src/config/env.js';
import { setPool } from '../src/db/pool.js';
import { createTestDb, type TestDbInstance } from '../src/db/testHarness.js';
import { FundingPlansService } from '../src/funding/plans.js';
import { MerchantPointsService } from '../src/funding/merchantPoints.js';
import { SponsorshipService } from '../src/funding/sponsorships.js';
import { vouchersService } from '../src/services/vouchers.js';

const realPg=process.env.JDQ_REAL_PG_URL?describe:describe.skip;
realPg('funded quest sponsorship lifecycle (disposable PostgreSQL)',()=>{
  let fixture:TestDbInstance;
  let plans:FundingPlansService;
  let sponsors:SponsorshipService;
  let merchantPoints:MerchantPointsService;
  const originalFlag=env.QUEST_FUNDING_ENABLED;
  const adminId=`sponsor-admin-${randomUUID()}`;
  const token=(id:string,role='user')=>`Bearer ${jwt.sign({id,seed_id:id,role},env.JWT_SECRET)}`;

  async function user(id:string,points=0,role='user'){
    await fixture.pool.query('INSERT INTO users(id,seed_id,display_name,email,role,demo_points) VALUES($1,$2,$3,$4,$5,$6)',[id,id,id,`${id}@example.test`,role,points]);
    db.users.push({id,seed_id:id,display_name:id,email:`${id}@example.test`,role,demo_points:points,is_test:false} as any);
  }

  beforeAll(async()=>{
    fixture=await createTestDb();setPool(fixture.pool);db.usersRepo.setPool(fixture.pool);env.QUEST_FUNDING_ENABLED=true;
    plans=new FundingPlansService(fixture.pool);sponsors=new SponsorshipService(fixture.pool);merchantPoints=new MerchantPointsService(fixture.pool);
    await user(adminId,0,'admin');
  });
  afterAll(async()=>{env.QUEST_FUNDING_ENABLED=originalFlag;setPool(null);db.usersRepo.setPool(null);if(fixture)await fixture.close();});

  it('negotiates a sponsor counter, activates only when fully funded, and grants one free perk on approval',async()=>{
    const suffix=randomUUID().slice(0,8),authorId=`a-${suffix}`,travelerId=`t-${suffix}`,merchantOwnerId=`mo-${suffix}`;
    const questId=`q-${suffix}`,merchantId=`m-${suffix}`,voucherId=`v-${suffix}`;
    await user(authorId,500);await user(travelerId);await user(merchantOwnerId);
    await fixture.pool.query(
      `INSERT INTO quests(id,title,description,category,location_name,gps_lat,gps_lng,radius_meters,reward_points,marker_code,marker_image_url,author_id,status,version,steps,is_active)
       VALUES($1,'Sponsor quest','Visit','eco','Test destination',16,120,100,50,$2,'',$3,'draft',1,$4::jsonb,false)`,
      [questId,`marker-${suffix}`,authorId,JSON.stringify([{step_order:1,title:'Arrive',description:'Visit.',checkpoint_type:'location',required:true}])]);
    db.quests.push({id:questId,title:'Sponsor quest',description:'Visit',category:'eco',location_name:'Test destination',gps_lat:16,gps_lng:120,radius_meters:100,reward_points:50,marker_code:`marker-${suffix}`,marker_image_url:'',author_id:authorId,status:'draft',version:1,steps:[{step_order:1,title:'Arrive',checkpoint_type:'location',required:true}],is_active:false,is_test:false} as any);
    await fixture.pool.query("INSERT INTO merchants(id,name,location,description,status,is_published,municipality,is_test) VALUES($1,'Sponsor Cafe','Town','Local partner','active',TRUE,'Town',FALSE)",[merchantId]);
    await fixture.pool.query("INSERT INTO merchant_memberships(id,merchant_id,user_id,role,status) VALUES($1,$2,$3,'owner','active')",[randomUUID(),merchantId,merchantOwnerId]);
    await fixture.pool.query("INSERT INTO vouchers(id,merchant_id,title,description,cost_points,is_active) VALUES($1,$2,'Free local treat','A sponsor perk',10,TRUE)",[voucherId,merchantId]);
    await merchantPoints.purchase(merchantOwnerId,merchantId,500,randomUUID());

    const plan=await plans.create(authorId,questId,{mode:'budget',planned_completions:2,starts_at:new Date(Date.now()-60_000).toISOString(),ends_at:new Date(Date.now()+2*86_400_000).toISOString()},randomUUID());
    await plans.contribute(authorId,plan.id,53,randomUUID());
    const pending=await plans.submit(authorId,plan.id,randomUUID());
    expect(pending.status).toBe('pending_sponsors');
    const directory=await request(app).get(`/api/v1/sponsor-directory?quest_id=${encodeURIComponent(questId)}`).set('Authorization',token(authorId));
    expect(directory.status).toBe(200);
    expect(directory.body.data.items.find((item:any)=>item.id===merchantId).vouchers).toEqual([
      expect.objectContaining({id:voucherId,title:'Free local treat'}),
    ]);
    const created=await sponsors.request(authorId,plan.id,merchantId,{points:40,voucher_id:voucherId,voucher_qty:1,promo:true,message:'Would love to partner.'},randomUUID());
    const merchantAlerts=await request(app).get('/api/v1/notifications').set('Authorization',token(merchantOwnerId));
    expect(merchantAlerts.status).toBe(200);
    expect(merchantAlerts.body.data.items).toEqual([expect.objectContaining({
      kind:'sponsorship',title:'New Eco-Quest sponsorship request',href:'/merchant/funding',read:false,
    })]);
    const countered=await sponsors.counter(merchantOwnerId,created.id,{points:53,voucher_id:voucherId,voucher_qty:1,promo:true,message:'Confirmed.'},created.terms_version,randomUUID());
    await expect(sponsors.acceptCounter(authorId,created.id,created.terms_version,randomUUID())).rejects.toMatchObject({code:'SPONSORSHIP_TERMS_CHANGED'});
    const accepted=await sponsors.acceptCounter(authorId,created.id,countered.terms_version,randomUUID());
    expect(accepted.status).toBe('accepted');
    expect((await plans.get(authorId,plan.id)).status).toBe('active');
    expect((await fixture.pool.query('SELECT balance_points FROM points_accounts WHERE id=$1',[`merchant:${merchantId}`])).rows[0].balance_points).toBe('447');
    const publicQuest=await request(app).get(`/api/v1/quests/${questId}`);
    expect(publicQuest.status).toBe(200);
    expect(publicQuest.body.data.funding).toMatchObject({status:'active',reward_points:50,sponsors:[{name:'Sponsor Cafe',logo:null}],perk:{title:'Free local treat',remaining:1}});

    const started=await request(app).post(`/api/v1/quests/${questId}/attempts`).set('Authorization',token(travelerId));
    expect(started.status).toBe(201);
    await fixture.pool.query("UPDATE quest_step_evidence SET status='verified' WHERE attempt_id=$1",[started.body.data.id]);
    const submitted=await request(app).post(`/api/v1/quests/${questId}/submit-for-review`).set('Authorization',token(travelerId));
    expect(submitted.status).toBe(200);
    const approved=await request(app).patch(`/api/v1/admin/quest-attempts/${started.body.data.id}`).set('Authorization',token(adminId,'admin')).send({action:'approve'});
    expect(approved.status).toBe(200);
    expect(approved.body.data.voucher_perk).toMatchObject({title:'Free local treat'});
    const redemption=await fixture.pool.query("SELECT cost_points,source,hold_id FROM redemptions WHERE user_id=$1",[travelerId]);
    expect(redemption.rows).toHaveLength(1);
    expect(redemption.rows[0]).toMatchObject({cost_points:0,source:'quest_sponsor_perk'});
    const perk=await fixture.pool.query('SELECT total_qty,granted_qty FROM quest_voucher_perks WHERE plan_id=$1',[plan.id]);
    expect(perk.rows[0]).toMatchObject({total_qty:1,granted_qty:1});
    const ledger=await fixture.pool.query("SELECT transaction_group_id FROM governance_ledger WHERE reference_type='quest_funding_hold' AND reference_id=$1 AND type='quest_reward_paid'",[redemption.rows[0].hold_id]);
    expect(ledger.rows).toHaveLength(2);
    const history=await sponsors.inbox(merchantOwnerId,'accepted');
    expect(history.items).toHaveLength(1);
  });

  it('routes voucher income to the merchant only when the explicit setting is enabled',async()=>{
    const suffix=randomUUID().slice(0,8),travelerId=`vu-${suffix}`,merchantId=`vm-${suffix}`,voucherId=`vi-${suffix}`;
    await user(travelerId,100);
    await fixture.pool.query("INSERT INTO merchants(id,name,location,description,status,is_published,municipality,is_test) VALUES($1,'Income Cafe','Town','Partner','active',TRUE,'Town',FALSE)",[merchantId]);
    await fixture.pool.query("INSERT INTO vouchers(id,merchant_id,title,description,cost_points,is_active) VALUES($1,$2,'Tea','A voucher',10,TRUE)",[voucherId,merchantId]);
    await fixture.pool.query("UPDATE system_settings_document SET values=jsonb_set(COALESCE(values,'{}'::jsonb),'{voucher_income_enabled}','true'::jsonb,true) WHERE id=1");
    try {
      const redeemed=await vouchersService.redeemVoucher(voucherId,travelerId,randomUUID());
      expect(redeemed.success).toBe(true);
      expect((await fixture.pool.query('SELECT demo_points FROM users WHERE id=$1',[travelerId])).rows[0].demo_points).toBe(90);
      expect((await fixture.pool.query('SELECT balance_points FROM points_accounts WHERE id=$1',[`merchant:${merchantId}`])).rows[0].balance_points).toBe('10');
      const credit=(await fixture.pool.query("SELECT source,points,ledger_group_id FROM merchant_point_credits WHERE merchant_id=$1",[merchantId])).rows[0];
      expect(credit).toMatchObject({source:'voucher_income',points:'10'});
      expect((await fixture.pool.query('SELECT COUNT(*)::int AS n FROM governance_ledger WHERE transaction_group_id=$1',[credit.ledger_group_id])).rows[0].n).toBe(2);
    } finally {
      await fixture.pool.query("UPDATE system_settings_document SET values=jsonb_set(COALESCE(values,'{}'::jsonb),'{voucher_income_enabled}','false'::jsonb,true) WHERE id=1");
    }
  });

  it('keeps durable funding notifications private to their recipient and supports read state',async()=>{
    const suffix=randomUUID().slice(0,8),recipient=`nr-${suffix}`,other=`no-${suffix}`;
    await user(recipient);await user(other);
    const inserted=await fixture.pool.query(
      `INSERT INTO user_notifications(id,user_id,event_key,kind,title,message,href,is_test)
       VALUES($1,$2,$3,'quest_funding','Funding ready','Your quest is now funded.','/funding',FALSE) RETURNING id`,
      [randomUUID(),recipient,`funding:${suffix}:active`]);
    const notificationId=inserted.rows[0].id as string;
    const own=await request(app).get('/api/v1/notifications').set('Authorization',token(recipient));
    expect(own.status).toBe(200);
    expect(own.headers['cache-control']).toContain('no-store');
    expect(own.body.data.items).toEqual([expect.objectContaining({id:notificationId,kind:'quest_funding',read:false})]);
    expect(own.body.data.unread_count).toBe(1);

    const hidden=await request(app).get('/api/v1/notifications').set('Authorization',token(other));
    expect(hidden.status).toBe(200);
    expect(hidden.body.data.items).toEqual([]);
    const forbiddenRead=await request(app).patch(`/api/v1/notifications/${notificationId}/read`).set('Authorization',token(other));
    expect(forbiddenRead.status).toBe(404);
    const marked=await request(app).patch(`/api/v1/notifications/${notificationId}/read`).set('Authorization',token(recipient));
    expect(marked.status).toBe(200);
    expect((await request(app).get('/api/v1/notifications').set('Authorization',token(recipient))).body.data)
      .toMatchObject({unread_count:0,items:[expect.objectContaining({id:notificationId,read:true})]});
  });
});
