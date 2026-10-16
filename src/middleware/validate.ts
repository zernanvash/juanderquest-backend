import { Request, Response, NextFunction } from 'express';
import { AnyZodObject, ZodError } from 'zod';

export const validateRequest = (schema: AnyZodObject) => {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = await schema.parseAsync({
        body: req.body,
        query: req.query,
        params: req.params,
      });
      res.locals.validatedRequest = parsed;
      return next();
    } catch (error) {
      if (error instanceof ZodError) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Request schema validation failed.',
            details: error.errors.map((e) => ({
              field: e.path.join('.').replace(/^(body|query|params)\./, ''),
              issue: e.message,
            })),
          },
        });
      }
      return next(error);
    }
  };
};
