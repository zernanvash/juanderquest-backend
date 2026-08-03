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
    username: z.string().trim().min(2).max(50),
    password: z.string().min(2).max(100),
  }),
});

router.post('/auth/simulated-wallet-login', rateLimit({ windowMs: 60_000, max: 20 }), validateRequest(simulatedWalletLoginSchema), (req, res) => {
  const username = req.body.username.trim();
  let user = db.users.find((candidate) => candidate.display_name.toLowerCase() === username.toLowerCase());

  if (!user) {
    const now = new Date().toISOString();
    user = {
      id: `sim_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      seed_id: `sim-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      display_name: username,
      email: `${username.toLowerCase().replace(/[^a-z0-9]/g, '') || 'traveler'}@simulation.juanderquest.test`,
      avatar_url: `https://api.dicebear.com/7.x/avataaars/svg?seed=${encodeURIComponent(username)}`,
      role: 'user',
      demo_points: 100,
      created_at: now,
      updated_at: now,
    };
    db.users.push(user);
  }

  const token = jwt.sign(
    { id: user.id, seed_id: user.seed_id, role: user.role },
    env.JWT_SECRET,
    { expiresIn: '24h' },
  );

  return res.status(200).json({
    success: true,
    data: {
      token,
      user,
      simulated_wallet_address: `0x${Array.from({ length: 40 }, () => Math.floor(Math.random() * 16).toString(16)).join('')}`,
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
