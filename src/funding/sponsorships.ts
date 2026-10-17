import { randomUUID } from 'crypto';
import type { Pool } from 'pg';
import { canonicalSettings } from '../settings/schema.js';
import { FundingError, fundingCommand, type FundingTx } from './transaction.js';
import { activateIfFunded, ensurePlanAccounts, lockPlan, refreshQuestMirror } from './plans.js';
import { insertFundingNotification, notifyMerchantOwners } from './notifications.js';

type Terms = { points: number; voucher_id?: string | null; voucher_qty: number; promo: boolean; message?: string | null };

function validTerms(terms: Terms) {
  if (!Number.isSafeInteger(terms.points) || terms.points < 0 || terms.points > 1_000_000_000 ||
      !Number.isSafeInteger(terms.voucher_qty) || terms.voucher_qty < 0 ||
      ((terms.voucher_qty > 0) !== Boolean(terms.voucher_id)) || (!terms.points && !terms.voucher_qty && !terms.promo) ||
      (terms.message?.length ?? 0) > 500) {
    throw new FundingError('INVALID_SPONSORSHIP_TERMS', 400, 'Provide points, a valid voucher quantity, or a promotional placement.');
  }
}

async function assertOwner(client: any, actorId: string, merchantId: string, scope: boolean) {
  const row = (await client.query(
    `SELECT m.id,m.is_test,m.status,m.is_published,mm.role,mm.status AS membership_status,u.is_test AS user_scope
       FROM merchants m JOIN merchant_memberships mm ON mm.merchant_id=m.id AND mm.user_id=$2
       JOIN users u ON u.id=mm.user_id WHERE m.id=$1 FOR UPDATE OF m,mm`, [merchantId, actorId])).rows[0];
  if (!row || row.status !== 'active' || row.is_published !== true || row.role !== 'owner' || row.membership_status !== 'active') {
    throw new FundingError('MERCHANT_OWNER_REQUIRED', 403, 'An active published merchant owner is required.');
  }
  if (Boolean(row.is_test) !== scope || Boolean(row.user_scope) !== scope) throw new FundingError('SCOPE_MISMATCH', 403, 'Merchant and account scopes do not match.');
  return row;
}

async function assertVoucher(client: any, merchantId: string, voucherId: string | undefined | null, quantity: number) {
  if (!quantity) return;
  const result = await client.query('SELECT id FROM vouchers WHERE id=$1 AND merchant_id=$2 AND is_active=TRUE', [voucherId, merchantId]);
  if (!result.rows[0]) throw new FundingError('VOUCHER_NOT_OWNED_BY_MERCHANT', 409, 'The sponsored voucher must be active and owned by this merchant.');
}

async function sponsorshipForUpdate(client: any, id: string) {
  const result = await client.query('SELECT * FROM quest_sponsorships WHERE id=$1 FOR UPDATE', [id]);
  if (!result.rows[0]) throw new FundingError('NOT_FOUND', 404, 'Sponsorship request not found.');
  return result.rows[0];
}

async function acceptTerms(tx: FundingTx, sponsorship: any, terms: Terms, actorId: string, merchantAccepts: boolean) {
  const plan = await lockPlan(tx.client, sponsorship.plan_id);
  if (!['pending_sponsors','active'].includes(plan.status) || new Date(sponsorship.expires_at).getTime() <= Date.now()) {
    throw new FundingError('SPONSORSHIP_STATE', 409, 'This sponsorship request is no longer open.');
  }
  if (Boolean(plan.is_test) !== Boolean(sponsorship.is_test)) throw new FundingError('SCOPE_MISMATCH', 409, 'Sponsorship and funding scopes do not match.');
  if (merchantAccepts) await assertOwner(tx.client, actorId, sponsorship.merchant_id, Boolean(plan.is_test));
  else if (sponsorship.requested_by !== actorId) throw new FundingError('QUEST_NOT_DESTINATION_AUTHOR',403,'Only the requesting destination author may accept a counter.');
  await assertVoucher(tx.client, sponsorship.merchant_id, terms.voucher_id, terms.voucher_qty);

  if (terms.points > 0) {
    await tx.client.query(
      `INSERT INTO points_accounts(id,kind,merchant_id,is_test) VALUES($1,'merchant',$2,$3) ON CONFLICT(id) DO NOTHING`,
      [`merchant:${sponsorship.merchant_id}`, sponsorship.merchant_id, plan.is_test]);
    const account = (await tx.client.query('SELECT balance_points,is_test FROM points_accounts WHERE id=$1 FOR UPDATE', [`merchant:${sponsorship.merchant_id}`])).rows[0];
    if (!account || Boolean(account.is_test) !== Boolean(plan.is_test)) throw new FundingError('SCOPE_MISMATCH', 409, 'Merchant point scope does not match.');
    const prior = (await tx.client.query("SELECT * FROM quest_funding_contributions WHERE plan_id=$1 AND merchant_id=$2 AND funder_kind='merchant' FOR UPDATE", [plan.id, sponsorship.merchant_id])).rows[0];
    const existingCap = Number(prior?.remaining_points ?? 0);
    if (plan.mode === 'window' && Number(account.balance_points) < existingCap + terms.points) {
      throw new FundingError('INSUFFICIENT_POINTS', 409, 'The merchant balance does not cover this sponsorship cap.');
    }
    if (plan.mode === 'budget') {
      await tx.transfer({ from: { id: `merchant:${sponsorship.merchant_id}`, kind: 'merchant' }, to: { id: `quest_budget:${plan.id}`, kind: 'quest_budget' },
        points: terms.points, type: 'quest_fund_lock', referenceType: 'quest_sponsorship', referenceId: sponsorship.id, actorId,
        metadata: { merchant_id: sponsorship.merchant_id, plan_id: plan.id } });
    }
    if (prior) await tx.client.query('UPDATE quest_funding_contributions SET committed_points=committed_points+$2,remaining_points=remaining_points+$2,updated_at=NOW() WHERE id=$1', [prior.id, terms.points]);
    else await tx.client.query(
      `INSERT INTO quest_funding_contributions(id,plan_id,funder_kind,merchant_id,sponsorship_id,is_test,committed_points,remaining_points)
       VALUES($1,$2,'merchant',$3,$4,$5,$6,$6)`, [randomUUID(), plan.id, sponsorship.merchant_id, sponsorship.id, plan.is_test, terms.points]);
    await ensurePlanAccounts(tx.client, plan);
  }
  if (terms.voucher_qty > 0) {
    await tx.client.query(
      `INSERT INTO quest_voucher_perks(id,plan_id,sponsorship_id,voucher_id,total_qty) VALUES($1,$2,$3,$4,$5)`,
      [randomUUID(), plan.id, sponsorship.id, terms.voucher_id, terms.voucher_qty]);
  }
  const updated = (await tx.client.query(
    `UPDATE quest_sponsorships SET status='accepted',points=$2,voucher_id=$3,voucher_qty=$4,promo=$5,message=$6,responded_by=$7,responded_at=NOW(),updated_at=NOW()
     WHERE id=$1 RETURNING *`, [sponsorship.id, terms.points,terms.voucher_qty?terms.voucher_id??sponsorship.voucher_id:null, terms.voucher_qty, terms.promo, terms.message ?? null, actorId])).rows[0];
  if (merchantAccepts) await insertFundingNotification(tx.client, {
    userId: sponsorship.requested_by, isTest: Boolean(plan.is_test),
    eventKey: `sponsorship:${sponsorship.id}:accepted:${Number(sponsorship.terms_version)}`,
    kind: 'sponsorship', title: 'Merchant accepted your sponsorship request',
    message: `The merchant sponsorship for this Eco-Quest is accepted with ${terms.points} demo points${terms.voucher_qty ? ' and a voucher perk' : ''}.`,
    href: `/funding?quest_id=${encodeURIComponent(plan.quest_id)}`,
  });
  else await notifyMerchantOwners(tx.client,sponsorship.merchant_id,Boolean(plan.is_test),
    `sponsorship:${sponsorship.id}:counter-accepted:${Number(sponsorship.terms_version)}`,'sponsorship',
    'Author accepted your sponsorship counter-offer','The destination author accepted your revised Eco-Quest sponsorship terms.','/merchant/funding');
  if (plan.status === 'pending_sponsors') await activateIfFunded(tx, plan);
  return updated;
}

export class SponsorshipService {
  constructor(private readonly pool: Pool) {}

  async directory(questId: string, actorId: string, options: { q?: string; page?: number }) {
    const client = await this.pool.connect();
    try {
      const quest = (await client.query('SELECT q.id,q.is_test,q.author_id,s.municipality FROM quests q LEFT JOIN spots s ON s.quest_id=q.id WHERE q.id=$1', [questId])).rows[0];
      if (!quest) throw new FundingError('NOT_FOUND',404,'Quest not found.');
      if (quest.author_id !== actorId) throw new FundingError('QUEST_NOT_DESTINATION_AUTHOR',403,'Only the destination author can request sponsorship.');
      const actor=(await client.query('SELECT is_test FROM users WHERE id=$1',[actorId])).rows[0];
      if(!actor||Boolean(actor.is_test)!==Boolean(quest.is_test))throw new FundingError('SCOPE_MISMATCH',403,'Account and quest scopes do not match.');
      const page = Math.max(1, Math.min(1000, options.page ?? 1));
      const query = (options.q ?? '').trim().slice(0,100);
      const result = await client.query(
        `SELECT m.id,m.name,m.municipality,m.category,m.logo_url,m.description,
          COALESCE((SELECT jsonb_agg(jsonb_build_object('id',v.id,'title',v.title,'description',v.description)
            ORDER BY v.title,v.id) FROM vouchers v WHERE v.merchant_id=m.id AND v.is_active=TRUE), '[]'::jsonb) AS vouchers,
          (m.municipality IS NOT DISTINCT FROM $2) AS same_municipality
         FROM merchants m WHERE m.status='active' AND m.is_published=TRUE AND m.is_test=$1
           AND ($3='' OR m.name ILIKE '%'||$3||'%' OR COALESCE(m.category,'') ILIKE '%'||$3||'%')
         ORDER BY (m.municipality IS NOT DISTINCT FROM $2) DESC,m.name,m.id LIMIT 20 OFFSET $4`,
        [quest.is_test, quest.municipality ?? null, query, (page-1)*20]);
      return { items: result.rows, page, simulated: true };
    } finally { client.release(); }
  }

  async request(actorId: string, planId: string, merchantId: string, terms: Terms, key: string) {
    validTerms(terms);
    const result = await fundingCommand(this.pool, actorId, 'sponsorship.request', key, { planId, merchantId, terms }, async tx => {
      const plan = await lockPlan(tx.client, planId, actorId);
      if (!['pending_sponsors','active'].includes(plan.status)) throw new FundingError('FUNDING_PLAN_STATE',409,'This round is not accepting sponsor requests.');
      const merchant = (await tx.client.query("SELECT id,is_test FROM merchants WHERE id=$1 AND status='active' AND is_published=TRUE FOR UPDATE",[merchantId])).rows[0];
      if (!merchant) throw new FundingError('MERCHANT_NOT_FOUND',404,'Active published merchant not found.');
      if (Boolean(merchant.is_test)!==Boolean(plan.is_test)) throw new FundingError('SCOPE_MISMATCH',409,'Merchant and quest scopes do not match.');
      await assertVoucher(tx.client,merchantId,terms.voucher_id,terms.voucher_qty);
      const settings=(await tx.client.query('SELECT values FROM system_settings_document WHERE id=1')).rows[0];
      const cap=Number(canonicalSettings(settings?.values??{}).max_open_sponsorship_requests_per_plan);
      const count=await tx.client.query("SELECT COUNT(*)::int AS count FROM quest_sponsorships WHERE plan_id=$1 AND status IN ('requested','countered')",[planId]);
      if(Number(count.rows[0].count)>=cap) throw new FundingError('SPONSORSHIP_REQUEST_LIMIT',429,'This funding round already has the maximum open sponsorship requests.');
      const expires=plan.status==='pending_sponsors'&&plan.sponsorship_deadline?plan.sponsorship_deadline:plan.ends_at;
      const inserted=await tx.client.query(
        `INSERT INTO quest_sponsorships(id,plan_id,merchant_id,requested_by,status,points,voucher_id,voucher_qty,promo,message,expires_at,is_test)
         VALUES($1,$2,$3,$4,'requested',$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [randomUUID(),planId,merchantId,actorId,terms.points,terms.voucher_id??null,terms.voucher_qty,terms.promo,terms.message??null,expires,plan.is_test]);
      const quest=(await tx.client.query('SELECT title FROM quests WHERE id=$1',[plan.quest_id])).rows[0];
      await notifyMerchantOwners(tx.client,merchantId,Boolean(plan.is_test),`sponsorship:${inserted.rows[0].id}:requested`,'sponsorship',
        'New Eco-Quest sponsorship request',`A destination author invited your business to sponsor “${quest?.title ?? 'an Eco-Quest'}”.`, '/merchant/funding');
      return inserted.rows[0];
    });
    return result;
  }

  async topUp(actorId:string,planId:string,points:number,key:string){
    if(!Number.isSafeInteger(points)||points<=0||points>1_000_000_000)throw new FundingError('INVALID_AMOUNT',400,'Top-up points must be a positive supported amount.');
    return fundingCommand(this.pool,actorId,'funding.merchant_top_up',key,{planId,points},async tx=>{
      const plan=await lockPlan(tx.client,planId);
      if(plan.status!=='active'||new Date(plan.ends_at).getTime()<=Date.now())throw new FundingError('FUNDING_PLAN_STATE',409,'Only an active funding round can receive merchant top-ups.');
      const accepted=(await tx.client.query("SELECT * FROM quest_sponsorships WHERE plan_id=$1 AND status='accepted' AND is_test=$2 ORDER BY id FOR UPDATE",[planId,plan.is_test])).rows;
      const owned=[] as any[];
      for(const sponsorship of accepted){
        const membership=await tx.client.query("SELECT 1 FROM merchant_memberships WHERE merchant_id=$1 AND user_id=$2 AND role='owner' AND status='active'",[sponsorship.merchant_id,actorId]);
        if(membership.rows.length)owned.push(sponsorship);
      }
      const sponsorship=owned[0];if(!sponsorship)throw new FundingError('MERCHANT_OWNER_REQUIRED',403,'Only an existing sponsor owner may add points to this round.');
      await assertOwner(tx.client,actorId,sponsorship.merchant_id,Boolean(plan.is_test));
      const contribution=(await tx.client.query("SELECT * FROM quest_funding_contributions WHERE plan_id=$1 AND merchant_id=$2 AND funder_kind='merchant' FOR UPDATE",[planId,sponsorship.merchant_id])).rows[0];
      if(!contribution||Boolean(contribution.is_test)!==Boolean(plan.is_test))throw new FundingError('SCOPE_MISMATCH',409,'Sponsor contribution is unavailable or belongs to another scope.');
      const account=(await tx.client.query('SELECT balance_points,is_test FROM points_accounts WHERE id=$1 FOR UPDATE',[`merchant:${sponsorship.merchant_id}`])).rows[0];
      if(!account||Boolean(account.is_test)!==Boolean(plan.is_test))throw new FundingError('SCOPE_MISMATCH',409,'Merchant point scope does not match.');
      if(plan.mode==='window'&&Number(account.balance_points)<Number(contribution.remaining_points)+points)throw new FundingError('INSUFFICIENT_POINTS',409,'The merchant balance does not cover this additional spending cap.');
      if(plan.mode==='budget')await tx.transfer({from:{id:`merchant:${sponsorship.merchant_id}`,kind:'merchant'},to:{id:`quest_budget:${planId}`,kind:'quest_budget'},points,type:'quest_fund_lock',referenceType:'quest_sponsorship',referenceId:sponsorship.id,actorId,metadata:{merchant_id:sponsorship.merchant_id,top_up:true}});
      await tx.client.query('UPDATE quest_funding_contributions SET committed_points=committed_points+$2,remaining_points=remaining_points+$2,updated_at=NOW() WHERE id=$1',[contribution.id,points]);
      return {plan_id:planId,merchant_id:sponsorship.merchant_id,added_points:points,simulated:true};
    });
  }

  async counter(actorId: string, id: string, terms: Terms, version: number, key: string) {
    validTerms(terms);
    return fundingCommand(this.pool,actorId,'sponsorship.counter',key,{id,terms,version},async tx=>{
      const sponsorship=await sponsorshipForUpdate(tx.client,id);
      if(sponsorship.status!=='requested'||Number(sponsorship.terms_version)!==version) throw new FundingError('SPONSORSHIP_TERMS_CHANGED',409,'Refresh this request before countering.');
      const plan=await lockPlan(tx.client,sponsorship.plan_id);
      if(!['pending_sponsors','active'].includes(plan.status)||new Date(sponsorship.expires_at).getTime()<=Date.now()) throw new FundingError('SPONSORSHIP_STATE',409,'This sponsorship request has expired or is no longer open.');
      await assertOwner(tx.client,actorId,sponsorship.merchant_id,Boolean(plan.is_test));
      await assertVoucher(tx.client,sponsorship.merchant_id,terms.voucher_id??sponsorship.voucher_id,terms.voucher_qty);
      const result=await tx.client.query(
        `UPDATE quest_sponsorships SET status='countered',counter_points=$2,counter_voucher_qty=$3,counter_promo=$4,counter_message=$5,
           terms_version=terms_version+1,responded_by=$6,responded_at=NOW(),updated_at=NOW() WHERE id=$1 RETURNING *`,
        [id,terms.points,terms.voucher_qty,terms.promo,terms.message??null,actorId]);
      const title=(await tx.client.query('SELECT title FROM quests WHERE id=$1',[plan.quest_id])).rows[0]?.title ?? 'an Eco-Quest';
      await insertFundingNotification(tx.client,{
        userId:sponsorship.requested_by,isTest:Boolean(plan.is_test),eventKey:`sponsorship:${id}:countered:${version+1}`,
        kind:'sponsorship',title:'Merchant sent a sponsorship counter-offer',
        message:`The merchant proposed revised sponsorship terms for “${title}”. Review them before accepting.`,
        href:`/funding?quest_id=${encodeURIComponent(plan.quest_id)}`,
      });
      return result.rows[0];
    });
  }

  async accept(actorId: string,id: string,version: number,key: string) {
    const result=await fundingCommand(this.pool,actorId,'sponsorship.accept',key,{id,version},async tx=>{
      const sponsorship=await sponsorshipForUpdate(tx.client,id);
      if(sponsorship.status!=='requested'||Number(sponsorship.terms_version)!==version) throw new FundingError('SPONSORSHIP_TERMS_CHANGED',409,'Refresh this request before accepting it.');
      return acceptTerms(tx,sponsorship,{points:Number(sponsorship.points),voucher_id:sponsorship.voucher_id,voucher_qty:Number(sponsorship.voucher_qty),promo:Boolean(sponsorship.promo),message:sponsorship.message},actorId,true);
    });
    const quest=(await this.pool.query('SELECT p.quest_id FROM quest_sponsorships s JOIN quest_funding_plans p ON p.id=s.plan_id WHERE s.id=$1',[id])).rows[0];
    if(quest) await refreshQuestMirror(this.pool,quest.quest_id);
    return result;
  }

  async acceptCounter(actorId:string,id:string,version:number,key:string) {
    const result=await fundingCommand(this.pool,actorId,'sponsorship.accept_counter',key,{id,version},async tx=>{
      const sponsorship=await sponsorshipForUpdate(tx.client,id);
      if(sponsorship.status!=='countered'||Number(sponsorship.terms_version)!==version||sponsorship.requested_by!==actorId) throw new FundingError('SPONSORSHIP_TERMS_CHANGED',409,'The counter changed or this is not your sponsorship request.');
      const terms={points:Number(sponsorship.counter_points??sponsorship.points),voucher_id:sponsorship.voucher_id,voucher_qty:Number(sponsorship.counter_voucher_qty??sponsorship.voucher_qty),promo:Boolean(sponsorship.counter_promo??sponsorship.promo),message:sponsorship.counter_message??sponsorship.message};
      return acceptTerms(tx,sponsorship,terms,actorId,false);
    });
    const quest=(await this.pool.query('SELECT p.quest_id FROM quest_sponsorships s JOIN quest_funding_plans p ON p.id=s.plan_id WHERE s.id=$1',[id])).rows[0];
    if(quest) await refreshQuestMirror(this.pool,quest.quest_id);
    return result;
  }

  async decide(actorId:string,id:string,action:'decline'|'withdraw',key:string,reason?:string) {
    return fundingCommand(this.pool,actorId,`sponsorship.${action}`,key,{id,action,reason},async tx=>{
      const sponsorship=await sponsorshipForUpdate(tx.client,id);
      const plan=await lockPlan(tx.client,sponsorship.plan_id);
      if(new Date(sponsorship.expires_at).getTime()<=Date.now()) throw new FundingError('SPONSORSHIP_STATE',409,'This sponsorship request has expired.');
      if(action==='withdraw') {
        if(sponsorship.requested_by!==actorId||!['requested','countered'].includes(sponsorship.status)) throw new FundingError('SPONSORSHIP_STATE',409,'Only the requesting author may withdraw an open request.');
      } else {
        await assertOwner(tx.client,actorId,sponsorship.merchant_id,Boolean(plan.is_test));
        if(!['requested','countered'].includes(sponsorship.status)) throw new FundingError('SPONSORSHIP_STATE',409,'Only an open request can be declined.');
      }
      const status=action==='withdraw'?'withdrawn':'declined';
      const updated=(await tx.client.query('UPDATE quest_sponsorships SET status=$2,counter_message=$3,responded_by=$4,responded_at=NOW(),updated_at=NOW(),terms_version=terms_version+1 WHERE id=$1 RETURNING *',[id,status,reason?.slice(0,500)??null,actorId])).rows[0];
      if(action==='withdraw'){
        await notifyMerchantOwners(tx.client,sponsorship.merchant_id,Boolean(plan.is_test),`sponsorship:${id}:withdrawn:${updated.terms_version}`,'sponsorship',
          'Sponsorship request withdrawn','The destination author withdrew their Eco-Quest sponsorship request.','/merchant/funding');
      }else{
        const title=(await tx.client.query('SELECT title FROM quests WHERE id=$1',[plan.quest_id])).rows[0]?.title ?? 'this Eco-Quest';
        await insertFundingNotification(tx.client,{userId:sponsorship.requested_by,isTest:Boolean(plan.is_test),eventKey:`sponsorship:${id}:declined:${updated.terms_version}`,
          kind:'sponsorship',title:'Merchant declined the sponsorship request',message:`The merchant declined the request for “${title}”.`,href:`/funding?quest_id=${encodeURIComponent(plan.quest_id)}`});
      }
      return updated;
    });
  }

  async inbox(actorId:string,status?:string) {
    const client=await this.pool.connect();
    try {
      const allowed=['requested','countered','accepted','declined','withdrawn','expired'];
      if(status&&!allowed.includes(status)) throw new FundingError('INVALID_STATUS',400,'Unsupported sponsorship status.');
      const result=await client.query(
        `SELECT s.*,p.quest_id,p.status AS plan_status,q.title AS quest_title,sp.name AS spot_name
           FROM quest_sponsorships s JOIN quest_funding_plans p ON p.id=s.plan_id JOIN quests q ON q.id=p.quest_id
           LEFT JOIN spots sp ON sp.quest_id=q.id JOIN merchant_memberships mm ON mm.merchant_id=s.merchant_id
          JOIN merchants m ON m.id=s.merchant_id JOIN users u ON u.id=mm.user_id
          WHERE mm.user_id=$1 AND mm.status='active' AND mm.role IN ('owner','staff') AND m.status='active'
            AND m.is_test=s.is_test AND u.is_test=s.is_test AND ($2::text IS NULL OR s.status=$2)
          ORDER BY s.updated_at DESC,s.id LIMIT 100`,[actorId,status??null]);
      return {items:result.rows,simulated:true};
    } finally {client.release();}
  }
}
