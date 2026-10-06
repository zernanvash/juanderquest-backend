import {
  computePercentile,
  computePercentileSummary,
  summarizeNegativeDurationGaps,
  summarizeResponseLifecycleDiagnostics,
  assertResponseLifecycleDiagnosticIntegrity,
  correlateRequestSample,
  computeCorrelatedSegmentSummary,
  assertCapacityPopulationIntegrity,
  RequestTimingSample,
  ServerTimingRecord,
  KNOWN_INVALID_TIMING_REASONS,
  InvalidTimingReason,
} from '../scripts/juanchoice-capacity-segments.js';

describe('response lifecycle timing diagnostic', () => {
  const record = (prefinish: number | undefined, finish = 100): ServerTimingRecord => ({
    serverIngress: 10,
    ...(prefinish === undefined ? {} : { serverPrefinish: prefinish }),
    serverFinish: finish,
    durationMs: finish - 10,
    statusCode: 200,
  });
  const sample = (reqId: string, totalClientMs: number): RequestTimingSample => ({
    reqId, kind: 'overview', status: 200, totalClientMs,
  });

  it('reports ordinary response order without anomalies', () => {
    const result = summarizeResponseLifecycleDiagnostics(
      [sample('safe', 110)], new Map([['safe', record(80)]])
    );
    expect(result.matched_samples).toBe(1);
    expect(result.client_below_prefinish_count).toBe(0);
    expect(result.client_below_finish_count).toBe(0);
    expect(() => assertResponseLifecycleDiagnosticIntegrity('reads', result)).not.toThrow();
  });

  it('keeps delayed finish separate from a client shorter than prefinish', () => {
    const result = summarizeResponseLifecycleDiagnostics(
      [sample('delayed', 70)], new Map([['delayed', record(60, 100)]])
    );
    expect(result.client_below_finish_count).toBe(1);
    expect(result.client_below_prefinish_count).toBe(0);
    expect(result.client_below_finish_but_at_or_above_prefinish_count).toBe(1);
    expect(result.client_below_finish_but_at_or_above_prefinish_magnitude.max_ms).toBe(20);
  });

  it('detects a client duration shorter than ingress-to-prefinish', () => {
    const result = summarizeResponseLifecycleDiagnostics(
      [sample('too-short', 50)], new Map([['too-short', record(80, 100)]])
    );
    expect(result.client_below_prefinish_count).toBe(1);
    expect(result.client_below_finish_count).toBe(1);
    expect(result.client_below_finish_but_at_or_above_prefinish_count).toBe(0);
  });

  it('fails integrity for missing, non-finite, or reversed lifecycle timestamps', () => {
    const result = summarizeResponseLifecycleDiagnostics(
      [sample('missing', 120), sample('nan', 120), sample('reversed', 120), sample('after', 120)],
      new Map([
        ['missing', record(undefined)],
        ['nan', record(Number.NaN)],
        ['reversed', record(5)],
        ['after', record(110)],
      ])
    );
    expect(result.missing_prefinish_count).toBe(1);
    expect(result.invalid_prefinish_count).toBe(2);
    expect(result.prefinish_after_finish_count).toBe(1);
    expect(() => assertResponseLifecycleDiagnosticIntegrity('reads', result)).toThrow(/missing prefinish/);
  });

  it('detects invalid server clocks and never prints request identifiers', () => {
    const result = summarizeResponseLifecycleDiagnostics(
      [sample('private-request-id', 120)],
      new Map([['private-request-id', { ...record(80), serverFinish: Number.NaN }]])
    );
    expect(result.invalid_server_clock_count).toBe(1);
    expect(() => assertResponseLifecycleDiagnosticIntegrity('reads', result)).toThrow(/invalid server clocks/);
    expect(JSON.stringify(result)).not.toContain('private-request-id');
  });
});

describe('child negative-duration-gap diagnostic', () => {
  const record = (durationMs: number, statusCode = 200, prefinishMs = durationMs): ServerTimingRecord => ({
    serverIngress: 10,
    serverPrefinish: 10 + prefinishMs,
    serverFinish: 10 + durationMs,
    durationMs,
    statusCode,
  });

  it('returns a bounded empty summary when no child duration is shorter', () => {
    const samples: RequestTimingSample[] = [{ reqId: 'clean', kind: 'overview', status: 200, totalClientMs: 101 }];
    expect(summarizeNegativeDurationGaps(samples, new Map([['clean', record(100)]]))).toEqual({
      count: 0, min_ms: 0, p50_ms: 0, p95_ms: 0, max_ms: 0,
    });
  });

  it('reports exact bounded magnitude and nearest-rank percentiles without identifiers', () => {
    const samples: RequestTimingSample[] = [
      { reqId: 'a', kind: 'overview', status: 200, totalClientMs: 99.875 },
      { reqId: 'b', kind: 'overview', status: 200, totalClientMs: 97 },
      { reqId: 'c', kind: 'overview', status: 200, totalClientMs: 95 },
      { reqId: 'd', kind: 'overview', status: 200, totalClientMs: 92 },
    ];
    const timings = new Map(samples.map(sample => [sample.reqId, record(100)]));
    expect(summarizeNegativeDurationGaps(samples, timings)).toEqual({
      count: 4, min_ms: 0.125, p50_ms: 3, p95_ms: 8, max_ms: 8,
    });
  });

  it('excludes unmatched, status-mismatched, nonfinite, negative and timestamped samples while integrity stays strict', () => {
    const samples: RequestTimingSample[] = [
      { reqId: 'valid', kind: 'overview', status: 200, totalClientMs: 99 },
      { reqId: 'missing', kind: 'overview', status: 200, totalClientMs: 1 },
      { reqId: 'mismatch', kind: 'overview', status: 200, totalClientMs: 1 },
      { reqId: 'nan', kind: 'overview', status: 200, totalClientMs: Number.NaN },
      { reqId: 'negative', kind: 'overview', status: 200, totalClientMs: -1 },
      { reqId: 'timestamped', kind: 'overview', status: 200, clientStart: 0, totalClientMs: 1 },
    ];
    const timings = new Map<string, ServerTimingRecord>([
      ['valid', record(100)], ['mismatch', record(100, 500)],
      ['nan', record(100)], ['negative', record(100)], ['timestamped', record(100)],
    ]);
    expect(summarizeNegativeDurationGaps(samples, timings)).toEqual({
      count: 1, min_ms: 1, p50_ms: 1, p95_ms: 1, max_ms: 1,
    });
    const correlated = computeCorrelatedSegmentSummary(samples, timings);
    expect(correlated.invalid_reason_counts.client_shorter_than_server).toBe(1);
    expect(() => assertCapacityPopulationIntegrity([{
      name: 'all_reads', unmatched_count: correlated.unmatched_count, invalid_count: correlated.invalid_count,
    }])).toThrow(/Integrity check failed/);
  });
});

describe('JuanChoice capacity correlated latency segments pure calculation helper', () => {
  describe('computePercentile & computePercentileSummary', () => {
    it('returns 0 for empty arrays', () => {
      expect(computePercentile([], 0.95)).toBe(0);
      expect(computePercentileSummary([])).toEqual({ p50_ms: 0, p95_ms: 0, max_ms: 0 });
    });

    it('computes exact percentiles for single and multiple elements', () => {
      expect(computePercentile([42], 0.50)).toBe(42);
      expect(computePercentile([42], 0.95)).toBe(42);

      const data = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
      const summary = computePercentileSummary(data);
      expect(summary.p50_ms).toBe(50);
      expect(summary.p95_ms).toBe(100);
      expect(summary.max_ms).toBe(100);
    });
  });

  describe('correlateRequestSample', () => {
    it('correlates a valid request and decomposes intervals accurately', () => {
      // clientStart = 1000, headersResolved = 1200, clientBodyConsumed = 1250, totalClientMs = 250
      // serverIngress = 1050, serverFinish = 1180, durationMs = 130
      const clientSample: RequestTimingSample = {
        reqId: 'req-1',
        kind: 'ballot',
        status: 200,
        clientStart: 1000,
        headersResolved: 1200,
        clientBodyConsumed: 1250,
        totalClientMs: 250,
      };

      const serverRecord: ServerTimingRecord = {
        serverIngress: 1050,
        serverFinish: 1180,
        durationMs: 130,
        statusCode: 200,
      };

      const sample = correlateRequestSample(clientSample, serverRecord);
      expect(sample.isValid).toBe(true);
      expect(sample.preIngressMs).toBe(50); // 1050 - 1000
      expect(sample.serverProcessingMs).toBe(130); // 1180 - 1050
      expect(sample.postFinishMs).toBe(70); // 1250 - 1180
      expect(sample.headersResolvedMs).toBe(200); // 1200 - 1000
      expect(sample.bodyTransferMs).toBe(50); // 1250 - 1200
      expect(sample.gapMs).toBe(120); // 250 - 130
      expect(sample.totalClientMs).toBe(250);
      expect(sample.serverDurationMs).toBe(130);
    });

    it('flags unmatched server record as invalid without throwing', () => {
      const clientSample: RequestTimingSample = {
        reqId: 'unmatched-req',
        kind: 'overview',
        status: 200,
        clientStart: 1000,
        totalClientMs: 50,
      };

      const sample = correlateRequestSample(clientSample, undefined);
      expect(sample.isValid).toBe(false);
      expect(sample.invalidReason).toBe('unmatched_server_timing');
      expect(sample.preIngressMs).toBeUndefined();
    });

    it('flags non-finite timestamps and durations (NaN/Infinity) as invalid without throwing', () => {
      const serverRecord: ServerTimingRecord = {
        serverIngress: 1000,
        serverFinish: 1020,
        durationMs: 20,
        statusCode: 200,
      };

      const nanStart: RequestTimingSample = {
        reqId: 'bad-nan',
        kind: 'overview',
        status: 200,
        clientStart: NaN,
        totalClientMs: 50,
      };
      expect(correlateRequestSample(nanStart, serverRecord)).toEqual(
        expect.objectContaining({ isValid: false, invalidReason: 'non_finite_timing_value' })
      );

      const infDuration: RequestTimingSample = {
        reqId: 'bad-inf',
        kind: 'overview',
        status: 200,
        clientStart: 1000,
        totalClientMs: Infinity,
      };
      expect(correlateRequestSample(infDuration, serverRecord)).toEqual(
        expect.objectContaining({ isValid: false, invalidReason: 'non_finite_timing_value' })
      );

      const infServerRecord: ServerTimingRecord = {
        serverIngress: 1000,
        serverFinish: 1020,
        durationMs: Infinity,
        statusCode: 200,
      };
      const validClient: RequestTimingSample = {
        reqId: 'ok-client',
        kind: 'overview',
        status: 200,
        clientStart: 990,
        clientBodyConsumed: 1030,
        totalClientMs: 40,
      };
      expect(correlateRequestSample(validClient, infServerRecord)).toEqual(
        expect.objectContaining({ isValid: false, invalidReason: 'non_finite_timing_value' })
      );
    });

    it('flags HTTP status code mismatch as invalid with static reason code', () => {
      const clientSample: RequestTimingSample = {
        reqId: 'status-mismatch',
        kind: 'ballot',
        status: 200,
        clientStart: 1000,
        clientBodyConsumed: 1250,
        totalClientMs: 250,
      };

      const serverRecord: ServerTimingRecord = {
        serverIngress: 1050,
        serverFinish: 1180,
        durationMs: 130,
        statusCode: 500, // server recorded 500 while client had 200
      };

      const sample = correlateRequestSample(clientSample, serverRecord);
      expect(sample.isValid).toBe(false);
      expect(sample.invalidReason).toBe('status_code_mismatch');
      expect(sample.preIngressMs).toBeUndefined();
    });

    it('flags negative durations as invalid without throwing', () => {
      const clientSample: RequestTimingSample = {
        reqId: 'negative-client-duration',
        kind: 'ballot',
        status: 200,
        clientStart: 1000,
        totalClientMs: -10,
      };

      const serverRecord: ServerTimingRecord = {
        serverIngress: 1050,
        serverFinish: 1180,
        durationMs: 130,
        statusCode: 200,
      };

      const sample = correlateRequestSample(clientSample, serverRecord);
      expect(sample.isValid).toBe(false);
      expect(sample.invalidReason).toBe('negative_duration');
    });

    it('flags inconsistent elapsed totals exceeding tolerance as invalid without silent clamping', () => {
      // clientBodyConsumed - clientStart = 1250 - 1000 = 250
      // but totalClientMs is recorded as 300 (difference of 50ms > 0.5ms tolerance)
      const clientSample: RequestTimingSample = {
        reqId: 'inconsistent-client',
        kind: 'ballot',
        status: 200,
        clientStart: 1000,
        clientBodyConsumed: 1250,
        totalClientMs: 300,
      };

      const serverRecord: ServerTimingRecord = {
        serverIngress: 1050,
        serverFinish: 1180,
        durationMs: 130,
        statusCode: 200,
      };

      const sample = correlateRequestSample(clientSample, serverRecord);
      expect(sample.isValid).toBe(false);
      expect(sample.invalidReason).toBe('inconsistent_client_duration');

      // Now test server duration inconsistency: serverFinish - serverIngress = 1180 - 1050 = 130
      // but serverRecord.durationMs is recorded as 140 (> 0.5ms tolerance)
      const validClient: RequestTimingSample = {
        reqId: 'consistent-client',
        kind: 'ballot',
        status: 200,
        clientStart: 1000,
        clientBodyConsumed: 1250,
        totalClientMs: 250,
      };

      const inconsistentServer: ServerTimingRecord = {
        serverIngress: 1050,
        serverFinish: 1180,
        durationMs: 140,
        statusCode: 200,
      };

      const serverSample = correlateRequestSample(validClient, inconsistentServer);
      expect(serverSample.isValid).toBe(false);
      expect(serverSample.invalidReason).toBe('inconsistent_server_duration');
    });

    it('flags negative intervals (serverIngress < clientStart) as invalid without clamping to zero', () => {
      // serverIngress appears before clientStart
      const clientSample: RequestTimingSample = {
        reqId: 'time-travel',
        kind: 'ballot',
        status: 200,
        clientStart: 1050,
        clientBodyConsumed: 1200,
        totalClientMs: 150,
      };

      const serverRecord: ServerTimingRecord = {
        serverIngress: 1000,
        serverFinish: 1100,
        durationMs: 100,
        statusCode: 200,
      };

      const sample = correlateRequestSample(clientSample, serverRecord);
      expect(sample.isValid).toBe(false);
      expect(sample.invalidReason).toBe('invalid_timing_order');
      expect(sample.preIngressMs).toBeUndefined();
    });

    it('flags negative postFinish (clientBodyConsumed < serverFinish) as invalid without clamping to zero', () => {
      const clientSample: RequestTimingSample = {
        reqId: 'premature-finish',
        kind: 'ballot',
        status: 200,
        clientStart: 1000,
        clientBodyConsumed: 1080,
        totalClientMs: 80,
      };

      const serverRecord: ServerTimingRecord = {
        serverIngress: 1020,
        serverFinish: 1100,
        durationMs: 80,
        statusCode: 200,
      };

      const sample = correlateRequestSample(clientSample, serverRecord);
      expect(sample.isValid).toBe(false);
      expect(sample.invalidReason).toBe('invalid_timing_order');
    });

    it('flags invalid header resolution timing order as invalid', () => {
      const clientSample: RequestTimingSample = {
        reqId: 'bad-header',
        kind: 'ballot',
        status: 200,
        clientStart: 1000,
        headersResolved: 950, // before clientStart
        clientBodyConsumed: 1200,
        totalClientMs: 200,
      };

      const serverRecord: ServerTimingRecord = {
        serverIngress: 1020,
        serverFinish: 1100,
        durationMs: 80,
        statusCode: 200,
      };

      const sample = correlateRequestSample(clientSample, serverRecord);
      expect(sample.isValid).toBe(false);
      expect(sample.invalidReason).toBe('invalid_header_timing_order');
    });
  });

  describe('computeCorrelatedSegmentSummary and independent p95 subtraction comparison', () => {
    it('demonstrates mathematically why independent p95 subtraction is wrong', () => {
      // Synthetic population of requests where request A has high pre-ingress and low server processing,
      // and request B has low pre-ingress and high server processing.
      //
      // Req 1: clientStart: 0, serverIngress: 800, serverFinish: 900, clientBodyConsumed: 950
      //        preIngress = 800, serverProcessing = 100, postFinish = 50, totalClient = 950
      //
      // Req 2: clientStart: 0, serverIngress: 100, serverFinish: 900, clientBodyConsumed: 950
      //        preIngress = 100, serverProcessing = 800, postFinish = 50, totalClient = 950
      //
      // For both requests: total client = 950. So client p95 = 950.
      // Server processing durations: [100, 800]. Server p95 = 800.
      //
      // If one naively calculates: client_p95 - server_p95 = 950 - 800 = 150.
      // BUT the actual per-request gaps are:
      // Req 1 gap: 950 - 100 = 850.
      // Req 2 gap: 950 - 800 = 150.
      // Gaps: [150, 850]. The true gap p95 is 850!
      // Naive subtraction (150) dramatically understates the true gap p95 (850).
      //
      // Furthermore, preIngress values are: [100, 800]. Pre-ingress p95 = 800!
      // Server processing p95 = 800!
      // If someone added pre-ingress p95 (800) + server p95 (800) + post-finish p95 (50) = 1650, which > 950!
      // This proves that independent percentiles cannot be added or subtracted.
      // Each segment must percentile its own population.

      const clients: RequestTimingSample[] = [
        {
          reqId: 'req-1',
          kind: 'ballot',
          status: 200,
          clientStart: 0,
          headersResolved: 850,
          clientBodyConsumed: 950,
          totalClientMs: 950,
        },
        {
          reqId: 'req-2',
          kind: 'ballot',
          status: 200,
          clientStart: 0,
          headersResolved: 850,
          clientBodyConsumed: 950,
          totalClientMs: 950,
        },
      ];

      const servers = new Map<string, ServerTimingRecord>([
        ['req-1', { serverIngress: 800, serverFinish: 900, durationMs: 100, statusCode: 200 }],
        ['req-2', { serverIngress: 100, serverFinish: 900, durationMs: 800, statusCode: 200 }],
      ]);

      const summary = computeCorrelatedSegmentSummary(clients, servers);

      expect(summary.client_count).toBe(2);
      expect(summary.matched_count).toBe(2);
      expect(summary.unmatched_count).toBe(0);
      expect(summary.invalid_count).toBe(0);

      expect(summary.client_p95_ms).toBe(950);
      expect(summary.server_p95_ms).toBe(800);

      // Independent subtraction would give 950 - 800 = 150
      const naiveSubtractedP95 = summary.client_p95_ms - summary.server_p95_ms;
      expect(naiveSubtractedP95).toBe(150);

      // The true per-request gap p95 is 850, NOT 150!
      expect(summary.gap_p95_ms).toBe(850);
      expect(summary.gap_p95_ms).not.toBe(naiveSubtractedP95);

      // And each segment percentiles its own population:
      expect(summary.pre_ingress!.p95_ms).toBe(800);
      expect(summary.server_processing!.p95_ms).toBe(800);
      expect(summary.post_finish!.p95_ms).toBe(50);
    });

    it('handles mixed valid, unmatched, and invalid samples gracefully', () => {
      const clients: RequestTimingSample[] = [
        // Valid
        { reqId: 'ok-1', kind: 'ballot', status: 200, clientStart: 100, clientBodyConsumed: 300, totalClientMs: 200 },
        // Unmatched
        { reqId: 'missing', kind: 'ballot', status: 200, clientStart: 100, clientBodyConsumed: 300, totalClientMs: 200 },
        // Invalid order
        { reqId: 'inverted', kind: 'ballot', status: 200, clientStart: 500, clientBodyConsumed: 600, totalClientMs: 100 },
      ];

      const servers = new Map<string, ServerTimingRecord>([
        ['ok-1', { serverIngress: 150, serverFinish: 250, durationMs: 100, statusCode: 200 }],
        ['inverted', { serverIngress: 400, serverFinish: 450, durationMs: 50, statusCode: 200 }], // ingress < start
      ]);

      const summary = computeCorrelatedSegmentSummary(clients, servers);
      expect(summary.client_count).toBe(3);
      expect(summary.matched_count).toBe(2);
      expect(summary.unmatched_count).toBe(1);
      expect(summary.invalid_count).toBe(1);

      // Only ok-1 is in the valid segment population
      expect(summary.pre_ingress!.p95_ms).toBe(50); // 150 - 100
      expect(summary.server_processing!.p95_ms).toBe(100); // 250 - 150
      expect(summary.post_finish!.p95_ms).toBe(50); // 300 - 250
      expect(summary.gap_p95_ms).toBe(100); // 200 - 100
    });
  });

  describe('correlateRequestSample with duration-only samples (child_process mode)', () => {
    it('correlates valid duration-only sample and marks sub-intervals null', () => {
      const clientSample: RequestTimingSample = {
        reqId: 'req-child-1',
        kind: 'ballot',
        status: 200,
        totalClientMs: 250,
      };

      const serverRecord: ServerTimingRecord = {
        serverIngress: 1050,
        serverPrefinish: 1150,
        serverFinish: 1180,
        durationMs: 130,
        statusCode: 200,
      };

      const sample = correlateRequestSample(clientSample, serverRecord);
      expect(sample.isValid).toBe(true);
      expect(sample.preIngressMs).toBeUndefined();
      expect(sample.serverProcessingMs).toBeUndefined();
      expect(sample.postFinishMs).toBeUndefined();
      expect(sample.headersResolvedMs).toBeUndefined();
      expect(sample.bodyTransferMs).toBeUndefined();
      expect(sample.totalClientMs).toBe(250);
      expect(sample.serverDurationMs).toBe(130);
      expect(sample.gapMs).toBe(120); // 250 - 130
    });

    it('accepts duration-only sample between prefinish and finish as valid with negative gap', () => {
      // serverIngress = 1000, serverPrefinish = 1100 (100ms), serverFinish = 1200 (200ms)
      // client duration = 150ms: >= 100ms (prefinish) but < 200ms (finish) -> gap = -50ms
      const clientSample: RequestTimingSample = {
        reqId: 'req-child-neg-gap-valid',
        kind: 'ballot',
        status: 200,
        totalClientMs: 150,
      };

      const serverRecord: ServerTimingRecord = {
        serverIngress: 1000,
        serverPrefinish: 1100,
        serverFinish: 1200,
        durationMs: 200,
        statusCode: 200,
      };

      const sample = correlateRequestSample(clientSample, serverRecord);
      expect(sample.isValid).toBe(true);
      expect(sample.gapMs).toBe(-50);
      expect(sample.totalClientMs).toBe(150);
      expect(sample.serverDurationMs).toBe(200);
    });

    it('keeps finish-based p95 and counts a between-events sample in the valid population', () => {
      const request: RequestTimingSample = {
        reqId: 'private-timing-request', kind: 'overview', status: 200, totalClientMs: 150,
      };
      const timing: ServerTimingRecord = {
        serverIngress: 1000, serverPrefinish: 1100, serverFinish: 1200,
        durationMs: 200, statusCode: 200,
      };
      const summary = computeCorrelatedSegmentSummary([request], new Map([[request.reqId, timing]]));
      expect(summary.invalid_count).toBe(0);
      expect(summary.matched_count).toBe(1);
      expect(summary.server_p95_ms).toBe(200);
      expect(summary.gap_p95_ms).toBe(-50);
      expect(JSON.stringify(summary)).not.toContain(request.reqId);
    });

    it('rejects duration-only sample when totalClientMs < ingress-to-prefinish', () => {
      // serverIngress = 1000, serverPrefinish = 1100 (100ms), serverFinish = 1200 (200ms)
      // client duration = 50ms < 100ms -> invalid
      const clientSample: RequestTimingSample = {
        reqId: 'req-child-skewed',
        kind: 'ballot',
        status: 200,
        totalClientMs: 50,
      };

      const serverRecord: ServerTimingRecord = {
        serverIngress: 1000,
        serverPrefinish: 1100,
        serverFinish: 1200,
        durationMs: 200,
        statusCode: 200,
      };

      const sample = correlateRequestSample(clientSample, serverRecord);
      expect(sample.isValid).toBe(false);
      expect(sample.invalidReason).toBe('client_shorter_than_server');
    });

    it('accepts duration-only sample on zero-gap boundary (totalClientMs === serverDurationMs)', () => {
      const clientSample: RequestTimingSample = {
        reqId: 'req-child-zero-gap',
        kind: 'ballot',
        status: 200,
        totalClientMs: 200,
      };

      const serverRecord: ServerTimingRecord = {
        serverIngress: 1000,
        serverPrefinish: 1150,
        serverFinish: 1200,
        durationMs: 200,
        statusCode: 200,
      };

      const sample = correlateRequestSample(clientSample, serverRecord);
      expect(sample.isValid).toBe(true);
      expect(sample.gapMs).toBe(0);
      expect(sample.totalClientMs).toBe(200);
      expect(sample.serverDurationMs).toBe(200);
    });

    it('rejects duration-only sample when prefinish is missing or non-finite', () => {
      const clientSample: RequestTimingSample = {
        reqId: 'req-child-bad-prefinish',
        kind: 'ballot',
        status: 200,
        totalClientMs: 150,
      };

      const missingPrefinish: ServerTimingRecord = {
        serverIngress: 1000,
        serverFinish: 1200,
        durationMs: 200,
        statusCode: 200,
      };
      expect(correlateRequestSample(clientSample, missingPrefinish)).toEqual(
        expect.objectContaining({ isValid: false, invalidReason: 'non_finite_timing_value' })
      );

      const nanPrefinish: ServerTimingRecord = {
        serverIngress: 1000,
        serverPrefinish: Number.NaN,
        serverFinish: 1200,
        durationMs: 200,
        statusCode: 200,
      };
      expect(correlateRequestSample(clientSample, nanPrefinish)).toEqual(
        expect.objectContaining({ isValid: false, invalidReason: 'non_finite_timing_value' })
      );
    });

    it('rejects duration-only sample when prefinish order is reversed (prefinish < ingress or prefinish > finish)', () => {
      const clientSample: RequestTimingSample = {
        reqId: 'req-child-reversed-prefinish',
        kind: 'ballot',
        status: 200,
        totalClientMs: 150,
      };

      const prefinishBeforeIngress: ServerTimingRecord = {
        serverIngress: 1000,
        serverPrefinish: 900,
        serverFinish: 1200,
        durationMs: 200,
        statusCode: 200,
      };
      expect(correlateRequestSample(clientSample, prefinishBeforeIngress)).toEqual(
        expect.objectContaining({ isValid: false, invalidReason: 'invalid_timing_order' })
      );

      const prefinishAfterFinish: ServerTimingRecord = {
        serverIngress: 1000,
        serverPrefinish: 1250,
        serverFinish: 1200,
        durationMs: 200,
        statusCode: 200,
      };
      expect(correlateRequestSample(clientSample, prefinishAfterFinish)).toEqual(
        expect.objectContaining({ isValid: false, invalidReason: 'invalid_timing_order' })
      );
    });

    it('rejects duration-only sample when server duration is inconsistent with finish - ingress', () => {
      const clientSample: RequestTimingSample = {
        reqId: 'req-child-inconsistent',
        kind: 'ballot',
        status: 200,
        totalClientMs: 150,
      };

      const inconsistentServer: ServerTimingRecord = {
        serverIngress: 1000,
        serverPrefinish: 1100,
        serverFinish: 1200,
        durationMs: 250, // finish - ingress is 200, difference 50 > 0.5ms tolerance
        statusCode: 200,
      };

      expect(correlateRequestSample(clientSample, inconsistentServer)).toEqual(
        expect.objectContaining({ isValid: false, invalidReason: 'inconsistent_server_duration' })
      );
    });

    it('rejects duration-only sample when status codes mismatch', () => {
      const clientSample: RequestTimingSample = {
        reqId: 'req-child-mismatch',
        kind: 'ballot',
        status: 200,
        totalClientMs: 200,
      };

      const serverRecord: ServerTimingRecord = {
        serverIngress: 1000,
        serverPrefinish: 1050,
        serverFinish: 1100,
        durationMs: 100,
        statusCode: 500,
      };

      const sample = correlateRequestSample(clientSample, serverRecord);
      expect(sample.isValid).toBe(false);
      expect(sample.invalidReason).toBe('status_code_mismatch');
    });

    it('computes summary with null decomposition percentiles for duration-only samples', () => {
      const clientSamples: RequestTimingSample[] = [
        { reqId: 'c-1', kind: 'overview', status: 200, totalClientMs: 100 },
        { reqId: 'c-2', kind: 'overview', status: 200, totalClientMs: 200 },
      ];

      const serverTimings = new Map<string, ServerTimingRecord>([
        ['c-1', { serverIngress: 10, serverPrefinish: 40, serverFinish: 50, durationMs: 40, statusCode: 200 }],
        ['c-2', { serverIngress: 60, serverPrefinish: 120, serverFinish: 140, durationMs: 80, statusCode: 200 }],
      ]);

      const summary = computeCorrelatedSegmentSummary(clientSamples, serverTimings);
      expect(summary.client_count).toBe(2);
      expect(summary.matched_count).toBe(2);
      expect(summary.unmatched_count).toBe(0);
      expect(summary.invalid_count).toBe(0);

      // Total and gap metrics are populated
      expect(summary.client_p95_ms).toBe(200);
      expect(summary.server_p95_ms).toBe(80);
      expect(summary.gap_p95_ms).toBe(120); // max gap is 200 - 80 = 120

      // Decomposition segments are null, NOT zero objects
      expect(summary.pre_ingress).toBeNull();
      expect(summary.server_processing).toBeNull();
      expect(summary.post_finish).toBeNull();
      expect(summary.headers_resolved).toBeNull();
      expect(summary.body_transfer).toBeNull();
    });

    it('reconciles invalid_reason_counts with invalid_count and unmatched_count across clean, negative-gap, status-mismatch, and unmatched samples', () => {
      // Clean sample
      const cleanSample: RequestTimingSample = {
        reqId: 'req-clean',
        kind: 'overview',
        status: 200,
        totalClientMs: 150,
      };
      // Negative-gap duration-only sample (client shorter than server prefinish)
      const negativeGapSample: RequestTimingSample = {
        reqId: 'req-neg-gap',
        kind: 'ballot',
        status: 200,
        totalClientMs: 80,
      };
      // Status code mismatch sample
      const statusMismatchSample: RequestTimingSample = {
        reqId: 'req-status-mismatch',
        kind: 'overview',
        status: 200,
        totalClientMs: 120,
      };
      // Unmatched sample (no server timing record present)
      const unmatchedSample: RequestTimingSample = {
        reqId: 'req-unmatched',
        kind: 'ballot',
        status: 200,
        totalClientMs: 90,
      };

      const serverTimings = new Map<string, ServerTimingRecord>([
        ['req-clean', { serverIngress: 100, serverPrefinish: 160, serverFinish: 180, durationMs: 80, statusCode: 200 }],
        ['req-neg-gap', { serverIngress: 200, serverPrefinish: 300, serverFinish: 350, durationMs: 150, statusCode: 200 }], // client 80 < prefinish (100) < server (150)
        ['req-status-mismatch', { serverIngress: 400, serverPrefinish: 440, serverFinish: 450, durationMs: 50, statusCode: 500 }], // client 200 !== server 500
      ]);

      const clientSamples = [cleanSample, negativeGapSample, statusMismatchSample, unmatchedSample];
      const summary = computeCorrelatedSegmentSummary(clientSamples, serverTimings);

      expect(summary.client_count).toBe(4);
      expect(summary.matched_count).toBe(3);
      expect(summary.unmatched_count).toBe(1);
      expect(summary.invalid_count).toBe(2);

      // Verify static keys are all present and no arbitrary/dynamic keys leak
      const expectedKeys: InvalidTimingReason[] = [
        ...KNOWN_INVALID_TIMING_REASONS,
        'unknown_invalid_reason',
      ];
      expect(Object.keys(summary.invalid_reason_counts).sort()).toEqual([...expectedKeys].sort());

      // Verify specific counts
      expect(summary.invalid_reason_counts.client_shorter_than_server).toBe(1);
      expect(summary.invalid_reason_counts.status_code_mismatch).toBe(1);
      expect(summary.invalid_reason_counts.unmatched_server_timing).toBe(1);
      expect(summary.invalid_reason_counts.unknown_invalid_reason).toBe(0);
      expect(summary.invalid_reason_counts.non_finite_timing_value).toBe(0);
      expect(summary.invalid_reason_counts.negative_duration).toBe(0);
      expect(summary.invalid_reason_counts.inconsistent_client_duration).toBe(0);
      expect(summary.invalid_reason_counts.inconsistent_server_duration).toBe(0);
      expect(summary.invalid_reason_counts.invalid_timing_order).toBe(0);
      expect(summary.invalid_reason_counts.invalid_header_timing_order).toBe(0);

      // Reconcile: unmatched_count equals unmatched_server_timing
      expect(summary.invalid_reason_counts.unmatched_server_timing).toBe(summary.unmatched_count);

      // Reconcile: sum of matched invalid reason counts equals invalid_count
      const matchedInvalidSum = Object.entries(summary.invalid_reason_counts)
        .filter(([key]) => key !== 'unmatched_server_timing')
        .reduce((sum, [, count]) => sum + count, 0);
      expect(matchedInvalidSum).toBe(summary.invalid_count);
    });

    it('reports all zeros for invalid_reason_counts in a completely clean group', () => {
      const cleanSamples: RequestTimingSample[] = [
        { reqId: 'c-1', kind: 'overview', status: 200, totalClientMs: 100 },
        { reqId: 'c-2', kind: 'ballot', status: 200, totalClientMs: 120 },
      ];

      const serverTimings = new Map<string, ServerTimingRecord>([
        ['c-1', { serverIngress: 10, serverPrefinish: 40, serverFinish: 50, durationMs: 40, statusCode: 200 }],
        ['c-2', { serverIngress: 60, serverPrefinish: 120, serverFinish: 140, durationMs: 80, statusCode: 200 }],
      ]);

      const summary = computeCorrelatedSegmentSummary(cleanSamples, serverTimings);
      expect(summary.client_count).toBe(2);
      expect(summary.matched_count).toBe(2);
      expect(summary.unmatched_count).toBe(0);
      expect(summary.invalid_count).toBe(0);

      for (const count of Object.values(summary.invalid_reason_counts)) {
        expect(count).toBe(0);
      }
    });

    it('preserves finish-based server p95 and max when client has negative finish gap', () => {
      // Two requests:
      // req-1: ingress: 0, prefinish: 80, finish: 100 (server duration 100), client: 90 -> valid, negative gap -10
      // req-2: ingress: 0, prefinish: 160, finish: 200 (server duration 200), client: 180 -> valid, negative gap -20
      const clients: RequestTimingSample[] = [
        { reqId: 'req-1', kind: 'overview', status: 200, totalClientMs: 90 },
        { reqId: 'req-2', kind: 'overview', status: 200, totalClientMs: 180 },
      ];

      const servers = new Map<string, ServerTimingRecord>([
        ['req-1', { serverIngress: 0, serverPrefinish: 80, serverFinish: 100, durationMs: 100, statusCode: 200 }],
        ['req-2', { serverIngress: 0, serverPrefinish: 160, serverFinish: 200, durationMs: 200, statusCode: 200 }],
      ]);

      const summary = computeCorrelatedSegmentSummary(clients, servers);
      expect(summary.matched_count).toBe(2);
      expect(summary.invalid_count).toBe(0);
      // Server p95/max must be based on finish duration (200), NEVER prefinish (160)
      expect(summary.server_p95_ms).toBe(200);
      expect(summary.server_max_ms).toBe(200);
      expect(summary.matched_server_p95_ms).toBe(200);
      expect(summary.matched_server_max_ms).toBe(200);
      expect(summary.gap_p50_ms).toBe(-20);
      expect(summary.gap_p95_ms).toBe(-10);
    });
  });

  describe('assertCapacityPopulationIntegrity (acceptance contract)', () => {
    it('passes when unmatched_count and invalid_count are both zero', () => {
      expect(() => {
        assertCapacityPopulationIntegrity([
          { name: 'all_reads', unmatched_count: 0, invalid_count: 0 },
          { name: 'all_ballots', unmatched_count: 0, invalid_count: 0 },
        ]);
      }).not.toThrow();
    });

    it('throws with clear descriptive message when invalid_count > 0', () => {
      expect(() => {
        assertCapacityPopulationIntegrity([
          { name: 'all_reads', unmatched_count: 0, invalid_count: 0 },
          { name: 'all_ballots', unmatched_count: 0, invalid_count: 2 },
        ]);
      }).toThrow('Integrity check failed: all_ballots group had 2 invalid timing samples');
    });

    it('throws with clear descriptive message when unmatched_count > 0', () => {
      expect(() => {
        assertCapacityPopulationIntegrity([
          { name: 'all_reads', unmatched_count: 1, invalid_count: 0 },
          { name: 'all_ballots', unmatched_count: 0, invalid_count: 0 },
        ]);
      }).toThrow('Integrity check failed: all_reads group had 1 unmatched timing samples');
    });
  });
});
