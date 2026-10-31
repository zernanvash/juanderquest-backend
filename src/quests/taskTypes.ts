// backend/src/quests/taskTypes.ts
// Single source of truth for Plan 43 Quest Builder tasks and verification

export type VerificationMethod = 'location' | 'qr' | 'photo' | 'ar' | 'action';

export interface GeoFence {
  lat: number;
  lng: number;
  radius_meters: number;
}

export interface LocationCfg {
  type: 'location';
  fence: GeoFence;
}

export type QrScanMode = 'traveler_scans' | 'host_scans_traveler';

export interface QrCfg {
  type: 'qr';
  fence: GeoFence;
  marker_code: string; // server-generated, never from client
  scan_mode?: QrScanMode;
}

export interface PhotoCfg {
  type: 'photo';
  prompt: string; // 5–200 chars
  fence: GeoFence | null; // optional: photo must be taken inside fence
  require_gps: boolean;
}

export interface ArCfg {
  type: 'ar';
  fence: GeoFence; // radius 30–150
  object: 'token' | 'gem' | 'beacon' | 'box';
  color: '#FFB703' | '#2D6A4F' | '#3B82F6' | '#E11D48';
}

export type InAppTask =
  | { kind: 'complete_quiz'; quiz_id: string }
  | { kind: 'save_spot'; spot_id: string }
  | { kind: 'like_spot'; spot_id: string }
  | { kind: 'vote_juanchoice'; campaign_id?: string };

export interface ActionCfg {
  type: 'action';
  task: InAppTask;
}

export type TaskVerificationConfig = LocationCfg | QrCfg | PhotoCfg | ArCfg | ActionCfg;

export interface QuestTask {
  key: string; // stable id 'task_' + uuid
  step_order: number; // 1..10, contiguous
  title: string; // 3–100
  description: string; // 5–500, traveler instructions
  required: boolean; // default true
  checkpoint_type: VerificationMethod; // legacy name kept for backward compatibility
  verification: TaskVerificationConfig;
  // legacy mirrors kept in sync for old clients:
  gps_lat?: number;
  gps_lng?: number;
  radius_meters?: number;
  hint?: string;
  marker_code?: string;
  qr_scan_mode?: QrScanMode;
}

export type StepOrderMode = 'sequential' | 'any';

export interface QuestTaskInput {
  key?: string;
  title: string;
  description: string;
  required?: boolean;
  checkpoint_type: VerificationMethod;
  verification?: TaskVerificationConfig;
  // Support legacy fields in input if client provides them
  gps_lat?: number;
  gps_lng?: number;
  radius_meters?: number;
  hint?: string;
  qr_scan_mode?: QrScanMode;
  action_kind?: string;
  action_target_id?: string;
}
