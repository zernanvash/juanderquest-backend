import { Router, Response } from 'express';
import { z } from 'zod';
import { authenticateToken, requireAdmin, AuthRequest } from '../middleware/auth.js';
import { validateRequest } from '../middleware/validate.js';
import { ObservableRequest } from '../middleware/observability.js';
import { SettingsService, SettingsError } from '../settings/service.js';
import { buildReadinessReport } from '../services/health.js';
import { getLatestAppVersion } from './appVersion.js';
import { env } from '../config/env.js';
import { getPool, MIGRATIONS } from '../db/pool.js';

export const adminSettingsRouter = Router();
const service = new SettingsService();

const settingsError = (res: Response, error: unknown) => {
  if (error instanceof SettingsError) {
    return res.status(error.status).json({
      success: false,
      error: { code: error.code, message: error.message, ...(error.details ? { current: error.details } : {}) },
    });
  }
  return res.status(503).json({
    success: false,
    error: { code: 'STORAGE_UNAVAILABLE', message: 'Settings storage is unavailable. Please try again later.' },
  });
};

// GET /api/v1/admin/settings - Canonical values + explicit schema + revision
adminSettingsRouter.get('/admin/settings', authenticateToken, requireAdmin, async (_req: AuthRequest, res: Response) => {
  try {
    const snapshot = await service.getSettings();
    return res.status(200).json({ success: true, data: snapshot });
  } catch (error) {
    return settingsError(res, error);
  }
});

const updateSettingsSchema = z.object({
  body: z.object({
    expected_revision: z.number().int().min(0),
    changes: z.record(z.string(), z.unknown()),
    reason: z.string().trim().min(3).max(500).optional(),
  }),
});

// PUT /api/v1/admin/settings - Optimistic concurrency, validated allowlist, audited
adminSettingsRouter.put(
  '/admin/settings',
  authenticateToken,
  requireAdmin,
  validateRequest(updateSettingsSchema),
  async (req: AuthRequest & ObservableRequest, res: Response) => {
    try {
      const result = await service.updateSettings({
        changes: req.body.changes,
        expectedRevision: req.body.expected_revision,
        actorId: req.user!.id,
        reason: req.body.reason,
        requestId: req.id,
      });
      return res.status(200).json({ success: true, data: result });
    } catch (error) {
      return settingsError(res, error);
    }
  }
);

// GET /api/v1/admin/settings/audit - Settings-only audit feed (not universal history)
adminSettingsRouter.get('/admin/settings/audit', authenticateToken, requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const limit = Number(req.query.limit ?? 25);
    const entries = await service.listAudit(Number.isFinite(limit) ? limit : 25);
    return res.status(200).json({
      success: true,
      data: {
        scope: 'settings_only',
        entries,
      },
    });
  } catch (error) {
    return settingsError(res, error);
  }
});

// GET /api/v1/admin/system/status - Read-only effective state; never secret-bearing
adminSettingsRouter.get('/admin/system/status', authenticateToken, requireAdmin, async (_req: AuthRequest, res: Response) => {
  const readiness = await buildReadinessReport();
  const release = getLatestAppVersion();

  let migrationLedger: { applied: number | null; total: number; up_to_date: boolean | null } = {
    applied: null,
    total: MIGRATIONS.length,
    up_to_date: null,
  };
  const pool = getPool();
  if (pool) {
    try {
      const { rows } = await pool.query('SELECT COUNT(*)::int AS count FROM schema_migrations');
      const applied = Number(rows[0]?.count ?? 0);
      migrationLedger = { applied, total: MIGRATIONS.length, up_to_date: applied >= MIGRATIONS.length };
    } catch {
      migrationLedger = { applied: null, total: MIGRATIONS.length, up_to_date: null };
    }
  }

  return res.status(200).json({
    success: true,
    data: {
      observed_at: new Date().toISOString(),
      read_only: true,
      service: {
        status: readiness.status,
        ready: readiness.ready,
        degraded: readiness.degraded,
        dependencies: readiness.dependencies,
        checked_at: readiness.timestamp,
      },
      release: {
        version_name: release.versionName,
        version_code: release.versionCode,
        commit_hash: release.commitHash,
        published_at: release.publishedAt,
        update_policy: release.updatePolicy ?? 'optional',
        force_update: release.forceUpdate,
        min_supported_version_code: release.minSupportedVersionCode,
        channel: 'alpha',
      },
      runtime: {
        node_env: env.NODE_ENV,
        wallet_auth_mode: env.WALLET_AUTH_MODE,
        spot_photo_storage: env.SPOT_PHOTO_STORAGE,
        migration_ledger: migrationLedger,
      },
      // Sanitized effective boolean flags only; secret-bearing configuration is
      // structurally excluded from this projection.
      feature_flags: {
        progression_enabled: env.PROGRESSION_ENABLED,
        juanchoice_enabled: env.JUANCHOICE_ENABLED,
        juanchoice_writes_enabled: env.JUANCHOICE_WRITES_ENABLED,
        juanchoice_promotion_enabled: env.JUANCHOICE_PROMOTION_ENABLED,
        marketplace_enabled: env.MARKETPLACE_ENABLED,
        guest_login_enabled: env.GUEST_LOGIN_ENABLED,
        alpha_wallet_simulation_enabled: env.ALPHA_WALLET_SIMULATION_ENABLED,
        demo_login_allowed: env.ALLOW_DEMO_LOGIN,
      },
      deployment_note: 'Deployment-owned values are read-only in the browser. Signing keys, database URLs, tunnel hosts and mailer credentials are never exposed.',
    },
  });
});

export default adminSettingsRouter;
