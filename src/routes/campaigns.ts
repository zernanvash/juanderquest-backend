import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { db } from '../db/index.js';
import { authenticateToken, requireAdmin, AuthRequest } from '../middleware/auth.js';
import { validateRequest } from '../middleware/validate.js';

const router = Router();

// List active campaigns for node_pangasinan
router.get('/campaigns', (_req: Request, res: Response) => {
  return res.status(200).json({
    success: true,
    data: db.campaigns,
  });
});

// View campaign detail
router.get('/campaigns/:id', (req: Request, res: Response) => {
  const { id } = req.params;
  const campaign = db.campaigns.find((c) => c.id === id);

  if (!campaign) {
    return res.status(404).json({
      success: false,
      error: { code: 'NOT_FOUND', message: `Campaign '${id}' not found.` },
    });
  }

  return res.status(200).json({
    success: true,
    data: campaign,
  });
});

const createCampaignSchema = z.object({
  body: z.object({
    title: z.string().min(3),
    category: z.enum(['eco', 'cultural', 'food_trade']),
    location_name: z.string().min(3),
    description: z.string().min(5),
    total_budget_mjdq: z.number().int().positive(),
    reward_per_participant_mjdq: z.number().int().positive(),
    max_participants: z.number().int().positive(),
  }),
});

// Host creates a campaign and locks escrow budget
router.post('/campaigns', authenticateToken, requireAdmin, validateRequest(createCampaignSchema), (req: AuthRequest, res: Response) => {
  const { title, category, location_name, description, total_budget_mjdq, reward_per_participant_mjdq, max_participants } = req.body;
  const hostId = req.user!.id;
  const hostName = (req.user as any).email || (req.user as any).displayName || `Host ${hostId.slice(0, 6)}`;

  const newCampaign = {
    id: `camp_${Date.now()}`,
    host_id: hostId,
    host_name: hostName,
    title,
    category,
    location_name,
    description,
    total_budget_mjdq,
    reward_per_participant_mjdq,
    max_participants,
    reserved_participants: 0,
    completed_participants: 0,
    unspent_refund_mjdq: 0,
    status: 'active' as const,
    created_at: new Date().toISOString(),
  };

  db.campaigns.push(newCampaign);

  return res.status(201).json({
    success: true,
    data: newCampaign,
  });
});

// Reserve a participant slot in a campaign
router.post('/campaigns/:id/reserve', authenticateToken, (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  const campaign = db.campaigns.find((c) => c.id === id);

  if (!campaign) {
    return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Campaign not found.' } });
  }

  if (campaign.reserved_participants >= campaign.max_participants) {
    return res.status(409).json({ success: false, error: { code: 'CAPACITY_REACHED', message: 'Campaign slots are fully reserved.' } });
  }

  campaign.reserved_participants += 1;

  return res.status(200).json({
    success: true,
    data: {
      campaign_id: campaign.id,
      reserved_participants: campaign.reserved_participants,
      max_participants: campaign.max_participants,
      reward_per_participant_mjdq: campaign.reward_per_participant_mjdq,
    },
  });
});

// Claim verified campaign participant reward
router.post('/campaigns/:id/claim', authenticateToken, (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  const campaign = db.campaigns.find((c) => c.id === id);

  if (!campaign) {
    return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Campaign not found.' } });
  }

  const user = db.findUserById(req.user!.id);
  if (!user) {
    return res.status(404).json({ success: false, error: { code: 'USER_NOT_FOUND', message: 'User not found.' } });
  }

  const payout = campaign.reward_per_participant_mjdq;
  user.mjdq_balance = (user.mjdq_balance || 0) + payout;
  user.demo_points = Math.floor(user.mjdq_balance / 1000);
  campaign.completed_participants += 1;

  db.ledger.push({
    id: `ledg_${Date.now()}`,
    user_id: user.id,
    entry_type: 'campaign_reward',
    mjdq_delta: payout,
    jdq_delta: 0,
    burned_mjdq: 0,
    description: `Campaign Reward: ${campaign.title}`,
    created_at: new Date().toISOString(),
  });

  return res.status(200).json({
    success: true,
    data: {
      campaign_id: campaign.id,
      awarded_mjdq: payout,
      new_mjdq_balance: user.mjdq_balance,
      new_demo_points: user.demo_points,
    },
  });
});

// Host closes campaign and automatically refunds unspent budget
router.post('/campaigns/:id/close', authenticateToken, requireAdmin, (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  const campaign = db.campaigns.find((c) => c.id === id);

  if (!campaign) {
    return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Campaign not found.' } });
  }

  const distributed = campaign.completed_participants * campaign.reward_per_participant_mjdq;
  const refund = Math.max(0, campaign.total_budget_mjdq - distributed);

  campaign.status = 'completed';
  campaign.unspent_refund_mjdq = refund;

  return res.status(200).json({
    success: true,
    data: {
      campaign_id: campaign.id,
      status: campaign.status,
      total_budget_mjdq: campaign.total_budget_mjdq,
      distributed_mjdq: distributed,
      unspent_refund_mjdq: refund,
    },
  });
});

export default router;
