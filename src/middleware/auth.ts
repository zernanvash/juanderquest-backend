import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { readSessionCookie } from '../auth/sessionCookie.js';

export interface AuthenticatedUser {
  id: string;
  seed_id: string;
  role: 'user' | 'admin' | 'qa';
}

export interface AuthRequest extends Request {
  user?: AuthenticatedUser;
  isQAAuthorized?: boolean;
}

export const optionalAuthenticateToken = (req: AuthRequest, _res: Response, next: NextFunction) => {
  const token = req.headers.authorization?.split(' ')[1] || readSessionCookie(req);
  if (!token) return next();
  try { req.user = jwt.verify(token, env.JWT_SECRET) as AuthenticatedUser; } catch { /* Continue as guest. */ }
  next();
};

export const authenticateToken = (req: AuthRequest, res: Response, next: NextFunction) => {
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

  jwt.verify(token, env.JWT_SECRET, (err, decoded) => {
    if (err) {
      return res.status(401).json({
        success: false,
        error: {
          code: 'UNAUTHORIZED',
          message: 'Invalid or expired JWT authentication token.',
        },
      });
    }

    req.user = decoded as AuthenticatedUser;
    next();
  });
};

import { db, UserRow } from '../db/index.js';
import { AlphaSessionScopeBatcher } from '../auth/alphaSessionScopeBatcher.js';
import { UsersRepository } from '../repositories/users.js';
import type { Pool } from 'pg';

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
