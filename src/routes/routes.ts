import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { calculateRoute, TravelCosting } from '../services/routing.js';

const routesRouter = Router();

const RouteQuerySchema = z.object({
  start_lat: z.coerce.number().min(-90).max(90),
  start_lng: z.coerce.number().min(-180).max(180),
  end_lat: z.coerce.number().min(-90).max(90),
  end_lng: z.coerce.number().min(-180).max(180),
  costing: z.enum(['auto', 'pedestrian', 'bicycle', 'motorcycle']).optional().default('auto'),
  avoid_congested: z
    .enum(['true', 'false', '1', '0'])
    .optional()
    .transform((val) => val === undefined || val === 'true' || val === '1'),
});

const RouteBodySchema = z.object({
  start: z.object({
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
  }),
  end: z.object({
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
  }),
  costing: z.enum(['auto', 'pedestrian', 'bicycle', 'motorcycle']).optional().default('auto'),
  avoid_congested: z.boolean().optional().default(true),
});

/**
 * GET /api/v1/routes?start_lat=16.04&start_lng=120.33&end_lat=16.02&end_lng=120.23&costing=auto
 */
routesRouter.get('/routes', async (req: Request, res: Response) => {
  const parsed = RouteQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({
      success: false,
      error: {
        code: 'INVALID_QUERY',
        message: 'Invalid coordinate parameters',
        details: parsed.error.format(),
      },
    });
  }

  const { start_lat, start_lng, end_lat, end_lng, costing, avoid_congested } = parsed.data;

  try {
    const route = await calculateRoute({
      startLat: start_lat,
      startLng: start_lng,
      endLat: end_lat,
      endLng: end_lng,
      costing: costing as TravelCosting,
      avoidCongested: avoid_congested,
    });

    return res.json({
      success: true,
      data: route,
    });
  } catch (error: any) {
    return res.status(500).json({
      success: false,
      error: {
        code: 'ROUTING_ERROR',
        message: error.message || 'Failed to compute route',
      },
    });
  }
});

/**
 * POST /api/v1/routes
 */
routesRouter.post('/routes', async (req: Request, res: Response) => {
  const parsed = RouteBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      success: false,
      error: {
        code: 'INVALID_PAYLOAD',
        message: 'Invalid route request body',
        details: parsed.error.format(),
      },
    });
  }

  const { start, end, costing, avoid_congested } = parsed.data;

  try {
    const route = await calculateRoute({
      startLat: start.lat,
      startLng: start.lng,
      endLat: end.lat,
      endLng: end.lng,
      costing: costing as TravelCosting,
      avoidCongested: avoid_congested,
    });

    return res.json({
      success: true,
      data: route,
    });
  } catch (error: any) {
    return res.status(500).json({
      success: false,
      error: {
        code: 'ROUTING_ERROR',
        message: error.message || 'Failed to compute route',
      },
    });
  }
});

export default routesRouter;
