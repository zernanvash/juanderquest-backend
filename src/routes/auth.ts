import { Router, Response } from 'express';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { db } from '../db/index.js';
import { env } from '../config/env.js';
import { validateRequest } from '../middleware/validate.js';
import { authenticateToken, AuthRequest } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';

const router = Router();

const loginSchema = z.object({
  body: z.object({
    seed_id: z.enum(['user-1', 'admin-1']),
  }),
});

router.post('/auth/demo-login', rateLimit({ windowMs: 60_000, max: 20 }), validateRequest(loginSchema), (req, res) => {
  const { seed_id } = req.body;
  const user = db.findUserBySeed(seed_id);

  if (!user) {
    return res.status(404).json({
      success: false,
      error: {
        code: 'NOT_FOUND',
        message: `Seed user with ID '${seed_id}' not found.`,
      },
    });
  }

  const token = jwt.sign(
    {
      id: user.id,
      seed_id: user.seed_id,
      role: user.role,
    },
    env.JWT_SECRET,
    { expiresIn: '24h' }
  );

  return res.status(200).json({
    success: true,
    data: {
      token,
      user,
    },
  });
});

const simulatedWalletLoginSchema = z.object({
  body: z.object({
    username: z.string().min(2, 'Username must be at least 2 characters'),
    password: z.string().min(2, 'Password must be at least 2 characters'),
  }),
});

router.post('/auth/simulated-wallet-login', validateRequest(simulatedWalletLoginSchema), (req, res) => {
  const { username } = req.body;
  const cleanUsername = username.trim();

  let user = db.users.find(
    (u) =>
      u.display_name.toLowerCase() === cleanUsername.toLowerCase() ||
      u.seed_id.toLowerCase() === cleanUsername.toLowerCase()
  );

  if (!user) {
    // Create new simulated Web3 wallet user with Starter Demo Assets!
    user = {
      id: `usr_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      seed_id: `user-${cleanUsername.toLowerCase().replace(/[^a-z0-9]/g, '-')}`,
      display_name: cleanUsername,
      email: `${cleanUsername.toLowerCase().replace(/\s+/g, '')}@juanderquest.ph`,
      avatar_url: `https://api.dicebear.com/7.x/avataaars/svg?seed=${encodeURIComponent(cleanUsername)}`,
      role: 'user',
      demo_points: 100,
      mjdq_balance: 100000,          // Starter 100,000 mJDQ (100.00 JDQ value)
      jdq_governance_balance: 15,    // Starter 15 JDQ Governance
      scout_reputation: 250,         // Starter 250 Scout Rep
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    db.users.push(user);

    db.ledger.push({
      id: `ledg_welcome_${Date.now()}`,
      user_id: user.id,
      entry_type: 'poa_reward',
      mjdq_delta: 100000,
      jdq_delta: 15,
      burned_mjdq: 0,
      description: 'MetaMask Starter Pack: 100,000 mJDQ + 15 JDQ + 250 Scout Rep',
      created_at: new Date().toISOString(),
    });
  }

  const token = jwt.sign(
    {
      id: user.id,
      seed_id: user.seed_id,
      role: user.role,
    },
    env.JWT_SECRET,
    { expiresIn: '24h' }
  );

  const simulatedAddress = `0x${Array.from({ length: 40 }, () => Math.floor(Math.random() * 16).toString(16)).join('')}`;

  return res.status(200).json({
    success: true,
    data: {
      token,
      user,
      simulated_wallet_address: simulatedAddress,
      message: 'Simulated MetaMask Wallet Connected Successfully! Starter Demo Pack Credited.',
    },
  });
});

router.get('/auth/me', authenticateToken, (req: AuthRequest, res: Response) => {
  const userId = req.user?.id;
  const user = db.findUserById(userId!);

  if (!user) {
    return res.status(404).json({
      success: false,
      error: {
        code: 'NOT_FOUND',
        message: 'User profile not found.',
      },
    });
  }

  return res.status(200).json({
    success: true,
    data: user,
  });
});

export default router;
