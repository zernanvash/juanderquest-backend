-- Plan 85c (D2 + D5): Drop 8 duplicate non-unique/redundant indexes and add CHECK constraints on 8 status/kind/type tables.

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
      CHECK (status IN ('published', 'needs_review', 'unpublished', 'approved', 'pending', 'rejected', 'archived'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_spot_assets_status' AND connamespace = ns) THEN
    ALTER TABLE spot_assets ADD CONSTRAINT chk_spot_assets_status
      CHECK (status IN ('pending', 'attached', 'deleted', 'approved'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_merchants_status' AND connamespace = ns) THEN
    ALTER TABLE merchants ADD CONSTRAINT chk_merchants_status
      CHECK (status IN ('active', 'pending', 'suspended', 'inactive', 'revoked'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_merchant_memberships_role' AND connamespace = ns) THEN
    ALTER TABLE merchant_memberships ADD CONSTRAINT chk_merchant_memberships_role
      CHECK (role IN ('owner', 'manager', 'staff', 'member'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_merchant_memberships_status' AND connamespace = ns) THEN
    ALTER TABLE merchant_memberships ADD CONSTRAINT chk_merchant_memberships_status
      CHECK (status IN ('active', 'pending', 'suspended', 'inactive', 'revoked'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_auth_mail_outbox_status' AND connamespace = ns) THEN
    ALTER TABLE auth_mail_outbox ADD CONSTRAINT chk_auth_mail_outbox_status
      CHECK (status IN ('pending', 'sent', 'failed'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_daily_missions_kind' AND connamespace = ns) THEN
    ALTER TABLE daily_missions ADD CONSTRAINT chk_daily_missions_kind
      CHECK (length(btrim(kind)) > 0);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_streak_shield_events_kind' AND connamespace = ns) THEN
    ALTER TABLE streak_shield_events ADD CONSTRAINT chk_streak_shield_events_kind
      CHECK (kind IN ('grant', 'consume', 'purchase'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_governance_ledger_type' AND connamespace = ns) THEN
    ALTER TABLE governance_ledger ADD CONSTRAINT chk_governance_ledger_type
      CHECK (type IN (
        'quest_reward_credit',
        'voucher_redemption_debit',
        'juanchoice_boost_debit',
        'quest_fund_lock',
        'quest_fund_refund',
        'quest_fund_release',
        'quest_fund_hold',
        'quest_reward_paid',
        'quest_fee',
        'trail_generation_debit',
        'trail_unlock_debit',
        'trail_reward_credit',
        'shop_cosmetic_purchase',
        'merchant_points_simulated_purchase',
        'merchant_points_admin_grant',
        'merchant_points_admin_correction',
        'merchant_points_voucher_income',
        'bond_lock',
        'bond_refund',
        'proposal_vote_debit',
        'proposal_escrow_credit',
        'feedback_vote_debit',
        'feedback_escrow_credit',
        'token_burn',
        'recipient_credit',
        'review_probe',
        'overflow_test',
        'large_test',
        'historical_fixture'
      ));
  END IF;
END $$;
