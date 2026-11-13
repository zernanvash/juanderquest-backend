import { Request, Response, NextFunction } from 'express';
import { log } from '../utils/logger.js';

export const errorHandler = (err: Error, req: Request, res: Response, _next: NextFunction) => {
  log.error('[SERVER ERROR]', { error: err.stack || err.message });
  res.status(500).json({
    success: false,
    error: {
      code: 'INTERNAL_ERROR',
      message: 'An unexpected internal error occurred.',
    },
  });
};
