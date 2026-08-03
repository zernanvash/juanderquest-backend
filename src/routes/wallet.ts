import { Router, Response } from 'express';
import { authenticateToken, AuthRequest } from '../middleware/auth.js';
import { db } from '../db/index.js';
import { governanceStore } from './proposals.js';

const router = Router();

router.get('/wallet', authenticateToken, (req: AuthRequest, res: Response) => {
  const user = db.findUserById(req.user!.id);
  const wallet = governanceStore.getWallet(req.user!.id);
  
  const mjdq_balance = user ? (user.mjdq_balance ?? wallet.balance_mjdq) : wallet.balance_mjdq;
  const formatted_jdq = mjdq_balance / 1000;
  const jdq_governance_balance = user ? (user.jdq_governance_balance ?? 15) : 15;
  const scout_reputation = user ? (user.scout_reputation ?? 100) : 100;
  
  res.json({
    success: true,
    data: {
      settlement: wallet.settlement,
      unit: 'mJDQ',
      mjdq_balance,
      jdq_governance_balance,
      formatted_mjdq: `${formatted_jdq.toFixed(2)} JDQ`,
      scout_reputation,
      demo_points: user ? user.demo_points : wallet.balance_jdq,
      balance_mjdq: mjdq_balance,
      balance_jdq: formatted_jdq,
      fiat_purchasing_power_php: formatted_jdq * 1.0, // 1 JDQ / 1000 mJDQ >= ₱1.00 Floor
      oracle_rate_php: 1.0,
    },
  });
});

router.get('/wallet/ledger', authenticateToken, (req: AuthRequest, res: Response) => {
  const govLedger = governanceStore.getWallet(req.user!.id).ledger;
  const dbLedger = db.ledger.filter((l) => l.user_id === req.user!.id);

  res.json({
    success: true,
    data: {
      governance_ledger: govLedger,
      system_ledger: dbLedger,
    },
  });
});

export default router;
