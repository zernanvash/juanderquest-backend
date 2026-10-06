import { Router, Response } from 'express';
import { authenticateToken, AuthRequest } from '../middleware/auth.js';
import { db } from '../db/index.js';
import { governanceStore } from './proposals.js';
import { authoritativeBalance } from '../governance/transaction.js';

const router = Router();

router.get('/wallet', authenticateToken, async (req: AuthRequest, res: Response) => {
  const pool = db.usersRepo.getPool();
  const localUser = db.findUserById(req.user!.id);
  let demoPoints = localUser?.demo_points;
  let scoutReputation = localUser?.scout_reputation ?? 0;
  const governanceBalance = localUser?.jdq_governance_balance ?? 15;
  let previousMjdq = governanceStore.balanceOf(req.user!.id);
  if (pool) {
    try {
      // A single SQL statement gives points and the remainder the same MVCC view.
      const result = await pool.query(
        'SELECT u.demo_points, u.scout_reputation, gs.data FROM users u CROSS JOIN governance_snapshot gs WHERE u.id = $1 AND gs.id = 1',
        [req.user!.id]
      );
      if (!result.rows[0]?.data) throw new Error('WALLET_STATE_MISSING');
      demoPoints = Number(result.rows[0].demo_points);
      scoutReputation = Number(result.rows[0].scout_reputation ?? 0);
      previousMjdq = Number(result.rows[0].data.balances?.[req.user!.id] ?? 0);
    } catch {
      return res.status(503).json({ success: false, error: { code: 'DATABASE_OUTAGE', message: 'Wallet temporarily unavailable.' } });
    }
  }
  const wallet = governanceStore.getWallet(req.user!.id);
  
  // SQL points are the whole-point authority. Preserve the committed snapshot's
  // sub-point remainder; the legacy mjdq_balance field can be stale.
  let mjdq_balance: number;
  try {
    mjdq_balance = demoPoints !== undefined ? authoritativeBalance(demoPoints, previousMjdq) : wallet.balance_mjdq;
  } catch {
    return res.status(503).json({ success: false, error: { code: 'ACCOUNTING_UNAVAILABLE', message: 'Wallet balance temporarily unavailable.' } });
  }
  const formatted_jdq = mjdq_balance / 1000;
  const jdq_governance_balance = governanceBalance;
  const scout_reputation = scoutReputation;
  
  res.setHeader('Cache-Control', 'private, no-store');
  res.json({
    success: true,
    data: {
      settlement: wallet.settlement,
      unit: 'mJDQ',
      mjdq_balance,
      jdq_governance_balance,
      formatted_mjdq: `${formatted_jdq.toFixed(2)} JDQ`,
      scout_reputation,
      demo_points: demoPoints ?? wallet.balance_jdq,
      balance_mjdq: mjdq_balance,
      balance_jdq: formatted_jdq,
      fiat_purchasing_power_php: formatted_jdq * 1.0, // 1 JDQ / 1000 mJDQ >= ₱1.00 Floor
      oracle_rate_php: 1.0,
    },
  });
});

router.get('/wallet/ledger', authenticateToken, async (req: AuthRequest, res: Response) => {
  let govLedger = governanceStore.getWallet(req.user!.id).ledger;
  const pool = db.usersRepo.getPool();
  if (pool) {
    try {
      const result = await pool.query(
        'SELECT * FROM governance_ledger WHERE account = $1 ORDER BY created_at DESC LIMIT 100',
        [req.user!.id]
      );
      govLedger = result.rows.map((row) => ({ ...row, amount_mjdq: Number(row.amount_mjdq) }));
      if (govLedger.some((entry) => !Number.isSafeInteger(entry.amount_mjdq))) throw new Error('LEDGER_AMOUNT_OVERFLOW');
    } catch {
      return res.status(503).json({ success: false, error: { code: 'ACCOUNTING_UNAVAILABLE', message: 'Wallet ledger temporarily unavailable.' } });
    }
  }
  const dbLedger = db.ledger.filter((l) => l.user_id === req.user!.id);

  res.setHeader('Cache-Control', 'private, no-store');
  res.json({
    success: true,
    data: {
      governance_ledger: govLedger,
      system_ledger: dbLedger,
    },
  });
});

export default router;
