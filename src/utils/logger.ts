import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

const requestContext = new AsyncLocalStorage<{ requestId: string }>();

export function getRequestId(): string | undefined {
  return requestContext.getStore()?.requestId;
}

export function runWithRequestId(requestId: string, fn: () => void): void {
  requestContext.run({ requestId }, fn);
}

export function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.headers['x-request-id'];
  const raw = Array.isArray(incoming) ? incoming[0] : incoming;
  const requestId = typeof raw === 'string' && raw.trim().length > 0 ? raw.trim().slice(0, 128) : randomUUID();
  res.setHeader('x-request-id', requestId);
  requestContext.run({ requestId }, next);
}

function serializeError(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    return {
      name: err.name,
      message: err.message,
    };
  }
  return { message: String(err) };
}

function emit(level: 'info' | 'warn' | 'error', message: string, fields?: Record<string, unknown>): void {
  const requestId = getRequestId();
  const entry: Record<string, unknown> = {
    level,
    time: new Date().toISOString(),
    message,
    ...(requestId ? { request_id: requestId } : {}),
  };
  if (fields) {
    for (const [k, v] of Object.entries(fields)) {
      if (k === 'error' && v instanceof Error) {
        entry[k] = serializeError(v);
      } else if (v !== undefined) {
        entry[k] = v;
      }
    }
  }
  const line = JSON.stringify(entry);
  if (level === 'error') {
    process.stderr.write(`${line}\n`);
  } else {
    process.stdout.write(`${line}\n`);
  }
}

export const log = {
  info: (message: string, fields?: Record<string, unknown>) => emit('info', message, fields),
  warn: (message: string, fields?: Record<string, unknown>) => emit('warn', message, fields),
  error: (message: string, fields?: Record<string, unknown>) => emit('error', message, fields),
};
