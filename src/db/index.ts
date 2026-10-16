import type { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { env } from '../config/env.js';
import { isDevelopmentSeedEnabled } from './policy.js';
import { UsersRepository, CreateUserData } from '../repositories/users.js';
import { AuthChallengeService } from '../auth/challengeService.js';
import { AuthMailerService } from '../auth/mailerService.js';
import { UnifiedIdentityService } from '../auth/identityService.js';

const developmentFixturesEnabled = isDevelopmentSeedEnabled({
  nodeEnv: env.NODE_ENV,
  allowInMemoryFallback: env.ALLOW_IN_MEMORY_FALLBACK,
  seedDevelopmentData: env.SEED_DEVELOPMENT_DATA,
});

export interface UserRow {
  id: string;
  seed_id: string;
  display_name: string;
  email: string;
  avatar_url: string;
  role: 'user' | 'admin' | 'qa';
  demo_points: number;            // Backwards-compatible formatted value (100 JDQ)
  mjdq_balance: number;           // Integer milli-JDQ balance (100,000 mJDQ = 100 JDQ)
  jdq_governance_balance: number; // JDQ Governance Token count (15 JDQ)
  scout_reputation: number;       // Non-inflationary reputation for casual spot discovery
  is_public: boolean;
  handle?: string | null;
  bio?: string | null;
  status_text?: string | null;
  wallet_address?: string | null;
  is_test?: boolean;
  created_at: string;
  updated_at: string;
}

export interface FollowRow {
  follower_id: string;
  following_id: string;
  created_at: string;
}

export interface PublicTravelerSummary {
  id: string;
  display_name: string;
  handle: string | null;
  avatar_url: string;
  bio: string | null;
  status_text: string | null;
  scout_reputation: number;
  is_test?: boolean;
  follower_count?: number;
  following_count?: number;
  is_unavailable?: boolean;
}

export class InvalidCursorError extends Error {
  constructor(message: string = 'Invalid or mismatched cursor.') {
    super(message);
    this.name = 'InvalidCursorError';
  }
}

export interface FollowCursorPayload {
  target_id: string;
  direction: 'followers' | 'following';
  created_at: string;
  last_id: string;
  version: 'follow-v1';
}

export function encodeFollowCursor(payload: FollowCursorPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

export function decodeFollowCursor(
  cursor: string,
  expectedTargetId: string,
  expectedDirection: 'followers' | 'following'
): FollowCursorPayload {
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    const parsed = JSON.parse(raw) as FollowCursorPayload;
    if (
      !parsed ||
      parsed.version !== 'follow-v1' ||
      parsed.target_id !== expectedTargetId ||
      parsed.direction !== expectedDirection ||
      !parsed.created_at ||
      !parsed.last_id ||
      isNaN(new Date(parsed.created_at).getTime())
    ) {
      throw new InvalidCursorError('Malformed or mismatched follow cursor.');
    }
    return parsed;
  } catch (err: any) {
    if (err instanceof InvalidCursorError) {
      throw err;
    }
    throw new InvalidCursorError('Malformed pagination cursor.');
  }
}

export type QuestStatus = 'draft' | 'published' | 'paused' | 'archived';

export interface QuestStep {
  step_order: number;
  title: string;
  description: string;
  checkpoint_type: 'location' | 'qr' | 'photo' | 'action';
  required: boolean;
  gps_lat?: number;
  gps_lng?: number;
  radius_meters?: number;
  hint?: string;
  /** Server-generated QR secret. Never included in traveler-facing snapshots. */
  marker_code?: string;
}

export type QuestStepStatus = 'not_started' | 'ready' | 'pending_review' | 'needs_changes' | 'verified' | 'skipped_optional';

export interface QuestStepEvidenceRow {
  id: string;
  attempt_id: string;
  quest_id: string;
  user_id: string;
  step_order: number;
  checkpoint_type: 'location' | 'qr' | 'photo' | 'action';
  status: QuestStepStatus;
  required: boolean;
  title: string;
  description?: string | null;
  idempotency_key?: string | null;
  evidence_payload?: Record<string, any> | null;
  rejection_reason?: string | null;
  verified_at?: string | null;
  reviewed_by?: string | null;
  reviewed_at?: string | null;
  created_at: string;
  updated_at: string;
}

export type QuestAttemptStatus = 'in_progress' | 'submitted' | 'completed' | 'abandoned';

export interface QuestAttemptRow {
  id: string;
  quest_id: string;
  user_id: string;
  version: number;
  current_step: number;
  total_steps: number;
  status: QuestAttemptStatus;
  steps_snapshot?: QuestStep[];
  verified_steps?: number;
  required_steps?: number;
  review_notes?: string | null;
  reviewed_by?: string | null;
  reviewed_at?: string | null;
  created_at: string;
  updated_at: string;
  completed_at?: string | null;
}

export type AffiliateApplicationStatus = 'received' | 'in_review' | 'approved' | 'rejected' | 'needs_changes';

export interface AffiliateApplicationRow {
  id: string;
  user_id: string;
  business_name: string;
  category: string;
  municipality: string;
  contact_name: string;
  contact_email: string;
  contact_phone: string;
  sponsorship_goals: string[];
  proposal_details: string;
  status: AffiliateApplicationStatus;
  version?: number;
  business_address?: string;
  business_province?: string;
  gps_lat?: number | null;
  gps_lng?: number | null;
  preferred_contact_method?: string;
  applicant_feedback?: string | null;
  declaration_version?: string;
  reviewer_id?: string | null;
  reviewer_notes?: string | null;
  reviewed_at?: string | null;
  created_at: string;
  updated_at: string;
}

export interface MerchantAffiliateDraftRow {
  user_id: string;
  draft_data: Record<string, any>;
  current_step: number;
  revision: number;
  created_at: string;
  updated_at: string;
}

export interface MerchantApplicationAuditRow {
  id: string;
  application_id: string;
  actor_id?: string | null;
  from_status: string;
  to_status: string;
  revision: number;
  notes?: string | null;
  applicant_feedback?: string | null;
  created_at: string;
}

export interface MerchantMembershipRow {
  id: string;
  merchant_id: string;
  user_id: string;
  role: 'owner' | 'staff';
  status: 'active' | 'suspended';
  created_at: string;
  updated_at: string;
}

export interface MerchantProductRow {
  id: string;
  merchant_id: string;
  name: string;
  description: string;
  price?: number | null;
  currency: string;
  image_url?: string | null;
  is_published: boolean;
  is_archived: boolean;
  display_order: number;
  created_at: string;
  updated_at: string;
}

export interface QuestRow {
  id: string;
  author_id?: string | null;
  status?: QuestStatus;
  version?: number;
  steps?: QuestStep[];
  title: string;
  description: string;
  category: 'eco' | 'cultural' | 'food_trade';
  location_name: string;
  gps_lat: number;
  gps_lng: number;
  radius_meters: number;
  base_reward_php: number;
  difficulty_factor: number;
  geo_multiplier: number;
  reward_points: number;          // reward_mjdq (e.g. 50,000 mJDQ / 50 JDQ)
  marker_code: string;
  marker_image_url: string;
  is_active: boolean;
  is_test?: boolean;
  created_at: string;
  updated_at: string;
}

export interface CampaignRow {
  id: string;
  host_id: string;
  host_name: string;
  title: string;
  category: 'eco' | 'cultural' | 'food_trade' | 'sports_adventure';
  location_name: string;
  municipality?: string;
  banner_image_url?: string;
  description: string;
  event_date: string;
  start_date: string;
  end_date: string;
  total_budget_mjdq: number;
  reward_per_participant_mjdq: number;
  referral_bounty_mjdq: number;
  max_participants: number;
  reserved_participants: number;
  completed_participants: number;
  unspent_refund_mjdq: number;
  pre_quest_requirements?: string[];
  gps_lat?: number;
  gps_lng?: number;
  gps_radius_meters?: number;
  status: 'active' | 'completed' | 'cancelled';
  created_at: string;
}

export interface CampaignReservationRow {
  id: string;
  campaign_id: string;
  user_id: string;
  user_display_name: string;
  referred_by_user_id?: string | null;
  referred_by_name?: string | null;
  ticket_code: string;
  status: 'reserved' | 'completed' | 'cancelled';
  created_at: string;
  completed_at?: string | null;
}

export interface SubmissionRow {
  id: string;
  idempotency_key: string;
  user_id: string;
  quest_id: string;
  scanned_marker_code: string;
  captured_lat: number;
  captured_lng: number;
  captured_accuracy: number;
  status: 'pending' | 'approved' | 'rejected';
  rejection_reason?: string | null;
  reviewed_by?: string | null;
  reviewed_at?: string | null;
  is_test?: boolean;
  created_at: string;
  updated_at: string;
}

export interface ProposalRow {
  id: string;
  title: string;
  location_name: string;
  category: 'eco' | 'cultural' | 'food_trade';
  description: string;
  proposed_lat?: number;
  proposed_lng?: number;
  submitted_by: string;
  votes: number;
  created_at: string;
}

export interface MerchantRow {
  id: string;
  name: string;
  location: string;
  description: string;
  status?: 'active' | 'suspended';
  is_published?: boolean;
  category?: string;
  municipality?: string;
  contact_email?: string;
  contact_phone?: string;
  logo_url?: string | null;
  banner_url?: string | null;
  source_application_id?: string | null;
  created_at: string;
}

export interface VoucherRow {
  id: string;
  merchant_id: string;
  title: string;
  description: string;
  cost_points: number;            // cost in mJDQ (e.g. 100,000 mJDQ = 100 JDQ)
  fiat_floor_php: number;
  is_active: boolean;
}

export interface RedemptionRow {
  id: string;
  voucher_id: string;
  user_id: string;
  code: string;
  cost_points: number;
  idempotency_key: string;
  created_at: string;
}

export interface TreasuryRow {
  growth_pool_mjdq: number;
  total_burned_mjdq: number;
  community_treasury_mjdq: number;
  oracle_rate_php_per_jdq: number;
}

export interface LedgerEntryRow {
  id: string;
  user_id: string;
  entry_type: 'poa_reward' | 'campaign_reward' | 'voucher_redemption' | 'proposal_vote_fee' | 'feedback_vote_fee' | 'event_creation_fee';
  mjdq_delta: number;
  jdq_delta: number;
  burned_mjdq: number;
  description: string;
  created_at: string;
}

export interface WebAnalyticsEventRow {
  id: string;
  event_type: 'page_view' | 'cta_click';
  path: string;
  label?: string | null;
  session_id: string;
  occurred_at: string;
}

// Memory Store Seed Data
const mockUsers: UserRow[] = [
  {
    id: '11111111-1111-1111-1111-111111111111',
    seed_id: 'user-1',
    display_name: 'Juan Dela Cruz',
    email: 'juan@juanderquest.ph',
    avatar_url: 'https://api.dicebear.com/7.x/avataaars/svg?seed=Juan',
    role: 'user',
    demo_points: 100,
    mjdq_balance: 100000,          // 100,000 mJDQ = 100.00 JDQ
    jdq_governance_balance: 15,    // 15 JDQ
    scout_reputation: 250,         // Scout Reputation
    is_public: true,
    handle: 'juandelacruz',
    bio: 'Pangasinan explorer & cultural heritage scout.',
    status_text: 'Exploring Hundred Islands & Bolinao 🌊',
    is_test: false,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
  {
    id: '22222222-2222-2222-2222-222222222222',
    seed_id: 'admin-1',
    display_name: 'Pangasinan Admin',
    email: 'admin@pangasinan.gov.ph',
    avatar_url: 'https://api.dicebear.com/7.x/avataaars/svg?seed=Admin',
    role: 'admin',
    demo_points: 0,
    mjdq_balance: 0,
    jdq_governance_balance: 50,
    scout_reputation: 1000,
    is_public: false,
    handle: null,
    bio: null,
    status_text: null,
    is_test: false,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
  {
    id: '33333333-3333-3333-3333-333333333333',
    seed_id: 'user-2',
    display_name: 'Maria Santos',
    email: 'maria@juanderquest.ph',
    avatar_url: 'https://api.dicebear.com/7.x/avataaars/svg?seed=Maria',
    role: 'user',
    demo_points: 250,
    mjdq_balance: 250000,
    jdq_governance_balance: 30,
    scout_reputation: 420,
    is_public: true,
    handle: 'mariasantos',
    bio: 'Eco-trail enthusiast and local food lover from Dagupan.',
    status_text: 'Tasting Dagupan bangus 🐟',
    is_test: false,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
  {
    id: '44444444-4444-4444-4444-444444444444',
    seed_id: 'user-3',
    display_name: 'Private Explorer',
    email: 'private@juanderquest.ph',
    avatar_url: 'https://api.dicebear.com/7.x/avataaars/svg?seed=Private',
    role: 'user',
    demo_points: 50,
    mjdq_balance: 50000,
    jdq_governance_balance: 5,
    scout_reputation: 50,
    is_public: false,
    handle: 'stealthscout',
    bio: 'This is a private profile.',
    status_text: 'Hidden',
    is_test: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
];

const mockFollows: FollowRow[] = [
  {
    follower_id: '11111111-1111-1111-1111-111111111111',
    following_id: '33333333-3333-3333-3333-333333333333',
    created_at: new Date(Date.now() - 3600000).toISOString(),
  },
  {
    follower_id: '33333333-3333-3333-3333-333333333333',
    following_id: '11111111-1111-1111-1111-111111111111',
    created_at: new Date(Date.now() - 7200000).toISOString(),
  },
  {
    follower_id: '44444444-4444-4444-4444-444444444444',
    following_id: '11111111-1111-1111-1111-111111111111',
    created_at: new Date(Date.now() - 10800000).toISOString(),
  },
];

const mockCampaigns: CampaignRow[] = [
  {
    id: 'camp_1',
    host_id: '22222222-2222-2222-2222-222222222222',
    host_name: 'Pangasinan Tourism Office',
    title: 'Bolinao Coastal Eco-Cleanup Raid',
    category: 'eco',
    location_name: 'Patar White Beach, Bolinao',
    municipality: 'Bolinao',
    banner_image_url: 'https://images.unsplash.com/photo-1507525428034-b723cf961d3e?auto=format&fit=crop&w=1400&q=80',
    description: 'Join local residents and travelers to clean up Patar beach front before sunset. Earn 250,000 mJDQ (250 JDQ value) plus the exclusive Bolinao Coastal Steward Civic Badge.',
    event_date: '2026-09-12T08:00:00.000Z',
    start_date: '2026-09-12T08:00:00.000Z',
    end_date: '2026-09-12T17:00:00.000Z',
    total_budget_mjdq: 50000000,          // 50,000,000 mJDQ (50,000 JDQ value)
    reward_per_participant_mjdq: 250000, // 250,000 mJDQ (250 JDQ value)
    referral_bounty_mjdq: 50000,         // 50,000 mJDQ (50 JDQ) per referred attendee
    max_participants: 200,
    reserved_participants: 45,
    completed_participants: 12,
    unspent_refund_mjdq: 0,
    pre_quest_requirements: ['Visit Cape Bolinao Lighthouse', 'Log GPS check-in at Patar Arch'],
    gps_lat: 16.3025,
    gps_lng: 119.7824,
    gps_radius_meters: 250,
    status: 'active',
    created_at: new Date().toISOString(),
  },
  {
    id: 'camp_2',
    host_id: '22222222-2222-2222-2222-222222222222',
    host_name: 'Dagupan Heritage Foundation',
    title: 'Bangus Festival Street Dance & Photo Raid',
    category: 'cultural',
    location_name: 'Downtown Commercial Strip, Dagupan City',
    municipality: 'Dagupan City',
    banner_image_url: 'https://images.unsplash.com/photo-1533174072545-7a4b6ad7a6c3?auto=format&fit=crop&w=1400&q=80',
    description: 'Document traditional milkfish street dancing and culinary street grills for the municipal cultural archive. Earn 150,000 mJDQ and free seafood voucher.',
    event_date: '2026-09-20T09:00:00.000Z',
    start_date: '2026-09-20T09:00:00.000Z',
    end_date: '2026-09-20T21:00:00.000Z',
    total_budget_mjdq: 30000000,
    reward_per_participant_mjdq: 150000,
    referral_bounty_mjdq: 30000,
    max_participants: 200,
    reserved_participants: 68,
    completed_participants: 15,
    unspent_refund_mjdq: 0,
    pre_quest_requirements: ['Explore Dagupan Fish Port Market'],
    gps_lat: 16.0433,
    gps_lng: 120.3334,
    gps_radius_meters: 300,
    status: 'active',
    created_at: new Date().toISOString(),
  },
  {
    id: 'camp_3',
    host_id: '22222222-2222-2222-2222-222222222222',
    host_name: 'Lingayen Eco-Sports Alliance',
    title: 'Lingayen Gulf Beach Sports & Coastal Tour',
    category: 'sports_adventure',
    location_name: 'Capitol Beachfront Park, Lingayen',
    municipality: 'Lingayen',
    banner_image_url: 'https://images.unsplash.com/photo-1612872087720-bb876e2e67d1?auto=format&fit=crop&w=1400&q=80',
    description: 'Participate in beach volleyball exhibition and heritage monument walking tour around the historic Provincial Capitol grounds.',
    event_date: '2026-09-28T07:30:00.000Z',
    start_date: '2026-09-28T07:30:00.000Z',
    end_date: '2026-09-28T18:00:00.000Z',
    total_budget_mjdq: 20000000,
    reward_per_participant_mjdq: 200000,
    referral_bounty_mjdq: 40000,
    max_participants: 100,
    reserved_participants: 28,
    completed_participants: 6,
    unspent_refund_mjdq: 0,
    pre_quest_requirements: ['Visit Pangasinan Provincial Capitol Building'],
    gps_lat: 16.0218,
    gps_lng: 120.2319,
    gps_radius_meters: 200,
    status: 'active',
    created_at: new Date().toISOString(),
  },
  {
    id: 'camp_4',
    host_id: '22222222-2222-2222-2222-222222222222',
    host_name: 'Dasol Salt Producers Cooperative',
    title: 'Dasol Pacific Salt Bed Heritage Tour',
    category: 'food_trade',
    location_name: 'Dasol Salt Farm Basin, Dasol',
    municipality: 'Dasol',
    banner_image_url: 'https://images.unsplash.com/photo-1464822759023-fed622ff2c3b?auto=format&fit=crop&w=1400&q=80',
    description: 'Experience authentic Pangasinan artisanal salt harvesting methods. Capture harvest photos and earn 180,000 mJDQ with free souvenir salt pouch.',
    event_date: '2026-10-05T08:30:00.000Z',
    start_date: '2026-10-05T08:30:00.000Z',
    end_date: '2026-10-05T16:30:00.000Z',
    total_budget_mjdq: 18000000,
    reward_per_participant_mjdq: 180000,
    referral_bounty_mjdq: 35000,
    max_participants: 100,
    reserved_participants: 19,
    completed_participants: 3,
    unspent_refund_mjdq: 0,
    pre_quest_requirements: ['Visit Dasol Municipal Plaza'],
    gps_lat: 15.9892,
    gps_lng: 119.8806,
    gps_radius_meters: 350,
    status: 'active',
    created_at: new Date().toISOString(),
  },
];

const mockQuests: QuestRow[] = [
  {
    id: 'q1111111-1111-1111-1111-111111111111',
    title: 'Hundred Islands Eco Trek',
    description: "Visit Governor's Island viewing deck in Alaminos City and scan the eco-marker.",
    category: 'eco',
    location_name: 'Alaminos City, Pangasinan',
    gps_lat: 16.2063,
    gps_lng: 119.9706,
    radius_meters: 150,
    base_reward_php: 25.0,
    difficulty_factor: 1.0,
    geo_multiplier: 2.0, // LGU priority zone surge
    reward_points: 50,  // (25 * 1.0 * 2.0) / 1.0
    marker_code: 'MARKER_HUNDRED_ISLANDS_01',
    marker_image_url: 'https://raw.githubusercontent.com/JuanderQuest/assets/main/markers/hundred_islands.png',
    is_active: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
  {
    id: 'q2222222-2222-2222-2222-222222222222',
    title: 'Bolinao Lighthouse Cultural Heritage',
    description: 'Explore Cape Bolinao Lighthouse built in 1905 and scan the heritage marker.',
    category: 'cultural',
    location_name: 'Bolinao, Pangasinan',
    gps_lat: 16.3885,
    gps_lng: 119.9095,
    radius_meters: 200,
    base_reward_php: 30.0,
    difficulty_factor: 1.5,
    geo_multiplier: 1.6667,
    reward_points: 75,
    marker_code: 'MARKER_BOLINAO_LIGHTHOUSE_01',
    marker_image_url: 'https://raw.githubusercontent.com/JuanderQuest/assets/main/markers/bolinao_lighthouse.png',
    is_active: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
  {
    id: 'q3333333-3333-3333-3333-333333333333',
    title: 'Manaoag Shrine Pilgrimage',
    description: 'Visit the Minor Basilica of Our Lady of the Rosary of Manaoag.',
    category: 'cultural',
    location_name: 'Manaoag, Pangasinan',
    gps_lat: 16.0436,
    gps_lng: 120.4867,
    radius_meters: 100,
    base_reward_php: 30.0,
    difficulty_factor: 1.0,
    geo_multiplier: 2.0,
    reward_points: 60,
    marker_code: 'MARKER_MANAOAG_SHRINE_01',
    marker_image_url: 'https://raw.githubusercontent.com/JuanderQuest/assets/main/markers/manaoag.png',
    is_active: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
  {
    id: 'q4444444-4444-4444-4444-444444444444',
    title: 'Lingayen Gulf Beach & Capitol Park',
    description: 'Discover the historic Pangasinan Provincial Capitol and beach park.',
    category: 'cultural',
    location_name: 'Lingayen, Pangasinan',
    gps_lat: 16.0232,
    gps_lng: 120.2312,
    radius_meters: 250,
    base_reward_php: 20.0,
    difficulty_factor: 1.0,
    geo_multiplier: 2.0,
    reward_points: 40,
    marker_code: 'MARKER_LINGAYEN_CAPITOL_01',
    marker_image_url: 'https://raw.githubusercontent.com/JuanderQuest/assets/main/markers/lingayen.png',
    is_active: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
  {
    id: 'q5555555-5555-5555-5555-555555555555',
    title: 'Dagupan Bangus Taste & Trade Trail',
    description: 'Scan the culinary marker at the famous Dagupan City fish port marketplace.',
    category: 'food_trade',
    location_name: 'Dagupan City, Pangasinan',
    gps_lat: 16.0433,
    gps_lng: 120.3334,
    radius_meters: 150,
    base_reward_php: 25.0,
    difficulty_factor: 1.0,
    geo_multiplier: 2.0,
    reward_points: 50,
    marker_code: 'MARKER_DAGUPAN_BANGUS_01',
    marker_image_url: 'https://raw.githubusercontent.com/JuanderQuest/assets/main/markers/dagupan_bangus.png',
    is_active: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
  {
    id: 'qa-quest-tambobong',
    title: 'Dasol Cove Explorer (QA Test Quest)',
    description: 'A test quest verifying GPS radius and offline marker scanning in Dasol.',
    category: 'eco',
    location_name: 'Dasol, Pangasinan',
    gps_lat: 15.9083,
    gps_lng: 119.7892,
    radius_meters: 150,
    base_reward_php: 50.0,
    difficulty_factor: 1.0,
    geo_multiplier: 1.0,
    reward_points: 50,
    marker_code: 'QA_MARKER_DASOL_01',
    marker_image_url: '',
    is_active: false,
    is_test: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
];

const mockSubmissions: SubmissionRow[] = [
  {
    id: 'sub-seeded-governance-eligibility',
    idempotency_key: 'seeded-governance-eligibility',
    user_id: '11111111-1111-1111-1111-111111111111',
    quest_id: 'q5555555-5555-5555-5555-555555555555',
    scanned_marker_code: 'MARKER_DAGUPAN_BANGUS_01',
    captured_lat: 16.0433,
    captured_lng: 120.3334,
    captured_accuracy: 5,
    status: 'approved',
    reviewed_by: '22222222-2222-2222-2222-222222222222',
    reviewed_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
  {
    id: 'sub-genuine-pending-001',
    idempotency_key: 'genuine-idemp-sub-001',
    user_id: '11111111-1111-1111-1111-111111111111',
    quest_id: 'q1111111-1111-1111-1111-111111111111',
    scanned_marker_code: 'MARKER_HUNDRED_ISLANDS_01',
    captured_lat: 16.2064,
    captured_lng: 119.9707,
    captured_accuracy: 5,
    status: 'pending',
    is_test: false,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
  {
    id: 'sub-qa-pending-001',
    idempotency_key: 'qa-idemp-sub-001',
    user_id: '11111111-1111-1111-1111-111111111111',
    quest_id: 'qa-quest-tambobong',
    scanned_marker_code: 'QA_MARKER_DASOL_01',
    captured_lat: 15.9085,
    captured_lng: 119.7894,
    captured_accuracy: 6,
    status: 'pending',
    is_test: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
];

const mockProposals: ProposalRow[] = [
  {
    id: 'prop_1',
    title: 'Patar White Beach Eco Trail',
    location_name: 'Bolinao, Pangasinan',
    category: 'eco',
    description: 'Feature golden sand beaches and coral rock formations along Bolinao coast.',
    submitted_by: 'Juan Dela Cruz',
    votes: 210,
    created_at: new Date().toISOString(),
  },
  {
    id: 'prop_2',
    title: 'Tayug Sunflower Maze Quest',
    location_name: 'Tayug, Pangasinan',
    category: 'eco',
    description: 'Promote agri-tourism maze and flower farms in Tayug.',
    submitted_by: 'Maria Santos',
    votes: 142,
    created_at: new Date().toISOString(),
  },
  {
    id: 'prop_3',
    title: 'San Fabian Beach Heritage Trail',
    location_name: 'San Fabian, Pangasinan',
    category: 'cultural',
    description: 'Feature WWII historic landing sites along San Fabian beach park.',
    submitted_by: 'Juan Dela Cruz',
    votes: 98,
    created_at: new Date().toISOString(),
  },
];

const mockMerchants: MerchantRow[] = [
  { id: 'm1', name: 'Bangus Street Grill', location: 'Dagupan City, Pangasinan', description: 'Local grill house serving the famous Dagupan bangus (milkfish).', created_at: new Date().toISOString() },
  { id: 'm2', name: 'Bolinao Lighthouse Cafe', location: 'Bolinao, Pangasinan', description: 'Cafe beside Cape Bolinao Lighthouse with coastal views.', created_at: new Date().toISOString() },
  { id: 'm3', name: 'Alaminos Souvenir Hub', location: 'Alaminos City, Pangasinan', description: 'Souvenir shop near the Hundred Islands ferry port.', created_at: new Date().toISOString() },
];

const mockVouchers: VoucherRow[] = [
  { id: 'v1', merchant_id: 'm1', title: 'P50 Off Bangus Meal', description: 'Discount voucher valid for one meal at Bangus Street Grill.', cost_points: 100, fiat_floor_php: 50.0, is_active: true },
  { id: 'v2', merchant_id: 'm2', title: 'Free Iced Coffee', description: 'Free iced coffee at Bolinao Lighthouse Cafe.', cost_points: 60, fiat_floor_php: 60.0, is_active: true },
  { id: 'v3', merchant_id: 'm3', title: '15% Off Souvenirs', description: '15% discount on a single souvenir item at Alaminos Souvenir Hub.', cost_points: 80, fiat_floor_php: 80.0, is_active: true },
];

// Oracled Proof-of-Activity (PoA) reward calculation helper
export function computeOracledReward(
  quest: { base_reward_php: number; difficulty_factor: number; geo_multiplier: number },
  oracleRate: number = 1.0
): number {
  const base = quest.base_reward_php || 25.0;
  const difficulty = quest.difficulty_factor || 1.0;
  const geo = quest.geo_multiplier || 1.0;
  return Math.round((base * difficulty * geo) / oracleRate);
}

// Haversine Distance Calculation helper
export function calculateHaversineDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000; // Earth radius in meters
  const dLat = (lat2 - lat1) * (Math.PI / 180);
  const dLon = (lon2 - lon1) * (Math.PI / 180);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * (Math.PI / 180)) * Math.cos(lat2 * (Math.PI / 180)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(R * c * 10) / 10;
}

export function withinRadius(
  lat: number,
  lng: number,
  targetLat: number,
  targetLng: number,
  radiusMeters: number,
  accuracyMeters = 0
): { ok: boolean; distance: number } {
  const distance = calculateHaversineDistance(lat, lng, targetLat, targetLng);
  if (!Number.isFinite(distance)) return { ok: false, distance };
  const accuracyAllowance = Number.isFinite(accuracyMeters)
    ? Math.min(Math.max(accuracyMeters, 0), 25)
    : 0;
  return { ok: distance <= radiusMeters + accuracyAllowance, distance };
}

export class MemoryDb {
  users = developmentFixturesEnabled ? [...mockUsers] : [];
  quests = developmentFixturesEnabled ? [...mockQuests] : [];
  campaigns = developmentFixturesEnabled ? [...mockCampaigns] : [];
  submissions = developmentFixturesEnabled ? [...mockSubmissions] : [];
  proposals = developmentFixturesEnabled ? [...mockProposals] : [];
  merchants = developmentFixturesEnabled ? [...mockMerchants] : [];
  vouchers = developmentFixturesEnabled ? [...mockVouchers] : [];
  redemptions: RedemptionRow[] = [];
  follows: FollowRow[] = developmentFixturesEnabled ? [...mockFollows] : [];
  campaign_reservations: CampaignReservationRow[] = developmentFixturesEnabled ? [
    {
      id: 'res_1',
      campaign_id: 'camp_1',
      user_id: '11111111-1111-1111-1111-111111111111',
      user_display_name: 'Juan Dela Cruz',
      referred_by_user_id: null,
      referred_by_name: null,
      ticket_code: 'TICKET-BOLINAO-8821',
      status: 'reserved',
      created_at: new Date().toISOString(),
    },
  ] : [];
  treasury: TreasuryRow = developmentFixturesEnabled ? {
    growth_pool_mjdq: 50000000,       // 50,000,000 mJDQ (50,000 JDQ initial Growth Pool)
    total_burned_mjdq: 250000,        // 250,000 mJDQ (250 JDQ total burned)
    community_treasury_mjdq: 1000000, // 1,000,000 mJDQ (1,000 JDQ treasury)
    oracle_rate_php_per_jdq: 1.0,     // 1 JDQ = ₱1.00 Floor
  } : {
    growth_pool_mjdq: 0,
    total_burned_mjdq: 0,
    community_treasury_mjdq: 0,
    oracle_rate_php_per_jdq: 1.0,
  };
  ledger: LedgerEntryRow[] = developmentFixturesEnabled ? [
    {
      id: 'ledg-1',
      user_id: '11111111-1111-1111-1111-111111111111',
      entry_type: 'poa_reward',
      mjdq_delta: 50000, // 50,000 mJDQ (50 JDQ)
      jdq_delta: 0,
      burned_mjdq: 0,
      description: 'PoA Reward: Dagupan Bangus Taste & Trade Trail (D=1.0, G=2.0)',
      created_at: new Date().toISOString(),
    },
  ] : [];
  web_analytics_events: WebAnalyticsEventRow[] = [];
  quest_attempts: QuestAttemptRow[] = [];
  quest_step_evidence: QuestStepEvidenceRow[] = [];
  affiliate_applications: AffiliateApplicationRow[] = [];
  merchant_affiliate_drafts: MerchantAffiliateDraftRow[] = [];
  merchant_application_audits: MerchantApplicationAuditRow[] = [];
  merchant_memberships: MerchantMembershipRow[] = [];
  merchant_products: MerchantProductRow[] = [];

  private pg: Pool | null = null;
  private _usersRepo: UsersRepository | null = null;
  private _challengeService: AuthChallengeService | null = null;
  private _mailerService: AuthMailerService | null = null;
  private _identityService: UnifiedIdentityService | null = null;

  public get usersRepo(): UsersRepository {
    if (!this._usersRepo) {
      this._usersRepo = new UsersRepository(this.pg);
    }
    return this._usersRepo;
  }

  public get challengeService(): AuthChallengeService {
    if (!this._challengeService) {
      this._challengeService = new AuthChallengeService(this.pg);
    }
    return this._challengeService;
  }

  public get mailerService(): AuthMailerService {
    if (!this._mailerService) {
      this._mailerService = new AuthMailerService(this.pg);
    }
    return this._mailerService;
  }

  public get identityService(): UnifiedIdentityService {
    if (!this._identityService) {
      this._identityService = new UnifiedIdentityService(this.pg);
    }
    return this._identityService;
  }

  // Hydrates the in-memory arrays from PostgreSQL and attaches the pool for write-through.
  async hydrateFromPg(pool: Pool) {
    this.pg = pool;
    this.usersRepo.setPool(pool);
    this.challengeService.setPool(pool);
    this.mailerService.setPool(pool);
    this.identityService.setPool(pool);
    const toIso = (value: Date | string) => new Date(value).toISOString();
    const { rows: users } = await pool.query('SELECT * FROM users ORDER BY created_at');
    this.users = users.map((row: any) => ({
      id: row.id, seed_id: row.seed_id, display_name: row.display_name, email: row.email,
      avatar_url: row.avatar_url, role: row.role, demo_points: row.demo_points,
      mjdq_balance: row.mjdq_balance ?? row.demo_points * 1000,
      jdq_governance_balance: row.jdq_governance_balance ?? (row.seed_id?.startsWith('guest:') ? 0 : 15),
      scout_reputation: row.scout_reputation ?? 100,
      is_public: Boolean(row.is_public),
      handle: row.handle ?? null,
      bio: row.bio ?? null,
      status_text: row.status_text ?? null,
      is_test: Boolean(row.is_test),
      created_at: toIso(row.created_at), updated_at: toIso(row.updated_at),
    }));
    const { rows: quests } = await pool.query('SELECT * FROM quests ORDER BY created_at');
    this.quests = quests.map((row: any) => ({
      id: row.id, title: row.title, description: row.description, category: row.category,
      location_name: row.location_name, gps_lat: row.gps_lat, gps_lng: row.gps_lng,
      radius_meters: row.radius_meters,
      base_reward_php: row.base_reward_php ?? 25.0,
      difficulty_factor: row.difficulty_factor ?? 1.0,
      geo_multiplier: row.geo_multiplier ?? 2.0,
      reward_points: row.reward_points, marker_code: row.marker_code,
      marker_image_url: row.marker_image_url, is_active: row.is_active,
      is_test: Boolean(row.is_test),
      author_id: row.author_id ?? null,
      status: row.status ?? 'published',
      version: row.version ?? 1,
      steps: Array.isArray(row.steps) ? row.steps : [],
      created_at: toIso(row.created_at), updated_at: toIso(row.updated_at),
    }));
    try {
      const { rows: attempts } = await pool.query('SELECT * FROM quest_attempts ORDER BY created_at');
      this.quest_attempts = attempts.map((row: any) => ({
        id: row.id,
        quest_id: row.quest_id,
        user_id: row.user_id,
        version: row.version ?? 1,
        current_step: row.current_step ?? 1,
        total_steps: row.total_steps ?? 1,
        status: row.status,
        created_at: toIso(row.created_at),
        updated_at: toIso(row.updated_at),
        completed_at: row.completed_at ? toIso(row.completed_at) : null,
      }));
    } catch {
      // quest_attempts table may not exist in legacy dev fixtures
    }
    try {
      const { rows: affiliateApps } = await pool.query('SELECT * FROM merchant_affiliate_applications ORDER BY created_at DESC');
      this.affiliate_applications = affiliateApps.map((row: any) => ({
        id: row.id,
        user_id: row.user_id,
        business_name: row.business_name,
        category: row.category,
        municipality: row.municipality,
        contact_name: row.contact_name,
        contact_email: row.contact_email,
        contact_phone: row.contact_phone,
        sponsorship_goals: Array.isArray(row.sponsorship_goals) ? row.sponsorship_goals : [],
        proposal_details: row.proposal_details ?? '',
        status: row.status,
        version: row.version ? Number(row.version) : 1,
        business_address: row.business_address ?? '',
        business_province: row.business_province ?? 'Pangasinan',
        gps_lat: row.gps_lat != null ? Number(row.gps_lat) : null,
        gps_lng: row.gps_lng != null ? Number(row.gps_lng) : null,
        preferred_contact_method: row.preferred_contact_method ?? 'email',
        applicant_feedback: row.applicant_feedback ?? null,
        declaration_version: row.declaration_version ?? '1.0',
        reviewer_id: row.reviewer_id ?? null,
        reviewer_notes: row.reviewer_notes ?? null,
        reviewed_at: row.reviewed_at ? toIso(row.reviewed_at) : null,
        created_at: toIso(row.created_at),
        updated_at: toIso(row.updated_at),
      }));
    } catch {
      // merchant_affiliate_applications may not exist in legacy fixtures
    }
    try {
      const { rows: drafts } = await pool.query('SELECT * FROM merchant_affiliate_drafts');
      this.merchant_affiliate_drafts = drafts.map((row: any) => ({
        user_id: row.user_id,
        draft_data: row.draft_data || {},
        current_step: Number(row.current_step) || 1,
        revision: Number(row.revision) || 1,
        created_at: toIso(row.created_at),
        updated_at: toIso(row.updated_at),
      }));
    } catch {}
    try {
      const { rows: audits } = await pool.query('SELECT * FROM merchant_application_audits ORDER BY created_at ASC');
      this.merchant_application_audits = audits.map((row: any) => ({
        id: row.id,
        application_id: row.application_id,
        actor_id: row.actor_id ?? null,
        from_status: row.from_status,
        to_status: row.to_status,
        revision: Number(row.revision) || 1,
        notes: row.notes ?? null,
        applicant_feedback: row.applicant_feedback ?? null,
        created_at: toIso(row.created_at),
      }));
    } catch {}
    try {
      const { rows: memberships } = await pool.query('SELECT * FROM merchant_memberships');
      this.merchant_memberships = memberships.map((row: any) => ({
        id: row.id,
        merchant_id: row.merchant_id,
        user_id: row.user_id,
        role: row.role,
        status: row.status,
        created_at: toIso(row.created_at),
        updated_at: toIso(row.updated_at),
      }));
    } catch {}
    try {
      const { rows: products } = await pool.query('SELECT * FROM merchant_products ORDER BY display_order ASC, created_at DESC');
      this.merchant_products = products.map((row: any) => ({
        id: row.id,
        merchant_id: row.merchant_id,
        name: row.name,
        description: row.description ?? '',
        price: row.price != null ? Number(row.price) : null,
        currency: row.currency ?? 'PHP',
        image_url: row.image_url ?? null,
        is_published: Boolean(row.is_published),
        is_archived: Boolean(row.is_archived),
        display_order: Number(row.display_order) || 0,
        created_at: toIso(row.created_at),
        updated_at: toIso(row.updated_at),
      }));
    } catch {}
    const { rows: submissions } = await pool.query('SELECT * FROM submissions ORDER BY created_at');
    this.submissions = submissions.map((row: any) => ({
      id: row.id, idempotency_key: row.idempotency_key, user_id: row.user_id, quest_id: row.quest_id,
      scanned_marker_code: row.scanned_marker_code, captured_lat: row.captured_lat, captured_lng: row.captured_lng,
      captured_accuracy: row.captured_accuracy, status: row.status, rejection_reason: row.rejection_reason,
      reviewed_by: row.reviewed_by, reviewed_at: row.reviewed_at ? toIso(row.reviewed_at) : null,
      is_test: Boolean(row.is_test),
      created_at: toIso(row.created_at), updated_at: toIso(row.updated_at),
    }));
    const { rows: merchants } = await pool.query('SELECT * FROM merchants ORDER BY created_at');
    this.merchants = merchants.map((row: any) => ({
      id: row.id,
      name: row.name,
      location: row.location,
      description: row.description,
      status: row.status ?? 'active',
      is_published: Boolean(row.is_published),
      category: row.category ?? null,
      municipality: row.municipality ?? null,
      contact_email: row.contact_email ?? null,
      contact_phone: row.contact_phone ?? null,
      logo_url: row.logo_url ?? null,
      banner_url: row.banner_url ?? null,
      source_application_id: row.source_application_id ?? null,
      created_at: toIso(row.created_at),
    }));
    const { rows: vouchers } = await pool.query('SELECT * FROM vouchers ORDER BY id');
    this.vouchers = vouchers.map((row: any) => ({
      id: row.id, merchant_id: row.merchant_id, title: row.title, description: row.description,
      cost_points: row.cost_points, fiat_floor_php: row.fiat_floor_php ?? 50.0, is_active: row.is_active,
    }));
    const { rows: redemptions } = await pool.query('SELECT * FROM redemptions ORDER BY created_at');
    this.redemptions = redemptions.map((row: any) => ({
      id: row.id, voucher_id: row.voucher_id, user_id: row.user_id, code: row.code,
      cost_points: row.cost_points, idempotency_key: row.idempotency_key, created_at: toIso(row.created_at),
    }));
    const { rows: analytics } = await pool.query('SELECT * FROM web_analytics_events WHERE occurred_at >= NOW() - INTERVAL \'90 days\' ORDER BY occurred_at');
    this.web_analytics_events = analytics.map((row: any) => ({ id: row.id, event_type: row.event_type, path: row.path, label: row.label, session_id: row.session_id, occurred_at: toIso(row.occurred_at) }));
    try {
      const { rows: follows } = await pool.query('SELECT * FROM user_follows ORDER BY created_at');
      this.follows = follows.map((row: any) => ({ follower_id: row.follower_id, following_id: row.following_id, created_at: toIso(row.created_at) }));
    } catch {
      // user_follows may not exist yet in dev/fallback
    }
  }

  private async persist(query: string, params: unknown[]) {
    if (!this.pg) return;
    try {
      await this.pg.query(query, params);
    } catch (error) {
      console.error('[db] write-through failed:', (error as Error).message);
    }
  }

  recordWebAnalyticsEvent(event: WebAnalyticsEventRow) {
    this.web_analytics_events.push(event);
    if (this.web_analytics_events.length > 20000) this.web_analytics_events.splice(0, this.web_analytics_events.length - 20000);
    this.persist('INSERT INTO web_analytics_events (id,event_type,path,label,session_id,occurred_at) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO NOTHING', [event.id, event.event_type, event.path, event.label ?? null, event.session_id, event.occurred_at]);
  }

  getWebAnalyticsSummary(days: number) {
    const cutoff = Date.now() - days * 86400000;
    const events = this.web_analytics_events.filter((event) => Date.parse(event.occurred_at) >= cutoff);
    const views = events.filter((event) => event.event_type === 'page_view');
    const clicks = events.filter((event) => event.event_type === 'cta_click');
    const count = (items: WebAnalyticsEventRow[], key: 'path' | 'label') => Object.entries(items.reduce<Record<string, number>>((acc, item) => { const value = item[key] || 'unknown'; acc[value] = (acc[value] || 0) + 1; return acc; }, {})).sort((a, b) => b[1] - a[1]).slice(0, 10);
    const daily = Object.entries(views.reduce<Record<string, { views: number; sessions: Set<string> }>>((acc, event) => { const date = event.occurred_at.slice(0, 10); acc[date] ||= { views: 0, sessions: new Set() }; acc[date].views += 1; acc[date].sessions.add(event.session_id); return acc; }, {})).sort(([a], [b]) => a.localeCompare(b)).map(([date, value]) => ({ date, views: value.views, sessions: value.sessions.size }));
    return { days, totalViews: views.length, uniqueSessions: new Set(views.map((event) => event.session_id)).size, ctaClicks: clicks.length, topPages: count(views, 'path').map(([path, total]) => ({ path, views: total })), topCtas: count(clicks, 'label').map(([label, total]) => ({ label, clicks: total })), daily };
  }

  // Writes a quest row (insert or update). Used by the governance store when it schedules community quests.
  upsertQuest(quest: QuestRow) {
    const existing = this.quests.find((item) => item.id === quest.id);
    if (existing) Object.assign(existing, quest);
    else this.quests.push(quest);
    this.persist(
      `INSERT INTO quests (id, title, description, category, location_name, gps_lat, gps_lng, radius_meters, reward_points, marker_code, marker_image_url, is_active, author_id, status, version, steps)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       ON CONFLICT (id) DO UPDATE SET title=EXCLUDED.title, description=EXCLUDED.description, category=EXCLUDED.category,
         location_name=EXCLUDED.location_name, gps_lat=EXCLUDED.gps_lat, gps_lng=EXCLUDED.gps_lng,
         radius_meters=EXCLUDED.radius_meters, reward_points=EXCLUDED.reward_points, marker_code=EXCLUDED.marker_code,
         marker_image_url=EXCLUDED.marker_image_url, is_active=EXCLUDED.is_active,
         author_id=COALESCE(EXCLUDED.author_id, quests.author_id),
         status=EXCLUDED.status, version=EXCLUDED.version, steps=EXCLUDED.steps,
         updated_at=NOW()`,
      [quest.id, quest.title, quest.description, quest.category, quest.location_name, quest.gps_lat, quest.gps_lng,
        quest.radius_meters, quest.reward_points, quest.marker_code, quest.marker_image_url, quest.is_active,
        quest.author_id ?? null, quest.status ?? 'published', quest.version ?? 1, JSON.stringify(quest.steps ?? [])]
    );
  }

  private persistSubmission(sub: SubmissionRow) {
    this.persist(
      `INSERT INTO submissions (id, idempotency_key, user_id, quest_id, scanned_marker_code, captured_lat, captured_lng, captured_accuracy, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (id) DO NOTHING`,
      [sub.id, sub.idempotency_key, sub.user_id, sub.quest_id, sub.scanned_marker_code, sub.captured_lat, sub.captured_lng, sub.captured_accuracy, sub.status]
    );
  }

  private persistReview(sub: SubmissionRow) {
    this.persist(
      `UPDATE submissions SET status=$2, rejection_reason=$3, reviewed_by=$4, reviewed_at=NOW(), updated_at=NOW() WHERE id=$1`,
      [sub.id, sub.status, sub.rejection_reason ?? null, sub.reviewed_by ?? null]
    );
  }

  private persistUserPoints(userId: string, demoPoints: number) {
    this.persist('UPDATE users SET demo_points=$2, updated_at=NOW() WHERE id=$1', [userId, demoPoints]);
  }

  private persistRedemption(redemption: RedemptionRow) {
    this.persist(
      `INSERT INTO redemptions (id, voucher_id, user_id, code, cost_points, idempotency_key)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (user_id, idempotency_key) DO NOTHING`,
      [redemption.id, redemption.voucher_id, redemption.user_id, redemption.code, redemption.cost_points, redemption.idempotency_key]
    );
  }

  listProposals(): ProposalRow[] {
    return [...this.proposals].sort((a, b) => b.votes - a.votes);
  }

  createProposal(payload: Omit<ProposalRow, 'id' | 'votes' | 'created_at'>): ProposalRow {
    const newProp: ProposalRow = {
      ...payload,
      id: `prop_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      votes: 1,
      created_at: new Date().toISOString(),
    };
    this.proposals.unshift(newProp);
    return newProp;
  }

  voteProposal(id: string): ProposalRow | undefined {
    const prop = this.proposals.find((p) => p.id === id);
    if (prop) {
      prop.votes += 1;
    }
    return prop;
  }

  findUserBySeed(seedId: string): UserRow | undefined {
    return this.users.find((u) => u.seed_id === seedId);
  }

  findUserById(id: string): UserRow | undefined {
    return this.users.find((u) => u.id === id);
  }

  async findPublicUserById(id: string, allowTest = false): Promise<UserRow | undefined> {
    if (this.pg) {
      return await this.usersRepo.findPublicById(id, allowTest);
    }
    return this.users.find((u) => u.id === id && u.is_public && (allowTest || !u.is_test));
  }

  async findPublicUserByHandle(handle: string, allowTest = false): Promise<UserRow | undefined> {
    if (this.pg) {
      return await this.usersRepo.findPublicByHandle(handle, allowTest);
    }
    const clean = handle.replace(/^@/, '').toLowerCase().trim();
    return this.users.find((u) => u.is_public && u.handle?.toLowerCase() === clean && (allowTest || !u.is_test));
  }

  findUserByHandle(handle: string): UserRow | undefined {
    const clean = handle.replace(/^@/, '').toLowerCase().trim();
    return this.users.find((u) => u.handle?.toLowerCase() === clean);
  }

  async findUserByIdDurable(id: string): Promise<UserRow | undefined> {
    if (this.pg) {
      const row = await this.usersRepo.findById(id);
      if (row) {
        const idx = this.users.findIndex((u) => u.id === id);
        if (idx >= 0) this.users[idx] = row;
        else this.users.push(row);
      }
      return row;
    }
    return this.findUserById(id);
  }

  async findUserBySeedDurable(seedId: string): Promise<UserRow | undefined> {
    if (this.pg) {
      const row = await this.usersRepo.findBySeedId(seedId);
      if (row) {
        const idx = this.users.findIndex((u) => u.seed_id === seedId);
        if (idx >= 0) this.users[idx] = row;
        else this.users.push(row);
      }
      return row;
    }
    return this.findUserBySeed(seedId);
  }

  async findOrCreateUserDurable(data: CreateUserData): Promise<UserRow> {
    const user = await this.usersRepo.findOrCreateBySeedId(data);
    const idx = this.users.findIndex((u) => u.id === user.id || u.seed_id === user.seed_id);
    if (idx >= 0) {
      this.users[idx] = user;
    } else {
      this.users.push(user);
    }
    return user;
  }

  async findUserByWalletAddressDurable(walletAddress: string): Promise<UserRow | undefined> {
    const clean = walletAddress.trim().toLowerCase();
    if (this.pg) {
      const row = await this.usersRepo.findByWalletAddress(clean);
      if (row) {
        const idx = this.users.findIndex((u) => u.id === row.id);
        if (idx >= 0) this.users[idx] = row;
        else this.users.push(row);
      }
      return row;
    }
    return this.users.find((u) => u.wallet_address?.toLowerCase() === clean);
  }

  async bindWalletAddress(userId: string, walletAddress: string): Promise<UserRow> {
    const clean = walletAddress.trim();
    if (this.pg) {
      const updated = await this.usersRepo.bindWalletAddress(userId, clean);
      const memIdx = this.users.findIndex((u) => u.id === userId);
      if (memIdx >= 0) this.users[memIdx] = updated;
      else this.users.push(updated);
      return updated;
    }

    const conflict = this.users.find(
      (u) => u.wallet_address?.toLowerCase() === clean.toLowerCase() && u.id !== userId
    );
    if (conflict) {
      const err = new Error('WALLET_ALREADY_BOUND');
      (err as any).code = 'WALLET_ALREADY_BOUND';
      throw err;
    }

    const user = this.findUserById(userId);
    if (!user) {
      const err = new Error('USER_NOT_FOUND');
      (err as any).code = 'USER_NOT_FOUND';
      throw err;
    }

    user.wallet_address = clean;
    user.updated_at = new Date().toISOString();
    return user;
  }

  async unbindWalletAddress(userId: string): Promise<UserRow> {
    if (this.pg) {
      const updated = await this.usersRepo.unbindWalletAddress(userId);
      const memIdx = this.users.findIndex((u) => u.id === userId);
      if (memIdx >= 0) this.users[memIdx] = updated;
      return updated;
    }

    const user = this.findUserById(userId);
    if (!user) {
      const err = new Error('USER_NOT_FOUND');
      (err as any).code = 'USER_NOT_FOUND';
      throw err;
    }

    user.wallet_address = null;
    user.updated_at = new Date().toISOString();
    return user;
  }

  async updateUserProfile(
    userId: string,
    updates: { is_public?: boolean; handle?: string | null; bio?: string | null; status_text?: string | null; display_name?: string }
  ): Promise<UserRow | undefined> {
    if (this.pg) {
      const updated = await this.usersRepo.updateProfile(userId, updates);
      if (updated) {
        const memIdx = this.users.findIndex((u) => u.id === userId);
        if (memIdx >= 0) {
          this.users[memIdx] = updated;
        } else {
          this.users.push(updated);
        }
      }
      return updated;
    }

    const user = this.findUserById(userId);
    if (!user) return undefined;

    const normalizedHandle = updates.handle !== undefined
      ? (updates.handle ? updates.handle.replace(/^@/, '').toLowerCase().trim() : null)
      : undefined;

    if (normalizedHandle) {
      const conflict = this.users.find(
        (u) => u.id !== userId && u.handle?.toLowerCase() === normalizedHandle
      );
      if (conflict) {
        const err = new Error('HANDLE_TAKEN');
        (err as any).code = 'HANDLE_TAKEN';
        throw err;
      }
    }

    if (updates.is_public !== undefined) user.is_public = updates.is_public;
    if (updates.handle !== undefined) user.handle = normalizedHandle || null;
    if (updates.bio !== undefined) user.bio = updates.bio;
    if (updates.status_text !== undefined) user.status_text = updates.status_text;
    if (updates.display_name !== undefined) user.display_name = updates.display_name;
    user.updated_at = new Date().toISOString();
    return user;
  }

  async getFollowCounts(userId: string, ownerView = false, allowTest = false): Promise<{ follower_count: number; following_count: number }> {
    if (this.pg) {
      return await this.usersRepo.getFollowCounts(userId, ownerView, allowTest);
    }
    const user = this.findUserById(userId);
    if (!user || (!user.is_public && !ownerView)) {
      return { follower_count: 0, following_count: 0 };
    }
    const publicUserIds = new Set(this.users.filter((u) => u.is_public && (allowTest || !u.is_test)).map((u) => u.id));
    const follower_count = this.follows.filter(
      (f) => f.following_id === userId && publicUserIds.has(f.follower_id)
    ).length;
    const following_count = this.follows.filter(
      (f) => f.follower_id === userId && publicUserIds.has(f.following_id)
    ).length;
    return { follower_count, following_count };
  }

  async getRelationship(actorId: string, targetId: string): Promise<{
    is_following: boolean;
    follows_you: boolean;
    can_follow: boolean;
    reason?: 'PROFILE_VISIBILITY_REQUIRED' | 'CANNOT_FOLLOW_SELF' | 'TARGET_NOT_FOUND';
  }> {
    if (this.pg) {
      return await this.usersRepo.getRelationship(actorId, targetId);
    }
    const actor = this.findUserById(actorId);
    const target = this.findUserById(targetId);

    if (!target || !target.is_public) {
      return {
        is_following: false,
        follows_you: false,
        can_follow: false,
        reason: 'TARGET_NOT_FOUND',
      };
    }

    const is_following = this.follows.some((f) => f.follower_id === actorId && f.following_id === targetId);
    const follows_you = this.follows.some((f) => f.follower_id === targetId && f.following_id === actorId);

    if (actorId === targetId) {
      return {
        is_following: false,
        follows_you: false,
        can_follow: false,
        reason: 'CANNOT_FOLLOW_SELF',
      };
    }

    if (!actor || !actor.is_public) {
      return {
        is_following,
        follows_you,
        can_follow: false,
        reason: 'PROFILE_VISIBILITY_REQUIRED',
      };
    }

    return {
      is_following,
      follows_you,
      can_follow: true,
    };
  }

  async followUser(actorId: string, targetId: string): Promise<{
    success: boolean;
    error?: 'CANNOT_FOLLOW_SELF' | 'PROFILE_VISIBILITY_REQUIRED' | 'NOT_FOUND';
    follower_count?: number;
    following_count?: number;
  }> {
    if (actorId === targetId) {
      return { success: false, error: 'CANNOT_FOLLOW_SELF' };
    }

    if (this.pg) {
      const res = await this.usersRepo.followUser(actorId, targetId);
      if (res.success) {
        if (!this.follows.some((f) => f.follower_id === actorId && f.following_id === targetId)) {
          this.follows.push({
            follower_id: actorId,
            following_id: targetId,
            created_at: new Date().toISOString(),
          });
        }
      }
      return res;
    }

    const actor = this.findUserById(actorId);
    if (!actor || !actor.is_public) {
      return { success: false, error: 'PROFILE_VISIBILITY_REQUIRED' };
    }

    const target = this.findUserById(targetId);
    if (!target || !target.is_public) {
      return { success: false, error: 'NOT_FOUND' };
    }

    const nowIso = new Date().toISOString();
    if (!this.follows.some((f) => f.follower_id === actorId && f.following_id === targetId)) {
      this.follows.push({
        follower_id: actorId,
        following_id: targetId,
        created_at: nowIso,
      });
    }

    const counts = await this.getFollowCounts(targetId);
    return {
      success: true,
      follower_count: counts.follower_count,
      following_count: counts.following_count,
    };
  }

  async unfollowUser(actorId: string, targetId: string): Promise<{
    success: boolean;
    follower_count: number;
    following_count: number;
  }> {
    if (this.pg) {
      const res = await this.usersRepo.unfollowUser(actorId, targetId);
      this.follows = this.follows.filter(
        (f) => !(f.follower_id === actorId && f.following_id === targetId)
      );
      return res;
    }

    this.follows = this.follows.filter(
      (f) => !(f.follower_id === actorId && f.following_id === targetId)
    );

    const counts = await this.getFollowCounts(targetId);
    return {
      success: true,
      follower_count: counts.follower_count,
      following_count: counts.following_count,
    };
  }

  async listFollowers(
    targetId: string,
    limit: number = 20,
    cursor?: string,
    ownerView = false,
    allowTest = false
  ): Promise<{ items: PublicTravelerSummary[]; next_cursor: string | null; has_more: boolean } | null> {
    if (this.pg) {
      return await this.usersRepo.listFollowers(targetId, limit, cursor, ownerView, allowTest);
    }
    const target = this.findUserById(targetId);
    if (!target || (!target.is_public && !ownerView)) return null;

    const publicUserIds = new Set(this.users.filter((u) => u.is_public && (allowTest || !u.is_test)).map((u) => u.id));
    let candidates = this.follows.filter(
      (f) => f.following_id === targetId && publicUserIds.has(f.follower_id)
    );

    candidates.sort((a, b) => {
      const timeDiff = new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
      if (timeDiff !== 0) return timeDiff;
      return b.follower_id.localeCompare(a.follower_id);
    });

    if (cursor) {
      const parsed = decodeFollowCursor(cursor, targetId, 'followers');
      const cursorTime = new Date(parsed.created_at).getTime();
      candidates = candidates.filter((item) => {
        const itemTime = new Date(item.created_at).getTime();
        if (itemTime < cursorTime) return true;
        if (itemTime === cursorTime && item.follower_id.localeCompare(parsed.last_id) < 0) return true;
        return false;
      });
    }

    const cappedLimit = Math.min(50, Math.max(1, limit));
    const has_more = candidates.length > cappedLimit;
    const pageEdges = candidates.slice(0, cappedLimit);
    const next_cursor =
      has_more && pageEdges.length > 0
        ? encodeFollowCursor({
            target_id: targetId,
            direction: 'followers',
            created_at: pageEdges[pageEdges.length - 1].created_at,
            last_id: pageEdges[pageEdges.length - 1].follower_id,
            version: 'follow-v1',
          })
        : null;

    const byId = new Map(this.users.map((u) => [u.id, u]));
    const items: PublicTravelerSummary[] = pageEdges.flatMap((edge) => {
      const u = byId.get(edge.follower_id);
      if (!u || !u.is_public) return [];
      const counts = this.getFollowCountsSync(u.id);
      return [
        {
          id: u.id,
          display_name: u.display_name,
          handle: u.handle || null,
          avatar_url: u.avatar_url,
          bio: u.bio || null,
          status_text: u.status_text || null,
          scout_reputation: u.scout_reputation ?? 0,
          follower_count: counts.follower_count,
          following_count: counts.following_count,
        },
      ];
    });

    return { items, next_cursor, has_more };
  }

  async listFollowing(
    targetId: string,
    limit: number = 20,
    cursor?: string,
    allowTest = false
  ): Promise<{ items: PublicTravelerSummary[]; next_cursor: string | null; has_more: boolean } | null> {
    if (this.pg) {
      return await this.usersRepo.listFollowing(targetId, limit, cursor, allowTest);
    }
    const target = this.findUserById(targetId);
    if (!target || !target.is_public) return null;

    const publicUserIds = new Set(this.users.filter((u) => u.is_public && (allowTest || !u.is_test)).map((u) => u.id));
    let candidates = this.follows.filter(
      (f) => f.follower_id === targetId && publicUserIds.has(f.following_id)
    );

    candidates.sort((a, b) => {
      const timeDiff = new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
      if (timeDiff !== 0) return timeDiff;
      return b.following_id.localeCompare(a.following_id);
    });

    if (cursor) {
      const parsed = decodeFollowCursor(cursor, targetId, 'following');
      const cursorTime = new Date(parsed.created_at).getTime();
      candidates = candidates.filter((item) => {
        const itemTime = new Date(item.created_at).getTime();
        if (itemTime < cursorTime) return true;
        if (itemTime === cursorTime && item.following_id.localeCompare(parsed.last_id) < 0) return true;
        return false;
      });
    }

    const cappedLimit = Math.min(50, Math.max(1, limit));
    const has_more = candidates.length > cappedLimit;
    const pageEdges = candidates.slice(0, cappedLimit);
    const next_cursor =
      has_more && pageEdges.length > 0
        ? encodeFollowCursor({
            target_id: targetId,
            direction: 'following',
            created_at: pageEdges[pageEdges.length - 1].created_at,
            last_id: pageEdges[pageEdges.length - 1].following_id,
            version: 'follow-v1',
          })
        : null;

    const byId = new Map(this.users.map((u) => [u.id, u]));
    const items: PublicTravelerSummary[] = pageEdges.flatMap((edge) => {
      const u = byId.get(edge.following_id);
      if (!u || !u.is_public) return [];
      const counts = this.getFollowCountsSync(u.id);
      return [
        {
          id: u.id,
          display_name: u.display_name,
          handle: u.handle || null,
          avatar_url: u.avatar_url,
          bio: u.bio || null,
          status_text: u.status_text || null,
          scout_reputation: u.scout_reputation ?? 0,
          follower_count: counts.follower_count,
          following_count: counts.following_count,
        },
      ];
    });

    return { items, next_cursor, has_more };
  }

  async listMyFollowing(
    actorId: string,
    limit: number = 20,
    cursor?: string
  ): Promise<{ items: PublicTravelerSummary[]; next_cursor: string | null; has_more: boolean }> {
    if (this.pg) {
      return await this.usersRepo.listMyFollowing(actorId, limit, cursor);
    }
    let candidates = this.follows.filter((f) => f.follower_id === actorId);

    candidates.sort((a, b) => {
      const timeDiff = new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
      if (timeDiff !== 0) return timeDiff;
      return b.following_id.localeCompare(a.following_id);
    });

    if (cursor) {
      const parsed = decodeFollowCursor(cursor, actorId, 'following');
      const cursorTime = new Date(parsed.created_at).getTime();
      candidates = candidates.filter((item) => {
        const itemTime = new Date(item.created_at).getTime();
        if (itemTime < cursorTime) return true;
        if (itemTime === cursorTime && item.following_id.localeCompare(parsed.last_id) < 0) return true;
        return false;
      });
    }

    const cappedLimit = Math.min(50, Math.max(1, limit));
    const has_more = candidates.length > cappedLimit;
    const pageEdges = candidates.slice(0, cappedLimit);
    const next_cursor =
      has_more && pageEdges.length > 0
        ? encodeFollowCursor({
            target_id: actorId,
            direction: 'following',
            created_at: pageEdges[pageEdges.length - 1].created_at,
            last_id: pageEdges[pageEdges.length - 1].following_id,
            version: 'follow-v1',
          })
        : null;

    const byId = new Map(this.users.map((u) => [u.id, u]));
    const items: PublicTravelerSummary[] = pageEdges.map((edge) => {
      const u = byId.get(edge.following_id);
      if (!u || !u.is_public) {
        return {
          id: edge.following_id,
          display_name: 'Unavailable traveler',
          handle: null,
          avatar_url: '',
          bio: null,
          status_text: null,
          scout_reputation: 0,
          is_unavailable: true,
        };
      }
      const counts = this.getFollowCountsSync(u.id);
      return {
        id: u.id,
        display_name: u.display_name,
        handle: u.handle || null,
        avatar_url: u.avatar_url,
        bio: u.bio || null,
        status_text: u.status_text || null,
        scout_reputation: u.scout_reputation ?? 0,
        follower_count: counts.follower_count,
        following_count: counts.following_count,
        is_unavailable: false,
      };
    });

    return { items, next_cursor, has_more };
  }

  async listPublicUsers(limit: number = 3, allowTest: boolean = false): Promise<PublicTravelerSummary[]> {
    if (this.pg) {
      return await this.usersRepo.listPublicUsers(limit, allowTest);
    }
    const capped = Math.min(6, Math.max(1, limit));
    const publicUsers = this.users
      .filter((u) => u.is_public && (allowTest || !u.is_test))
      .sort((a, b) => a.display_name.localeCompare(b.display_name) || a.id.localeCompare(b.id))
      .slice(0, capped);

    return publicUsers.map((u) => {
      const counts = this.getFollowCountsSync(u.id);
      return {
        id: u.id,
        display_name: u.display_name,
        handle: u.handle || null,
        avatar_url: u.avatar_url,
        bio: u.bio || null,
        status_text: u.status_text || null,
        scout_reputation: u.scout_reputation ?? 0,
        follower_count: counts.follower_count,
        following_count: counts.following_count,
      };
    });
  }

  private getFollowCountsSync(userId: string): { follower_count: number; following_count: number } {
    const user = this.findUserById(userId);
    if (!user || !user.is_public) {
      return { follower_count: 0, following_count: 0 };
    }
    const publicUserIds = new Set(this.users.filter((u) => u.is_public).map((u) => u.id));
    const follower_count = this.follows.filter(
      (f) => f.following_id === userId && publicUserIds.has(f.follower_id)
    ).length;
    const following_count = this.follows.filter(
      (f) => f.follower_id === userId && publicUserIds.has(f.following_id)
    ).length;
    return { follower_count, following_count };
  }

  findQuestById(id: string, includeInactive = false): QuestRow | undefined {
    return this.quests.find((q) => q.id === id && (includeInactive || q.is_active));
  }

  listQuests(category?: string, allowTest = false): QuestRow[] {
    const filter = (q: QuestRow) => {
      const categoryMatches = !category || q.category === category;
      const activeMatches = q.is_active || (allowTest && q.is_test);
      return categoryMatches && activeMatches;
    };
    return this.quests.filter(filter);
  }

  getActiveAttempt(userId: string, questId: string): QuestAttemptRow | undefined {
    return this.quest_attempts.find((a) => a.user_id === userId && a.quest_id === questId && a.status === 'in_progress');
  }

  getAttemptsForUser(userId: string): QuestAttemptRow[] {
    return this.quest_attempts.filter((a) => a.user_id === userId);
  }

  getStepEvidence(attemptId: string): QuestStepEvidenceRow[] {
    return this.quest_step_evidence
      .filter((e) => e.attempt_id === attemptId)
      .sort((a, b) => a.step_order - b.step_order);
  }

  findStepEvidence(attemptId: string, stepOrder: number): QuestStepEvidenceRow | undefined {
    return this.quest_step_evidence.find((e) => e.attempt_id === attemptId && e.step_order === stepOrder);
  }

  saveStepEvidence(evidence: QuestStepEvidenceRow): QuestStepEvidenceRow {
    const existingIndex = this.quest_step_evidence.findIndex(
      (e) => e.attempt_id === evidence.attempt_id && e.step_order === evidence.step_order
    );
    if (existingIndex >= 0) {
      this.quest_step_evidence[existingIndex] = evidence;
    } else {
      this.quest_step_evidence.push(evidence);
    }
    return evidence;
  }

  createAttempt(payload: Omit<QuestAttemptRow, 'created_at' | 'updated_at' | 'completed_at'>): QuestAttemptRow {
    const stepsSnapshot = payload.steps_snapshot && payload.steps_snapshot.length > 0
      ? payload.steps_snapshot
      : [
          {
            step_order: 1,
            title: 'Destination check-in',
            description: 'Submit location proof for verification.',
            checkpoint_type: 'location',
            required: true,
          } as QuestStep,
        ];
    const requiredCount = stepsSnapshot.filter((s) => s.required !== false).length;

    const newAttempt: QuestAttemptRow = {
      ...payload,
      steps_snapshot: stepsSnapshot,
      verified_steps: payload.verified_steps ?? 0,
      required_steps: payload.required_steps ?? requiredCount,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      completed_at: null,
    };
    this.quest_attempts.push(newAttempt);

    // Initialize per-step evidence records in memory
    for (const step of stepsSnapshot) {
      this.saveStepEvidence({
        id: `step_ev_${randomUUID()}`,
        attempt_id: newAttempt.id,
        quest_id: newAttempt.quest_id,
        user_id: newAttempt.user_id,
        step_order: step.step_order,
        checkpoint_type: step.checkpoint_type,
        status: step.step_order === 1 ? 'ready' : 'not_started',
        required: step.required !== false,
        title: step.title,
        description: step.description,
        evidence_payload: null,
        rejection_reason: null,
        verified_at: null,
        reviewed_by: null,
        reviewed_at: null,
        created_at: newAttempt.created_at,
        updated_at: newAttempt.updated_at,
      });
    }

    this.persist(
      `INSERT INTO quest_attempts (id, quest_id, user_id, version, current_step, total_steps, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
       ON CONFLICT (id) DO UPDATE SET current_step = EXCLUDED.current_step, status = EXCLUDED.status, updated_at = NOW()`,
      [newAttempt.id, newAttempt.quest_id, newAttempt.user_id, newAttempt.version, newAttempt.current_step, newAttempt.total_steps, newAttempt.status]
    );
    return newAttempt;
  }

  completeAttempt(userId: string, questId: string): QuestAttemptRow | undefined {
    const attempt = this.getActiveAttempt(userId, questId);
    if (attempt) {
      attempt.status = 'completed';
      attempt.completed_at = new Date().toISOString();
      attempt.updated_at = new Date().toISOString();
      this.persist(
        `UPDATE quest_attempts SET status = 'completed', completed_at = NOW(), updated_at = NOW() WHERE id = $1`,
        [attempt.id]
      );
    }
    return attempt;
  }

  getQuestAttemptStats(questId: string): { total_attempts: number; active_attempts: number; completed_attempts: number } {
    const attempts = this.quest_attempts.filter((a) => a.quest_id === questId);
    return {
      total_attempts: attempts.length,
      active_attempts: attempts.filter((a) => a.status === 'in_progress').length,
      completed_attempts: attempts.filter((a) => a.status === 'completed').length,
    };
  }

  findAffiliateApplicationByUser(userId: string): AffiliateApplicationRow | undefined {
    const userApps = this.affiliate_applications.filter((a) => a.user_id === userId);
    const active = userApps.find((a) => a.status === 'received' || a.status === 'in_review' || a.status === 'needs_changes');
    if (active) return active;
    return userApps[0];
  }

  findAffiliateApplicationById(id: string): AffiliateApplicationRow | undefined {
    return this.affiliate_applications.find((a) => a.id === id);
  }

  listAffiliateApplications(status?: AffiliateApplicationStatus): AffiliateApplicationRow[] {
    let list = this.affiliate_applications;
    if (status) {
      list = list.filter((a) => a.status === status);
    }
    return [...list].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  }

  getAffiliateDraft(userId: string): MerchantAffiliateDraftRow | undefined {
    return this.merchant_affiliate_drafts.find((d) => d.user_id === userId);
  }

  saveAffiliateDraft(userId: string, draftData: Record<string, any>, currentStep: number, expectedRevision?: number): MerchantAffiliateDraftRow {
    const existing = this.getAffiliateDraft(userId);
    const now = new Date().toISOString();

    if (existing) {
      if (expectedRevision !== undefined && existing.revision !== expectedRevision) {
        const err: any = new Error('Draft revision conflict');
        err.code = 'VERSION_CONFLICT';
        err.currentRevision = existing.revision;
        throw err;
      }
      existing.draft_data = draftData;
      existing.current_step = currentStep;
      existing.revision += 1;
      existing.updated_at = now;
      this.persist(
        `INSERT INTO merchant_affiliate_drafts (user_id, draft_data, current_step, revision, updated_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (user_id) DO UPDATE SET draft_data = EXCLUDED.draft_data, current_step = EXCLUDED.current_step, revision = EXCLUDED.revision, updated_at = NOW()`,
        [userId, JSON.stringify(draftData), currentStep, existing.revision]
      );
      return existing;
    }

    const newDraft: MerchantAffiliateDraftRow = {
      user_id: userId,
      draft_data: draftData,
      current_step: currentStep,
      revision: 1,
      created_at: now,
      updated_at: now,
    };
    this.merchant_affiliate_drafts.push(newDraft);
    this.persist(
      `INSERT INTO merchant_affiliate_drafts (user_id, draft_data, current_step, revision, created_at, updated_at)
       VALUES ($1, $2, $3, $4, NOW(), NOW())
       ON CONFLICT (user_id) DO UPDATE SET draft_data = EXCLUDED.draft_data, current_step = EXCLUDED.current_step, revision = EXCLUDED.revision, updated_at = NOW()`,
      [userId, JSON.stringify(draftData), currentStep, 1]
    );
    return newDraft;
  }

  deleteAffiliateDraft(userId: string): void {
    this.merchant_affiliate_drafts = this.merchant_affiliate_drafts.filter((d) => d.user_id !== userId);
    this.persist('DELETE FROM merchant_affiliate_drafts WHERE user_id = $1', [userId]);
  }

  createAffiliateApplication(payload: Omit<AffiliateApplicationRow, 'id' | 'status' | 'reviewer_id' | 'reviewer_notes' | 'reviewed_at' | 'created_at' | 'updated_at'>): AffiliateApplicationRow {
    const existingActive = this.affiliate_applications.find(
      (a) => a.user_id === payload.user_id && (a.status === 'received' || a.status === 'in_review' || a.status === 'needs_changes')
    );
    if (existingActive) {
      const error: any = new Error('You already have an active application under review.');
      error.code = 'ACTIVE_APPLICATION_EXISTS';
      throw error;
    }

    const now = new Date().toISOString();
    const id = `app_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const newApp: AffiliateApplicationRow = {
      id,
      user_id: payload.user_id,
      business_name: payload.business_name,
      category: payload.category,
      municipality: payload.municipality,
      contact_name: payload.contact_name,
      contact_email: payload.contact_email,
      contact_phone: payload.contact_phone,
      sponsorship_goals: payload.sponsorship_goals,
      proposal_details: payload.proposal_details || '',
      status: 'received',
      version: payload.version ?? 1,
      business_address: payload.business_address ?? '',
      business_province: payload.business_province ?? 'Pangasinan',
      gps_lat: payload.gps_lat ?? null,
      gps_lng: payload.gps_lng ?? null,
      preferred_contact_method: payload.preferred_contact_method ?? 'email',
      applicant_feedback: null,
      declaration_version: payload.declaration_version ?? '1.0',
      created_at: now,
      updated_at: now,
    };

    this.affiliate_applications.unshift(newApp);
    this.deleteAffiliateDraft(payload.user_id);

    this.recordApplicationAudit(newApp.id, payload.user_id, 'draft', 'received', 1, 'Initial submission');

    this.persist(
      `INSERT INTO merchant_affiliate_applications 
       (id, user_id, business_name, category, municipality, contact_name, contact_email, contact_phone, sponsorship_goals, proposal_details, status, version, business_address, business_province, gps_lat, gps_lng, preferred_contact_method, declaration_version, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, NOW(), NOW())`,
      [
        newApp.id,
        newApp.user_id,
        newApp.business_name,
        newApp.category,
        newApp.municipality,
        newApp.contact_name,
        newApp.contact_email,
        newApp.contact_phone,
        JSON.stringify(newApp.sponsorship_goals),
        newApp.proposal_details,
        newApp.status,
        newApp.version ?? 1,
        newApp.business_address ?? '',
        newApp.business_province ?? 'Pangasinan',
        newApp.gps_lat,
        newApp.gps_lng,
        newApp.preferred_contact_method ?? 'email',
        newApp.declaration_version ?? '1.0',
      ]
    );
    return newApp;
  }

  resubmitAffiliateApplication(id: string, userId: string, payload: Partial<AffiliateApplicationRow>): AffiliateApplicationRow {
    const app = this.findAffiliateApplicationById(id);
    if (!app) {
      const err: any = new Error('Application not found');
      err.code = 'APPLICATION_NOT_FOUND';
      throw err;
    }
    if (app.user_id !== userId) {
      const err: any = new Error('Forbidden');
      err.code = 'FORBIDDEN';
      throw err;
    }
    if (app.status !== 'needs_changes') {
      const err: any = new Error('Only applications marked needs_changes can be resubmitted.');
      err.code = 'INVALID_STATE_TRANSITION';
      throw err;
    }

    const now = new Date().toISOString();
    const oldStatus = app.status;
    app.status = 'received';
    app.version = (app.version || 1) + 1;
    if (payload.business_name) app.business_name = payload.business_name;
    if (payload.category) app.category = payload.category;
    if (payload.municipality) app.municipality = payload.municipality;
    if (payload.business_province) app.business_province = payload.business_province;
    if (payload.contact_name) app.contact_name = payload.contact_name;
    if (payload.contact_email) app.contact_email = payload.contact_email;
    if (payload.contact_phone) app.contact_phone = payload.contact_phone;
    if (payload.sponsorship_goals) app.sponsorship_goals = payload.sponsorship_goals;
    if (payload.proposal_details !== undefined) app.proposal_details = payload.proposal_details;
    if (payload.business_address !== undefined) app.business_address = payload.business_address;
    if (payload.gps_lat !== undefined) app.gps_lat = payload.gps_lat;
    if (payload.gps_lng !== undefined) app.gps_lng = payload.gps_lng;
    if (payload.preferred_contact_method) app.preferred_contact_method = payload.preferred_contact_method;
    app.applicant_feedback = null;
    app.updated_at = now;

    this.recordApplicationAudit(app.id, userId, oldStatus, 'received', app.version, 'Applicant resubmission');

    this.persist(
      `UPDATE merchant_affiliate_applications 
       SET status = 'received', version = $1, business_name = $2, category = $3, municipality = $4,
           contact_name = $5, contact_email = $6, contact_phone = $7, sponsorship_goals = $8,
           proposal_details = $9, business_address = $10, gps_lat = $11, gps_lng = $12,
           preferred_contact_method = $13, business_province = $14, applicant_feedback = NULL, updated_at = NOW()
       WHERE id = $15`,
      [
        app.version,
        app.business_name,
        app.category,
        app.municipality,
        app.contact_name,
        app.contact_email,
        app.contact_phone,
        JSON.stringify(app.sponsorship_goals),
        app.proposal_details,
        app.business_address ?? '',
        app.gps_lat,
        app.gps_lng,
        app.preferred_contact_method ?? 'email',
        app.business_province ?? 'Pangasinan',
        app.id,
      ]
    );
    return app;
  }

  recordApplicationAudit(applicationId: string, actorId: string | null, fromStatus: string, toStatus: string, revision: number, notes?: string | null, applicantFeedback?: string | null): MerchantApplicationAuditRow {
    const audit: MerchantApplicationAuditRow = {
      id: `audit_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      application_id: applicationId,
      actor_id: actorId,
      from_status: fromStatus,
      to_status: toStatus,
      revision,
      notes: notes ?? null,
      applicant_feedback: applicantFeedback ?? null,
      created_at: new Date().toISOString(),
    };
    this.merchant_application_audits.push(audit);
    this.persist(
      `INSERT INTO merchant_application_audits (id, application_id, actor_id, from_status, to_status, revision, notes, applicant_feedback, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())`,
      [audit.id, audit.application_id, audit.actor_id, audit.from_status, audit.to_status, audit.revision, audit.notes, audit.applicant_feedback]
    );
    return audit;
  }

  getApplicationAudits(applicationId: string): MerchantApplicationAuditRow[] {
    return this.merchant_application_audits.filter((a) => a.application_id === applicationId).sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
  }

  updateAffiliateApplicationStatus(id: string, update: { status: AffiliateApplicationStatus; reviewer_id: string; reviewer_notes?: string | null; applicant_feedback?: string | null; expected_version?: number }): AffiliateApplicationRow | null {
    const app = this.findAffiliateApplicationById(id);
    if (!app) return null;

    if (update.expected_version !== undefined && app.version !== undefined && app.version !== update.expected_version) {
      const err: any = new Error('Application version conflict');
      err.code = 'VERSION_CONFLICT';
      throw err;
    }

    const fromStatus = app.status;
    const now = new Date().toISOString();
    app.status = update.status;
    app.reviewer_id = update.reviewer_id;
    app.reviewer_notes = update.reviewer_notes ?? null;
    if (update.applicant_feedback !== undefined) {
      app.applicant_feedback = update.applicant_feedback;
    }
    app.reviewed_at = now;
    app.updated_at = now;

    this.recordApplicationAudit(app.id, update.reviewer_id, fromStatus, update.status, app.version || 1, update.reviewer_notes, update.applicant_feedback);

    this.persist(
      `UPDATE merchant_affiliate_applications 
       SET status = $1, reviewer_id = $2, reviewer_notes = $3, applicant_feedback = $4, reviewed_at = NOW(), updated_at = NOW()
       WHERE id = $5`,
      [app.status, app.reviewer_id, app.reviewer_notes, app.applicant_feedback ?? null, app.id]
    );

    // If status is 'approved', atomically provision merchant and owner membership
    if (update.status === 'approved') {
      this.provisionMerchantForApplication(app);
    }

    return app;
  }

  private provisionMerchantForApplication(app: AffiliateApplicationRow): MerchantRow {
    let merchant = this.merchants.find((m) => m.source_application_id === app.id);
    const now = new Date().toISOString();

    if (!merchant) {
      const merchantId = `m_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
      merchant = {
        id: merchantId,
        name: app.business_name,
        location: `${app.municipality}, ${app.business_province || 'Pangasinan'}`,
        description: app.proposal_details || `${app.business_name} in ${app.municipality}`,
        status: 'active',
        is_published: false,
        category: app.category,
        municipality: app.municipality,
        contact_email: app.contact_email,
        contact_phone: app.contact_phone,
        source_application_id: app.id,
        created_at: now,
      };
      this.merchants.push(merchant);
      this.persist(
        `INSERT INTO merchants (id, name, location, description, status, is_published, category, municipality, contact_email, contact_phone, source_application_id, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
         ON CONFLICT (id) DO NOTHING`,
        [merchant.id, merchant.name, merchant.location, merchant.description, merchant.status, merchant.is_published, merchant.category, merchant.municipality, merchant.contact_email, merchant.contact_phone, merchant.source_application_id]
      );
    }

    // Ensure applicant is active owner in merchant_memberships
    const existingMembership = this.merchant_memberships.find(
      (m) => m.merchant_id === merchant!.id && m.user_id === app.user_id
    );
    if (!existingMembership) {
      const membershipId = `memb_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
      const newMembership: MerchantMembershipRow = {
        id: membershipId,
        merchant_id: merchant.id,
        user_id: app.user_id,
        role: 'owner',
        status: 'active',
        created_at: now,
        updated_at: now,
      };
      this.merchant_memberships.push(newMembership);
      this.persist(
        `INSERT INTO merchant_memberships (id, merchant_id, user_id, role, status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
         ON CONFLICT (merchant_id, user_id) DO UPDATE SET status = 'active', updated_at = NOW()`,
        [newMembership.id, newMembership.merchant_id, newMembership.user_id, newMembership.role, newMembership.status]
      );
    }

    return merchant;
  }

  // Merchant membership and resource helpers
  getMerchantMembershipForUser(userId: string): { membership: MerchantMembershipRow; merchant: MerchantRow } | undefined {
    const membership = this.merchant_memberships.find((m) => m.user_id === userId && m.status === 'active');
    if (!membership) return undefined;
    const merchant = this.merchants.find((m) => m.id === membership.merchant_id && m.status === 'active');
    if (!merchant) return undefined;
    return { membership, merchant };
  }

  findMerchantById(id: string): MerchantRow | undefined {
    return this.merchants.find((m) => m.id === id);
  }

  listMerchants(): MerchantRow[] {
    return [...this.merchants].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  }

  listMerchantMemberships(merchantId: string): MerchantMembershipRow[] {
    return this.merchant_memberships.filter((m) => m.merchant_id === merchantId);
  }

  updateMerchantProfile(merchantId: string, updates: Partial<MerchantRow>): MerchantRow | undefined {
    const merchant = this.merchants.find((m) => m.id === merchantId);
    if (!merchant) return undefined;

    if (updates.name !== undefined) merchant.name = updates.name;
    if (updates.description !== undefined) merchant.description = updates.description;
    if (updates.location !== undefined) merchant.location = updates.location;
    if (updates.municipality !== undefined) merchant.municipality = updates.municipality;
    if (updates.contact_email !== undefined) merchant.contact_email = updates.contact_email;
    if (updates.contact_phone !== undefined) merchant.contact_phone = updates.contact_phone;
    if (updates.logo_url !== undefined) merchant.logo_url = updates.logo_url;
    if (updates.banner_url !== undefined) merchant.banner_url = updates.banner_url;
    if (updates.is_published !== undefined) merchant.is_published = updates.is_published;

    this.persist(
      `UPDATE merchants 
       SET name = $1, description = $2, location = $3, municipality = $4, contact_email = $5,
           contact_phone = $6, logo_url = $7, banner_url = $8, is_published = $9
       WHERE id = $10`,
      [
        merchant.name,
        merchant.description,
        merchant.location,
        merchant.municipality ?? null,
        merchant.contact_email ?? null,
        merchant.contact_phone ?? null,
        merchant.logo_url ?? null,
        merchant.banner_url ?? null,
        merchant.is_published ?? false,
        merchant.id,
      ]
    );
    return merchant;
  }

  listMerchantProducts(merchantId: string, includeArchived = false): MerchantProductRow[] {
    return this.merchant_products
      .filter((p) => p.merchant_id === merchantId && (includeArchived || !p.is_archived))
      .sort((a, b) => a.display_order - b.display_order || new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  }

  findMerchantProductById(productId: string): MerchantProductRow | undefined {
    return this.merchant_products.find((p) => p.id === productId);
  }

  createMerchantProduct(payload: Omit<MerchantProductRow, 'id' | 'created_at' | 'updated_at'>): MerchantProductRow {
    const now = new Date().toISOString();
    const id = `prod_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const product: MerchantProductRow = {
      ...payload,
      id,
      created_at: now,
      updated_at: now,
    };
    this.merchant_products.push(product);
    this.persist(
      `INSERT INTO merchant_products (id, merchant_id, name, description, price, currency, image_url, is_published, is_archived, display_order, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW(), NOW())`,
      [product.id, product.merchant_id, product.name, product.description, product.price ?? null, product.currency, product.image_url ?? null, product.is_published, product.is_archived, product.display_order]
    );
    return product;
  }

  updateMerchantProduct(productId: string, updates: Partial<MerchantProductRow>): MerchantProductRow | undefined {
    const product = this.merchant_products.find((p) => p.id === productId);
    if (!product) return undefined;

    const now = new Date().toISOString();
    if (updates.name !== undefined) product.name = updates.name;
    if (updates.description !== undefined) product.description = updates.description;
    if (updates.price !== undefined) product.price = updates.price;
    if (updates.currency !== undefined) product.currency = updates.currency;
    if (updates.image_url !== undefined) product.image_url = updates.image_url;
    if (updates.is_published !== undefined) product.is_published = updates.is_published;
    if (updates.is_archived !== undefined) product.is_archived = updates.is_archived;
    if (updates.display_order !== undefined) product.display_order = updates.display_order;
    product.updated_at = now;

    this.persist(
      `UPDATE merchant_products 
       SET name = $1, description = $2, price = $3, currency = $4, image_url = $5, is_published = $6, is_archived = $7, display_order = $8, updated_at = NOW()
       WHERE id = $9`,
      [product.name, product.description, product.price ?? null, product.currency, product.image_url ?? null, product.is_published, product.is_archived, product.display_order, product.id]
    );
    return product;
  }

  archiveMerchantProduct(productId: string): boolean {
    const updated = this.updateMerchantProduct(productId, { is_archived: true, is_published: false });
    return Boolean(updated);
  }

  // User-scoped idempotency lookup (Fix 4.4)
  findSubmissionByIdempotency(key: string, userId: string): SubmissionRow | undefined {
    return this.submissions.find((s) => s.idempotency_key === key && s.user_id === userId);
  }

  hasApprovedSubmission(userId: string, questId: string): boolean {
    return this.submissions.some((s) => s.user_id === userId && s.quest_id === questId && s.status === 'approved');
  }

  hasPendingSubmission(userId: string, questId: string): boolean {
    return this.submissions.some((s) => s.user_id === userId && s.quest_id === questId && s.status === 'pending');
  }

  createSubmission(payload: Omit<SubmissionRow, 'id' | 'created_at' | 'updated_at'>): SubmissionRow {
    const newSub: SubmissionRow = {
      ...payload,
      id: `sub_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    this.submissions.push(newSub);
    this.persistSubmission(newSub);
    return newSub;
  }

  listSubmissionsForUser(userId: string): Array<SubmissionRow & { quest_title: string; category: string; reward_points: number }> {
    return this.submissions
      .filter((s) => s.user_id === userId)
      .map((s) => {
        const quest = this.findQuestById(s.quest_id, true);
        return {
          ...s,
          quest_title: quest?.title || 'Unknown Quest',
          category: quest?.category || 'eco',
          reward_points: quest?.reward_points || 0,
        };
      });
  }

  listAllSubmissions(statusFilter?: string) {
    return this.submissions
      .filter((s) => (statusFilter ? s.status === statusFilter : true))
      .map((s) => {
        const user = this.findUserById(s.user_id);
        const quest = this.findQuestById(s.quest_id, true);
        const distance_meters = calculateHaversineDistance(
          s.captured_lat,
          s.captured_lng,
          quest?.gps_lat || 0,
          quest?.gps_lng || 0
        );

        return {
          ...s,
          user_name: user?.display_name || 'Unknown User',
          quest_title: quest?.title || 'Unknown Quest',
          target_lat: quest?.gps_lat || 0,
          target_lng: quest?.gps_lng || 0,
          distance_meters,
          quest_radius_meters: quest?.radius_meters || 0,
        };
      });
  }

  // Idempotent state transition & single point award (Fix 4.5 & 4.7)
  reviewSubmission(id: string, action: 'approve' | 'reject', adminId: string, reason?: string): { submission: SubmissionRow; alreadyReviewed: boolean; conflicting: boolean; reason?: 'ALREADY_COMPLETED' } | undefined {
    const sub = this.submissions.find((s) => s.id === id);
    if (!sub) return undefined;

    const targetStatus = action === 'approve' ? 'approved' : 'rejected';

    if (action === 'approve' && this.submissions.some((candidate) =>
      candidate.id !== id && candidate.user_id === sub.user_id && candidate.quest_id === sub.quest_id && candidate.status === 'approved')) {
      return { submission: sub, alreadyReviewed: false, conflicting: true, reason: 'ALREADY_COMPLETED' };
    }

    // Idempotent check: if already in target status, return without re-adding points
    if (sub.status === targetStatus) {
      return { submission: sub, alreadyReviewed: true, conflicting: false };
    }

    // Conflicting terminal state (e.g. reject after approve): explicit conflict, not silent success
    if (sub.status !== 'pending') {
      return { submission: sub, alreadyReviewed: true, conflicting: true };
    }

    sub.status = action === 'approve' ? 'approved' : 'rejected';
    sub.reviewed_by = adminId;
    sub.reviewed_at = new Date().toISOString();
    sub.updated_at = sub.reviewed_at;
    if (action === 'reject' && reason) {
      sub.rejection_reason = reason;
    }

    if (action === 'approve') {
      const user = this.findUserById(sub.user_id);
      const quest = this.findQuestById(sub.quest_id);
      if (user && quest) {
        user.demo_points += quest.reward_points;
        user.updated_at = sub.updated_at;
        this.persistUserPoints(user.id, user.demo_points);
      }
    }

    this.persistReview(sub);

    return { submission: sub, alreadyReviewed: false, conflicting: false };
  }

  listVouchers(): Array<VoucherRow & { merchant_name: string }> {
    return this.vouchers
      .filter((voucher) => voucher.is_active)
      .map((voucher) => ({
        ...voucher,
        merchant_name: this.merchants.find((merchant) => merchant.id === voucher.merchant_id)?.name || 'Unknown Merchant',
      }));
  }

  findVoucherById(id: string): VoucherRow | undefined {
    return this.vouchers.find((voucher) => voucher.id === id && voucher.is_active);
  }

  findRedemptionByIdempotency(key: string, userId: string): RedemptionRow | undefined {
    return this.redemptions.find((redemption) => redemption.idempotency_key === key && redemption.user_id === userId);
  }

  // Redeems a voucher: atomic points deduction, unique code, user-scoped idempotent replay.
  redeemVoucher(
    voucherId: string,
    userId: string,
    idempotencyKey: string
  ): { redemption: RedemptionRow; replayed: boolean } | { error: 'NOT_FOUND' | 'INSUFFICIENT_POINTS' | 'ALREADY_REDEEMED' } {
    const replay = this.findRedemptionByIdempotency(idempotencyKey, userId);
    if (replay) return { redemption: replay, replayed: true };

    const voucher = this.findVoucherById(voucherId);
    if (!voucher) return { error: 'NOT_FOUND' };

    if (this.redemptions.some((redemption) => redemption.user_id === userId && redemption.voucher_id === voucherId)) {
      return { error: 'ALREADY_REDEEMED' };
    }

    const user = this.findUserById(userId);
    if (!user || user.demo_points < voucher.cost_points) return { error: 'INSUFFICIENT_POINTS' };

    const code = `JDQ-${Math.random().toString(36).slice(2, 6).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
    const redemption: RedemptionRow = {
      id: `rdm_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      voucher_id: voucherId,
      user_id: userId,
      code,
      cost_points: voucher.cost_points,
      idempotency_key: idempotencyKey,
      created_at: new Date().toISOString(),
    };
    user.demo_points -= voucher.cost_points;
    user.updated_at = redemption.created_at;
    this.redemptions.push(redemption);
    this.persistRedemption(redemption);
    this.persistUserPoints(userId, user.demo_points);
    return { redemption, replayed: false };
  }
}

export const db = new MemoryDb();
