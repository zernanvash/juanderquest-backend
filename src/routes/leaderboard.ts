import { Router, Response } from 'express';
import { z } from 'zod';
import { computeLeaderboard } from '../services/leaderboard.js';
import { optionalAuthenticateToken, AuthRequest } from '../middleware/auth.js';

export const leaderboardRouter = Router();

const leaderboardQuerySchema = z.object({
  timeframe: z.enum(['weekly', 'all_time']).optional().default('all_time'),
  metric: z.enum(['scout_reputation', 'quests_completed', 'points']).optional().default('scout_reputation'),
  limit: z.coerce.number().int().min(1).max(50).optional().default(20),
});

leaderboardRouter.get('/leaderboard', optionalAuthenticateToken, (req: AuthRequest, res: Response) => {
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

  const currentUserId = req.user?.id;
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
