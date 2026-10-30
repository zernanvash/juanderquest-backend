import { describe, it, expect, beforeEach } from '@jest/globals';
import request from 'supertest';
import { app } from '../src/app.js';
import { db } from '../src/db/index.js';
import { LoginThrottle, accountLoginThrottle } from '../src/auth/loginThrottle.js';

describe('Plan 72 Phase 4: Per-Account Login Throttle', () => {
  beforeEach(() => {
    accountLoginThrottle.reset();
  });

  describe('LoginThrottle unit tests with fake time', () => {
    it('allows 9 consecutive failures and throttles on the 10th failure', () => {
      let currentTime = 1_000_000;
      const throttle = new LoginThrottle({
        maxFailures: 10,
        windowMs: 15 * 60 * 1000,
        cooldownMs: 15 * 60 * 1000,
        now: () => currentTime,
      });

      const email = 'victim@example.com';

      // 9 failures: not throttled yet
      for (let i = 0; i < 9; i++) {
        expect(throttle.isThrottled(email)).toBe(false);
        throttle.recordFailure(email);
        currentTime += 1000;
      }
      expect(throttle.isThrottled(email)).toBe(false);

      // 10th failure triggers cooldown
      throttle.recordFailure(email);
      expect(throttle.isThrottled(email)).toBe(true);

      // Inside cooldown window (14 minutes later) -> still throttled
      currentTime += 14 * 60 * 1000;
      expect(throttle.isThrottled(email)).toBe(true);

      // After 15-minute cooldown expires -> no longer throttled
      currentTime += 61 * 1000;
      expect(throttle.isThrottled(email)).toBe(false);
    });

    it('resets the failure count on successful login', () => {
      let currentTime = 1_000_000;
      const throttle = new LoginThrottle({
        maxFailures: 10,
        windowMs: 15 * 60 * 1000,
        cooldownMs: 15 * 60 * 1000,
        now: () => currentTime,
      });

      const email = 'user@example.com';

      // 9 failures
      for (let i = 0; i < 9; i++) {
        throttle.recordFailure(email);
      }
      expect(throttle.isThrottled(email)).toBe(false);

      // Successful login resets counter
      throttle.recordSuccess(email);

      // Another 9 failures: still not throttled because counter was reset
      for (let i = 0; i < 9; i++) {
        throttle.recordFailure(email);
      }
      expect(throttle.isThrottled(email)).toBe(false);
    });

    it('resets failure count if rolling window expires before hitting threshold', () => {
      let currentTime = 1_000_000;
      const throttle = new LoginThrottle({
        maxFailures: 10,
        windowMs: 15 * 60 * 1000,
        cooldownMs: 15 * 60 * 1000,
        now: () => currentTime,
      });

      const email = 'slow-attacker@example.com';

      // 5 failures
      for (let i = 0; i < 5; i++) {
        throttle.recordFailure(email);
      }

      // Advance time by 16 minutes (window expires)
      currentTime += 16 * 60 * 1000;

      // isThrottled cleans up expired entry
      expect(throttle.isThrottled(email)).toBe(false);

      // Next failure starts a fresh window of 1 failure
      throttle.recordFailure(email);
      const record = throttle.getRecord(email);
      expect(record?.failures).toBe(1);
    });

    it('does not throttle a different email', () => {
      let currentTime = 1_000_000;
      const throttle = new LoginThrottle({
        maxFailures: 10,
        windowMs: 15 * 60 * 1000,
        cooldownMs: 15 * 60 * 1000,
        now: () => currentTime,
      });

      for (let i = 0; i < 10; i++) {
        throttle.recordFailure('attacker-target@example.com');
      }

      expect(throttle.isThrottled('attacker-target@example.com')).toBe(true);
      expect(throttle.isThrottled('innocent-target@example.com')).toBe(false);
    });
  });

  describe('HTTP endpoint integration (/auth/login)', () => {
    it('returns uniform 401 INVALID_CREDENTIALS before and after throttling, without revealing account existence', async () => {
      const email = `throttle.test.${Date.now()}@example.com`;

      // 10 invalid login attempts for non-existent account
      for (let i = 0; i < 10; i++) {
        const res = await request(app)
          .post('/api/v1/auth/login')
          .send({ email, password: 'wrongpassword' });
        expect(res.status).toBe(401);
        expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
      }

      // 11th attempt is throttled, returning the exact same 401 status and code
      const throttledRes = await request(app)
        .post('/api/v1/auth/login')
        .send({ email, password: 'wrongpassword' });
      expect(throttledRes.status).toBe(401);
      expect(throttledRes.body.error.code).toBe('INVALID_CREDENTIALS');
      expect(throttledRes.body.error.message).toBe('Invalid email or password.');
      expect(accountLoginThrottle.isThrottled(email)).toBe(true);
    });
  });
});
