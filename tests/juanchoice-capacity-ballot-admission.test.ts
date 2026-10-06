import {
  BallotAdmissionController,
  resolveBallotAdmission,
  isBallotRequest,
} from '../scripts/juanchoice-capacity-ballot-admission.js';

describe('juanchoice capacity ballot admission pure helper unit tests', () => {
  describe('resolveBallotAdmission validation', () => {
    it('defaults to 0 when env value is undefined, empty string, or whitespace', () => {
      expect(resolveBallotAdmission(undefined, 5)).toBe(0);
      expect(resolveBallotAdmission('', 5)).toBe(0);
      expect(resolveBallotAdmission('   ', 5)).toBe(0);
    });

    it('returns 0 when env value is explicit 0', () => {
      expect(resolveBallotAdmission('0', 5)).toBe(0);
      expect(resolveBallotAdmission(' 0 ', 5)).toBe(0);
    });

    it('accepts integer in range 1..poolMax-1', () => {
      expect(resolveBallotAdmission('1', 5)).toBe(1);
      expect(resolveBallotAdmission('2', 5)).toBe(2);
      expect(resolveBallotAdmission('3', 5)).toBe(3);
      expect(resolveBallotAdmission('4', 5)).toBe(4);
    });

    it('rejects values >= poolMax or < 0', () => {
      expect(() => resolveBallotAdmission('5', 5)).toThrow(/must be 0 \(disabled\) or between 1 and 4/);
      expect(() => resolveBallotAdmission('6', 5)).toThrow(/must be 0 \(disabled\) or between 1 and 4/);
      expect(() => resolveBallotAdmission('-1', 5)).toThrow(/must be an integer/);
    });

    it('rejects non-integer strings', () => {
      expect(() => resolveBallotAdmission('abc', 5)).toThrow(/must be an integer/);
      expect(() => resolveBallotAdmission('3.5', 5)).toThrow(/must be an integer/);
      expect(() => resolveBallotAdmission('Infinity', 5)).toThrow(/must be an integer/);
    });

    it('rejects poolMax < 2 when admission > 0 is requested', () => {
      expect(() => resolveBallotAdmission('1', 1)).toThrow(/Cannot enable ballot admission when poolMax is 1/);
    });
  });

  describe('isBallotRequest route matching', () => {
    it('matches PUT /api/v1/juanchoice/campaigns/:id/ballot', () => {
      expect(isBallotRequest('PUT', '/api/v1/juanchoice/campaigns/c-123/ballot')).toBe(true);
      expect(isBallotRequest('PUT', '/api/v1/juanchoice/campaigns/c-123/ballot?query=1')).toBe(true);
    });

    it('rejects non-PUT methods', () => {
      expect(isBallotRequest('GET', '/api/v1/juanchoice/campaigns/c-123/ballot')).toBe(false);
      expect(isBallotRequest('POST', '/api/v1/juanchoice/campaigns/c-123/ballot')).toBe(false);
      expect(isBallotRequest('DELETE', '/api/v1/juanchoice/campaigns/c-123/ballot')).toBe(false);
    });

    it('rejects non-ballot paths', () => {
      expect(isBallotRequest('PUT', '/api/v1/juanchoice/overview')).toBe(false);
      expect(isBallotRequest('PUT', '/api/v1/juanchoice/campaigns/c-123/standings')).toBe(false);
      expect(isBallotRequest('PUT', '/api/v1/juanchoice/campaigns/c-123/candidate/1')).toBe(false);
      expect(isBallotRequest('PUT', '/api/v1/juanchoice/campaigns//ballot')).toBe(false);
      expect(isBallotRequest('PUT', undefined)).toBe(false);
    });
  });

  describe('BallotAdmissionController concurrency and queue bounds', () => {
    it('when limit is 0, acquire resolves immediately with no-op release and zero stats', async () => {
      const controller = new BallotAdmissionController({ limit: 0 });
      const release1 = await controller.acquire();
      const release2 = await controller.acquire();
      expect(controller.getActiveCount()).toBe(0);
      expect(controller.getPeakQueue()).toBe(0);
      expect(controller.getQueueDepth()).toBe(0);

      release1();
      release2();
      expect(controller.getActiveCount()).toBe(0);
      expect(controller.getStats().totalWaiters).toBe(0);
      expect(controller.getWaitPercentiles()).toEqual({ p50_ms: 0, p95_ms: 0, max_ms: 0 });
    });

    it('grants permits up to limit concurrently', async () => {
      const controller = new BallotAdmissionController({ limit: 2 });
      const r1 = await controller.acquire();
      const r2 = await controller.acquire();
      expect(controller.getActiveCount()).toBe(2);
      expect(controller.getQueueDepth()).toBe(0);

      r1();
      expect(controller.getActiveCount()).toBe(1);
      r2();
      expect(controller.getActiveCount()).toBe(0);
    });

    it('enqueues when limit is reached and dispatches on release', async () => {
      const controller = new BallotAdmissionController({ limit: 1 });
      const r1 = await controller.acquire();
      expect(controller.getActiveCount()).toBe(1);

      let p2Resolved = false;
      let r2Release: (() => void) | undefined;
      const p2 = controller.acquire().then(release => {
        p2Resolved = true;
        r2Release = release;
      });

      expect(controller.getQueueDepth()).toBe(1);
      expect(controller.getPeakQueue()).toBe(1);
      expect(p2Resolved).toBe(false);

      r1();
      await p2;
      expect(p2Resolved).toBe(true);
      expect(controller.getActiveCount()).toBe(1);
      expect(controller.getQueueDepth()).toBe(0);

      r2Release!();
      expect(controller.getActiveCount()).toBe(0);
      expect(controller.getStats().totalWaiters).toBe(1);
      expect(controller.getStats().waitDurationSamplesMs.length).toBe(1);
    });

    it('release is strictly idempotent', async () => {
      const controller = new BallotAdmissionController({ limit: 1 });
      const r1 = await controller.acquire();
      expect(controller.getActiveCount()).toBe(1);

      r1();
      r1();
      r1();
      expect(controller.getActiveCount()).toBe(0);
    });

    it('fails closed when queue exceeds maxQueueDepth', async () => {
      const controller = new BallotAdmissionController({ limit: 1, maxQueueDepth: 2 });
      const r1 = await controller.acquire();

      const p2 = controller.acquire();
      const p3 = controller.acquire();
      expect(controller.getQueueDepth()).toBe(2);

      await expect(controller.acquire()).rejects.toThrow(/Ballot admission queue limit \(2\) exceeded; failing closed/);
      expect(controller.getQueueDepth()).toBe(2);

      r1();
      const r2 = await p2;
      r2();
      const r3 = await p3;
      r3();
      expect(controller.getActiveCount()).toBe(0);
    });
  });

  describe('BallotAdmissionController cancellation and aborts', () => {
    it('throws immediately when acquire is passed an already aborted signal without incrementing active count', async () => {
      const controller = new BallotAdmissionController({ limit: 2 });
      const abortCtrl = new AbortController();
      abortCtrl.abort();

      await expect(controller.acquire(abortCtrl.signal)).rejects.toMatchObject({
        name: 'AbortError',
      });
      expect(controller.getActiveCount()).toBe(0);
      expect(controller.getQueueDepth()).toBe(0);
    });

    it('cancels queued waiter when signal aborts while queued and does not leak permit', async () => {
      const controller = new BallotAdmissionController({ limit: 1 });
      const r1 = await controller.acquire();
      expect(controller.getActiveCount()).toBe(1);

      const abortCtrl = new AbortController();
      const queuedPromise = controller.acquire(abortCtrl.signal);
      expect(controller.getQueueDepth()).toBe(1);

      // Abort while waiting
      abortCtrl.abort();
      await expect(queuedPromise).rejects.toMatchObject({
        name: 'AbortError',
      });
      expect(controller.getQueueDepth()).toBe(0);

      // Now release r1; queue is empty so activeCount should drop to 0, no permit leaked
      r1();
      expect(controller.getActiveCount()).toBe(0);

      // Subsequent callers can acquire normally
      const r2 = await controller.acquire();
      expect(controller.getActiveCount()).toBe(1);
      r2();
      expect(controller.getActiveCount()).toBe(0);
    });

    it('handles multiple waiters with middle waiter cancellation gracefully', async () => {
      const controller = new BallotAdmissionController({ limit: 1 });
      const r1 = await controller.acquire();

      const w1Ctrl = new AbortController();
      const w2Ctrl = new AbortController();
      const w3Ctrl = new AbortController();

      const p1 = controller.acquire(w1Ctrl.signal);
      const p2 = controller.acquire(w2Ctrl.signal);
      const p3 = controller.acquire(w3Ctrl.signal);
      expect(controller.getQueueDepth()).toBe(3);

      // Abort middle waiter w2
      w2Ctrl.abort();
      await expect(p2).rejects.toMatchObject({ name: 'AbortError' });
      expect(controller.getQueueDepth()).toBe(2);

      // Release r1 -> should dispatch p1
      r1();
      const rP1 = await p1;
      expect(controller.getActiveCount()).toBe(1);
      expect(controller.getQueueDepth()).toBe(1);

      // Release p1 -> should dispatch p3
      rP1();
      const rP3 = await p3;
      expect(controller.getActiveCount()).toBe(1);
      expect(controller.getQueueDepth()).toBe(0);

      rP3();
      expect(controller.getActiveCount()).toBe(0);
    });

    it('calculates wait percentiles accurately', async () => {
      const controller = new BallotAdmissionController({ limit: 1 });
      const r1 = await controller.acquire();

      const p2 = controller.acquire();
      await new Promise(resolve => setTimeout(resolve, 15));
      r1();
      const r2 = await p2;
      r2();

      const percentiles = controller.getWaitPercentiles();
      expect(percentiles.p50_ms).toBeGreaterThan(0);
      expect(percentiles.p95_ms).toBeGreaterThanOrEqual(percentiles.p50_ms);
      expect(percentiles.max_ms).toBeGreaterThanOrEqual(percentiles.p95_ms);
    });
  });
});
