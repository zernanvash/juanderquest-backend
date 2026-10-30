export interface LoginThrottleOptions {
  maxFailures?: number;
  windowMs?: number;
  cooldownMs?: number;
  now?: () => number;
  maxEntries?: number;
}

interface FailureRecord {
  failures: number;
  firstFailureAt: number;
  blockedUntil?: number;
}

export class LoginThrottle {
  private records = new Map<string, FailureRecord>();
  private readonly maxFailures: number;
  private readonly windowMs: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;
  private readonly maxEntries: number;

  constructor(options?: LoginThrottleOptions) {
    this.maxFailures = options?.maxFailures ?? 10;
    this.windowMs = options?.windowMs ?? 15 * 60 * 1000; // 15 minutes
    this.cooldownMs = options?.cooldownMs ?? 15 * 60 * 1000; // 15 minutes
    this.now = options?.now ?? Date.now;
    this.maxEntries = options?.maxEntries ?? 10_000;
  }

  isThrottled(normalizedEmail: string): boolean {
    const record = this.records.get(normalizedEmail);
    if (!record) return false;

    const currentTime = this.now();
    if (record.blockedUntil) {
      if (currentTime < record.blockedUntil) {
        return true;
      }
      // Cooldown expired
      this.records.delete(normalizedEmail);
      return false;
    }

    // If rolling window expired without hitting maxFailures
    if (currentTime - record.firstFailureAt > this.windowMs) {
      this.records.delete(normalizedEmail);
      return false;
    }

    return false;
  }

  recordFailure(normalizedEmail: string): void {
    const currentTime = this.now();
    const record = this.records.get(normalizedEmail);

    if (!record || (currentTime - record.firstFailureAt > this.windowMs && !record.blockedUntil)) {
      if (this.records.size >= this.maxEntries) {
        this.pruneExpired(currentTime);
      }
      this.records.set(normalizedEmail, {
        failures: 1,
        firstFailureAt: currentTime,
      });
      return;
    }

    // Already blocked
    if (record.blockedUntil && currentTime < record.blockedUntil) {
      return;
    }

    record.failures += 1;
    if (record.failures >= this.maxFailures) {
      record.blockedUntil = currentTime + this.cooldownMs;
    }
  }

  recordSuccess(normalizedEmail: string): void {
    this.records.delete(normalizedEmail);
  }

  pruneExpired(currentTime: number = this.now()): number {
    let pruned = 0;
    for (const [email, record] of this.records.entries()) {
      if (record.blockedUntil) {
        if (currentTime >= record.blockedUntil) {
          this.records.delete(email);
          pruned++;
        }
      } else if (currentTime - record.firstFailureAt > this.windowMs) {
        this.records.delete(email);
        pruned++;
      }
    }
    return pruned;
  }

  getRecord(normalizedEmail: string): FailureRecord | undefined {
    return this.records.get(normalizedEmail);
  }

  reset(): void {
    this.records.clear();
  }
}

export const accountLoginThrottle = new LoginThrottle();
