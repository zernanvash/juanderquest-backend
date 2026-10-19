import { randomUUID, createHash } from 'node:crypto';
import type {
  QuestTask,
  TaskVerificationConfig,
  VerificationMethod,
  GeoFence,
  InAppTask,
} from './taskTypes.js';

export interface SpotContext {
  gps_lat?: number | null;
  gps_lng?: number | null;
  municipality?: string | null;
}

/**
 * Normalizes legacy v1 or modern v2 quest steps into canonical QuestTask[] (v2).
 * Fills in stable keys, verification configs, legacy mirrors, and converts
 * unverified action 'view_story' to optional (required: false).
 */
export function normalizeTasks(rawSteps: any, spot?: SpotContext | null): QuestTask[] {
  if (!Array.isArray(rawSteps)) return [];

  const defaultLat = typeof spot?.gps_lat === 'number' && Number.isFinite(spot.gps_lat) ? spot.gps_lat : 16.0;
  const defaultLng = typeof spot?.gps_lng === 'number' && Number.isFinite(spot.gps_lng) ? spot.gps_lng : 120.0;

  return rawSteps.map((raw: any, index: number) => {
    const stepOrder = index + 1;
    const title = typeof raw?.title === 'string' ? raw.title.trim() : `Task ${stepOrder}`;
    const description = typeof raw?.description === 'string' ? raw.description.trim() : '';
    let required = raw?.required !== false;

    // Checkpoint type normalization
    let checkpointType: VerificationMethod = 'location';
    if (['location', 'qr', 'photo', 'ar', 'action'].includes(raw?.checkpoint_type)) {
      checkpointType = raw.checkpoint_type;
    } else if (raw?.verification?.type && ['location', 'qr', 'photo', 'ar', 'action'].includes(raw.verification.type)) {
      checkpointType = raw.verification.type;
    }

    // Stable key: keep existing key or generate task_<uuid>
    let key = typeof raw?.key === 'string' && raw.key.startsWith('task_')
      ? raw.key
      : `task_${randomUUID()}`;

    // Deterministic key fallback if raw provides an id or stable reference
    if (!key && raw?.id) {
      key = `task_${createHash('md5').update(`${raw.id}_${stepOrder}`).digest('hex')}`;
    }

    // Build GeoFence from legacy fields or spot default
    const fenceLat = typeof raw?.gps_lat === 'number' && Number.isFinite(raw.gps_lat)
      ? raw.gps_lat
      : (typeof raw?.verification?.fence?.lat === 'number' ? raw.verification.fence.lat : defaultLat);
    const fenceLng = typeof raw?.gps_lng === 'number' && Number.isFinite(raw.gps_lng)
      ? raw.gps_lng
      : (typeof raw?.verification?.fence?.lng === 'number' ? raw.verification.fence.lng : defaultLng);
    const fenceRadius = typeof raw?.radius_meters === 'number' && Number.isFinite(raw.radius_meters)
      ? raw.radius_meters
      : (typeof raw?.verification?.fence?.radius_meters === 'number'
          ? raw.verification.fence.radius_meters
          : (checkpointType === 'ar' ? 50 : 100));

    const fence: GeoFence = {
      lat: fenceLat,
      lng: fenceLng,
      radius_meters: Math.max(30, Math.min(500, fenceRadius)),
    };

    // Marker code for QR
    const markerCode: string = typeof raw?.marker_code === 'string' && raw.marker_code.length > 0
      ? raw.marker_code
      : (typeof raw?.verification?.marker_code === 'string' ? raw.verification.marker_code : randomUUID());

    // Build verification object
    let verification: TaskVerificationConfig;
    if (raw?.verification && typeof raw.verification === 'object' && raw.verification.type === checkpointType) {
      verification = { ...raw.verification };
      if (checkpointType === 'qr') {
        (verification as any).marker_code = markerCode;
      }
    } else {
      // Build from legacy fields
      switch (checkpointType) {
        case 'location':
          verification = { type: 'location', fence };
          break;
        case 'qr':
          verification = { type: 'qr', fence, marker_code: markerCode };
          break;
        case 'photo':
          verification = {
            type: 'photo',
            prompt: typeof raw?.hint === 'string' && raw.hint ? raw.hint : (description || title),
            fence: raw?.gps_lat != null && raw?.gps_lng != null ? fence : null,
            require_gps: raw?.gps_lat != null && raw?.gps_lng != null,
          };
          break;
        case 'ar':
          verification = {
            type: 'ar',
            fence: { ...fence, radius_meters: Math.min(150, Math.max(30, fence.radius_meters)) },
            object: ['token', 'gem', 'beacon', 'box'].includes(raw?.object) ? raw.object : 'token',
            color: ['#FFB703', '#2D6A4F', '#3B82F6', '#E11D48'].includes(raw?.color) ? raw.color : '#FFB703',
          };
          break;
        case 'action': {
          let task: InAppTask;
          const actionKind = raw?.action_kind || raw?.verification?.task?.kind || 'save_spot';
          const targetId = raw?.action_target_id || raw?.verification?.task?.spot_id || raw?.verification?.task?.quiz_id || raw?.verification?.task?.campaign_id || '';

          if (actionKind === 'complete_quiz') {
            task = { kind: 'complete_quiz', quiz_id: targetId };
          } else if (actionKind === 'like_spot') {
            task = { kind: 'like_spot', spot_id: targetId };
          } else if (actionKind === 'vote_juanchoice') {
            task = targetId ? { kind: 'vote_juanchoice', campaign_id: targetId } : { kind: 'vote_juanchoice' };
          } else if (actionKind === 'view_story') {
            // view_story cannot be verified -> demoted to optional
            required = false;
            task = { kind: 'save_spot', spot_id: targetId };
          } else {
            task = { kind: 'save_spot', spot_id: targetId };
          }
          verification = { type: 'action', task };
          break;
        }
      }
    }

    // Construct the QuestTask
    const task: QuestTask = {
      key,
      step_order: stepOrder,
      title,
      description,
      required,
      checkpoint_type: checkpointType,
      verification,
      // Legacy mirrors for backwards-compatibility:
      gps_lat: fence.lat,
      gps_lng: fence.lng,
      radius_meters: fence.radius_meters,
      hint: raw?.hint || (checkpointType === 'photo' && verification.type === 'photo' ? verification.prompt : undefined),
      marker_code: checkpointType === 'qr' ? markerCode : undefined,
    };

    return task;
  });
}

/**
 * Sanitizes a QuestTask for traveler-facing views by stripping secret marker_code.
 * Fences for QR and AR remain public so travelers know where to go.
 */
export function publicTask(task: QuestTask): QuestTask {
  const { marker_code: _markerCode, ...rest } = task;
  let verification = rest.verification;
  if (verification.type === 'qr') {
    const { marker_code: _qrSecret, ...publicQr } = verification;
    verification = publicQr as any;
  }
  return {
    ...rest,
    verification,
  };
}

/**
 * Sanitizes a list of tasks for traveler views.
 */
export function publicTasks(tasks: QuestTask[]): QuestTask[] {
  return tasks.map(publicTask);
}
