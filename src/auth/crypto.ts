import { scrypt, randomBytes, timingSafeEqual, createHmac } from 'crypto';
import { promisify } from 'util';

const scryptAsync = promisify(scrypt);

const KEY_LENGTH = 64;

export interface HashResult {
  hash: string;
  salt: string;
}

/**
 * Derives a cryptographically strong scrypt password hash.
 */
export async function hashPassword(password: string): Promise<HashResult> {
  const salt = randomBytes(16).toString('hex');
  const derivedKey = (await scryptAsync(password, salt, KEY_LENGTH)) as Buffer;
  return {
    hash: derivedKey.toString('hex'),
    salt,
  };
}

/**
 * Compares a plain password against a stored salt and hash in constant time.
 */
export async function verifyPassword(password: string, salt: string, storedHash: string): Promise<boolean> {
  try {
    const derivedKey = (await scryptAsync(password, salt, KEY_LENGTH)) as Buffer;
    const storedBuffer = Buffer.from(storedHash, 'hex');
    if (derivedKey.length !== storedBuffer.length) {
      return false;
    }
    return timingSafeEqual(derivedKey, storedBuffer);
  } catch {
    return false;
  }
}

/**
 * Computes a secure HMAC for an OTP or challenge code with a purpose and target.
 */
export function hashChallengeCode(code: string, secret: string): string {
  return createHmac('sha256', secret).update(code.trim()).digest('hex');
}

/**
 * Constant-time comparison for challenge hashes.
 */
export function verifyChallengeCode(code: string, expectedHash: string, secret: string): boolean {
  try {
    const actualHash = hashChallengeCode(code, secret);
    const actualBuf = Buffer.from(actualHash, 'hex');
    const expectedBuf = Buffer.from(expectedHash, 'hex');
    if (actualBuf.length !== expectedBuf.length) {
      return false;
    }
    return timingSafeEqual(actualBuf, expectedBuf);
  } catch {
    return false;
  }
}

/**
 * Generates a cryptographically random 6-digit numeric OTP code.
 */
export function generateNumericOtp(): string {
  const buf = randomBytes(4);
  const num = buf.readUInt32BE(0) % 1_000_000;
  return num.toString().padStart(6, '0');
}
