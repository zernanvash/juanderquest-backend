import { Router, Response } from 'express';
import { db } from '../db/index.js';
import { optionalAuthenticateToken, checkQAAuthorization, isAuthorizedQA, AuthRequest } from '../middleware/auth.js';

const router = Router();

router.get('/quests', optionalAuthenticateToken, checkQAAuthorization, (req: AuthRequest, res: Response) => {
  const category = req.query.category as string | undefined;
  const allowTest = isAuthorizedQA(req);
  if (allowTest) {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  }

  // ponytail: marker_code stays on GET /quests/:id only (simulated AR needs it client-side);
  // the list must not leak markers.
  const quests = db.listQuests(category, allowTest).map(({ marker_code, ...quest }) => quest);

  return res.status(200).json({
    success: true,
    data: quests,
  });
});

router.get('/quests/:id', optionalAuthenticateToken, checkQAAuthorization, (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  const allowTest = isAuthorizedQA(req);
  const quest = db.findQuestById(id, allowTest);

  if (!quest) {
    return res.status(404).json({
      success: false,
      error: {
        code: 'NOT_FOUND',
        message: `Quest with ID '${id}' not found.`,
      },
    });
  }

  if (allowTest && quest.is_test) {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  }

  return res.status(200).json({
    success: true,
    data: quest,
  });
});

export default router;
