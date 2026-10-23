import type { Router } from 'express';

/** Express 4 does not forward rejected async handler promises to error middleware. */
export function forwardAsyncRouteErrors(router: Router): void {
  const stack = (router as any).stack as Array<{ route?: { stack: Array<{ handle: Function }> } }>;
  for (const layer of stack) {
    if (!layer.route) continue;
    for (const routeLayer of layer.route.stack) {
      const handler = routeLayer.handle;
      if (handler.length === 4 || (handler as any).__asyncErrorsForwarded) continue;
      const wrapped = function (req: unknown, res: unknown, next: (error?: unknown) => void) {
        try { Promise.resolve(handler(req, res, next)).catch(next); }
        catch (error) { next(error); }
      };
      (wrapped as any).__asyncErrorsForwarded = true;
      routeLayer.handle = wrapped;
    }
  }
}
