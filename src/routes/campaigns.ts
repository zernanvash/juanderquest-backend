import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { db } from '../db/index.js';
import { authenticateToken, requireAdmin, AuthRequest } from '../middleware/auth.js';
import { validateRequest } from '../middleware/validate.js';

const router = Router();

// List active/upcoming campaigns for node_pangasinan
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

// Check current user's registration status & ticket for a campaign
router.get('/campaigns/:id/my-status', authenticateToken, (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  const userId = req.user!.id;

  const campaign = db.campaigns.find((c) => c.id === id);
  if (!campaign) {
    return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Campaign not found.' } });
  }

  const reservation = db.campaign_reservations.find(
    (r) => r.campaign_id === id && r.user_id === userId
  );

  return res.status(200).json({
    success: true,
    data: {
      is_registered: !!reservation,
      is_completed: reservation?.status === 'completed',
      ticket_code: reservation?.ticket_code || null,
      reservation: reservation || null,
    },
  });
});

// Get user's referral performance and earnings for a campaign
router.get('/campaigns/:id/referral-stats', authenticateToken, (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  const userId = req.user!.id;
  const user = db.findUserById(userId);

  const campaign = db.campaigns.find((c) => c.id === id);
  if (!campaign) {
    return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Campaign not found.' } });
  }

  const referrals = db.campaign_reservations.filter(
    (r) => r.campaign_id === id && (r.referred_by_user_id === userId || (user && r.referred_by_name?.toLowerCase() === user.display_name.toLowerCase()))
  );

  const totalInvited = referrals.length;
  const totalAttended = referrals.filter((r) => r.status === 'completed').length;
  const totalEarnedMjdq = totalAttended * (campaign.referral_bounty_mjdq || 0);

  return res.status(200).json({
    success: true,
    data: {
      campaign_id: id,
      user_id: userId,
      referral_code: user?.display_name.toLowerCase().replace(/\s+/g, '_') || userId.slice(0, 8),
      referral_bounty_per_attendee_mjdq: campaign.referral_bounty_mjdq || 0,
      total_invited: totalInvited,
      total_attended: totalAttended,
      total_earned_mjdq: totalEarnedMjdq,
      referred_friends: referrals.map((r) => ({
        user_name: r.user_display_name,
        status: r.status,
        reserved_at: r.created_at,
        bounty_awarded: r.status === 'completed',
      })),
    },
  });
});

const reserveSlotSchema = z.object({
  body: z.object({
    ref: z.string().optional(),
  }),
});

// Pre-Register / Reserve a participant slot in a campaign (with referral attribution)
router.post('/campaigns/:id/reserve', authenticateToken, validateRequest(reserveSlotSchema), (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  const { ref } = req.body || {};
  const userId = req.user!.id;
  const user = db.findUserById(userId);

  const campaign = db.campaigns.find((c) => c.id === id);
  if (!campaign) {
    return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Campaign not found.' } });
  }

  // Check if already reserved
  const existing = db.campaign_reservations.find(
    (r) => r.campaign_id === id && r.user_id === userId
  );

  if (existing) {
    return res.status(200).json({
      success: true,
      data: {
        message: 'Already reserved.',
        ticket_code: existing.ticket_code,
        reservation: existing,
        campaign,
      },
    });
  }

  if (campaign.reserved_participants >= campaign.max_participants) {
    return res.status(409).json({ success: false, error: { code: 'CAPACITY_REACHED', message: 'Campaign pre-registration slots are fully reserved.' } });
  }

  // Resolve referrer if ref is provided
  let referrerUser = null;
  if (ref) {
    const cleanRef = String(ref).trim().toLowerCase();
    referrerUser = db.users.find(
      (u) => u.id === cleanRef || u.display_name.toLowerCase().replace(/\s+/g, '_') === cleanRef || u.display_name.toLowerCase() === cleanRef
    );
  }

  const tagPrefix = (campaign.municipality || 'JQ').slice(0, 4).toUpperCase();
  const randomSuffix = Math.floor(1000 + Math.random() * 9000);
  const ticketCode = `TICKET-${tagPrefix}-${randomSuffix}`;

  const newReservation = {
    id: `res_${Date.now()}`,
    campaign_id: campaign.id,
    user_id: userId,
    user_display_name: user?.display_name || 'Anonymous Scout',
    referred_by_user_id: referrerUser?.id || null,
    referred_by_name: referrerUser?.display_name || null,
    ticket_code: ticketCode,
    status: 'reserved' as const,
    created_at: new Date().toISOString(),
  };

  db.campaign_reservations.push(newReservation);
  campaign.reserved_participants += 1;

  return res.status(201).json({
    success: true,
    data: {
      campaign_id: campaign.id,
      ticket_code: ticketCode,
      reservation: newReservation,
      reserved_participants: campaign.reserved_participants,
      max_participants: campaign.max_participants,
      reward_per_participant_mjdq: campaign.reward_per_participant_mjdq,
      referred_by: referrerUser ? referrerUser.display_name : null,
    },
  });
});

// Claim verified campaign participant reward & trigger referral payout
router.post('/campaigns/:id/claim', authenticateToken, (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  const userId = req.user!.id;
  const campaign = db.campaigns.find((c) => c.id === id);

  if (!campaign) {
    return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Campaign not found.' } });
  }

  const user = db.findUserById(userId);
  if (!user) {
    return res.status(404).json({ success: false, error: { code: 'USER_NOT_FOUND', message: 'User not found.' } });
  }

  // Check if user already claimed
  let reservation = db.campaign_reservations.find(
    (r) => r.campaign_id === id && r.user_id === userId
  );

  if (reservation?.status === 'completed') {
    return res.status(409).json({ success: false, error: { code: 'ALREADY_CLAIMED', message: 'Campaign reward already claimed.' } });
  }

  // Mark reservation as completed or create completed record
  if (reservation) {
    reservation.status = 'completed';
    reservation.completed_at = new Date().toISOString();
  } else {
    reservation = {
      id: `res_${Date.now()}`,
      campaign_id: campaign.id,
      user_id: userId,
      user_display_name: user.display_name,
      referred_by_user_id: null,
      referred_by_name: null,
      ticket_code: `TICKET-WALKIN-${Date.now().toString().slice(-4)}`,
      status: 'completed',
      created_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
    };
    db.campaign_reservations.push(reservation);
  }

  // 1. Credit Attending Tourist
  const payout = campaign.reward_per_participant_mjdq;
  user.mjdq_balance = (user.mjdq_balance || 0) + payout;
  user.demo_points = Math.floor(user.mjdq_balance / 1000);
  user.scout_reputation = (user.scout_reputation || 0) + 150; // +150 Rep for Civic Event
  campaign.completed_participants += 1;

  db.ledger.push({
    id: `ledg_${Date.now()}_tourist`,
    user_id: user.id,
    entry_type: 'campaign_reward',
    mjdq_delta: payout,
    jdq_delta: 0,
    burned_mjdq: 0,
    description: `Campaign Arrival Bounty: ${campaign.title}`,
    created_at: new Date().toISOString(),
  });

  // 2. Credit Referrer / Promoter Bounty if referred
  let referrerPayout = 0;
  let referrerName = null;
  if (reservation.referred_by_user_id && campaign.referral_bounty_mjdq > 0) {
    const referrer = db.findUserById(reservation.referred_by_user_id);
    if (referrer && referrer.id !== user.id) {
      referrerPayout = campaign.referral_bounty_mjdq;
      referrer.mjdq_balance = (referrer.mjdq_balance || 0) + referrerPayout;
      referrer.demo_points = Math.floor(referrer.mjdq_balance / 1000);
      referrerName = referrer.display_name;

      db.ledger.push({
        id: `ledg_${Date.now()}_ref`,
        user_id: referrer.id,
        entry_type: 'campaign_reward',
        mjdq_delta: referrerPayout,
        jdq_delta: 0,
        burned_mjdq: 0,
        description: `Promoter Referral Bounty: ${user.display_name} attended ${campaign.title}`,
        created_at: new Date().toISOString(),
      });
    }
  }

  return res.status(200).json({
    success: true,
    data: {
      campaign_id: campaign.id,
      ticket_code: reservation.ticket_code,
      awarded_mjdq: payout,
      new_mjdq_balance: user.mjdq_balance,
      new_demo_points: user.demo_points,
      new_scout_reputation: user.scout_reputation,
      referral_payout: referrerPayout > 0 ? {
        referrer_id: reservation.referred_by_user_id,
        referrer_name: referrerName,
        referral_bounty_mjdq: referrerPayout,
      } : null,
    },
  });
});

const createCampaignSchema = z.object({
  body: z.object({
    title: z.string().min(3),
    category: z.enum(['eco', 'cultural', 'food_trade', 'sports_adventure']),
    location_name: z.string().min(3),
    municipality: z.string().optional(),
    description: z.string().min(5),
    event_date: z.string(),
    start_date: z.string().optional(),
    end_date: z.string().optional(),
    total_budget_mjdq: z.number().int().positive(),
    reward_per_participant_mjdq: z.number().int().positive(),
    referral_bounty_mjdq: z.number().int().nonnegative().optional(),
    max_participants: z.number().int().positive(),
    banner_image_url: z.string().optional(),
    pre_quest_requirements: z.array(z.string()).optional(),
  }),
});

// Host creates a campaign and locks escrow budget
router.post('/campaigns', authenticateToken, requireAdmin, validateRequest(createCampaignSchema), (req: AuthRequest, res: Response) => {
  const {
    title,
    category,
    location_name,
    municipality,
    description,
    event_date,
    start_date,
    end_date,
    total_budget_mjdq,
    reward_per_participant_mjdq,
    referral_bounty_mjdq = 0,
    max_participants,
    banner_image_url,
    pre_quest_requirements = [],
  } = req.body;

  const hostId = req.user!.id;
  const hostName = (req.user as any).email || (req.user as any).displayName || `Host ${hostId.slice(0, 6)}`;

  const newCampaign = {
    id: `camp_${Date.now()}`,
    host_id: hostId,
    host_name: hostName,
    title,
    category,
    location_name,
    municipality: municipality || location_name.split(',')[0].trim(),
    banner_image_url: banner_image_url || 'https://images.unsplash.com/photo-1507525428034-b723cf961d3e',
    description,
    event_date: event_date || new Date(Date.now() + 14 * 86400000).toISOString(),
    start_date: start_date || event_date,
    end_date: end_date || event_date,
    total_budget_mjdq,
    reward_per_participant_mjdq,
    referral_bounty_mjdq,
    max_participants,
    reserved_participants: 0,
    completed_participants: 0,
    unspent_refund_mjdq: 0,
    pre_quest_requirements,
    status: 'active' as const,
    created_at: new Date().toISOString(),
  };

  db.campaigns.push(newCampaign);

  return res.status(201).json({
    success: true,
    data: newCampaign,
  });
});

// Host closes campaign and automatically refunds unspent budget
router.post('/campaigns/:id/close', authenticateToken, requireAdmin, (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  const campaign = db.campaigns.find((c) => c.id === id);

  if (!campaign) {
    return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Campaign not found.' } });
  }

  const distributed = campaign.completed_participants * (campaign.reward_per_participant_mjdq + (campaign.referral_bounty_mjdq || 0));
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
