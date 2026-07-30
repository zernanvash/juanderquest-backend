import { Router, Response } from 'express';
import { z } from 'zod';
import { db } from '../db/index.js';
import { authenticateToken, AuthRequest } from '../middleware/auth.js';

export const proposalsRouter = Router();

const createProposalSchema = z.object({
  title: z.string().min(3),
  location_name: z.string().min(3),
  category: z.enum(['eco', 'cultural', 'food_trade']),
  description: z.string().min(5),
  proposed_lat: z.number().optional(),
  proposed_lng: z.number().optional(),
});

// GET /api/v1/proposals - List all destination location proposals
proposalsRouter.get('/', (_req: AuthRequest, res: Response) => {
  const proposals = db.listProposals();
  res.json({
    success: true,
    data: proposals,
  });
});

// POST /api/v1/proposals - Submit a new tourism location proposal
proposalsRouter.post('/', authenticateToken, (req: AuthRequest, res: Response) => {
  const result = createProposalSchema.safeParse(req.body);
  if (!result.success) {
    res.status(422).json({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Invalid proposal fields',
        details: result.error.errors,
      },
    });
    return;
  }

  const userId = req.user?.id || '';
  const user = db.findUserById(userId);
  const proposal = db.createProposal({
    ...result.data,
    submitted_by: user?.display_name || 'Anonymous Traveler',
  });

  res.status(201).json({
    success: true,
    data: proposal,
  });
});

// POST /api/v1/proposals/:id/vote - Upvote a destination proposal
proposalsRouter.post('/:id/vote', authenticateToken, (req: AuthRequest, res: Response) => {
  const proposal = db.voteProposal(req.params.id);
  if (!proposal) {
    res.status(404).json({
      success: false,
      error: {
        code: 'NOT_FOUND',
        message: 'Proposal not found',
      },
    });
    return;
  }

  res.json({
    success: true,
    data: proposal,
  });
});
