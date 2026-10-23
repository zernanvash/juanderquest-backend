import { z } from 'zod';
import { withinRadius } from '../db/index.js';

export const PHILIPPINES_BOUNDS = {
  minLat: 4.5,
  maxLat: 21.5,
  minLng: 116.0,
  maxLng: 127.0,
};

export const geoFenceSchema = z.object({
  lat: z.number().finite().min(PHILIPPINES_BOUNDS.minLat, 'Latitude must be within the Philippines').max(PHILIPPINES_BOUNDS.maxLat, 'Latitude must be within the Philippines'),
  lng: z.number().finite().min(PHILIPPINES_BOUNDS.minLng, 'Longitude must be within the Philippines').max(PHILIPPINES_BOUNDS.maxLng, 'Longitude must be within the Philippines'),
  radius_meters: z.number().int().min(30).max(500).default(100),
});

export const locationCfgSchema = z.object({
  type: z.literal('location'),
  fence: geoFenceSchema,
});

export const qrCfgSchema = z.object({
  type: z.literal('qr'),
  fence: geoFenceSchema,
  // Note: marker_code is server-assigned; if supplied by client it will be ignored/stripped
});

export const photoCfgSchema = z.object({
  type: z.literal('photo'),
  prompt: z.string().trim().min(5).max(200),
  fence: geoFenceSchema.nullable().optional(),
  require_gps: z.boolean().default(false),
});

export const arCfgSchema = z.object({
  type: z.literal('ar'),
  fence: z.object({
    lat: z.number().finite().min(PHILIPPINES_BOUNDS.minLat).max(PHILIPPINES_BOUNDS.maxLat),
    lng: z.number().finite().min(PHILIPPINES_BOUNDS.minLng).max(PHILIPPINES_BOUNDS.maxLng),
    radius_meters: z.number().int().min(30).max(150).default(50),
  }),
  object: z.enum(['token', 'gem', 'beacon', 'box']).default('token'),
  color: z.enum(['#FFB703', '#2D6A4F', '#3B82F6', '#E11D48']).default('#FFB703'),
});

export const inAppTaskSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('complete_quiz'),
    quiz_id: z.string().min(1),
  }),
  z.object({
    kind: z.literal('save_spot'),
    spot_id: z.string().min(1),
  }),
  z.object({
    kind: z.literal('like_spot'),
    spot_id: z.string().min(1),
  }),
  z.object({
    kind: z.literal('vote_juanchoice'),
    campaign_id: z.string().optional(),
  }),
]);

export const actionCfgSchema = z.object({
  type: z.literal('action'),
  task: inAppTaskSchema,
});

export const taskVerificationSchema = z.discriminatedUnion('type', [
  locationCfgSchema,
  qrCfgSchema,
  photoCfgSchema,
  arCfgSchema,
  actionCfgSchema,
]);

export const questTaskInputSchema = z.object({
  key: z.string().optional(),
  title: z.string().trim().min(3).max(100),
  description: z.string().trim().min(5).max(500),
  required: z.boolean().default(true),
  checkpoint_type: z.enum(['location', 'qr', 'photo', 'ar', 'action']),
  verification: taskVerificationSchema.optional(),
  // Legacy fields supported if client doesn't send verification block
  gps_lat: z.number().finite().min(PHILIPPINES_BOUNDS.minLat).max(PHILIPPINES_BOUNDS.maxLat).optional(),
  gps_lng: z.number().finite().min(PHILIPPINES_BOUNDS.minLng).max(PHILIPPINES_BOUNDS.maxLng).optional(),
  radius_meters: z.number().int().min(30).max(500).optional(),
  hint: z.string().max(200).optional(),
  action_kind: z.string().optional(),
  action_target_id: z.string().optional(),
});

export function validateTasksWithinDistance(
  tasks: any[],
  destinationLat: number,
  destinationLng: number,
  maxDistanceKm: number = 5
): { valid: boolean; error?: string; taskIndex?: number } {
  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i];
    const fence = t.verification?.fence || (t.gps_lat != null && t.gps_lng != null ? { lat: t.gps_lat, lng: t.gps_lng } : null);
    if (fence && typeof fence.lat === 'number' && typeof fence.lng === 'number') {
      const check = withinRadius(fence.lat, fence.lng, destinationLat, destinationLng, maxDistanceKm * 1000, 0);
      if (!check.ok) {
        return {
          valid: false,
          taskIndex: i,
          error: `Task ${i + 1} (${t.title || 'Untitled'}) is ${Math.round(check.distance / 1000)} km away from the destination, exceeding the ${maxDistanceKm} km limit.`,
        };
      }
    }
  }
  return { valid: true };
}
