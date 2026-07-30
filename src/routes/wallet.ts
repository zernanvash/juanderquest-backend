import { Router, Response } from 'express';
import { authenticateToken, AuthRequest } from '../middleware/auth.js';
import { governanceStore } from './proposals.js';

const router = Router();

router.get('/wallet', authenticateToken, (req: AuthRequest, res: Response) => {
  const wallet = governanceStore.getWallet(req.user!.id);
  res.json({
    success: true,
    data: {
      settlement: wallet.settlement,
      unit: wallet.unit,
      balance_mjdq: wallet.balance_mjdq,
      balance_jdq: wallet.balance_jdq,
    },
  });
});

router.get('/wallet/ledger', authenticateToken, (req: AuthRequest, res: Response) => {
  res.json({ success: true, data: governanceStore.getWallet(req.user!.id).ledger });
});

export default router;
