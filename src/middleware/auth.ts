import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';

export interface AuthenticatedUser {
  id: string;
  seed_id: string;
  role: 'user' | 'admin';
}

export interface AuthRequest extends Request {
  user?: AuthenticatedUser;
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

export const requireAdmin = (req: AuthRequest, res: Response, next: NextFunction) => {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({
      success: false,
      error: {
        code: 'FORBIDDEN',
        message: 'Administrative privileges required for this action.',
      },
    });
  }
  next();
};
