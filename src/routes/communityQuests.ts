import { Router, Response } from 'express';
import { z } from 'zod';
import { authenticateToken, AuthRequest } from '../middleware/auth.js';

const router = Router();
const _feedbackSchema = z.object({
  choice: z.enum(['approve', 'disapprove']),
  idempotency_key: z.string().min(8),
  rating: z.number().int().min(1).max(5).optional(),
  comment: z.string().max(500).optional(),
});

router.post('/community-quests/:id/feedback', authenticateToken, (_req: AuthRequest, res: Response) => {
  res.status(410).json({
    success: false,
    error: {
      code: 'FEATURE_RETIRED',
      message:
        'Community quest feedback voting has been retired. JuanChoice (/choice) is the active community voting engine.',
    },
  });
});

export default router;
