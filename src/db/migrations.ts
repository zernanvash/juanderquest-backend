import type { Pool } from 'pg';
import { createHash } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

// This module intentionally does not import `config/env.ts`: migration tooling
// (scripts/db-migrate.ts, the test harness) must be able to run against a
// database without the full runtime configuration being valid.
// Normal app builds live under dist/db; isolated simulation builds include
// scripts and live under dist-simulation/src/db. Both must read the same
// checked-in migrations rather than a copied or stale artifact.
const candidateRoot = join(__dirname, '..', '..');
const rootDir = existsSync(join(candidateRoot, 'migrations'))
  ? candidateRoot : join(candidateRoot, '..');

export const MIGRATIONS = [
  '001_init.sql',
  '002_runtime.sql',
  '003_spot_discovery.sql',
  '004_spot_photos.sql',
  '005_crowd_diversion.sql',
  '006_web_analytics.sql',
  '007_public_profiles.sql',
  '008_user_follows.sql',
  '009_synthetic_qa_isolation.sql',
  '010_redemptions_user_voucher_unique.sql',
  '011_governance_ledger.sql',
  '012_qa_evaluator_role.sql',
  '013_progression_identity_foundation.sql',
  '014_progression_hardening_and_retrofits.sql',
  '015_progression_legacy_013_upgrade.sql',
  '016_juanchoice_pilot.sql',
  '017_juanchoice_supporter_quest.sql',
  '018_juanchoice_retention_foundation.sql',
  '019_juanchoice_partnerships_and_budget_guardrails.sql',
  '020_juanchoice_monthly_schedules.sql',
  '021_juanchoice_unverified_offer_quarantine.sql',
  '022_juanchoice_unfunded_budget_quarantine.sql',
  '023_juanchoice_promotion_assessments.sql',
  '024_user_wallet_binding.sql',
  '025_seed_pangasinan_discovery_spots.sql',
  '026_destination_author_quest_progression.sql',
  '027_merchant_affiliate_applications.sql',
  '028_economic_backbone.sql',
  '029_economic_ledger_integrity.sql',
  '030_economic_restricted_posting.sql',
  '031_economic_correction_invariants.sql',
  '032_economic_canonical_activity.sql',
  '033_economic_lifecycle_outbox.sql',
  '034_economic_cosmetic_refund.sql',
  '035_chain_indexer_reorg_safety.sql',
  '036_cultural_quizzes.sql',
  '037_unified_auth_foundation.sql',
  '038_pangasinan_real_photo_catalog.sql',
  '039_pangasinan_commons_photo_refresh.sql',
  '040_pangasinan_expanded_commons_photos.sql',
  '041_clear_unverified_stock_images.sql',
  '042_merchant_affiliation_and_dashboard.sql',
  '043_admin_settings.sql',
  '044_quest_step_evidence.sql',
  '045_quest_step_marker_codes.sql',
  '046_submissions_single_pending.sql',
  '047_submissions_challenge_nonce_unique.sql',
  '048_quest_attempts_single_completion.sql',
  '049_quest_funding.sql',
  '050_spot_visitor_fit.sql',
  '051_funding_notifications.sql',
  '052_plaza_social.sql',
  '053_plaza_push.sql',
  '055_trail_engine.sql',
  '056_admin_areas.sql',
  '057_admin_area_boundaries.sql',
];

// Stable arbitrary 32-bit key ("JDQ0") used to serialize concurrent boots so
// two processes cannot apply the same migration twice.
const MIGRATION_ADVISORY_LOCK_KEY = 0x4a445130;
const pgMemMigrationAdapters = new WeakSet<object>();

/** Mark pg-mem pools that need compatibility handling for unsupported SQL features. */
export function registerPgMemMigrationAdapter(pool: Pool): void {
  pgMemMigrationAdapters.add(pool as object);
}

function migrationChecksum(sql: string): string {
  return createHash('sha256').update(sql).digest('hex');
}

// Line endings are not migration history. Early ledgers (001-005) were recorded
// from a CRLF Windows checkout while .gitattributes now checks files out as LF,
// so a clean clone must still verify against them (2026-10-17 release rehearsal).
// Any other byte difference remains a mismatch.
export function migrationChecksumMatches(stored: string, sql: string): boolean {
  const lf = sql.replace(/\r\n/g, '\n');
  return [sql, lf, lf.replace(/\n/g, '\r\n')].some((variant) => migrationChecksum(variant) === stored);
}

// A restricted runtime must never attempt DDL or repair the ledger on boot.
// Deployment tooling applies migrations with the owner connection first; the
// application then verifies that the exact checked-in files are installed.
export async function verifyMigrations(pg: Pick<Pool, 'query'>): Promise<void> {
  const result = await pg.query('SELECT filename, checksum FROM schema_migrations');
  const applied = new Map<string, string | null>(
    result.rows.map((row) => [String(row.filename), row.checksum === null ? null : String(row.checksum)])
  );
  for (const file of MIGRATIONS) {
    const stored = applied.get(file);
    if (!stored) throw new Error(`Migration ${file} is missing or has no checksum; run the owner-only migration command first.`);
    const sql = readFileSync(join(rootDir, 'migrations', file), 'utf8');
    if (!migrationChecksumMatches(stored, sql)) throw new Error(`Migration ${file} checksum mismatch; runtime refuses altered migration history.`);
    applied.delete(file);
  }
  if (applied.size) throw new Error(`Database has unknown migrations: ${[...applied.keys()].sort().join(', ')}`);
}

// Applies pending migrations in filename order. One pooled client holds an
// advisory lock for the whole run; each migration commits atomically with its
// ledger row. A stored checksum that no longer matches the file on disk means
// an applied migration was edited and startup must refuse to continue.
export async function applyMigrations(pg: Pool) {
  await pg.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pg.query('ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum TEXT');

  const client = await pg.connect();
  let lockAcquired = false;
  try {
    try {
      await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_ADVISORY_LOCK_KEY]);
      lockAcquired = true;
    } catch (error) {
      // pg-mem and other limited engines do not implement advisory locks; the
      // ledger itself remains the backstop there.
      if (process.env.NODE_ENV !== 'test') {
        const reason = error instanceof Error ? error.message.split('\n')[0] : String(error);
        console.warn(`[db] Advisory lock unavailable; continuing without it. ${reason}`);
      }
    }

    for (const file of MIGRATIONS) {
      const sql = readFileSync(join(rootDir, 'migrations', file), 'utf8');
      const checksum = migrationChecksum(sql);

      const applied = await client.query('SELECT checksum FROM schema_migrations WHERE filename = $1', [file]);
      if (applied.rowCount) {
        const stored = applied.rows[0].checksum as string | null;
        if (stored && !migrationChecksumMatches(stored, sql)) {
          throw new Error(
            `Migration ${file} was modified after it was applied (checksum mismatch). ` +
            'Create a new forward migration instead of editing history.'
          );
        }
        if (!stored) {
          // Backfill checksums for ledgers written before checksums existed.
          await client.query('UPDATE schema_migrations SET checksum = $1 WHERE filename = $2', [checksum, file]);
        }
        continue;
      }

      try {
        await client.query('BEGIN');
        // pg-mem does not implement jsonb_array_elements or the correlated
        // UPDATE form used to reconcile historical submissions. Exercise the
        // production JSON backfill on PostgreSQL; keep the safety index active
        // in pg-mem so uniqueness behavior remains covered by unit tests.
        if (file === '045_quest_step_marker_codes.sql' && pgMemMigrationAdapters.has(pg as object)) {
          // Backfill uses PostgreSQL-only JSONB array operators.
        } else if (file === '046_submissions_single_pending.sql' && pgMemMigrationAdapters.has(pg as object)) {
          await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_submissions_unique_pending
            ON submissions(user_id, quest_id) WHERE status = 'pending'`);
        } else if (file === '048_quest_attempts_single_completion.sql' && pgMemMigrationAdapters.has(pg as object)) {
          await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_quest_attempts_single_completion
            ON quest_attempts(user_id, quest_id) WHERE status = 'completed'`);
        } else if (file === '051_funding_notifications.sql' && pgMemMigrationAdapters.has(pg as object)) {
          await client.query(`
            CREATE TABLE IF NOT EXISTS user_notifications (
              id TEXT PRIMARY KEY,
              user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
              event_key TEXT NOT NULL,
              kind TEXT NOT NULL,
              title TEXT NOT NULL,
              message TEXT NOT NULL,
              href TEXT NOT NULL,
              is_test BOOLEAN NOT NULL DEFAULT FALSE,
              created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
              read_at TIMESTAMPTZ,
              CONSTRAINT uq_user_notifications_event UNIQUE (user_id, event_key)
            );
            CREATE INDEX IF NOT EXISTS idx_user_notifications_owner_created ON user_notifications (user_id, created_at DESC, id DESC);
            CREATE INDEX IF NOT EXISTS idx_user_notifications_unread ON user_notifications (user_id, created_at DESC, id DESC);
          `);
        } else if (file === '052_plaza_social.sql' && pgMemMigrationAdapters.has(pg as object)) {
          await client.query(`
            ALTER TABLE users ADD COLUMN IF NOT EXISTS share_activity BOOLEAN NOT NULL DEFAULT TRUE;
            CREATE TABLE IF NOT EXISTS social_activities (
              id TEXT PRIMARY KEY,
              event_key TEXT NOT NULL,
              actor_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
              verb TEXT NOT NULL,
              subject_type TEXT NOT NULL,
              subject_id TEXT NOT NULL,
              subject_title TEXT NOT NULL,
              subject_href TEXT NOT NULL,
              municipality TEXT,
              payload JSONB NOT NULL DEFAULT '{}'::jsonb,
              cheer_count INTEGER NOT NULL DEFAULT 0,
              comment_count INTEGER NOT NULL DEFAULT 0,
              hidden_at TIMESTAMPTZ,
              hidden_reason TEXT,
              is_test BOOLEAN NOT NULL DEFAULT FALSE,
              created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
              CONSTRAINT uq_social_activities_event_key UNIQUE (event_key)
            );
            CREATE UNIQUE INDEX IF NOT EXISTS idx_social_activities_event_key ON social_activities (event_key);
            CREATE INDEX IF NOT EXISTS idx_social_activities_feed ON social_activities (is_test, created_at DESC, id DESC);
            CREATE INDEX IF NOT EXISTS idx_social_activities_actor ON social_activities (actor_id, created_at DESC, id DESC);
            CREATE INDEX IF NOT EXISTS idx_social_activities_town ON social_activities (municipality, created_at DESC);

            CREATE TABLE IF NOT EXISTS social_cheers (
              activity_id TEXT NOT NULL REFERENCES social_activities(id) ON DELETE CASCADE,
              user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
              is_test BOOLEAN NOT NULL DEFAULT FALSE,
              created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
              PRIMARY KEY (activity_id, user_id)
            );
            CREATE INDEX IF NOT EXISTS idx_social_cheers_user ON social_cheers (user_id, created_at DESC);

            CREATE TABLE IF NOT EXISTS social_comments (
              id TEXT PRIMARY KEY,
              activity_id TEXT NOT NULL REFERENCES social_activities(id) ON DELETE CASCADE,
              author_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
              body TEXT NOT NULL,
              idempotency_key TEXT NOT NULL,
              report_count INTEGER NOT NULL DEFAULT 0,
              deleted_at TIMESTAMPTZ,
              hidden_at TIMESTAMPTZ,
              hidden_by TEXT,
              is_test BOOLEAN NOT NULL DEFAULT FALSE,
              created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
              UNIQUE (author_id, idempotency_key)
            );
            CREATE INDEX IF NOT EXISTS idx_social_comments_thread ON social_comments (activity_id, created_at ASC, id ASC);

            CREATE TABLE IF NOT EXISTS social_comment_reports (
              comment_id TEXT NOT NULL REFERENCES social_comments(id) ON DELETE CASCADE,
              reporter_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
              reason TEXT NOT NULL,
              note TEXT,
              resolved_at TIMESTAMPTZ,
              resolved_by TEXT,
              resolution TEXT,
              is_test BOOLEAN NOT NULL DEFAULT FALSE,
              created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
              PRIMARY KEY (comment_id, reporter_id)
            );
            CREATE INDEX IF NOT EXISTS idx_social_comment_reports_comment ON social_comment_reports (comment_id);

            CREATE TABLE IF NOT EXISTS social_user_settings (
              user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
              share_activity BOOLEAN NOT NULL DEFAULT TRUE,
              updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );

            CREATE TABLE IF NOT EXISTS plaza_weekly_scores (
              week_start DATE NOT NULL,
              user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
              score INTEGER NOT NULL DEFAULT 0,
              quests INTEGER NOT NULL DEFAULT 0,
              home_town TEXT,
              rank INTEGER,
              prev_rank INTEGER,
              top10_announced BOOLEAN NOT NULL DEFAULT FALSE,
              is_test BOOLEAN NOT NULL DEFAULT FALSE,
              updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
              PRIMARY KEY (week_start, user_id)
            );
            CREATE INDEX IF NOT EXISTS idx_plaza_weekly_rank ON plaza_weekly_scores (week_start, is_test, rank);

            CREATE TABLE IF NOT EXISTS plaza_job_runs (
              job_key TEXT PRIMARY KEY,
              finished_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );

            INSERT INTO achievement_definitions (id, track, title, description, badge_icon, category, threshold, criteria_version)
            VALUES
              ('weekly_champion', 'explorer', 'Weekly Champion', 'Finished #1 on the Plaza weekly board.', '🏆', 'weekly', 1, 'v1'),
              ('weekly_podium',   'explorer', 'Weekly Podium',   'Finished #2 or #3 on the Plaza weekly board.', '🥈', 'weekly', 1, 'v1')
            ON CONFLICT (id) DO NOTHING;
          `);
        } else if (file === '053_plaza_push.sql' && pgMemMigrationAdapters.has(pg as object)) {
          await client.query(`
            CREATE TABLE IF NOT EXISTS user_devices (
              id TEXT PRIMARY KEY,
              user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
              token TEXT NOT NULL UNIQUE,
              platform TEXT NOT NULL,
              app_build INTEGER,
              created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
              last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
              disabled_at TIMESTAMPTZ,
              disabled_reason TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_user_devices_user ON user_devices (user_id);

            CREATE TABLE IF NOT EXISTS user_notification_preferences (
              user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
              push_overtaken BOOLEAN NOT NULL DEFAULT TRUE,
              push_friend_activity BOOLEAN NOT NULL DEFAULT TRUE,
              push_social BOOLEAN NOT NULL DEFAULT TRUE,
              push_weekly_recap BOOLEAN NOT NULL DEFAULT TRUE,
              quiet_hours BOOLEAN NOT NULL DEFAULT TRUE,
              updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );

            CREATE TABLE IF NOT EXISTS push_deliveries (
              id TEXT PRIMARY KEY,
              user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
              category TEXT NOT NULL,
              collapse_key TEXT NOT NULL,
              notification_id TEXT REFERENCES user_notifications(id) ON DELETE SET NULL,
              title TEXT NOT NULL,
              body TEXT NOT NULL,
              href TEXT NOT NULL,
              batch_count INTEGER NOT NULL DEFAULT 1,
              batch_names JSONB NOT NULL DEFAULT '[]'::jsonb,
              status TEXT NOT NULL DEFAULT 'queued',
              skip_reason TEXT,
              send_after TIMESTAMPTZ NOT NULL DEFAULT NOW(),
              attempts INTEGER NOT NULL DEFAULT 0,
              last_error TEXT,
              is_test BOOLEAN NOT NULL DEFAULT FALSE,
              created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
              sent_at TIMESTAMPTZ
            );
            CREATE UNIQUE INDEX IF NOT EXISTS uq_push_open_collapse ON push_deliveries (user_id, collapse_key) WHERE status = 'queued';
            CREATE INDEX IF NOT EXISTS idx_push_due ON push_deliveries (send_after) WHERE status = 'queued';
            CREATE INDEX IF NOT EXISTS idx_push_user_day ON push_deliveries (user_id, category, sent_at) WHERE status = 'sent';
          `);
        } else if (file === '056_admin_areas.sql' && pgMemMigrationAdapters.has(pg as object)) {
          await client.query(`
            CREATE TABLE IF NOT EXISTS admin_areas (
              id TEXT PRIMARY KEY,
              psgc_code BIGINT UNIQUE,
              level TEXT NOT NULL CHECK (level IN ('province','town','barangay')),
              name TEXT NOT NULL,
              display_name TEXT NOT NULL,
              parent_id TEXT REFERENCES admin_areas(id),
              osm_relation_id BIGINT,
              has_boundary BOOLEAN NOT NULL DEFAULT TRUE,
              label_lat DOUBLE PRECISION NOT NULL,
              label_lng DOUBLE PRECISION NOT NULL,
              bbox DOUBLE PRECISION[] NOT NULL,
              min_zoom SMALLINT NOT NULL DEFAULT 9,
              shape_file TEXT,
              data_version TEXT NOT NULL DEFAULT '2023-psa-namria',
              updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );
            CREATE INDEX IF NOT EXISTS idx_admin_areas_parent ON admin_areas (parent_id);
            CREATE INDEX IF NOT EXISTS idx_admin_areas_level ON admin_areas (level);
            CREATE INDEX IF NOT EXISTS idx_admin_areas_psgc ON admin_areas (psgc_code);

            ALTER TABLE spots ADD COLUMN IF NOT EXISTS town_area_id TEXT REFERENCES admin_areas(id);
            ALTER TABLE spots ADD COLUMN IF NOT EXISTS barangay_area_id TEXT REFERENCES admin_areas(id);

            CREATE INDEX IF NOT EXISTS idx_spots_town_area ON spots (town_area_id) WHERE status = 'published';
            CREATE INDEX IF NOT EXISTS idx_spots_barangay_area ON spots (barangay_area_id) WHERE status = 'published';
          `);
        } else {
          await client.query(sql);
        }
        await client.query('INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)', [file, checksum]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
  } finally {
    if (lockAcquired) {
      try {
        await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_ADVISORY_LOCK_KEY]);
      } catch {
        // The lock is session-scoped and is released when the client ends.
      }
    }
    client.release();
  }
}

export async function seedDevelopmentData(pg: Pick<Pool, 'query'>) {
  // The seed file is intentionally idempotent. Always replay it when local
  // seeding is enabled so a partially populated development database repairs
  // missing dependency rows (for example quests referenced by seeded spots).
  const seedSql = readFileSync(join(rootDir, 'seeds', 'development.sql'), 'utf8');
  await pg.query(seedSql);
}
