import { Router, Response } from 'express';
import { z } from 'zod';
import { db } from '../db/index.js';
import { GovernanceStore } from '../governance/store.js';
import { authenticateToken, AuthRequest } from '../middleware/auth.js';

export const governanceStore = new GovernanceStore(db);
export const proposalsRouter = Router();

const recipientSchema = z.object({
  user_id: z.string().min(1),
  display_name: z.string().min(1),
  role: z.enum(['organizer', 'manager', 'merchant']),
  duty: z.string().min(3),
  share_bps: z.number().int().min(1).max(10000),
});

const createProposalSchema = z.object({
  title: z.string().min(3),
  location_name: z.string().min(3),
  category: z.enum(['eco', 'cultural', 'food_trade']),
  description: z.string().min(5),
  proposed_lat: z.number().optional(),
  proposed_lng: z.number().optional(),
  recipients: z.array(recipientSchema).min(1).optional(),
});

const voteSchema = z.object({
  choice: z.enum(['yes', 'no']),
  idempotency_key: z.string().min(8),
});

function sendGovernanceError(res: Response, error: unknown) {
  const code = error instanceof Error ? error.message : 'INTERNAL_ERROR';
  const status = code.includes('NOT_FOUND') ? 404
    : ['INSUFFICIENT_JDQ', 'ALREADY_VOTED', 'IDEMPOTENCY_CONFLICT', 'INVALID_TRANSITION'].includes(code) ? 409
    : ['NOT_ELIGIBLE', 'VOTES_PAUSED', 'FINANCIAL_ACTIVITY_PAUSED'].includes(code) ? 403
    : 422;
  res.status(status).json({ success: false, error: { code, message: code.replaceAll('_', ' ').toLowerCase() } });
}

proposalsRouter.get('/', (_req: AuthRequest, res: Response) => {
  res.json({ success: true, data: governanceStore.listProposals() });
});

proposalsRouter.get('/config', (_req: AuthRequest, res: Response) => {
  res.json({ success: true, data: governanceStore.getConfig() });
});

proposalsRouter.get('/:id', (req: AuthRequest, res: Response) => {
  const proposal = governanceStore.getProposal(req.params.id);
  if (!proposal) {
    res.status(404).json({ success: false, error: { code: 'PROPOSAL_NOT_FOUND', message: 'Proposal not found.' } });
    return;
  }
  res.json({ success: true, data: proposal });
});

// Retired mutation endpoints — JuanChoice is now the only active voting engine.
// Historical records remain readable via GET routes.
proposalsRouter.post('/', authenticateToken, (_req: AuthRequest, res: Response) => {
  res.status(410).json({
    success: false,
    error: {
      code: 'FEATURE_RETIRED',
      message: 'Proposal creation has been retired. JuanChoice (/choice) is the active community voting engine.',
    },
  });
});

proposalsRouter.post('/:id/submit', authenticateToken, (_req: AuthRequest, res: Response) => {
  res.status(410).json({
    success: false,
    error: {
      code: 'FEATURE_RETIRED',
      message: 'Proposal submission has been retired. JuanChoice (/choice) is the active community voting engine.',
    },
  });
});

proposalsRouter.post('/:id/votes', authenticateToken, (_req: AuthRequest, res: Response) => {
  res.status(410).json({
    success: false,
    error: {
      code: 'FEATURE_RETIRED',
      message: 'Proposal voting has been retired. JuanChoice (/choice) is the active community voting engine.',
    },
  });
});

// Compatibility route for old clients
proposalsRouter.post('/:id/vote', authenticateToken, (_req: AuthRequest, res: Response) => {
  res.status(410).json({
    success: false,
    error: {
      code: 'FEATURE_RETIRED',
      message: 'Proposal voting has been retired. JuanChoice (/choice) is the active community voting engine.',
    },
  });
});
