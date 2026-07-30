import { env } from '../config/env.js';

export interface UserRow {
  id: string;
  seed_id: string;
  display_name: string;
  email: string;
  avatar_url: string;
  role: 'user' | 'admin';
  demo_points: number;
  created_at: string;
  updated_at: string;
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
  reward_points: number;
  marker_code: string;
  marker_image_url: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
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
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
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
    reward_points: 50,
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
    reward_points: 50,
    marker_code: 'MARKER_DAGUPAN_BANGUS_01',
    marker_image_url: 'https://raw.githubusercontent.com/JuanderQuest/assets/main/markers/dagupan_bangus.png',
    is_active: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
];

const mockSubmissions: SubmissionRow[] = [];

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
  users = mockUsers;
  quests = mockQuests;
  submissions = mockSubmissions;

  findUserBySeed(seedId: string): UserRow | undefined {
    return this.users.find((u) => u.seed_id === seedId);
  }

  findUserById(id: string): UserRow | undefined {
    return this.users.find((u) => u.id === id);
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
        };
      });
  }

  // Idempotent state transition & single point award (Fix 4.5 & 4.7)
  reviewSubmission(id: string, action: 'approve' | 'reject', adminId: string, reason?: string): { submission: SubmissionRow; alreadyReviewed: boolean } | undefined {
    const sub = this.submissions.find((s) => s.id === id);
    if (!sub) return undefined;

    const targetStatus = action === 'approve' ? 'approved' : 'rejected';

    // Idempotent check: if already in target status, return without re-adding points
    if (sub.status === targetStatus) {
      return { submission: sub, alreadyReviewed: true };
    }

    // Only allow transition from pending
    if (sub.status !== 'pending') {
      return { submission: sub, alreadyReviewed: true };
    }

    sub.status = action === 'approve' ? 'approved' : 'rejected';
    sub.reviewed_by = adminId;
    sub.reviewed_at = new Date().toISOString();
    if (action === 'reject' && reason) {
      sub.rejection_reason = reason;
    }

    if (action === 'approve') {
      const user = this.findUserById(sub.user_id);
      const quest = this.findQuestById(sub.quest_id);
      if (user && quest) {
        user.demo_points += quest.reward_points;
      }
    }

    return { submission: sub, alreadyReviewed: false };
  }
}

export const db = new MemoryDb();
