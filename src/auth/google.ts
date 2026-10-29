import { env } from '../config/env.js';

// Plan 67: Google Identity Services sign-in. The ID token is checked by Google's
// tokeninfo endpoint (signature + expiry), then issuer, audience and email
// verification are checked here. Nothing from an unchecked token is trusted.

export interface GoogleProfile {
  sub: string;
  email: string;
  name: string | null;
  picture: string | null;
}

export type GoogleVerification =
  | { ok: true; profile: GoogleProfile }
  | { ok: false; reason: 'UNAVAILABLE' | 'INVALID_GOOGLE_CREDENTIAL' };

const GOOGLE_ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com']);
const DEV_PREFIX = 'dev_google:';

let fetchImpl: typeof fetch = (...args) => fetch(...args);
export const setGoogleFetch = (impl: typeof fetch) => { fetchImpl = impl; };

/** Local previews and tests may use `dev_google:<email>:<name>`; production never does. */
export const devGoogleCredentialsEnabled = (): boolean =>
  env.NODE_ENV !== 'production' && (env.NODE_ENV === 'test' || env.ALLOW_INSECURE_LOCAL_WALLET_AUTH);

export const googleSignInAvailable = (): boolean => Boolean(env.GOOGLE_CLIENT_ID) || devGoogleCredentialsEnabled();

const parseDevCredential = (credential: string): GoogleProfile | null => {
  const [email, ...nameParts] = credential.slice(DEV_PREFIX.length).split(':');
  const cleanEmail = (email ?? '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) return null;
  const name = nameParts.join(':').trim();
  return { sub: `dev:${cleanEmail}`, email: cleanEmail, name: name || null, picture: null };
};

export async function verifyGoogleCredential(credential: string): Promise<GoogleVerification> {
  if (credential.startsWith(DEV_PREFIX) && devGoogleCredentialsEnabled()) {
    const profile = parseDevCredential(credential);
    return profile ? { ok: true, profile } : { ok: false, reason: 'INVALID_GOOGLE_CREDENTIAL' };
  }
  if (!env.GOOGLE_CLIENT_ID) return { ok: false, reason: 'UNAVAILABLE' };

  let claims: Record<string, unknown>;
  try {
    const response = await fetchImpl(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`, {
      signal: AbortSignal.timeout(5000),
    });
    if (response.status >= 500) return { ok: false, reason: 'UNAVAILABLE' };
    if (!response.ok) return { ok: false, reason: 'INVALID_GOOGLE_CREDENTIAL' };
    claims = await response.json() as Record<string, unknown>;
  } catch {
    return { ok: false, reason: 'UNAVAILABLE' };
  }

  const exp = Number(claims.exp);
  const verified = claims.email_verified === true || claims.email_verified === 'true';
  if (
    !GOOGLE_ISSUERS.has(String(claims.iss)) ||
    claims.aud !== env.GOOGLE_CLIENT_ID ||
    !Number.isFinite(exp) || exp * 1000 <= Date.now() ||
    !verified ||
    typeof claims.sub !== 'string' || !claims.sub ||
    typeof claims.email !== 'string' || !claims.email
  ) {
    return { ok: false, reason: 'INVALID_GOOGLE_CREDENTIAL' };
  }
  return {
    ok: true,
    profile: {
      sub: claims.sub,
      email: claims.email.trim().toLowerCase(),
      name: typeof claims.name === 'string' ? claims.name : null,
      picture: typeof claims.picture === 'string' ? claims.picture : null,
    },
  };
}
