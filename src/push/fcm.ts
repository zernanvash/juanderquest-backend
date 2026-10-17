import fs from 'fs';
import { initializeApp, getApps, getApp, cert, App } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
import { env } from '../config/env.js';

export interface MulticastPayload {
  title: string;
  body: string;
  data: Record<string, string>;
  channelId?: string;
  collapseKey?: string;
}

export interface SendResult {
  successCount: number;
  failureCount: number;
  unregisteredTokens: string[];
  transientError?: string;
}

let firebaseApp: App | null = null;
let isDryRun = true;

/**
 * Initializes FCM credentials safely.
 * Never crashes on missing credentials; falls back to dry-run mode.
 */
export function initFcm(): { enabled: boolean; dryRun: boolean } {
  if (!env.PUSH_ENABLED) {
    isDryRun = true;
    return { enabled: false, dryRun: true };
  }

  const saPath = env.FCM_SERVICE_ACCOUNT_FILE;
  if (!saPath || !fs.existsSync(saPath)) {
    console.log('[push] disabled: service account unavailable; running in dry-run mode');
    isDryRun = true;
    return { enabled: true, dryRun: true };
  }

  try {
    const raw = fs.readFileSync(saPath, 'utf8');
    const serviceAccount = JSON.parse(raw);

    const apps = getApps();
    if (!apps.length) {
      firebaseApp = initializeApp({
        credential: cert(serviceAccount),
      });
    } else {
      firebaseApp = getApp();
    }

    isDryRun = false;
    console.log('[push] initialized FCM successfully');
    return { enabled: true, dryRun: false };
  } catch (err: any) {
    console.error('[push] failed to initialize service account:', err?.message);
    isDryRun = true;
    return { enabled: true, dryRun: true };
  }
}

export function isFcmDryRun(): boolean {
  return isDryRun;
}

export function setFcmDryRun(val: boolean): void {
  isDryRun = val;
}

/**
 * Sends a push payload to a set of device tokens via Firebase Cloud Messaging.
 * Never logs raw tokens or service account data.
 */
export async function sendToTokens(
  tokens: string[],
  payload: MulticastPayload,
): Promise<SendResult> {
  if (!tokens || tokens.length === 0) {
    return { successCount: 0, failureCount: 0, unregisteredTokens: [] };
  }

  if (isDryRun || !env.PUSH_ENABLED) {
    return {
      successCount: tokens.length,
      failureCount: 0,
      unregisteredTokens: [],
    };
  }

  try {
    const messaging = firebaseApp ? getMessaging(firebaseApp) : getMessaging();
    const response = await messaging.sendEachForMulticast({
      tokens,
      notification: {
        title: payload.title,
        body: payload.body,
      },
      data: payload.data,
      android: {
        priority: 'high',
        notification: {
          channelId: payload.channelId,
          tag: payload.collapseKey,
        },
      },
    });

    const unregisteredTokens: string[] = [];
    response.responses.forEach((resp: any, idx: number) => {
      if (!resp.success && resp.error) {
        const code = resp.error.code;
        if (
          code === 'messaging/registration-token-not-registered' ||
          code === 'messaging/invalid-registration-token'
        ) {
          unregisteredTokens.push(tokens[idx]);
        }
      }
    });

    return {
      successCount: response.successCount,
      failureCount: response.failureCount,
      unregisteredTokens,
    };
  } catch (err: any) {
    const msg = err?.message || 'FCM multicast error';
    return {
      successCount: 0,
      failureCount: tokens.length,
      unregisteredTokens: [],
      transientError: msg,
    };
  }
}
