import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { computeLeaderboard } from '../services/leaderboard.js';
import { verifySessionToken } from '../auth/tokens.js';

export const leaderboardRouter = Router();

const leaderboardQuerySchema = z.object({
  timeframe: z.enum(['weekly', 'all_time']).optional().default('all_time'),
  metric: z.enum(['scout_reputation', 'quests_completed', 'points']).optional().default('scout_reputation'),
  limit: z.coerce.number().int().min(1).max(50).optional().default(20),
});

leaderboardRouter.get('/leaderboard', (req: Request, res: Response) => {
  const parsed = leaderboardQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({
      success: false,
      error: {
        code: 'INVALID_QUERY',
        message: 'Invalid leaderboard parameters',
        details: parsed.error.format(),
      },
    });
  }

  // Extract optional authenticated user
  let currentUserId: string | undefined;
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.substring(7);
    try {
      currentUserId = verifySessionToken(token)?.id;
    } catch {
      // Ignored for unauthenticated lookups
    }
  }

  const { timeframe, metric, limit } = parsed.data;
  const leaderboard = computeLeaderboard({
    timeframe,
    metric,
    limit,
    currentUserId,
  });

  return res.status(200).json({
    success: true,
    data: leaderboard,
  });
});
