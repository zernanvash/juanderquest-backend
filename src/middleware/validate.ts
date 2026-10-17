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
      // Apply Zod defaults/coercions/transforms to the live request. Merge (not replace)
      // plain objects so undeclared fields that routes still read are preserved.
      // Before this, every schema `.default(...)` was silently ignored.
      const merge = (original: unknown, validated: unknown) =>
        isPlainObject(original) && isPlainObject(validated) ? { ...original, ...validated } : validated;
      if (parsed.body !== undefined) req.body = merge(req.body, parsed.body);
      if (parsed.query !== undefined) req.query = merge(req.query, parsed.query) as Request['query'];
      if (parsed.params !== undefined) req.params = merge(req.params, parsed.params) as Request['params'];
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Buffer);
}
