import { Request, Response, NextFunction } from 'express';
import { env } from '../config/env.js';
import { readSessionCookie } from '../auth/sessionCookie.js';
import { verifySessionToken } from '../auth/tokens.js';
import { db, UserRow } from '../db/index.js';
import { AlphaSessionScopeBatcher } from '../auth/alphaSessionScopeBatcher.js';
import { UsersRepository } from '../repositories/users.js';
import type { Pool } from 'pg';

export interface AuthenticatedUser {
  id: string;
  seed_id: string;
  role: 'user' | 'admin' | 'qa';
  sep?: number;
}

export interface AuthRequest extends Request {
  user?: AuthenticatedUser;
  isQAAuthorized?: boolean;
}

interface CachedSessionScope {
  session_epoch: number;
  role: 'user' | 'admin' | 'qa';
  expiresAt: number;
}

const sessionScopeCache = new Map<string, CachedSessionScope>();
const SESSION_CACHE_TTL_MS = 30_000;

export const invalidateSessionScopeCache = (userId?: string): void => {
  if (userId) {
    sessionScopeCache.delete(userId);
  } else {
    sessionScopeCache.clear();
  }
};

const batcherRegistry = new WeakMap<Pool, AlphaSessionScopeBatcher>();

export const getAlphaSessionScopeBatcher = (pool: Pool): AlphaSessionScopeBatcher => {
  let batcher = batcherRegistry.get(pool);
  if (!batcher) {
    const scopedRepo = new UsersRepository(pool);
    batcher = new AlphaSessionScopeBatcher(ids => scopedRepo.findAlphaSessionScopesByIds(ids));
    batcherRegistry.set(pool, batcher);
  }
  return batcher;
};

export const getSessionScope = async (userId: string): Promise<{ session_epoch: number; role: 'user' | 'admin' | 'qa' } | null> => {
  const cached = sessionScopeCache.get(userId);
  if (cached && Date.now() < cached.expiresAt) {
    return { session_epoch: cached.session_epoch, role: cached.role };
  }

  const pool = db.usersRepo.getPool();
  if (pool) {
    const batcher = getAlphaSessionScopeBatcher(pool);
    const scope = await batcher.lookup(userId);
    if (!scope) return null;
    const result = { session_epoch: scope.session_epoch ?? 0, role: scope.role ?? 'user' };
    sessionScopeCache.set(userId, { ...result, expiresAt: Date.now() + SESSION_CACHE_TTL_MS });
    return result;
  }

  const user = db.findUserById(userId);
  if (!user) return null;
  const result = { session_epoch: user.session_epoch ?? 0, role: user.role };
  sessionScopeCache.set(userId, { ...result, expiresAt: Date.now() + SESSION_CACHE_TTL_MS });
  return result;
};

export const optionalAuthenticateToken = async (req: AuthRequest, res: Response, next: NextFunction) => {
  const token = req.headers.authorization?.split(' ')[1] || readSessionCookie(req);
  if (!token) return next();
  const user = verifySessionToken(token);
  if (!user) return next();

  try {
    const scope = await getSessionScope(user.id);
    if (!scope) return next();
    const tokenSep = user.sep ?? 0;
    if (tokenSep !== scope.session_epoch) {
      return next();
    }
    user.role = scope.role;
    req.user = user;
    next();
  } catch (err) {
    console.error('[auth] optionalAuthenticateToken database error:', err);
    return res.status(503).json({
      success: false,
      error: { code: 'DATABASE_UNAVAILABLE', message: 'Authentication service temporarily unavailable. Please try again.' },
    });
  }
};

export const authenticateToken = async (req: AuthRequest, res: Response, next: NextFunction) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader ? authHeader.split(' ')[1] : readSessionCookie(req);

  if (!token) {
    return res.status(401).json({
      success: false,
      error: {
        code: 'UNAUTHORIZED',
        message: 'Missing JWT authentication bearer token.',
      },
    });
  }

  const user = verifySessionToken(token);
  if (!user) {
    return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Invalid or expired JWT authentication token.' } });
  }

  try {
    const scope = await getSessionScope(user.id);
    if (!scope) {
      return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'User account no longer exists.' } });
    }
    const tokenSep = user.sep ?? 0;
    if (tokenSep !== scope.session_epoch) {
      return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Session has been revoked or expired. Please sign in again.' } });
    }
    user.role = scope.role;
    req.user = user;
    next();
  } catch (err) {
    console.error('[auth] session scope verification database error:', err);
    return res.status(503).json({
      success: false,
      error: { code: 'DATABASE_UNAVAILABLE', message: 'Authentication service temporarily unavailable. Please try again.' },
    });
  }
};

export const requireAdmin = async (req: AuthRequest, res: Response, next: NextFunction) => {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({
      success: false,
      error: {
        code: 'FORBIDDEN',
        message: 'Administrative privileges required for this action.',
      },
    });
  }

  // Durable verification: ensure account still exists and role has not been demoted/revoked
  try {
    let durableUser: UserRow | null = null;
    if (db.usersRepo.getPool()) {
      durableUser = (await db.usersRepo.findById(req.user.id)) ?? null;
    } else {
      durableUser = db.findUserById(req.user.id) ?? null;
    }

    if (!durableUser || durableUser.role !== 'admin') {
      return res.status(403).json({
        success: false,
        error: {
          code: 'FORBIDDEN',
          message: 'Account no longer exists or administrative privileges have been revoked.',
        },
      });
    }
  } catch (err: any) {
    // Fail closed on database outage/error: do NOT fall back to trusting token or stale memory
    return res.status(503).json({
      success: false,
      error: {
        code: 'DATABASE_OUTAGE',
        message: 'Database unavailable during administrative authorization check.',
      },
    });
  }

  next();
};

export const isAuthorizedQA = (req: AuthRequest): boolean => {
  return Boolean(req.isQAAuthorized);
};

export const checkQAAuthorization = async (req: AuthRequest, res: Response, next: NextFunction) => {
  const requestedQA =
    req.query.include_test === 'true' ||
    req.query.include_qa === 'true' ||
    req.query.scope === 'test' ||
    req.headers['x-include-test'] === 'true' ||
    typeof req.headers['x-qa-preview-token'] === 'string';

  if (!requestedQA) {
    req.isQAAuthorized = false;
    // Laptop alpha: a real, durable wallet session sees the seeded simulation
    // in normal read surfaces. The flag is off in every other environment.
    const travelerSession = req.user?.seed_id?.startsWith('wallet:') || req.user?.seed_id?.startsWith('guest:');
    if (!env.ALPHA_WALLET_SIMULATION_ENABLED || !travelerSession || req.method !== 'GET' || !req.user) return next();
    const pool = db.usersRepo.getPool();
    if (!pool) {
      const user = db.findUserById(req.user.id);
      if (!user || user.seed_id !== req.user.seed_id || user.is_test) return next();
      req.isQAAuthorized = true;
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('X-Robots-Tag', 'noindex, nofollow');
      return next();
    }

    try {
      const batcher = getAlphaSessionScopeBatcher(pool);
      const scope = await batcher.lookup(req.user.id);
      if (db.usersRepo.getPool() !== pool) {
        return res.status(503).json({ success: false, error: { code: 'DATABASE_OUTAGE', message: 'Wallet session could not be verified.' } });
      }
      if (!env.ALPHA_WALLET_SIMULATION_ENABLED) {
        return next();
      }
      if (!scope || scope.id !== req.user.id || scope.seed_id !== req.user.seed_id || scope.is_test !== false) {
        return next();
      }
      req.isQAAuthorized = true;
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('X-Robots-Tag', 'noindex, nofollow');
      return next();
    } catch {
      return res.status(503).json({ success: false, error: { code: 'DATABASE_OUTAGE', message: 'Wallet session could not be verified.' } });
    }
  }

  return authorizeQAPreview(req, res, next);
};

// Reused by the capability endpoint; always verify the current durable identity.
export const authorizeQAPreview = async (req: AuthRequest, res: Response, next: NextFunction) => {
  req.isQAAuthorized = false;
  res.setHeader('Cache-Control', 'private, no-store');
  if (!req.user || !req.user.id) {
    return res.status(403).json({
      success: false,
      error: {
        code: 'UNAUTHORIZED_QA_MODE',
        message: 'Explicit authenticated QA or admin privileges required to access synthetic test data.',
      },
    });
  }

  try {
    let durableUser: UserRow | null = null;
    if (db.usersRepo.getPool()) {
      durableUser = (await db.usersRepo.findById(req.user.id)) ?? null;
    } else {
      durableUser = db.findUserById(req.user.id) ?? null;
    }

    if (!durableUser || (durableUser.role !== 'admin' && durableUser.role !== 'qa')) {
      return res.status(403).json({
        success: false,
        error: {
          code: 'UNAUTHORIZED_QA_MODE',
          message: 'Explicit authenticated QA or admin privileges required to access synthetic test data.',
        },
      });
    }

    req.isQAAuthorized = true;
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    next();
  } catch (err: any) {
    // Fail closed on database outage during QA authorization check
    return res.status(503).json({
      success: false,
      error: {
        code: 'DATABASE_OUTAGE',
        message: 'Database unavailable during QA authorization check.',
      },
    });
  }
};

/**
 * Plan 67: shop purchases and redemptions need a wallet bound to the account.
 * Everything else (quests, EXP, map, posting, browsing the shop) stays open to
 * any signed-in traveler. Run after authenticateToken.
 */
export const requireBoundWallet = async (req: AuthRequest, res: Response, next: NextFunction) => {
  let user: UserRow | undefined;
  try {
    user = db.usersRepo.getPool() ? await db.usersRepo.findById(req.user!.id) : db.findUserById(req.user!.id);
  } catch {
    return res.status(503).json({ success: false, error: { code: 'DATABASE_OUTAGE', message: 'Account could not be checked. Please try again.' } });
  }
  if (!user) {
    return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Session account no longer exists.' } });
  }
  if (!user.wallet_address || !user.wallet_address.trim()) {
    return res.status(403).json({
      success: false,
      error: {
        code: 'WALLET_REQUIRED',
        message: 'Connect a blockchain wallet to your account before purchasing or redeeming shop items.',
        connect_url: '/wallet/connect',
      },
    });
  }
  next();
};
