export type CulturalQuizStatus = 'draft' | 'published' | 'paused' | 'archived';
export type CulturalQuizAttemptStatus = 'in_progress' | 'passed' | 'failed' | 'abandoned' | 'expired';
export type CulturalQuizLanguage = 'en' | 'fil' | 'ilo' | 'pag';
export type CulturalQuizQuestionType = 'multiple_choice' | 'true_false' | 'picture' | 'order' | 'map_drop';
export type CulturalQuizRound = 'main' | 'special' | 'lightning';
export type CulturalQuizLifeline = 'fifty_fifty' | 'ask_local' | 'skip';

export interface CulturalQuiz {
  id: string;
  destination_id: string;
  reward_scope_id: string;
  status: CulturalQuizStatus;
  current_version: number;
  created_by?: string | null;
  is_test: boolean;
  created_at: string;
  updated_at: string;
}

export interface CulturalQuizVersion {
  id: string;
  quiz_id: string;
  version: number;
  title: string;
  description: string;
  language: CulturalQuizLanguage;
  radius_meters: number;
  xp_reward: number;
  time_limit_minutes: number;
  cooldown_hours: number;
  created_by?: string | null;
  published_at?: string | null;
  host_lines?: any | null;
  theme?: string;
  created_at: string;
}

export interface CulturalQuizOption {
  id: string;
  question_id: string;
  ordinal: number;
  option_text: string;
  is_correct?: boolean; // stripped on public/traveler surfaces
  created_at: string;
}

export interface CulturalQuizQuestion {
  id: string;
  version_id: string;
  ordinal: number;
  question_text: string;
  explanation: string;
  source_url?: string | null;
  question_type?: CulturalQuizQuestionType;
  media_url?: string | null;
  hint?: string | null;
  round?: CulturalQuizRound;
  answer_payload?: any | null;
  created_at: string;
  options: CulturalQuizOption[];
}

export interface CulturalQuizDetail {
  quiz: CulturalQuiz;
  version: CulturalQuizVersion;
  destination: {
    id: string;
    name: string;
    municipality: string;
    gps_lat: number;
    gps_lng: number;
  };
  questions?: CulturalQuizQuestion[];
  is_completed?: boolean;
  active_attempt_id?: string | null;
  cooldown_until?: string | null;
}

export interface CulturalQuizAttempt {
  id: string;
  quiz_id: string;
  version_id: string;
  reward_scope_id: string;
  user_id: string;
  status: CulturalQuizAttemptStatus;
  started_at: string;
  expires_at: string;
  completed_at?: string | null;
  score?: number | null;
  total_questions: number;
  xp_awarded: number;
  location_validated: boolean;
  distance_meters?: number | null;
  lifelines_used?: string[];
  style_score?: number;
  streak_max?: number;
  idempotency_key?: string | null;
  created_at: string;
  updated_at: string;
}

export interface CulturalQuizAttemptAnswer {
  attempt_id: string;
  question_id: string;
  selected_option_id: string;
  is_correct: boolean;
  answered_at: string;
}

export interface CulturalQuizGradedResult {
  attempt: CulturalQuizAttempt;
  passed: boolean;
  score: number;
  total_questions: number;
  xp_awarded: number;
  already_completed_prior: boolean;
  cooldown_until?: string | null;
  breakdown: Array<{
    question_id: string;
    question_text: string;
    selected_option_id: string;
    correct_option_id: string;
    is_correct: boolean;
    explanation: string;
    source_url?: string | null;
  }>;
}

export interface NearbyQuizInvitation {
  quiz_id: string;
  destination_id: string;
  destination_name: string;
  municipality: string;
  title: string;
  description: string;
  radius_meters: number;
  distance_meters: number;
  xp_reward: number;
  time_limit_minutes: number;
  language: CulturalQuizLanguage;
  is_completed?: boolean;
}
