import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import { authenticateToken, optionalAuthenticateToken, AuthRequest } from '../middleware/auth.js';
import { validateRequest } from '../middleware/validate.js';
import { forwardAsyncRouteErrors } from '../middleware/asyncRoutes.js';
import { AR_GAMES, closeSession, findSession, getBoard, implausibleReason } from '../services/arGames.js';

// Plan 77: finish a mini-game session and read the boards. Sessions start at
// POST /quests/:id/steps/:stepOrder/ar-game (it needs the quest attempt).
export const arGamesRouter = Router();

const finishSchema = z.object({
  params: z.object({ id: z.string().min(1).max(64) }),
  body: z.object({
    score: z.number().int().min(0).max(10_000_000),
    passed: z.boolean(),
    stats: z.record(z.string(), z.unknown()).default({}),
  }),
});

arGamesRouter.post(
  '/ar-games/sessions/:id/finish',
  authenticateToken,
  validateRequest(finishSchema),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    const fail = (status: number, code: string, message: string) =>
      res.status(status).json({ success: false, error: { code, message } });
    try {
      const session = await findSession(req.params.id);
      if (!session || session.user_id !== req.user!.id)
        return fail(404, 'SESSION_NOT_FOUND', 'Game session not found.');
      if (session.status !== 'open') return fail(409, 'SESSION_CLOSED', 'This game has already ended.');

      const { score, passed, stats } = req.body as z.infer<typeof finishSchema>['body'];
      const elapsedMs = Date.now() - session.started_at.getTime();
      const reason = implausibleReason(session.game, elapsedMs, score, passed, stats);
      if (reason) {
        await closeSession(session.id, {
          status: 'rejected',
          score,
          passed: false,
          stats: { ...stats, reject_reason: reason },
        });
        return fail(422, 'SCORE_REJECTED', 'That result could not be accepted. Play again.');
      }
      const closed = await closeSession(session.id, {
        status: 'finished',
        score,
        passed,
        stats: { ...stats, duration_ms: elapsedMs },
      });
      if (!closed) return fail(409, 'SESSION_CLOSED', 'This game has already ended.');

      const viewer = req.user!.id;
      const place = await getBoard({ kind: 'place', questId: session.quest_id, taskKey: session.task_key }, viewer, 5);
      const week = session.is_test ? null : await getBoard({ kind: 'week', game: session.game }, viewer, 1);
      return res.json({
        success: true,
        data: {
          session_id: session.id,
          passed,
          score,
          best: place.me?.score ?? null,
          rank_place: place.me?.rank ?? null,
          rank_week: week?.me?.rank ?? null,
          top: place.entries,
          lower_is_better: place.lower_is_better,
        },
      });
    } catch (err) {
      return next(err);
    }
  },
);

const boardSchema = z.object({
  query: z.union([
    z.object({
      quest_id: z.string().min(1).max(100),
      task_key: z.string().min(1).max(100),
      limit: z.coerce.number().int().min(1).max(20).optional(),
    }),
    z.object({
      game: z.enum(AR_GAMES),
      scope: z.literal('week'),
      limit: z.coerce.number().int().min(1).max(20).optional(),
    }),
  ]),
});

arGamesRouter.get(
  '/ar-games/leaderboard',
  optionalAuthenticateToken,
  validateRequest(boardSchema),
  async (req: AuthRequest, res: Response) => {
    const q = req.query as Record<string, string | undefined>;
    const limit = q.limit ? Number(q.limit) : 20;
    const board =
      q.quest_id && q.task_key
        ? await getBoard({ kind: 'place', questId: q.quest_id, taskKey: q.task_key }, req.user?.id ?? null, limit)
        : await getBoard({ kind: 'week', game: q.game as (typeof AR_GAMES)[number] }, req.user?.id ?? null, limit);
    res.setHeader('Cache-Control', 'private, no-store');
    return res.json({ success: true, data: board });
  },
);

forwardAsyncRouteErrors(arGamesRouter);
