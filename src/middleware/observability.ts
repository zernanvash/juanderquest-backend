import { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';

export interface ObservableRequest extends Request {
  id?: string;
  startTime?: number;
}

const REDACTED_KEYS = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'x-qa-auth',
  'x-api-key',
  'password',
  'token',
  'jwt',
  'secret',
  'captured_lat',
  'captured_lng',
  'gps_lat',
  'gps_lng',
]);

/**
 * Deep redaction of sensitive credential, token, and precise geospatial coordinates.
 */
export function redactSensitiveData(obj: any): any {
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(redactSensitiveData);

  const redacted: Record<string, any> = {};
  for (const [key, value] of Object.entries(obj)) {
    const lower = key.toLowerCase();
    if (REDACTED_KEYS.has(lower) || lower.includes('password') || lower.includes('secret') || lower.includes('token')) {
      redacted[key] = '[REDACTED]';
    } else if (typeof value === 'object' && value !== null) {
      redacted[key] = redactSensitiveData(value);
    } else {
      redacted[key] = value;
    }
  }
  return redacted;
}

/**
 * Middleware that assigns a deterministic or generated X-Request-Id header to every request,
 * records processing latency, and emits structured log payloads with automatic redaction.
 */
export function requestTracingMiddleware(req: ObservableRequest, res: Response, next: NextFunction): void {
  const incomingId = req.headers['x-request-id'];
  const requestId =
    typeof incomingId === 'string' && incomingId.trim().length > 0
      ? incomingId.trim()
      : randomUUID();

  req.id = requestId;
  req.startTime = Date.now();
  res.setHeader('X-Request-Id', requestId);

  res.on('finish', () => {
    const durationMs = req.startTime ? Date.now() - req.startTime : 0;
    const logEntry = {
      timestamp: new Date().toISOString(),
      level: res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info',
      requestId,
      method: req.method,
      path: req.originalUrl || req.url,
      statusCode: res.statusCode,
      durationMs,
      ip: req.ip,
      userAgent: req.headers['user-agent'] || null,
    };

    if (process.env.NODE_ENV !== 'test') {
      if (res.statusCode >= 500) {
        console.error(JSON.stringify(logEntry));
      } else if (res.statusCode >= 400) {
        console.warn(JSON.stringify(logEntry));
      } else {
        console.log(JSON.stringify(logEntry));
      }
    }
  });

  next();
}
