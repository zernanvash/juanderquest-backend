import { Router, Response } from 'express';
import { z } from 'zod';
import { authenticateToken, requireAdmin, AuthRequest } from '../middleware/auth.js';
import { governanceStore } from './proposals.js';

const router = Router();
router.use('/admin/governance', authenticateToken, requireAdmin);
router.use('/admin/tokenomics', authenticateToken, requireAdmin);

const screenSchema = z.object({
  decision: z.enum(['approve', 'reject']),
  reason: z.string().min(5),
  evidence_reference: z.string().min(3),
  checklist_complete: z.boolean(),
});

const transitionSchema = z.object({
  action: z.enum(['close_voting', 'schedule', 'activate', 'open_feedback', 'close_feedback', 'finalize_payout', 'mark_disputed']),
  force: z.boolean().optional(),
});

const resolveSchema = z.object({
  release_percent: z.number().int().min(0).max(100),
  bond_action: z.enum(['refund', 'slash_50', 'slash_100']),
  reason: z.string().min(5),
  evidence_reference: z.string().min(3),
});

const controlsSchema = z.object({
  pause_votes: z.boolean().optional(),
  pause_payouts: z.boolean().optional(),
  pause_vouchers: z.boolean().optional(),
  pause_all_financial: z.boolean().optional(),
  reason: z.string().min(5),
});

function fail(res: Response, error: unknown) {
  const code = error instanceof Error ? error.message : 'INTERNAL_ERROR';
  const status = code.includes('NOT_FOUND') ? 404
    : ['INVALID_TRANSITION', 'INSUFFICIENT_JDQ'].includes(code) ? 409
    : ['PAYOUTS_PAUSED', 'FINANCIAL_ACTIVITY_PAUSED'].includes(code) ? 403
    : 422;
  res.status(status).json({ success: false, error: { code, message: code.replaceAll('_', ' ').toLowerCase() } });
}

router.get('/admin/governance/overview', (_req, res) => {
  res.json({ success: true, data: governanceStore.getOverview() });
});

router.get('/admin/governance/proposals', (_req, res) => {
  res.json({ success: true, data: governanceStore.listProposals() });
});

router.get('/admin/governance/proposals/:id', (req, res) => {
  const proposal = governanceStore.getProposal(req.params.id);
  if (!proposal) {
    res.status(404).json({ success: false, error: { code: 'PROPOSAL_NOT_FOUND', message: 'Proposal not found.' } });
    return;
  }
  res.json({ success: true, data: proposal });
});

router.post('/admin/governance/proposals/:id/screen', (req: AuthRequest, res: Response) => {
  const parsed = screenSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(422).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Complete checklist, reason, and evidence reference are required.', details: parsed.error.errors } });
    return;
  }
  try {
    const data = governanceStore.screenProposal(req.params.id, req.user!.id, parsed.data.decision, parsed.data.reason, parsed.data.evidence_reference, parsed.data.checklist_complete);
    res.json({ success: true, data });
  } catch (error) {
    fail(res, error);
  }
});

router.post('/admin/governance/proposals/:id/transition', (req: AuthRequest, res: Response) => {
  const parsed = transitionSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(422).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid governance transition.' } });
    return;
  }
  try {
    const targets = {
      schedule: 'scheduled',
      activate: 'active',
      open_feedback: 'feedback',
      mark_disputed: 'disputed',
    } as const;
    const data = parsed.data.action === 'close_voting'
      ? governanceStore.closeVoting(req.params.id, req.user!.id, parsed.data.force)
      : parsed.data.action === 'close_feedback'
      ? governanceStore.closeFeedback(req.params.id, req.user!.id, parsed.data.force)
      : parsed.data.action === 'finalize_payout'
      ? governanceStore.finalizePayout(req.params.id, req.user!.id)
      : governanceStore.transitionProposal(req.params.id, req.user!.id, targets[parsed.data.action]);
    res.json({ success: true, data });
  } catch (error) {
    fail(res, error);
  }
});

router.post('/admin/governance/proposals/:id/resolve', (req: AuthRequest, res: Response) => {
  const parsed = resolveSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(422).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Release, bond, reason, and evidence are required.', details: parsed.error.errors } });
    return;
  }
  try {
    const data = governanceStore.resolveDispute(req.params.id, req.user!.id, parsed.data.release_percent, parsed.data.bond_action, parsed.data.reason, parsed.data.evidence_reference);
    res.json({ success: true, data });
  } catch (error) {
    fail(res, error);
  }
});

router.get('/admin/tokenomics/analytics', (_req, res) => {
  res.json({ success: true, data: governanceStore.getTokenomics() });
});

router.get('/admin/tokenomics/ledger', (_req, res) => {
  res.json({ success: true, data: governanceStore.getLedger() });
});

router.get('/admin/governance/audit', (_req, res) => {
  res.json({ success: true, data: governanceStore.getAudit() });
});

router.get('/admin/governance/controls', (_req, res) => {
  res.json({ success: true, data: governanceStore.getControls() });
});

router.put('/admin/governance/controls', (req: AuthRequest, res: Response) => {
  const parsed = controlsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(422).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'A reason and valid control values are required.', details: parsed.error.errors } });
    return;
  }
  try {
    const { reason, ...updates } = parsed.data;
    const data = governanceStore.updateControls(req.user!.id, updates, reason);
    res.json({ success: true, data });
  } catch (error) {
    fail(res, error);
  }
});

export default router;
