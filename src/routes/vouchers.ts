import { getActiveJuanChoicePerks } from '../juanchoice/perks.js';
import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { env } from '../config/env.js';
import { db } from '../db/index.js';
import { governanceStore } from './proposals.js';
import { authenticateToken, requireBoundWallet, AuthRequest } from '../middleware/auth.js';
import { validateRequest } from '../middleware/validate.js';
import { vouchersService } from '../services/vouchers.js';
import { getPool } from '../db/pool.js';
import { forwardAsyncRouteErrors } from '../middleware/asyncRoutes.js';

const router = Router();

const redeemSchema = z.object({
  body: z.object({
    idempotency_key: z.string().min(8, 'Idempotency key is required'),
    voucher_id: z.string().optional(),
    id: z.string().optional(),
  }),
});

async function marketplaceRedemptionGate(req: Request, res: Response, next: NextFunction) {
  if (env.MARKETPLACE_ENABLED) return next();
  const voucherId = req.params.id || (req.body?.voucher_id as string | undefined) || (req.body?.id as string | undefined);
  if (voucherId) {
    const pool = getPool();
    const isPreview = pool
      ? (await pool.query('SELECT 1 FROM vouchers WHERE id=$1 AND availability=$2 AND is_active=TRUE', [voucherId, 'preview'])).rowCount! > 0
      : ['v1', 'v2', 'v3'].includes(voucherId);
    if (isPreview) return res.status(409).json({ success:false, error:{ code:'NOT_REDEEMABLE', message:'This partner offer is coming soon.' } });
  }
  return res.status(503).json({ success:false, error:{ code:'FEATURE_UNAVAILABLE', message:'Merchant vouchers are under development.' } });
}

async function handleRedemption(voucherId: string, req: AuthRequest, res: Response) {
  const pool = getPool();
  if (pool) {
    const preview = await pool.query('SELECT 1 FROM vouchers WHERE id=$1 AND availability=$2 AND is_active=TRUE', [voucherId, 'preview']);
    if (preview.rowCount) return res.status(409).json({ success:false, error:{ code:'NOT_REDEEMABLE', message:'This partner offer is coming soon.' } });
  } else if (['v1','v2','v3'].includes(voucherId)) {
    return res.status(409).json({ success:false, error:{ code:'NOT_REDEEMABLE', message:'This partner offer is coming soon.' } });
  }
  if (!env.MARKETPLACE_ENABLED) {
    return res.status(503).json({ success:false, error:{ code:'FEATURE_UNAVAILABLE', message:'Merchant vouchers are under development.' } });
  }
  if (governanceStore.getControls().pause_vouchers) {
    return res.status(403).json({
      success: false,
      error: { code: 'VOUCHERS_PAUSED', message: 'Voucher redemption is temporarily paused.' },
    });
  }

  try {
    const result = await vouchersService.redeemVoucher(voucherId, req.user!.id, req.body.idempotency_key);

    if (!result.success) {
      return res.status(result.statusCode || 400).json({
        success: false,
        error: result.error,
      });
    }

    const { redemption, replayed } = result.data!;
    const voucher = db.vouchers.find((item) => item.id === redemption.voucher_id);

    return res.status(replayed ? 200 : 201).json({
      success: true,
      data: {
        ...redemption,
        voucher_title: voucher?.title || 'Unknown Voucher',
        merchant_name: db.merchants.find((merchant) => merchant.id === voucher?.merchant_id)?.name || 'Unknown Merchant',
      },
    });
  } catch (err) {
    console.error('[vouchers] redemption failed:', err);
    return res.status(503).json({
      success: false,
      error: { code: 'STORAGE_UNAVAILABLE', message: 'Durable redemption storage is unavailable. Please try again later.' },
    });
  }
}

router.get('/vouchers', async (_req, res: Response) => {
  const pool=getPool();
  if(pool){
    try {
      // Plan 65: a reigning msme_partner_spotlight pins vouchers from that town to the top.
      const towns=(await getActiveJuanChoicePerks(pool,false).catch(()=>[]))
        .filter(perk=>perk.key==='msme_partner_spotlight').map(perk=>perk.municipality);
      const r=await pool.query(`SELECT v.*,m.name AS merchant_name,v.partner_label AS "partnerLabel",v.icon_key AS "iconKey",(v.availability='live' AND $1::boolean) AS redeemable,
          EXISTS (SELECT 1 FROM unnest($2::text[]) town WHERE m.location ILIKE '%' || town || '%') AS featured
        FROM vouchers v JOIN merchants m ON m.id=v.merchant_id WHERE v.is_active=TRUE AND (v.availability='preview' OR $1::boolean)
        ORDER BY featured DESC,v.sort_order,v.id`,[env.MARKETPLACE_ENABLED,towns]);
      return res.json({success:true,data:r.rows}); }
    catch { return res.status(503).json({success:false,error:{code:'STORAGE_UNAVAILABLE',message:'Voucher catalog unavailable.'}}); }
  }
  const values=db.listVouchers().filter(v=>env.MARKETPLACE_ENABLED?true:['v1','v2','v3'].includes(v.id)).map(v=>({...v,availability:'preview',redeemable:false,partnerLabel:v.id==='v1'?'Partner grill \u00b7 Dagupan':v.id==='v2'?'Partner caf\u00e9 \u00b7 Bolinao':'Souvenir shop \u00b7 Alaminos',iconKey:v.id==='v1'?'meal':v.id==='v2'?'coffee':'souvenir'}));
  res.json({ success: true, data: values });
});

router.post('/vouchers/:id/redeem', marketplaceRedemptionGate, authenticateToken, requireBoundWallet, validateRequest(redeemSchema), async (req: AuthRequest, res: Response) => {
  return await handleRedemption(req.params.id, req, res);
});

router.post('/vouchers/redeem', marketplaceRedemptionGate, authenticateToken, requireBoundWallet, validateRequest(redeemSchema), async (req: AuthRequest, res: Response) => {
  const voucherId = req.body.voucher_id || req.body.id;
  if (!voucherId) {
    return res.status(400).json({
      success: false,
      error: { code: 'INVALID_REQUEST', message: 'voucher_id is required.' },
    });
  }
  return await handleRedemption(voucherId, req, res);
});

forwardAsyncRouteErrors(router);

export default router;
