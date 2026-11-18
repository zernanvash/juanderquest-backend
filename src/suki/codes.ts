import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'crypto';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';

/** Public origin the printed standee points at (web landing page, Plan 107 §9). */
export const SUKI_STANDEE_ORIGIN = 'https://juanderquest.app';
export const SUKI_PASS_PREFIX = 'JDQSUKIPASS:';
export const SUKI_PASS_TTL_SEC = 120;
const PASS_TYP = 'suki_pass';

// A dedicated key derived from JWT_SECRET, so a standee signature can never be
// confused with any other signed value. Rotating JWT_SECRET invalidates every
// printed standee (runbook note).
const standeeKey = () => createHmac('sha256', env.JWT_SECRET).update('jdq-suki-standee-v1').digest();

export function standeeSignature(programId: string, version: number): string {
  return createHmac('sha256', standeeKey()).update(`suki-standee:${programId}:${version}`).digest('hex').slice(0, 16);
}

export function standeeUrl(programId: string, version: number): string {
  return `${SUKI_STANDEE_ORIGIN}/suki/${encodeURIComponent(programId)}?v=${version}&s=${standeeSignature(programId, version)}`;
}

export interface ParsedStandee {
  programId: string;
  version: number;
  signatureOk: boolean;
}

/** Parses a scanned standee URL. Returns null when it is not a Suki standee at all. */
export function parseStandee(raw: unknown): ParsedStandee | null {
  if (typeof raw !== 'string' || raw.length > 400) return null;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.origin !== SUKI_STANDEE_ORIGIN) return null;
  const match = /^\/suki\/([A-Za-z0-9_-]{3,80})$/.exec(url.pathname);
  if (!match) return null;
  const version = Number(url.searchParams.get('v'));
  const signature = url.searchParams.get('s') ?? '';
  if (!Number.isSafeInteger(version) || version < 1) return null;
  const programId = match[1];
  const expected = Buffer.from(standeeSignature(programId, version), 'utf8');
  const supplied = Buffer.from(signature, 'utf8');
  const signatureOk = expected.length === supplied.length && timingSafeEqual(expected, supplied);
  return { programId, version, signatureOk };
}

export interface SukiPassClaims {
  typ: typeof PASS_TYP;
  programId: string;
  userId: string;
  jti: string;
}

export function signSukiPass(programId: string, userId: string): { pass: string; expiresAt: string; jti: string } {
  const jti = randomUUID();
  const token = jwt.sign({ typ: PASS_TYP, programId, userId, jti }, env.JWT_SECRET, {
    algorithm: 'HS256',
    expiresIn: SUKI_PASS_TTL_SEC,
  });
  return {
    pass: `${SUKI_PASS_PREFIX}${token}`,
    expiresAt: new Date(Date.now() + SUKI_PASS_TTL_SEC * 1000).toISOString(),
    jti,
  };
}

export type PassCheck = { ok: true; claims: SukiPassClaims } | { ok: false; code: 'PASS_EXPIRED' | 'PASS_INVALID' };

export function verifySukiPass(raw: string): PassCheck {
  const token = raw.slice(SUKI_PASS_PREFIX.length).trim();
  try {
    const claims = jwt.verify(token, env.JWT_SECRET, { algorithms: ['HS256'] }) as Partial<SukiPassClaims>;
    if (claims.typ !== PASS_TYP || !claims.programId || !claims.userId || !claims.jti) {
      return { ok: false, code: 'PASS_INVALID' };
    }
    return { ok: true, claims: claims as SukiPassClaims };
  } catch (error) {
    return { ok: false, code: (error as Error)?.name === 'TokenExpiredError' ? 'PASS_EXPIRED' : 'PASS_INVALID' };
  }
}

export function newRewardCode(): string {
  return `SUKI-${randomBytes(3).toString('hex').toUpperCase()}-${randomBytes(3).toString('hex').toUpperCase()}`;
}

/** Normalises a typed or scanned counter code: trims, removes inner spaces, upper-cases plain codes. */
export function normaliseCounterCode(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const trimmed = raw.trim();
  if (trimmed.toUpperCase().startsWith(SUKI_PASS_PREFIX)) {
    return SUKI_PASS_PREFIX + trimmed.slice(SUKI_PASS_PREFIX.length).trim();
  }
  return trimmed.replace(/\s+/g, '').toUpperCase();
}

/** Stable per-shop pseudonym so merchants never see who a customer is. */
export function customerLabel(userId: string, merchantId: string): string {
  const tag = createHmac('sha256', standeeKey()).update(`label:${merchantId}:${userId}`).digest('hex').slice(0, 3);
  return `Suki #${tag.toUpperCase()}`;
}
