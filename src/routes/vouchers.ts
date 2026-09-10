import { Router, Response } from 'express';
import { z } from 'zod';
import { db } from '../db/index.js';
import { governanceStore } from './proposals.js';
import { authenticateToken, AuthRequest } from '../middleware/auth.js';
import { validateRequest } from '../middleware/validate.js';
import { vouchersService } from '../services/vouchers.js';

const router = Router();

const redeemSchema = z.object({
  body: z.object({
    idempotency_key: z.string().min(8, 'Idempotency key is required'),
    voucher_id: z.string().optional(),
    id: z.string().optional(),
  }),
});

async function handleRedemption(voucherId: string, req: AuthRequest, res: Response) {
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

router.get('/vouchers', (_req, res: Response) => {
  res.json({ success: true, data: db.listVouchers() });
});

router.post('/vouchers/:id/redeem', authenticateToken, validateRequest(redeemSchema), async (req: AuthRequest, res: Response) => {
  return await handleRedemption(req.params.id, req, res);
});

router.post('/vouchers/redeem', authenticateToken, validateRequest(redeemSchema), async (req: AuthRequest, res: Response) => {
  const voucherId = req.body.voucher_id || req.body.id;
  if (!voucherId) {
    return res.status(400).json({
      success: false,
      error: { code: 'INVALID_REQUEST', message: 'voucher_id is required.' },
    });
  }
  return await handleRedemption(voucherId, req, res);
});

export default router;
