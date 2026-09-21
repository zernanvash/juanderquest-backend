export type ProgressionTrack = 'explorer' | 'civic' | 'scout';

export interface ReviewedQuestSpotBinding {
  id: string;
  quest_id: string;
  spot_id: string;
  binding_version: string;
  status: 'active' | 'deprecated' | 'ambiguous';
  reviewed_by: string | null;
  notes: string | null;
  is_test: boolean;
  created_at: string;
  updated_at: string;
}

export interface VerifiedVisit {
  id: string;
  user_id: string;
  spot_id: string;
  binding_id?: string | null;
  municipality_id: string | null;
  source_submission_id: string;
  /** Submission creation/receipt time (not proven physical capture time) */
  occurred_at: string;
  verified_at: string;
  evidence_version: string;
  is_test: boolean;
  revoked_at?: string | null;
  revocation_reason?: string | null;
  created_at: string;
}

export interface ProgressionEvent {
  id: string;
  user_id: string;
  track: ProgressionTrack;
  delta: number;
  source_type: string;
  source_id: string;
  award_kind: string;
  rule_version: string;
  earned_at: string;
  is_test: boolean;
  reversal_of?: string | null;
  created_at: string;
}

export interface ProgressionTotals {
  user_id: string;
  explorer_xp: number;
  civic_xp: number;
  civic_stamps: number;
  last_event_at: string | null;
  updated_at: string;
}

export interface AchievementDefinition {
  id: string;
  track: ProgressionTrack;
  title: string;
  description: string;
  badge_icon: string;
  category: string;
  threshold: number;
  criteria_version: string;
  is_active: boolean;
  created_at: string;
}

export interface AchievementAward {
  id: string;
  user_id: string;
  achievement_id: string;
  season: string;
  source_evidence_id: string | null;
  evidence_version?: string;
  criteria_version?: string;
  criteria_snapshot?: Record<string, any> | null;
  awarded_at: string;
  revoked_at?: string | null;
  revocation_reason?: string | null;
  is_test: boolean;
  created_at: string;
  definition?: AchievementDefinition;
}

export interface CuratedCollectionItem {
  spot_id: string;
  name: string;
  municipality: string;
  category: string;
  image_url: string;
  order_index: number;
  is_visited: boolean;
}

export interface CuratedCollection {
  id: string;
  title: string;
  description: string;
  category: string;
  badge_id: string | null;
  is_active: boolean;
  total_spots: number;
  visited_spots: number;
  completed: boolean;
  spots: CuratedCollectionItem[];
}

export interface TravelerPassport {
  user_id: string;
  display_name: string;
  avatar_url: string;
  role: string;
  is_public: boolean;
  explorer: {
    level: number;
    title: string;
    xp: number;
    next_level_xp: number;
    current_tier_base_xp: number;
  };
  civic: {
    level: number;
    title: string;
    xp: number;
    stamps: number;
    next_level_xp: number;
  };
  scout: {
    level: number;
    title: string;
    reputation: number;
  };
  lgu_progress: {
    explored: number;
    total: number;
    percentage: number;
  };
  recent_visits: VerifiedVisit[];
  recent_achievements: AchievementAward[];
}

export interface OutboxEvent<T = any> {
  id: string;
  event_key: string;
  event_type: string;
  payload: T;
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'dead_letter';
  attempts: number;
  max_attempts: number;
  lease_owner: string | null;
  claim_token?: string | null;
  lease_expires_at: string | null;
  next_attempt_at: string;
  delivered_at: string | null;
  last_error: string | null;
  created_at: string;
}
