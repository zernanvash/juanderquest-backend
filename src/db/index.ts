import type { Pool } from 'pg';
import { env } from '../config/env.js';
import { isDevelopmentSeedEnabled } from './policy.js';

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
  role: 'user' | 'admin';
  demo_points: number;            // Backwards-compatible formatted value (100 JDQ)
  mjdq_balance: number;           // Integer milli-JDQ balance (100,000 mJDQ = 100 JDQ)
  jdq_governance_balance: number; // JDQ Governance Token count (15 JDQ)
  scout_reputation: number;       // Non-inflationary reputation for casual spot discovery
  is_public: boolean;
  handle?: string | null;
  bio?: string | null;
  status_text?: string | null;
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

export interface QuestRow {
  id: string;
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

  private pg: Pool | null = null;

  // Hydrates the in-memory arrays from PostgreSQL and attaches the pool for write-through.
  async hydrateFromPg(pool: Pool) {
    this.pg = pool;
    const toIso = (value: Date | string) => new Date(value).toISOString();
    const { rows: users } = await pool.query('SELECT * FROM users ORDER BY created_at');
    this.users = users.map((row: any) => ({
      id: row.id, seed_id: row.seed_id, display_name: row.display_name, email: row.email,
      avatar_url: row.avatar_url, role: row.role, demo_points: row.demo_points,
      mjdq_balance: row.mjdq_balance ?? row.demo_points * 1000,
      jdq_governance_balance: row.jdq_governance_balance ?? 15,
      scout_reputation: row.scout_reputation ?? 100,
      is_public: Boolean(row.is_public),
      handle: row.handle ?? null,
      bio: row.bio ?? null,
      status_text: row.status_text ?? null,
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
      created_at: toIso(row.created_at), updated_at: toIso(row.updated_at),
    }));
    const { rows: submissions } = await pool.query('SELECT * FROM submissions ORDER BY created_at');
    this.submissions = submissions.map((row: any) => ({
      id: row.id, idempotency_key: row.idempotency_key, user_id: row.user_id, quest_id: row.quest_id,
      scanned_marker_code: row.scanned_marker_code, captured_lat: row.captured_lat, captured_lng: row.captured_lng,
      captured_accuracy: row.captured_accuracy, status: row.status, rejection_reason: row.rejection_reason,
      reviewed_by: row.reviewed_by, reviewed_at: row.reviewed_at ? toIso(row.reviewed_at) : null,
      created_at: toIso(row.created_at), updated_at: toIso(row.updated_at),
    }));
    const { rows: merchants } = await pool.query('SELECT * FROM merchants ORDER BY created_at');
    this.merchants = merchants.map((row: any) => ({
      id: row.id, name: row.name, location: row.location, description: row.description,
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
      `INSERT INTO quests (id, title, description, category, location_name, gps_lat, gps_lng, radius_meters, reward_points, marker_code, marker_image_url, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (id) DO UPDATE SET title=EXCLUDED.title, description=EXCLUDED.description, category=EXCLUDED.category,
         location_name=EXCLUDED.location_name, gps_lat=EXCLUDED.gps_lat, gps_lng=EXCLUDED.gps_lng,
         radius_meters=EXCLUDED.radius_meters, reward_points=EXCLUDED.reward_points, marker_code=EXCLUDED.marker_code,
         marker_image_url=EXCLUDED.marker_image_url, is_active=EXCLUDED.is_active, updated_at=NOW()`,
      [quest.id, quest.title, quest.description, quest.category, quest.location_name, quest.gps_lat, quest.gps_lng,
        quest.radius_meters, quest.reward_points, quest.marker_code, quest.marker_image_url, quest.is_active]
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

  findPublicUserById(id: string): UserRow | undefined {
    return this.users.find((u) => u.id === id && u.is_public);
  }

  findPublicUserByHandle(handle: string): UserRow | undefined {
    const clean = handle.replace(/^@/, '').toLowerCase().trim();
    return this.users.find((u) => u.is_public && u.handle?.toLowerCase() === clean);
  }

  findUserByHandle(handle: string): UserRow | undefined {
    const clean = handle.replace(/^@/, '').toLowerCase().trim();
    return this.users.find((u) => u.handle?.toLowerCase() === clean);
  }

  async updateUserProfile(
    userId: string,
    updates: { is_public?: boolean; handle?: string | null; bio?: string | null; status_text?: string | null; display_name?: string }
  ): Promise<UserRow | undefined> {
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

    if (this.pg) {
      try {
        const query = `
          UPDATE users
          SET is_public = COALESCE($2, is_public),
              handle = CASE WHEN $3::text IS NOT NULL THEN NULLIF(LOWER(TRIM($3)), '') ELSE handle END,
              bio = COALESCE($4, bio),
              status_text = COALESCE($5, status_text),
              display_name = COALESCE($6, display_name),
              updated_at = NOW()
          WHERE id = $1
          RETURNING *
        `;
        const { rows } = await this.pg.query(query, [
          userId,
          updates.is_public !== undefined ? updates.is_public : null,
          normalizedHandle !== undefined ? normalizedHandle : null,
          updates.bio !== undefined ? updates.bio : null,
          updates.status_text !== undefined ? updates.status_text : null,
          updates.display_name !== undefined ? updates.display_name : null,
        ]);
        if (!rows.length) return undefined;
        const row = rows[0];
        user.is_public = Boolean(row.is_public);
        user.handle = row.handle ?? null;
        user.bio = row.bio ?? null;
        user.status_text = row.status_text ?? null;
        user.display_name = row.display_name;
        user.updated_at = new Date(row.updated_at).toISOString();
        return user;
      } catch (err: any) {
        if (err.code === '23505') {
          const conflictErr = new Error('HANDLE_TAKEN');
          (conflictErr as any).code = 'HANDLE_TAKEN';
          throw conflictErr;
        }
        throw err;
      }
    }

    if (updates.is_public !== undefined) user.is_public = updates.is_public;
    if (normalizedHandle !== undefined) user.handle = normalizedHandle;
    if (updates.bio !== undefined) user.bio = updates.bio;
    if (updates.status_text !== undefined) user.status_text = updates.status_text;
    if (updates.display_name !== undefined) user.display_name = updates.display_name;
    user.updated_at = new Date().toISOString();
    return user;
  }

  getFollowCounts(userId: string): { follower_count: number; following_count: number } {
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

  getRelationship(actorId: string, targetId: string): {
    is_following: boolean;
    follows_you: boolean;
    can_follow: boolean;
    reason?: 'PROFILE_VISIBILITY_REQUIRED' | 'CANNOT_FOLLOW_SELF' | 'TARGET_NOT_FOUND';
  } {
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

    const actor = this.findUserById(actorId);
    if (!actor || !actor.is_public) {
      return { success: false, error: 'PROFILE_VISIBILITY_REQUIRED' };
    }

    const target = this.findUserById(targetId);
    if (!target || !target.is_public) {
      return { success: false, error: 'NOT_FOUND' };
    }

    if (this.pg) {
      const client = await this.pg.connect();
      try {
        await client.query('BEGIN');
        const [firstId, secondId] = [actorId, targetId].sort();
        const { rows: locked } = await client.query(
          'SELECT id, is_public FROM users WHERE id IN ($1, $2) FOR UPDATE',
          [firstId, secondId]
        );
        const lockedActor = locked.find((r: any) => r.id === actorId);
        const lockedTarget = locked.find((r: any) => r.id === targetId);
        if (!lockedActor || !lockedActor.is_public) {
          await client.query('ROLLBACK');
          return { success: false, error: 'PROFILE_VISIBILITY_REQUIRED' };
        }
        if (!lockedTarget || !lockedTarget.is_public) {
          await client.query('ROLLBACK');
          return { success: false, error: 'NOT_FOUND' };
        }
        await client.query(
          `INSERT INTO user_follows (follower_id, following_id, created_at)
           VALUES ($1, $2, NOW())
           ON CONFLICT (follower_id, following_id) DO NOTHING`,
          [actorId, targetId]
        );
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    }

    const nowIso = new Date().toISOString();
    if (!this.follows.some((f) => f.follower_id === actorId && f.following_id === targetId)) {
      this.follows.push({
        follower_id: actorId,
        following_id: targetId,
        created_at: nowIso,
      });
    }

    const counts = this.getFollowCounts(targetId);
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
      await this.pg.query(
        'DELETE FROM user_follows WHERE follower_id = $1 AND following_id = $2',
        [actorId, targetId]
      );
    }

    this.follows = this.follows.filter(
      (f) => !(f.follower_id === actorId && f.following_id === targetId)
    );

    const counts = this.getFollowCounts(targetId);
    return {
      success: true,
      follower_count: counts.follower_count,
      following_count: counts.following_count,
    };
  }

  listFollowers(
    targetId: string,
    limit: number = 20,
    cursor?: string
  ): { items: PublicTravelerSummary[]; next_cursor: string | null; has_more: boolean } | null {
    const target = this.findUserById(targetId);
    if (!target || !target.is_public) return null;

    const publicUserIds = new Set(this.users.filter((u) => u.is_public).map((u) => u.id));
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
      const counts = this.getFollowCounts(u.id);
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

  listFollowing(
    targetId: string,
    limit: number = 20,
    cursor?: string
  ): { items: PublicTravelerSummary[]; next_cursor: string | null; has_more: boolean } | null {
    const target = this.findUserById(targetId);
    if (!target || !target.is_public) return null;

    const publicUserIds = new Set(this.users.filter((u) => u.is_public).map((u) => u.id));
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
      const counts = this.getFollowCounts(u.id);
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

  listMyFollowing(
    actorId: string,
    limit: number = 20,
    cursor?: string
  ): { items: PublicTravelerSummary[]; next_cursor: string | null; has_more: boolean } {
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
      const counts = this.getFollowCounts(u.id);
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

  listPublicUsers(limit: number = 3): PublicTravelerSummary[] {
    const capped = Math.min(6, Math.max(1, limit));
    const publicUsers = this.users
      .filter((u) => u.is_public)
      .sort((a, b) => a.display_name.localeCompare(b.display_name) || a.id.localeCompare(b.id))
      .slice(0, capped);

    return publicUsers.map((u) => {
      const counts = this.getFollowCounts(u.id);
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

  findQuestById(id: string): QuestRow | undefined {
    return this.quests.find((q) => q.id === id && q.is_active);
  }

  listQuests(category?: string): QuestRow[] {
    if (!category) return this.quests.filter((q) => q.is_active);
    return this.quests.filter((q) => q.is_active && q.category === category);
  }

  // User-scoped idempotency lookup (Fix 4.4)
  findSubmissionByIdempotency(key: string, userId: string): SubmissionRow | undefined {
    return this.submissions.find((s) => s.idempotency_key === key && s.user_id === userId);
  }

  hasApprovedSubmission(userId: string, questId: string): boolean {
    return this.submissions.some((s) => s.user_id === userId && s.quest_id === questId && s.status === 'approved');
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
        const quest = this.findQuestById(s.quest_id);
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
        const quest = this.findQuestById(s.quest_id);
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
  reviewSubmission(id: string, action: 'approve' | 'reject', adminId: string, reason?: string): { submission: SubmissionRow; alreadyReviewed: boolean; conflicting: boolean } | undefined {
    const sub = this.submissions.find((s) => s.id === id);
    if (!sub) return undefined;

    const targetStatus = action === 'approve' ? 'approved' : 'rejected';

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
