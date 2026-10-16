import type { NextFunction, Request, Response } from 'express';

let ready = true;
let shuttingDown = false;

export const setServiceReady = (value: boolean): void => {
  ready = value;
  // Becoming ready again means any earlier drain is over; keep state coherent.
  if (value) shuttingDown = false;
};

export const isServiceReady = (): boolean => ready;

export const isServiceShuttingDown = (): boolean => shuttingDown;

export const beginServiceShutdown = (): void => {
  shuttingDown = true;
  ready = false;
};

const HEALTH_PATH = /^\/health(\/|$)/;

// While the process is hydrating (or draining on shutdown) every API route
// except health answers a JSON 503 MAINTENANCE with Retry-After instead of
// letting the tunnel turn a restart into opaque Cloudflare HTML.
export const readinessGate = (req: Request, res: Response, next: NextFunction): void => {
  if (ready || HEALTH_PATH.test(req.path)) {
    next();
    return;
  }
  res.setHeader('Retry-After', '5');
  res.status(503).json({
    success: false,
    error: {
      code: 'MAINTENANCE',
      message: shuttingDown ? 'JuanDerQuest is restarting' : 'JuanDerQuest is starting up',
    },
  });
};
