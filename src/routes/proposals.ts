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

proposalsRouter.post('/', authenticateToken, (req: AuthRequest, res: Response) => {
  const result = createProposalSchema.safeParse(req.body);
  if (!result.success) {
    res.status(422).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid proposal fields', details: result.error.errors } });
    return;
  }
  try {
    const proposal = governanceStore.createProposal({ ...result.data, submitted_by_id: req.user!.id });
    res.status(201).json({ success: true, data: proposal });
  } catch (error) {
    sendGovernanceError(res, error);
  }
});

proposalsRouter.post('/:id/submit', authenticateToken, (req: AuthRequest, res: Response) => {
  try {
    const proposal = governanceStore.submitProposal(req.params.id, req.user!.id);
    res.json({ success: true, data: proposal });
  } catch (error) {
    sendGovernanceError(res, error);
  }
});

proposalsRouter.post('/:id/votes', authenticateToken, (req: AuthRequest, res: Response) => {
  const result = voteSchema.safeParse(req.body);
  if (!result.success) {
    res.status(422).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Vote choice and idempotency key are required.', details: result.error.errors } });
    return;
  }
  try {
    const vote = governanceStore.castProposalVote(req.params.id, req.user!.id, result.data.choice, result.data.idempotency_key);
    res.json({ success: true, data: vote, server_time: new Date().toISOString() });
  } catch (error) {
    sendGovernanceError(res, error);
  }
});

// Compatibility route for old clients. Paid governance requires an explicit choice and idempotency key.
proposalsRouter.post('/:id/vote', authenticateToken, (_req: AuthRequest, res: Response) => {
  res.status(410).json({
    success: false,
    error: {
      code: 'PAID_VOTE_REQUIRED',
      message: 'Use POST /proposals/:id/votes with choice and idempotency_key. The 5 JDQ fee and 20% burn must be disclosed before confirmation.',
    },
  });
});
