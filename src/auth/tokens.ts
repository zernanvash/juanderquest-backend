import jwt, { JwtPayload } from 'jsonwebtoken';
import { env } from '../config/env.js';

export const SESSION_TYP = 'session';
export const CHALLENGE_TYP = 'quest_challenge';

export interface SessionClaims {
  id: string;
  seed_id: string;
  role: 'user' | 'admin' | 'qa';
}

export interface QuestChallengeClaims {
  sub: typeof CHALLENGE_TYP;
  typ: typeof CHALLENGE_TYP;
  user_id: string;
  quest_id: string;
  nonce: string;
}

const validRole = (role: unknown): role is SessionClaims['role'] =>
  role === 'user' || role === 'admin' || role === 'qa';

export function signSessionToken(
  user: { id: string; seed_id: string; role: string },
  rememberMe = false,
): string {
  if (!validRole(user.role)) throw new Error('Cannot issue session token for unsupported role.');
  return jwt.sign(
    { id: user.id, seed_id: user.seed_id, role: user.role, typ: SESSION_TYP },
    env.JWT_SECRET,
    { algorithm: 'HS256', expiresIn: rememberMe ? '7d' : '24h' },
  );
}

export function signQuestChallenge(input: Omit<QuestChallengeClaims, 'sub' | 'typ'>, expiresInSec = 600): string {
  return jwt.sign(
    { sub: CHALLENGE_TYP, typ: CHALLENGE_TYP, ...input },
    env.JWT_SECRET,
    { algorithm: 'HS256', expiresIn: expiresInSec },
  );
}

export function verifySessionToken(token: string): SessionClaims | null {
  try {
    const decoded = jwt.verify(token, env.JWT_SECRET, { algorithms: ['HS256'] });
    if (!decoded || typeof decoded === 'string') return null;
    const claims = decoded as JwtPayload & Record<string, unknown>;
    // TODO(2026-10-23): require typ === 'session' after the longest legacy session expires.
    if ((claims.typ !== undefined && claims.typ !== SESSION_TYP) || claims.sub === CHALLENGE_TYP) return null;
    if (typeof claims.id !== 'string' || claims.id.length === 0) return null;
    if (typeof claims.seed_id !== 'string' || !validRole(claims.role)) return null;
    return { id: claims.id, seed_id: claims.seed_id, role: claims.role };
  } catch {
    return null;
  }
}

export function verifyQuestChallengeToken(token: string): QuestChallengeClaims | null {
  try {
    const decoded = jwt.verify(token, env.JWT_SECRET, { algorithms: ['HS256'] });
    if (!decoded || typeof decoded === 'string') return null;
    const claims = decoded as JwtPayload & Record<string, unknown>;
    if (claims.sub !== CHALLENGE_TYP || (claims.typ !== undefined && claims.typ !== CHALLENGE_TYP)) return null;
    if (typeof claims.user_id !== 'string' || typeof claims.quest_id !== 'string' ||
        typeof claims.nonce !== 'string' || claims.nonce.length === 0) return null;
    return claims as unknown as QuestChallengeClaims;
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) throw error;
    return null;
  }
}
