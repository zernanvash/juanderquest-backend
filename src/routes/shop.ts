import { Router } from 'express';
import { z } from 'zod';
import { authenticateToken, optionalAuthenticateToken, AuthRequest } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { getPool } from '../db/pool.js';
import { listCosmetics, purchaseCosmetic, ownedCosmetics } from '../shop/cosmetics.js';
import { cosmeticsFor } from '../shop/render.js';

export const shopRouter = Router();
const fail=(res:any,error:unknown)=>{
  const code=error instanceof Error?error.message:'STORAGE_UNAVAILABLE';
  const mapped:Record<string,[number,string]>={FINANCIAL_ACTIVITY_PAUSED:[409,'Financial activity is temporarily paused.'],USER_NOT_FOUND:[404,'Traveler not found.'],NOT_AVAILABLE:[409,'This item is not currently available.'],NOT_FOR_SALE:[409,'This item is not for sale with points.'],BADGE_REQUIRED:[409,'This item requires its achievement badge.'],ALREADY_OWNED:[409,'You already own this item.'],INSUFFICIENT_POINTS:[409,'You do not have enough points.'],IDEMPOTENCY_CONFLICT:[409,'This idempotency key was used for another item.'],STORAGE_UNAVAILABLE:[503,'Shop storage is unavailable.']};
  const [status,message]=mapped[code]??[503,'Shop request failed.']; return res.status(status).json({success:false,error:{code,message}});
};
shopRouter.get('/shop/cosmetics',optionalAuthenticateToken,async(req:AuthRequest,res)=>{
  try { const data=await listCosmetics(req.user?.id); if(req.user)res.setHeader('Cache-Control','private, max-age=30'); return res.json({success:true,data}); } catch(e){return fail(res,e);}
});
shopRouter.post('/shop/cosmetics/:id/purchase',authenticateToken,rateLimit({policyId:'shop:purchase',windowMs:60_000,max:10,keyStrategy:'actor'}),async(req:AuthRequest,res)=>{
  const parsed=z.object({idempotency_key:z.string().min(8).max(80)}).safeParse(req.body); if(!parsed.success)return res.status(400).json({success:false,error:{code:'INVALID_REQUEST',message:'A valid idempotency_key is required.'}});
  try { const result=await purchaseCosmetic(req.user!.id,req.params.id,parsed.data.idempotency_key);return res.status(result.statusCode).json({success:true,data:result});}catch(e){return fail(res,e);}
});
shopRouter.get('/me/cosmetics',authenticateToken,async(req:AuthRequest,res)=>{
  try {const data=await ownedCosmetics(req.user!.id);return res.json({success:true,data});}catch(e){return fail(res,e);}
});
shopRouter.put('/me/cosmetics/loadout',authenticateToken,rateLimit({policyId:'shop:loadout',windowMs:60_000,max:30,keyStrategy:'actor'}),async(req:AuthRequest,res)=>{
  const schema=z.object({banner_id:z.string().nullable().optional(),frame_id:z.string().nullable().optional(),title_id:z.string().nullable().optional(),name_color_id:z.string().nullable().optional()}).strict().refine(v=>Object.keys(v).length>0);
  const parsed=schema.safeParse(req.body);if(!parsed.success)return res.status(400).json({success:false,error:{code:'INVALID_REQUEST',message:'Provide one or more valid loadout slots.'}});
  const pool=getPool();if(!pool)return fail(res,new Error('STORAGE_UNAVAILABLE'));const c=await pool.connect();
  try{
    await c.query('BEGIN');
    const kinds:Record<string,string>={banner_id:'banner',frame_id:'frame',title_id:'title',name_color_id:'name_color'};
    for(const [slot,id] of Object.entries(parsed.data)){if(!id)continue;const row=(await c.query('SELECT i.kind FROM user_cosmetics uc JOIN cosmetic_items i ON i.id=uc.item_id WHERE uc.user_id=$1 AND uc.item_id=$2',[req.user!.id,id])).rows[0];if(!row){await c.query('ROLLBACK');return res.status(400).json({success:false,error:{code:'NOT_OWNED',message:`${slot} item is not owned.`}});}if(row.kind!==kinds[slot]){await c.query('ROLLBACK');return res.status(400).json({success:false,error:{code:'WRONG_SLOT',message:`${slot} item has the wrong kind.`}});}}
    const existing=(await c.query('SELECT banner_id,frame_id,title_id,name_color_id FROM user_cosmetic_loadout WHERE user_id=$1',[req.user!.id])).rows[0]??{};
    const next={banner_id:parsed.data.banner_id===undefined?existing.banner_id??null:parsed.data.banner_id,frame_id:parsed.data.frame_id===undefined?existing.frame_id??null:parsed.data.frame_id,title_id:parsed.data.title_id===undefined?existing.title_id??null:parsed.data.title_id,name_color_id:parsed.data.name_color_id===undefined?existing.name_color_id??null:parsed.data.name_color_id};
    await c.query(`INSERT INTO user_cosmetic_loadout(user_id,banner_id,frame_id,title_id,name_color_id,updated_at) VALUES($1,$2,$3,$4,$5,now()) ON CONFLICT(user_id) DO UPDATE SET banner_id=EXCLUDED.banner_id,frame_id=EXCLUDED.frame_id,title_id=EXCLUDED.title_id,name_color_id=EXCLUDED.name_color_id,updated_at=now()`,[req.user!.id,next.banner_id,next.frame_id,next.title_id,next.name_color_id]);
    await c.query('COMMIT');const render=(await cosmeticsFor([req.user!.id],pool)).get(req.user!.id);return res.json({success:true,data:{loadout:next,cosmetics:render}});
  }catch(e){await c.query('ROLLBACK').catch(()=>{});return fail(res,e);}finally{c.release();}
});
shopRouter.get('/shop/teasers',async(_req,res)=>{const pool=getPool();if(!pool)return res.json({success:true,data:[]});try{const r=await pool.query('SELECT id,title,description,icon_key AS "iconKey",eta_text AS "etaText" FROM shop_teasers WHERE is_active=TRUE ORDER BY sort_order,id');return res.json({success:true,data:r.rows});}catch{return res.status(503).json({success:false,error:{code:'STORAGE_UNAVAILABLE',message:'Shop storage is unavailable.'}});}});
