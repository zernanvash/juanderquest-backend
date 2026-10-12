import { Router, Response } from 'express';
import { z } from 'zod';
import { authenticateToken, AuthRequest } from '../middleware/auth.js';
import { governanceStore } from './proposals.js';

const router = Router();
const feedbackSchema = z.object({
  choice: z.enum(['approve', 'disapprove']),
  idempotency_key: z.string().min(8),
  rating: z.number().int().min(1).max(5).optional(),
  comment: z.string().max(500).optional(),
});

router.get('/community-quests/:id', (req, res) => {
  const proposal = governanceStore.getProposal(req.params.id);
  if (!proposal || !['scheduled', 'active', 'feedback', 'payout_pending', 'disputed', 'completed'].includes(proposal.state)) {
    res.status(404).json({ success: false, error: { code: 'COMMUNITY_QUEST_NOT_FOUND', message: 'Community Quest not found.' } });
    return;
  }
  res.json({ success: true, data: proposal });
});

router.post('/community-quests/:id/feedback', authenticateToken, (_req: AuthRequest, res: Response) => {
  res.status(410).json({
    success: false,
    error: {
      code: 'FEATURE_RETIRED',
      message: 'Community quest feedback voting has been retired. JuanChoice (/choice) is the active community voting engine.',
    },
  });
});

export default router;
