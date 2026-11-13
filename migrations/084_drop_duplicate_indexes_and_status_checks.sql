-- Plan 85c (D2 + D5): Drop 8 duplicate non-unique/redundant indexes and add CHECK constraints on 8 status/kind columns.
-- NOT VALID: existing rows are not checked, so this cannot fail on old data; new writes are checked.
-- No governance_ledger.type CHECK: production holds historical types (quadratic_vote_cast, grant_allocated) that no current code writes.

DROP INDEX IF EXISTS idx_users_seed_id;
DROP INDEX IF EXISTS idx_admin_areas_psgc;
DROP INDEX IF EXISTS idx_social_activities_event_key;
DROP INDEX IF EXISTS idx_juanchoice_periods_recent;
DROP INDEX IF EXISTS idx_juanchoice_assessments_candidate_revision;
DROP INDEX IF EXISTS idx_cultural_quiz_versions_quiz;
DROP INDEX IF EXISTS idx_cultural_quiz_options_question;
DROP INDEX IF EXISTS idx_cultural_quiz_questions_version;

DO $$
DECLARE
  ns oid := (SELECT oid FROM pg_namespace WHERE nspname = current_schema());
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_spots_status' AND connamespace = ns) THEN
    ALTER TABLE spots ADD CONSTRAINT chk_spots_status
      CHECK (status IN ('published', 'needs_review', 'unpublished', 'approved', 'pending', 'rejected', 'archived')) NOT VALID;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_spot_assets_status' AND connamespace = ns) THEN
    ALTER TABLE spot_assets ADD CONSTRAINT chk_spot_assets_status
      CHECK (status IN ('pending', 'attached', 'deleted', 'approved')) NOT VALID;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_merchants_status' AND connamespace = ns) THEN
    ALTER TABLE merchants ADD CONSTRAINT chk_merchants_status
      CHECK (status IN ('active', 'pending', 'suspended', 'inactive', 'revoked')) NOT VALID;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_merchant_memberships_role' AND connamespace = ns) THEN
    ALTER TABLE merchant_memberships ADD CONSTRAINT chk_merchant_memberships_role
      CHECK (role IN ('owner', 'manager', 'staff', 'member')) NOT VALID;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_merchant_memberships_status' AND connamespace = ns) THEN
    ALTER TABLE merchant_memberships ADD CONSTRAINT chk_merchant_memberships_status
      CHECK (status IN ('active', 'pending', 'suspended', 'inactive', 'revoked')) NOT VALID;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_auth_mail_outbox_status' AND connamespace = ns) THEN
    ALTER TABLE auth_mail_outbox ADD CONSTRAINT chk_auth_mail_outbox_status
      CHECK (status IN ('pending', 'sent', 'failed')) NOT VALID;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_daily_missions_kind' AND connamespace = ns) THEN
    ALTER TABLE daily_missions ADD CONSTRAINT chk_daily_missions_kind
      CHECK (length(btrim(kind)) > 0) NOT VALID;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_streak_shield_events_kind' AND connamespace = ns) THEN
    ALTER TABLE streak_shield_events ADD CONSTRAINT chk_streak_shield_events_kind
      CHECK (kind IN ('grant', 'consume', 'purchase')) NOT VALID;
  END IF;
END $$;
