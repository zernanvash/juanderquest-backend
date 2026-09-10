import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';

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
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return next();
  try { req.user = jwt.verify(token, env.JWT_SECRET) as AuthenticatedUser; } catch { /* Continue as guest. */ }
  next();
};

export const authenticateToken = (req: AuthRequest, res: Response, next: NextFunction) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

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
    req.headers['x-include-test'] === 'true' ||
    typeof req.headers['x-qa-preview-token'] === 'string';

  if (!requestedQA) {
    req.isQAAuthorized = false;
    return next();
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

