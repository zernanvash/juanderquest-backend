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
adminSettingsRouter.get(
  '/admin/settings',
  authenticateToken,
  requireAdmin,
  async (_req: AuthRequest, res: Response) => {
    try {
      const snapshot = await service.getSettings();
      return res.status(200).json({ success: true, data: snapshot });
    } catch (error) {
      return settingsError(res, error);
    }
  },
);

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
  },
);

// GET /api/v1/admin/settings/audit - Settings-only audit feed (not universal history)
adminSettingsRouter.get(
  '/admin/settings/audit',
  authenticateToken,
  requireAdmin,
  async (req: AuthRequest, res: Response) => {
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
  },
);

// GET /api/v1/admin/system/status - Read-only effective state; never secret-bearing
adminSettingsRouter.get(
  '/admin/system/status',
  authenticateToken,
  requireAdmin,
  async (_req: AuthRequest, res: Response) => {
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
        deployment_note:
          'Deployment-owned values are read-only in the browser. Signing keys, database URLs, tunnel hosts and mailer credentials are never exposed.',
      },
    });
  },
);

// GET /api/v1/admin/mobile-app/overview - Aggregate release, device build distribution, push 7d, opt-in rates
adminSettingsRouter.get(
  '/admin/mobile-app/overview',
  authenticateToken,
  requireAdmin,
  async (_req: AuthRequest, res: Response) => {
    const pool = getPool();
    if (!pool) {
      return res.status(503).json({
        success: false,
        error: { code: 'STORAGE_UNAVAILABLE', message: 'PostgreSQL is required for mobile app telemetry.' },
      });
    }
    const versionData = getLatestAppVersion();
    const latestBuild = Number(versionData.buildNumber ?? versionData.versionCode ?? 1);
    const settingsSnapshot = await service.getSettings();

    const [{ rows: deviceRows }, { rows: pushRows }, { rows: prefRows }] = await Promise.all([
      pool.query(
        `SELECT COALESCE(app_build, 0)::int AS app_build,
                COUNT(*)::int AS devices,
                COUNT(*) FILTER (WHERE last_seen_at >= NOW() - INTERVAL '7 days')::int AS active_7d,
                COUNT(*) FILTER (WHERE last_seen_at >= NOW() - INTERVAL '30 days')::int AS active_30d
         FROM user_devices
         WHERE disabled_at IS NULL
         GROUP BY COALESCE(app_build, 0)
         ORDER BY app_build DESC`,
      ),
      pool.query(
        `SELECT category,
                COUNT(*) FILTER (WHERE status = 'sent')::int AS sent,
                COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
                COUNT(*) FILTER (WHERE status = 'skipped')::int AS skipped,
                COUNT(*)::int AS total
         FROM push_deliveries
         WHERE is_test = FALSE AND created_at >= NOW() - INTERVAL '7 days'
         GROUP BY category
         ORDER BY category`,
      ),
      pool.query(
        `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE push_overtaken)::int AS overtaken,
                COUNT(*) FILTER (WHERE push_friend_activity)::int AS friend_activity,
                COUNT(*) FILTER (WHERE push_social)::int AS social,
                COUNT(*) FILTER (WHERE push_weekly_recap)::int AS weekly_recap,
                COUNT(*) FILTER (WHERE quiet_hours)::int AS quiet_hours
         FROM user_notification_preferences`,
      ),
    ]);

    const totalDevices = deviceRows.reduce((sum: number, r: any) => sum + Number(r.devices || 0), 0);
    const active7d = deviceRows.reduce((sum: number, r: any) => sum + Number(r.active_7d || 0), 0);
    const active30d = deviceRows.reduce((sum: number, r: any) => sum + Number(r.active_30d || 0), 0);
    const onLatestCount = deviceRows
      .filter((r: any) => Number(r.app_build) >= latestBuild)
      .reduce((sum: number, r: any) => sum + Number(r.devices || 0), 0);
    const onLatestPct = totalDevices > 0 ? Math.round((onLatestCount / totalDevices) * 1000) / 10 : 0;

    const pRow = prefRows[0] ?? {};
    const prefTotal = Number(pRow.total ?? 0);
    const pct = (count: number) => (prefTotal > 0 ? Math.round((count / prefTotal) * 1000) / 10 : 0);

    const minSupportedBuild = Number(settingsSnapshot.values.app_min_supported_build ?? 1);
    const announcementText = String(settingsSnapshot.values.app_announcement_text ?? '').trim();
    const announcementSeverity =
      settingsSnapshot.values.app_announcement_severity === 'warning' ? 'warning' : 'info';
    const announcementUntil = String(settingsSnapshot.values.app_announcement_until ?? '').trim();

    return res.status(200).json({
      success: true,
      data: {
        observed_at: new Date().toISOString(),
        version: {
          version_name: versionData.versionName,
          version_code: versionData.versionCode,
          build_number: latestBuild,
          commit_hash: versionData.commitHash,
          changelog: versionData.changelog,
          download_url: versionData.downloadUrl,
          published_at: versionData.publishedAt,
        },
        devices: {
          total_registered: totalDevices,
          active_7d: active7d,
          active_30d: active30d,
          latest_build: latestBuild,
          on_latest_count: onLatestCount,
          on_latest_pct: onLatestPct,
          by_build: deviceRows.map((r: any) => ({
            app_build: Number(r.app_build),
            devices: Number(r.devices),
            active_7d: Number(r.active_7d),
            active_30d: Number(r.active_30d),
          })),
        },
        push_7d: {
          by_category: pushRows.map((r: any) => ({
            category: r.category,
            sent: Number(r.sent),
            failed: Number(r.failed),
            skipped: Number(r.skipped),
            total: Number(r.total),
          })),
          totals: {
            sent: pushRows.reduce((s: number, r: any) => s + Number(r.sent || 0), 0),
            failed: pushRows.reduce((s: number, r: any) => s + Number(r.failed || 0), 0),
            skipped: pushRows.reduce((s: number, r: any) => s + Number(r.skipped || 0), 0),
          },
        },
        notification_preferences: {
          total_profiles: prefTotal,
          rates: {
            overtaken_pct: pct(Number(pRow.overtaken ?? 0)),
            friend_activity_pct: pct(Number(pRow.friend_activity ?? 0)),
            social_pct: pct(Number(pRow.social ?? 0)),
            weekly_recap_pct: pct(Number(pRow.weekly_recap ?? 0)),
            quiet_hours_pct: pct(Number(pRow.quiet_hours ?? 0)),
          },
        },
        settings: {
          revision: settingsSnapshot.revision,
          app_min_supported_build: minSupportedBuild,
          app_announcement_text: announcementText,
          app_announcement_severity: announcementSeverity,
          app_announcement_until: announcementUntil,
        },
      },
    });
  },
);

export default adminSettingsRouter;
