import { Router, Response } from 'express';
import { z } from 'zod';
import { db } from '../db/index.js';
import { governanceStore } from './proposals.js';
import { authenticateToken, AuthRequest } from '../middleware/auth.js';
import { validateRequest } from '../middleware/validate.js';

const router = Router();

const redeemSchema = z.object({
  body: z.object({
    idempotency_key: z.string().min(8, 'Idempotency key is required'),
  }),
});

router.get('/vouchers', (_req, res: Response) => {
  res.json({ success: true, data: db.listVouchers() });
});

router.post('/vouchers/:id/redeem', authenticateToken, validateRequest(redeemSchema), (req: AuthRequest, res: Response) => {
  if (governanceStore.getControls().pause_vouchers) {
    return res.status(403).json({
      success: false,
      error: { code: 'VOUCHERS_PAUSED', message: 'Voucher redemption is temporarily paused.' },
    });
  }

  const result = db.redeemVoucher(req.params.id, req.user!.id, req.body.idempotency_key);

  if ('error' in result) {
    const responses = {
      NOT_FOUND: () =>
        res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: `Voucher '${req.params.id}' not found or inactive.` } }),
      INSUFFICIENT_POINTS: () =>
        res.status(409).json({ success: false, error: { code: 'INSUFFICIENT_POINTS', message: 'You do not have enough demo points for this voucher.' } }),
      ALREADY_REDEEMED: () =>
        res.status(409).json({ success: false, error: { code: 'ALREADY_REDEEMED', message: 'You have already redeemed this voucher.' } }),
    };
    return responses[result.error]();
  }

  const { redemption, replayed } = result;
  const voucher = db.vouchers.find((item) => item.id === redemption.voucher_id);
  // Only charge the governance ledger on the first (non-replayed) redemption.
  if (!replayed) {
    try {
      governanceStore.consumePoints(redemption.user_id, redemption.cost_points, redemption.voucher_id, redemption.id);
    } catch (error) {
      return res.status(409).json({ success: false, error: { code: 'INSUFFICIENT_POINTS', message: 'You do not have enough demo points for this voucher.' } });
    }
  }

  return res.status(replayed ? 200 : 201).json({
    success: true,
    data: {
      ...redemption,
      voucher_title: voucher?.title || 'Unknown Voucher',
      merchant_name: db.merchants.find((merchant) => merchant.id === voucher?.merchant_id)?.name || 'Unknown Merchant',
    },
  });
});

export default router;
