import type { Request, Response } from 'express';
import { env } from '../config/env.js';

const isPresentationMode = (): boolean => Boolean(env.JUANCHOICE_PRESENTATION_MODE);
const isPublicPresentationProfile = (): boolean =>
  isPresentationMode() && (env.JDQ_PRESENTATION_PROFILE === 'public' || Boolean(env.CORS_ORIGIN?.startsWith('https://')));

// The isolated demo needs its own cookie namespace so demo sessions cannot authenticate alpha.
export const sessionCookieName = (): string => isPresentationMode()
  ? 'jdq_presentation_session'
  : env.NODE_ENV === 'production' ? '__Host-jdq_session' : 'jdq_session';

const isCookieSecure = (): boolean => {
  if (isPresentationMode()) {
    return isPublicPresentationProfile();
  }
  return env.NODE_ENV === 'production';
};

export const readSessionCookie = (req: Request): string | null => {
  const name = sessionCookieName();
  for (const part of (req.headers.cookie || '').split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name && value.length) return value.join('=');
  }
  return null;
};

export const setSessionCookie = (res: Response, token: string, rememberMe: boolean) => {
  res.cookie(sessionCookieName(), token, {
    httpOnly: true,
    secure: isCookieSecure(),
    sameSite: 'lax',
    path: '/',
    ...(rememberMe ? { maxAge: 7 * 24 * 60 * 60 * 1000 } : {}),
  });
  res.setHeader('Cache-Control', 'private, no-store');
};

export const clearSessionCookie = (res: Response) => {
  res.clearCookie(sessionCookieName(), {
    httpOnly: true,
    secure: isCookieSecure(),
    sameSite: 'lax',
    path: '/',
  });
  res.setHeader('Cache-Control', 'private, no-store');
};
