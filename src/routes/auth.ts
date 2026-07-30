import { Router, Response } from 'express';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { db } from '../db/index.js';
import { env } from '../config/env.js';
import { validateRequest } from '../middleware/validate.js';
import { authenticateToken, AuthRequest } from '../middleware/auth.js';

const router = Router();

const loginSchema = z.object({
  body: z.object({
    seed_id: z.enum(['user-1', 'admin-1']),
  }),
});

router.post('/auth/demo-login', validateRequest(loginSchema), (req, res) => {
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
