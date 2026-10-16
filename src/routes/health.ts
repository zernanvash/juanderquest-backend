import { Router } from 'express';
import {
  buildReadinessReport,
  defaultReadinessProbes,
  ReadinessProbes,
} from '../services/health.js';
import { isServiceReady, isServiceShuttingDown } from '../middleware/readiness.js';

const livenessResponse = () => ({
  status: 'ok' as const,
  timestamp: new Date().toISOString(),
  service: 'juanderquest-backend' as const,
});

export function createHealthRouter(probes: ReadinessProbes = defaultReadinessProbes): Router {
  const router = Router();

  // Backwards-compatible endpoint retained for existing load balancers/clients.
  router.get('/health', (_req, res) => {
    res.status(200).json(livenessResponse());
  });

  router.get('/health/live', (_req, res) => {
    res.status(200).json(livenessResponse());
  });

  router.get('/health/ready', async (_req, res) => {
    // Readiness must also reflect boot/drain state, otherwise monitors and the
    // mobile ConnectionMonitor see 'ready' while every API route answers 503.
    if (!isServiceReady()) {
      res.setHeader('Retry-After', '5');
      res.status(503).json({
        status: isServiceShuttingDown() ? 'restarting' : 'starting',
        ready: false,
        degraded: true,
        timestamp: new Date().toISOString(),
        service: 'juanderquest-backend',
      });
      return;
    }
    const report = await buildReadinessReport(probes);
    res.status(report.ready ? 200 : 503).json(report);
  });

  router.get('/ready', async (_req, res) => {
    // Readiness must also reflect boot/drain state, otherwise monitors and the
    // mobile ConnectionMonitor see 'ready' while every API route answers 503.
    if (!isServiceReady()) {
      res.setHeader('Retry-After', '5');
      res.status(503).json({
        status: isServiceShuttingDown() ? 'restarting' : 'starting',
        ready: false,
        degraded: true,
        timestamp: new Date().toISOString(),
        service: 'juanderquest-backend',
      });
      return;
    }
    const report = await buildReadinessReport(probes);
    res.status(report.ready ? 200 : 503).json(report);
  });

  return router;
}

export default createHealthRouter();
