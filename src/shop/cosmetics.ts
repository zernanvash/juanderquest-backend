import { randomUUID } from 'crypto';
import { getPool } from '../db/pool.js';
import { lockGovernanceSnapshot, commitGovernanceTransaction } from '../governance/transaction.js';
import { movePoints } from '../funding/ledger.js';

export const NAME_COLORS = ['#2d6a4f','#c2410c','#1d4ed8','#7e22ce'] as const;
export const validateAsset = (kind: string, asset: any): boolean => {
  if (!asset || typeof asset !== 'object' || Array.isArray(asset)) return false;
  const hex = (v: unknown) => typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v);
  if (kind === 'banner') return asset.style === 'gradient' && Array.isArray(asset.colors) && asset.colors.length >= 2 && asset.colors.length <= 3 && asset.colors.every(hex) && Number.isInteger(asset.angle) && asset.angle >= 0 && asset.angle <= 360 && ['none','waves','islands','capiz','bamboo','sun'].includes(asset.pattern);
  if (kind === 'frame') return asset.style === 'ring' && Array.isArray(asset.colors) && asset.colors.length >= 1 && asset.colors.length <= 3 && asset.colors.every(hex) && Number.isInteger(asset.width) && asset.width >= 2 && asset.width <= 6 && typeof asset.animated === 'boolean';
  if (kind === 'title') return typeof asset.text === 'string' && asset.text.length > 0 && asset.text.length <= 24;
  if (kind === 'name_color') return NAME_COLORS.includes(asset.color);
  return false;
};

export async function listCosmetics(userId?: string) {
  const pool = getPool(); if (!pool) throw new Error('STORAGE_UNAVAILABLE');
  let isTest = false;
  if (userId) isTest = Boolean((await pool.query('SELECT is_test FROM users WHERE id=$1',[userId])).rows[0]?.is_test);
  if (userId) await grantAchievementCosmetics(pool, userId);
  const result = await pool.query(`SELECT i.*, a.title AS achievement_title,
      (uc.user_id IS NOT NULL) AS owned, (l.banner_id=i.id OR l.frame_id=i.id OR l.title_id=i.id OR l.name_color_id=i.id) AS equipped
    FROM cosmetic_items i LEFT JOIN achievement_definitions a ON a.id=i.unlock_achievement_id
    LEFT JOIN user_cosmetics uc ON uc.item_id=i.id AND uc.user_id=$1
    LEFT JOIN user_cosmetic_loadout l ON l.user_id=$1
    WHERE i.is_active=TRUE AND (i.available_from IS NULL OR i.available_from<=now()) AND (i.available_until IS NULL OR i.available_until>now()) AND (i.is_test=FALSE OR $2=TRUE)
    ORDER BY i.kind,i.sort_order,i.id`,[userId ?? null,isTest]);
  return result.rows.map((r:any) => {
    const achievement = r.unlock_achievement_id ? { achievementId:r.unlock_achievement_id,title:r.achievement_title ?? r.unlock_achievement_id } : undefined;
    const lockedReason = r.unlock_achievement_id && !r.owned ? 'badge_required' : r.price_tjdq != null && r.price_points == null && !achievement ? 'tjdq_coming_soon' : r.price_points == null && !achievement ? 'not_for_sale' : undefined;
    return { id:r.id,kind:r.kind,name:r.name,description:r.description,rarity:r.rarity,pricePoints:r.price_points,priceTjdq:r.price_tjdq == null ? null : Number(r.price_tjdq),unlock:achievement,asset:r.asset,owned:Boolean(r.owned),equipped:Boolean(r.equipped),buyable:r.price_points != null && !r.owned && !achievement,lockedReason };
  });
}

export async function grantAchievementCosmetics(client:any,userId:string) {
  await client.query(`INSERT INTO user_cosmetics(user_id,item_id,source)
    SELECT $1,i.id,'achievement' FROM cosmetic_items i
    JOIN achievement_awards a ON a.user_id=$1 AND a.achievement_id=i.unlock_achievement_id AND a.revoked_at IS NULL
    WHERE i.unlock_achievement_id IS NOT NULL ON CONFLICT(user_id,item_id) DO NOTHING`,[userId]);
}

export async function purchaseCosmetic(userId:string,itemId:string,key:string) {
  const pool=getPool(); if(!pool) throw new Error('STORAGE_UNAVAILABLE'); const c=await pool.connect();
  try {
    await c.query('BEGIN'); const snapshot=await lockGovernanceSnapshot(c);
    if(snapshot.controls?.pause_all_financial) throw new Error('FINANCIAL_ACTIVITY_PAUSED');
    const u=(await c.query('SELECT id,demo_points,is_test FROM users WHERE id=$1 FOR UPDATE',[userId])).rows[0];
    if(!u) throw new Error('USER_NOT_FOUND');
    const replay=(await c.query('SELECT uc.item_id,uc.points_spent,i.name,i.kind,i.asset,u.demo_points FROM user_cosmetics uc JOIN cosmetic_items i ON i.id=uc.item_id JOIN users u ON u.id=uc.user_id WHERE uc.user_id=$1 AND uc.idempotency_key=$2',[userId,key])).rows[0];
    if(replay) { if(replay.item_id!==itemId) throw new Error('IDEMPOTENCY_CONFLICT'); await commitGovernanceTransaction(c); return { item:{id:replay.item_id,name:replay.name,kind:replay.kind,asset:replay.asset},pointsBalance:Number(replay.demo_points),replayed:true,statusCode:200 }; }
    const item=(await c.query(`SELECT * FROM cosmetic_items WHERE id=$1 AND is_active=TRUE AND (available_from IS NULL OR available_from<=now()) AND (available_until IS NULL OR available_until>now()) FOR SHARE`,[itemId])).rows[0];
    if(!item) throw new Error('NOT_AVAILABLE'); if(item.price_points==null) throw new Error('NOT_FOR_SALE');
    if(item.is_test && !u.is_test) throw new Error('NOT_AVAILABLE');
    if(item.unlock_achievement_id) throw new Error('BADGE_REQUIRED');
    if((await c.query('SELECT 1 FROM user_cosmetics WHERE user_id=$1 AND item_id=$2',[userId,itemId])).rowCount) throw new Error('ALREADY_OWNED');
    if(Number(u.demo_points)<Number(item.price_points)) throw new Error('INSUFFICIENT_POINTS');
    const group=await movePoints(c,{from:{id:userId,userId,kind:'traveler'},to:{id:u.is_test?'treasury:test':'treasury',kind:'treasury'},points:Number(item.price_points),type:'shop_cosmetic_purchase',referenceType:'cosmetic_purchase',referenceId:itemId,actorId:userId,idempotencyKey:key,metadata:{item_id:itemId}});
    const groupId=group.entries[0].transaction_group_id;
    await c.query(`INSERT INTO user_cosmetics(user_id,item_id,source,points_spent,idempotency_key,ledger_group_id) VALUES($1,$2,'purchase',$3,$4,$5)`,[userId,itemId,item.price_points,key,groupId]);
    await c.query(`INSERT INTO cosmetic_audit(id,actor_user_id,action,item_id,target_user_id,details) VALUES($1,$2,'purchase',$3,$2,$4::jsonb)`,[randomUUID(),userId,itemId,JSON.stringify({points:item.price_points,ledger_group_id:groupId})]);
    await commitGovernanceTransaction(c);
    return {item:{id:item.id,name:item.name,kind:item.kind,asset:item.asset},pointsBalance:Number(group.userBalanceUpdate?.demoPoints),replayed:false,statusCode:201};
  } catch(e) { await c.query('ROLLBACK').catch(()=>{}); throw e; } finally { c.release(); }
}

export async function ownedCosmetics(userId:string) {
  const pool=getPool();if(!pool)throw new Error('STORAGE_UNAVAILABLE'); await grantAchievementCosmetics(pool,userId);
  const [owned,loadout,user]=await Promise.all([
    pool.query('SELECT i.*,uc.acquired_at,uc.source,uc.points_spent FROM user_cosmetics uc JOIN cosmetic_items i ON i.id=uc.item_id WHERE uc.user_id=$1 ORDER BY i.kind,i.sort_order',[userId]),
    pool.query('SELECT banner_id,frame_id,title_id,name_color_id FROM user_cosmetic_loadout WHERE user_id=$1',[userId]),
    pool.query('SELECT demo_points FROM users WHERE id=$1',[userId])]);
  return {owned:owned.rows.map((i:any)=>({...i,acquiredAt:i.acquired_at})),loadout:loadout.rows[0]??{banner_id:null,frame_id:null,title_id:null,name_color_id:null},pointsBalance:Number(user.rows[0]?.demo_points??0)};
}
