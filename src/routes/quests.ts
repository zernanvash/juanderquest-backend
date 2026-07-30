import { Router, Request, Response } from 'express';
import { db } from '../db/index.js';

const router = Router();

router.get('/quests', (req: Request, res: Response) => {
  const category = req.query.category as string | undefined;
  const quests = db.listQuests(category);

  return res.status(200).json({
    success: true,
    data: quests,
  });
});

router.get('/quests/:id', (req: Request, res: Response) => {
  const { id } = req.params;
  const quest = db.findQuestById(id);

  if (!quest) {
    return res.status(404).json({
      success: false,
      error: {
        code: 'NOT_FOUND',
        message: `Quest with ID '${id}' not found.`,
      },
    });
  }

  return res.status(200).json({
    success: true,
    data: quest,
  });
});

export default router;
