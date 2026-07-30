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

router.post('/community-quests/:id/feedback', authenticateToken, (req: AuthRequest, res: Response) => {
  const parsed = feedbackSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(422).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Feedback choice and idempotency key are required.', details: parsed.error.errors } });
    return;
  }
  try {
    const data = governanceStore.castFeedback(
      req.params.id,
      req.user!.id,
      parsed.data.choice,
      parsed.data.idempotency_key,
      parsed.data.rating,
      parsed.data.comment,
    );
    res.json({ success: true, data, server_time: new Date().toISOString() });
  } catch (error) {
    const code = error instanceof Error ? error.message : 'INTERNAL_ERROR';
    const status = ['NOT_ELIGIBLE'].includes(code) ? 403 : ['ALREADY_VOTED', 'INSUFFICIENT_JDQ'].includes(code) ? 409 : 422;
    res.status(status).json({ success: false, error: { code, message: code.replaceAll('_', ' ').toLowerCase() } });
  }
});

export default router;
