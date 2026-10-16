import { createHash } from 'crypto';
import type { NextFunction, Request, Response } from 'express';

const PUBLIC_CACHE_PATHS = new Set([
  '/spots',
  '/quests',
  '/leaderboard',
  '/juanchoice/spotlight',
  '/app/version',
]);

export const PUBLIC_READ_CACHE_CONTROL = 'public, max-age=30, stale-while-revalidate=120';

function isCacheableRequest(req: Request): boolean {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  // Authenticated or cookie-bearing responses vary by identity; never share.
  if (req.headers.authorization || req.headers.cookie) return false;
  return PUBLIC_CACHE_PATHS.has(req.path);
}

/**
 * Cheap read performance (Plan 40 §C6): anonymous public GETs get a weak
 * ETag plus `public, max-age=30, stale-while-revalidate=120`, so mobile
 * clients (and Cloudflare, if enabled) can revalidate instead of re-fetching.
 * Users with a session/Authorization header keep private, uncached responses.
 */
export const publicReadCache = (req: Request, res: Response, next: NextFunction): void => {
  if (!isCacheableRequest(req)) {
    next();
    return;
  }

  const originalJson = res.json.bind(res);
  res.json = (body: unknown) => {
    const text = JSON.stringify(body);
    const etag = `W/"${createHash('sha256').update(text).digest('base64url').slice(0, 24)}"`;
    res.setHeader('ETag', etag);
    res.setHeader('Cache-Control', PUBLIC_READ_CACHE_CONTROL);
    // Identity changes the representation (QA/alpha scope, own data); a shared
    // cache must never hand the anonymous copy to a credentialed request.
    res.vary('Cookie');
    res.vary('Authorization');

    const ifNoneMatch = req.headers['if-none-match'];
    if (typeof ifNoneMatch === 'string') {
      const candidates = ifNoneMatch.split(',').map((value) => value.trim());
      if (candidates.includes(etag) || candidates.includes('*')) {
        res.removeHeader('Content-Type');
        res.status(304).end();
        return res;
      }
    }
    return originalJson(body);
  };

  next();
};
