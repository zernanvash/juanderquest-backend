import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createCuoptSolver, buildCuoptRequest, CuoptError } from '../src/trails/solver/cuopt.js';
import type { TrailLegLookup, TrailProblem } from '../src/trails/types.js';

const problem: TrailProblem = {
  nodes: [
    { spotId: 'spot-a', value: 0.8, dwellMin: 30, windows: [[540, 720]], crowdByHour: Array(24).fill(0), category: 'beach' },
    { spotId: 'spot-b', value: 0.7, dwellMin: 30, windows: [], crowdByHour: Array(24).fill(0), category: 'heritage' },
  ],
  dayStartMin: 480, budgetMin: 240, minStops: 2, maxStops: 2, maxLegMin: 90, maxPerCategory: 2,
  mustInclude: [], exclude: [], weights: { crowdPenalty: 0.15, travelPenalty: 0.003 }, seed: 17,
};
const matrix: TrailLegLookup = (from, to) => from === to ? { minutes: 0, km: 0, approximate: false } : { minutes: 30, km: 9, approximate: false };

describe('cuOpt adapter (mock HTTP only)', () => {
  let server: Server;
  let baseUrl: string;
  let statusBaseUrl: string;

  async function serve(handler: (request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse) => void) {
    server = createServer(handler);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}/v1/nvidia/cuopt`;
    statusBaseUrl = `http://127.0.0.1:${port}/v1/status`;
  }

  afterEach(async () => { if (server?.listening) await new Promise<void>(resolve => server.close(() => resolve())); });

  test('maps the TrailProblem to OpenAPI field names and accepts 202 + NVCF-REQID poll success', async () => {
    let submitted: any;
    let pollCount = 0;
    await serve((req, res) => {
      if (req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
          submitted = JSON.parse(body);
          res.writeHead(202, { 'NVCF-REQID': '123e4567-e89b-12d3-a456-426614174000', 'content-type': 'application/json' });
          res.end('{}');
        });
      } else {
        pollCount++;
        expect(req.url).toContain('/123e4567-e89b-12d3-a456-426614174000');
        expect(req.headers['nvcf-reqid']).toBe('123e4567-e89b-12d3-a456-426614174000');
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ response: { solver_response: { status: 0, vehicle_data: { '0': { route: [0, 2, 1, 0] } } } } }));
      }
    });

    const mapped = buildCuoptRequest(problem, matrix);
    expect(mapped).toMatchObject({ action: 'cuOpt_OptimizedRouting', client_version: 'custom', parameters: {} });
    expect(mapped.data).toMatchObject({
      cost_matrix_data: { cost_matrix: { '0': expect.any(Array) } },
      travel_time_matrix_data: { cost_matrix: { '0': expect.any(Array) } },
      fleet_data: { vehicle_locations: [[0, 0]], vehicle_time_windows: [[28800, 43200]] },
      task_data: { task_locations: [1, 2], service_times: [1800, 1800], task_time_windows: [[32400, 43200], [28800, 43200]], prizes: [8000, 7000] },
    });

    const result = await createCuoptSolver({ baseUrl, statusBaseUrl, allowInsecureLocalhost: true, getApiKey: async () => 'mock-token', pollIntervalMs: 10 }).solve(problem, matrix);
    expect(result).toMatchObject({ feasible: true, solver: 'cuopt', totalKm: 9 });
    expect(result.objective).toBeCloseTo(1.5 - 0.003 * 30);
    expect(pollCount).toBe(1);
    expect(submitted.action).toBe('cuOpt_OptimizedRouting');
  });

  test('reports infeasible solver status without accepting a route', async () => {
    await serve((_req, res) => {
      res.writeHead(202, { 'NVCF-REQID': '123e4567-e89b-12d3-a456-426614174000' });
      res.end('{}');
    });
    const solver = createCuoptSolver({ baseUrl, statusBaseUrl, allowInsecureLocalhost: true, getApiKey: async () => 'mock-token', pollIntervalMs: 10,
      fetcher: async (input, init) => String(input).includes('/v1/status/')
        ? new Response(JSON.stringify({ response: { solver_response: { status: 1 } } }), { status: 200 })
        : fetch(input, init) });
    await expect(solver.solve(problem, matrix)).rejects.toMatchObject({ code: 'CUOPT_INFEASIBLE' });
  });

  test('fails closed when the asynchronous result remains pending at the 60-second budget', async () => {
    await serve((_req, res) => {
      res.writeHead(202, { 'NVCF-REQID': '123e4567-e89b-12d3-a456-426614174000' });
      res.end('{}');
    });
    const solver = createCuoptSolver({ baseUrl, statusBaseUrl, allowInsecureLocalhost: true, getApiKey: async () => 'mock-token', timeoutMs: 45, pollIntervalMs: 10 });
    await expect(solver.solve(problem, matrix)).rejects.toMatchObject({ code: 'CUOPT_TIMEOUT' });
  });

  test('rejects malformed submit or result payloads', async () => {
    await serve((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{not json'); });
    await expect(createCuoptSolver({ baseUrl, statusBaseUrl, allowInsecureLocalhost: true, getApiKey: async () => 'mock-token' }).solve(problem, matrix))
      .rejects.toMatchObject({ code: 'CUOPT_MALFORMED' });
  });

  test('does not run without both explicit feature opt-in and an injected test key', async () => {
    await serve(() => undefined);
    await expect(createCuoptSolver({ baseUrl, statusBaseUrl, allowInsecureLocalhost: true }).solve(problem, matrix))
      .rejects.toBeInstanceOf(CuoptError);
  });
});
