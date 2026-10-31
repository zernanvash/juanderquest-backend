import jwt, { JwtPayload } from 'jsonwebtoken';
import { env } from '../config/env.js';

export const SESSION_TYP = 'session';
export const CHALLENGE_TYP = 'quest_challenge';
export const AR_CHALLENGE_TYP = 'quest_ar_challenge';
export const QR_PASS_TYP = 'quest_qr_pass';

export interface SessionClaims {
  id: string;
  seed_id: string;
  role: 'user' | 'admin' | 'qa';
  sep?: number;
}

export interface QuestChallengeClaims {
  sub: typeof CHALLENGE_TYP;
  typ: typeof CHALLENGE_TYP;
  user_id: string;
  quest_id: string;
  nonce: string;
}

export interface QuestArChallengeClaims {
  sub: typeof AR_CHALLENGE_TYP;
  typ: typeof AR_CHALLENGE_TYP;
  user_id: string;
  quest_id: string;
  attempt_id: string;
  task_key: string;
  nonce: string;
}

export interface QuestQrPassClaims {
  sub: typeof QR_PASS_TYP;
  typ: typeof QR_PASS_TYP;
  user_id: string;
  quest_id: string;
  attempt_id: string;
  step_order: number;
  task_key: string;
  nonce: string;
}

const validRole = (role: unknown): role is SessionClaims['role'] =>
  role === 'user' || role === 'admin' || role === 'qa';

export function signSessionToken(
  user: { id: string; seed_id: string; role: string; session_epoch?: number },
  rememberMe = false,
): string {
  if (!validRole(user.role)) throw new Error('Cannot issue session token for unsupported role.');
  return jwt.sign(
    { id: user.id, seed_id: user.seed_id, role: user.role, typ: SESSION_TYP, sep: user.session_epoch ?? 0 },
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

export function signQuestArChallenge(input: Omit<QuestArChallengeClaims, 'sub' | 'typ'>, expiresInSec = 600): string {
  return jwt.sign(
    { sub: AR_CHALLENGE_TYP, typ: AR_CHALLENGE_TYP, ...input },
    env.JWT_SECRET,
    { algorithm: 'HS256', expiresIn: expiresInSec },
  );
}

export function signQuestQrPass(input: Omit<QuestQrPassClaims, 'sub' | 'typ'>, expiresInSec = 600): string {
  return jwt.sign(
    { sub: QR_PASS_TYP, typ: QR_PASS_TYP, ...input },
    env.JWT_SECRET,
    { algorithm: 'HS256', expiresIn: expiresInSec },
  );
}

// SESSIONS_VALID_AFTER signs everyone out at once (owner 2026-10-29, after Plan 67 made
// wallet accounts finish with email + password). Tokens without iat predate the cutoff too.
const issuedBeforeCutoff = (iat: unknown): boolean => {
  const cutoff = Date.parse(env.SESSIONS_VALID_AFTER);
  if (!Number.isFinite(cutoff)) return false;
  return typeof iat !== 'number' || iat * 1000 < cutoff;
};

export function verifySessionToken(token: string): SessionClaims | null {
  try {
    const decoded = jwt.verify(token, env.JWT_SECRET, { algorithms: ['HS256'] });
    if (!decoded || typeof decoded === 'string') return null;
    const claims = decoded as JwtPayload & Record<string, unknown>;
    // TODO(2026-10-23): require typ === 'session' after the longest legacy session expires.
    if ((claims.typ !== undefined && claims.typ !== SESSION_TYP) || claims.sub === CHALLENGE_TYP || claims.sub === AR_CHALLENGE_TYP || claims.typ === AR_CHALLENGE_TYP || claims.sub === QR_PASS_TYP || claims.typ === QR_PASS_TYP) return null;
    if (typeof claims.id !== 'string' || claims.id.length === 0) return null;
    if (typeof claims.seed_id !== 'string' || !validRole(claims.role)) return null;
    if (issuedBeforeCutoff(claims.iat)) return null;
    const sep = typeof claims.sep === 'number' && Number.isInteger(claims.sep) && claims.sep >= 0 ? claims.sep : 0;
    return { id: claims.id, seed_id: claims.seed_id, role: claims.role, sep };
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

export function verifyQuestArChallengeToken(token: string): QuestArChallengeClaims | null {
  try {
    const decoded = jwt.verify(token, env.JWT_SECRET, { algorithms: ['HS256'] });
    if (!decoded || typeof decoded === 'string') return null;
    const claims = decoded as JwtPayload & Record<string, unknown>;
    if (claims.sub !== AR_CHALLENGE_TYP || (claims.typ !== undefined && claims.typ !== AR_CHALLENGE_TYP)) return null;
    if (typeof claims.user_id !== 'string' || typeof claims.quest_id !== 'string' ||
        typeof claims.attempt_id !== 'string' || typeof claims.task_key !== 'string' ||
        typeof claims.nonce !== 'string' || claims.nonce.length === 0) return null;
    return claims as unknown as QuestArChallengeClaims;
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) throw error;
    return null;
  }
}

export function verifyQuestQrPassToken(token: string): QuestQrPassClaims | null {
  try {
    const cleaned = token.startsWith('JDQPASS:') ? token.slice('JDQPASS:'.length).trim() : token.trim();
    const decoded = jwt.verify(cleaned, env.JWT_SECRET, { algorithms: ['HS256'] });
    if (!decoded || typeof decoded === 'string') return null;
    const claims = decoded as JwtPayload & Record<string, unknown>;
    if (claims.sub !== QR_PASS_TYP || (claims.typ !== undefined && claims.typ !== QR_PASS_TYP)) return null;
    if (typeof claims.user_id !== 'string' || typeof claims.quest_id !== 'string' ||
        typeof claims.attempt_id !== 'string' || typeof claims.step_order !== 'number' ||
        typeof claims.task_key !== 'string' || typeof claims.nonce !== 'string' || claims.nonce.length === 0) return null;
    return claims as unknown as QuestQrPassClaims;
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) throw error;
    return null;
  }
}
