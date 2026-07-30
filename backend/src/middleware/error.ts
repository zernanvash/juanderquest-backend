import { Request, Response, NextFunction } from 'express';

export const errorHandler = (err: Error, req: Request, res: Response, _next: NextFunction) => {
  console.error('[SERVER ERROR]', err.stack || err.message);
  res.status(500).json({
    success: false,
    error: {
      code: 'INTERNAL_ERROR',
      message: 'An unexpected internal error occurred.',
    },
  });
};
