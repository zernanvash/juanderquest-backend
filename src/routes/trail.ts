import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { validateRequest } from '../middleware/validate.js';
import { planTrailCorridor, PANGASINAN_SERVICE_AREA, TravelCosting } from '../services/trail.js';

export const trailRouter = Router();

const TrailPlanSchema = z.object({
  body: z.object({
    start: z.object({
      lat: z.number().min(-90).max(90),
      lng: z.number().min(-180).max(180),
      name: z.string().optional(),
    }),
    end: z.object({
      lat: z.number().min(-90).max(90),
      lng: z.number().min(-180).max(180),
      name: z.string().optional(),
    }),
    costing: z.enum(['auto', 'pedestrian', 'bicycle', 'motorcycle']).optional(),
    max_stops: z.number().int().min(1).max(5).optional(),
    max_detour_km: z.number().min(1).max(50).optional(),
    preferred_categories: z.array(z.string()).optional(),
    avoid_congested: z.boolean().optional(),
  }),
});

// GET /api/v1/trail/service-area
trailRouter.get('/trail/service-area', (_req: Request, res: Response) => {
  return res.status(200).json({
    success: true,
    data: PANGASINAN_SERVICE_AREA,
  });
});

// POST /api/v1/trail/plan
trailRouter.post('/trail/plan', validateRequest(TrailPlanSchema), async (req: Request, res: Response) => {
  try {
    const plan = await planTrailCorridor({
      start: req.body.start,
      end: req.body.end,
      costing: req.body.costing as TravelCosting | undefined,
      max_stops: req.body.max_stops,
      max_detour_km: req.body.max_detour_km,
      preferred_categories: req.body.preferred_categories,
      avoid_congested: req.body.avoid_congested,
    });

    return res.status(200).json({
      success: true,
      data: plan,
    });
  } catch (error: any) {
    return res.status(500).json({
      success: false,
      error: {
        code: 'TRAIL_PLAN_ERROR',
        message: error.message || 'Failed to generate trail corridor plan',
      },
    });
  }
});
