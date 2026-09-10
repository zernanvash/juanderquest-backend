import { Request, Response, NextFunction } from 'express';

export type RateLimitKeyStrategy = 'ip' | 'actor' | 'actor_or_ip';

export interface RateLimitOptions {
  policyId?: string;
  windowMs: number;
  max: number;
  keyStrategy?: RateLimitKeyStrategy;
  now?: () => number;
  coarseIpMax?: number;
  maxEntries?: number;
}

interface CounterEntry {
  count: number;
  resetAt: number;
  blocked?: boolean;
}

// Bounded state storage: policyId -> Map<key, CounterEntry>
const policyStores = new Map<string, Map<string, CounterEntry>>();
export const DEFAULT_MAX_ENTRIES_PER_POLICY = 10_000;

export function resetRateLimits(): void {
  policyStores.clear();
}

export function getRateLimitStoreSize(policyId?: string): number {
  if (policyId) {
    return policyStores.get(policyId)?.size ?? 0;
  }
  let total = 0;
  for (const store of policyStores.values()) {
    total += store.size;
  }
  return total;
}

// Periodic background worker to sweep expired entries
let cleanupInterval: NodeJS.Timeout | null = null;

export function pruneAllExpired(currentTime: number = Date.now()): number {
  let pruned = 0;
  for (const store of policyStores.values()) {
    for (const [k, v] of store.entries()) {
      if (v.resetAt <= currentTime) {
        store.delete(k);
        pruned++;
      }
    }
  }
  return pruned;
}

export function startRateLimitCleanup(intervalMs: number = 60_000): void {
  if (cleanupInterval) return;
  cleanupInterval = setInterval(() => {
    pruneAllExpired(Date.now());
  }, intervalMs);
  cleanupInterval.unref?.();
}

export function stopRateLimitCleanup(): void {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }
}

// Automatically start background cleanup
startRateLimitCleanup();

function ensureStoreCapacity(
  store: Map<string, CounterEntry>,
  currentTime: number,
  maxEntries: number
): boolean {
  if (store.size < maxEntries) {
    return true;
  }
  // 1. Prune expired entries in this store
  for (const [k, v] of store.entries()) {
    if (v.resetAt <= currentTime) {
      store.delete(k);
    }
  }
  if (store.size < maxEntries) {
    return true;
  }
  // 2. Evict the earliest non-blocked entry (never evict active abusers)
  for (const [k, v] of store.entries()) {
    if (!v.blocked) {
      store.delete(k);
      return true;
    }
  }
  // Saturated with active abusers
  return false;
}

export function rateLimit(options: RateLimitOptions) {
  const {
    policyId = `default_${options.windowMs}_${options.max}`,
    windowMs,
    max,
    keyStrategy = 'ip',
    now: clock = () => Date.now(),
    coarseIpMax,
    maxEntries = DEFAULT_MAX_ENTRIES_PER_POLICY,
  } = options;

  return (req: Request, res: Response, next: NextFunction) => {
    let store = policyStores.get(policyId);
    if (!store) {
      store = new Map<string, CounterEntry>();
      policyStores.set(policyId, store);
    }

    const currentTime = clock();
    const clientIp = req.ip || req.socket.remoteAddress || 'unknown';

    // Coarse IP guard for actor-based limiters
    if (coarseIpMax) {
      const ipKey = `ip_coarse:${clientIp}`;
      let ipEntry = store.get(ipKey);
      if (!ipEntry || ipEntry.resetAt <= currentTime) {
        if (!ipEntry && !ensureStoreCapacity(store, currentTime, maxEntries)) {
          return res.status(429).json({
            success: false,
            error: {
              code: 'RATE_LIMITED',
              message: 'Rate limit tracking capacity saturated. Please try again later.',
            },
          });
        }
        ipEntry = { count: 0, resetAt: currentTime + windowMs, blocked: false };
        store.set(ipKey, ipEntry);
      }
      ipEntry.count += 1;
      if (ipEntry.count > coarseIpMax) {
        ipEntry.blocked = true;
        const retryAfter = Math.max(1, Math.ceil((ipEntry.resetAt - currentTime) / 1000));
        if (typeof res.setHeader === 'function') {
          res.setHeader('Retry-After', String(retryAfter));
          res.setHeader('X-RateLimit-Limit', String(coarseIpMax));
          res.setHeader('X-RateLimit-Remaining', '0');
          res.setHeader('X-RateLimit-Reset', String(Math.ceil(ipEntry.resetAt / 1000)));
        }
        return res.status(429).json({
          success: false,
          error: {
            code: 'RATE_LIMITED',
            message: 'Too many requests from this IP address. Please try again later.',
          },
        });
      }
    }

    // Determine primary key based on strategy
    let primaryKey: string;
    const actorId = (req as any).user?.id;

    if (keyStrategy === 'actor') {
      if (actorId && typeof actorId === 'string') {
        primaryKey = `actor:${actorId}`;
      } else {
        primaryKey = `unauth:${clientIp}`;
      }
    } else if (keyStrategy === 'actor_or_ip') {
      if (actorId && typeof actorId === 'string') {
        primaryKey = `actor:${actorId}`;
      } else {
        primaryKey = `ip:${clientIp}`;
      }
    } else {
      primaryKey = `ip:${clientIp}`;
    }

    let entry = store.get(primaryKey);
    if (!entry || entry.resetAt <= currentTime) {
      if (!entry && !ensureStoreCapacity(store, currentTime, maxEntries)) {
        return res.status(429).json({
          success: false,
          error: {
            code: 'RATE_LIMITED',
            message: 'Rate limit tracking capacity saturated. Please try again later.',
          },
        });
      }
      entry = { count: 0, resetAt: currentTime + windowMs, blocked: false };
      store.set(primaryKey, entry);
    }

    entry.count += 1;

    if (typeof res.setHeader === 'function') {
      res.setHeader('X-RateLimit-Limit', String(max));
      res.setHeader('X-RateLimit-Remaining', String(Math.max(0, max - entry.count)));
      res.setHeader('X-RateLimit-Reset', String(Math.ceil(entry.resetAt / 1000)));
    }

    if (entry.count > max) {
      entry.blocked = true;
      const retryAfter = Math.max(1, Math.ceil((entry.resetAt - currentTime) / 1000));
      if (typeof res.setHeader === 'function') {
        res.setHeader('Retry-After', String(retryAfter));
      }
      return res.status(429).json({
        success: false,
        error: {
          code: 'RATE_LIMITED',
          message: 'Too many requests. Please try again later.',
        },
      });
    }

    next();
  };
}
