-- Migration 112 (Plan 116 §5): index and constraint hygiene for the national launch DB.
-- Inputs came from an audit of the fully migrated schema (001-111) on PostgreSQL 17:
-- 98 foreign keys had no leading index; only the ones that matter at national scale are
-- indexed here (children of spots, growing user-generated tables, and tables touched by
-- retention deletes). Tiny admin/audit tables stay as they are.

-- Foreign keys whose parent rows get deleted or joined at scale.
CREATE INDEX IF NOT EXISTS idx_push_deliveries_notification ON push_deliveries (notification_id);   -- notification retention deletes
CREATE INDEX IF NOT EXISTS idx_merchants_spot ON merchants (spot_id);
CREATE INDEX IF NOT EXISTS idx_spot_photo_submissions_spot ON spot_photo_submissions (spot_id);
CREATE INDEX IF NOT EXISTS idx_spot_photo_submissions_asset ON spot_photo_submissions (asset_id);
CREATE INDEX IF NOT EXISTS idx_spot_reports_user ON spot_reports (user_id);
CREATE INDEX IF NOT EXISTS idx_avatar_reports_user ON avatar_reports (user_id);
CREATE INDEX IF NOT EXISTS idx_avatar_reports_reporter ON avatar_reports (reporter_id);
CREATE INDEX IF NOT EXISTS idx_bug_reports_user ON bug_reports (user_id);
CREATE INDEX IF NOT EXISTS idx_users_favorite_spot ON users (favorite_spot_id);
CREATE INDEX IF NOT EXISTS idx_economic_activity_scopes_spot ON economic_activity_scopes (destination_spot_id);
CREATE INDEX IF NOT EXISTS idx_juanchoice_supporter_claims_spot ON juanchoice_supporter_quest_claims (spot_id);
CREATE INDEX IF NOT EXISTS idx_juanchoice_supporter_claims_quest ON juanchoice_supporter_quest_claims (quest_id);
CREATE INDEX IF NOT EXISTS idx_trails_generation ON trails (generation_id);
CREATE INDEX IF NOT EXISTS idx_trail_checkins_trail_position ON trail_checkins (trail_id, position);
CREATE INDEX IF NOT EXISTS idx_suki_visits_program ON suki_visits (program_id);
CREATE INDEX IF NOT EXISTS idx_suki_rewards_program ON suki_rewards (program_id);
CREATE INDEX IF NOT EXISTS idx_verified_visits_binding ON verified_visits (binding_id);
CREATE INDEX IF NOT EXISTS idx_question_of_the_day_question ON question_of_the_day (question_id);
CREATE INDEX IF NOT EXISTS idx_quest_sponsorships_voucher ON quest_sponsorships (voucher_id);
CREATE INDEX IF NOT EXISTS idx_quest_funding_contributions_sponsorship ON quest_funding_contributions (sponsorship_id);

-- PGMEM_SKIP_BEGIN
-- Exact duplicate of the UNIQUE chain_block_headers_canonical_height (same keys and predicate).
DROP INDEX IF EXISTS chain_block_headers_canonical_lookup;

-- Append-only tables: tiny BRIN indexes for time-range scans and retention deletes.
CREATE INDEX IF NOT EXISTS brin_push_deliveries_created ON push_deliveries USING brin (created_at);
CREATE INDEX IF NOT EXISTS brin_user_notifications_created ON user_notifications USING brin (created_at);
CREATE INDEX IF NOT EXISTS brin_spot_activity_events_created ON spot_activity_events USING brin (created_at);
CREATE INDEX IF NOT EXISTS brin_spot_interactions_created ON spot_interactions USING brin (created_at);
CREATE INDEX IF NOT EXISTS brin_admin_audit_log_created ON admin_audit_log USING brin (created_at);
CREATE INDEX IF NOT EXISTS brin_outbox_events_created ON outbox_events USING brin (created_at);
CREATE INDEX IF NOT EXISTS brin_progression_events_created ON progression_events USING brin (created_at);

-- Hot append tables: vacuum/analyze sooner than the cluster default (stats went stale on the old cluster).
ALTER TABLE spot_activity_events SET (autovacuum_vacuum_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.01);
ALTER TABLE spot_interactions SET (autovacuum_vacuum_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.01);
ALTER TABLE push_deliveries SET (autovacuum_vacuum_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.01);
ALTER TABLE user_notifications SET (autovacuum_vacuum_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.01);
ALTER TABLE web_analytics_events SET (autovacuum_vacuum_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.01);
-- spots: the national import rewrites many rows at once; keep planner stats fresh.
ALTER TABLE spots SET (autovacuum_analyze_scale_factor = 0.01);

-- 084 added these CHECKs as NOT VALID so old data could not block the migration.
-- Validate whichever are still unvalidated (a fresh database passes trivially; a copy of
-- old data fails loudly here instead of hiding a bad row).
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT c.conrelid::regclass AS tbl, c.conname
      FROM pg_constraint c
     WHERE c.connamespace = (SELECT oid FROM pg_namespace WHERE nspname = current_schema())
       AND c.contype = 'c' AND NOT c.convalidated
       AND c.conname IN ('chk_spots_status', 'chk_spot_assets_status', 'chk_merchants_status',
                         'chk_merchant_memberships_role', 'chk_merchant_memberships_status',
                         'chk_auth_mail_outbox_status', 'chk_daily_missions_kind', 'chk_streak_shield_events_kind')
  LOOP
    EXECUTE format('ALTER TABLE %s VALIDATE CONSTRAINT %I', r.tbl, r.conname);
  END LOOP;
END $$;
-- PGMEM_SKIP_END
