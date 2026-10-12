-- ECONOMY_REAL_PG_ACTIVITY: Reviewed activity and policy authority. Existing
-- demo balances and historical reward rows are never rewritten or inferred.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM reward_pools WHERE status = 'active') THEN
    RAISE EXCEPTION 'ACTIVE_LEGACY_REWARD_POOL_REQUIRES_MANUAL_REVIEW';
  END IF;
  IF EXISTS (SELECT 1 FROM reward_reservations) OR EXISTS (SELECT 1 FROM reward_awards) THEN
    RAISE EXCEPTION 'LEGACY_REWARD_RESERVATIONS_REQUIRE_MANUAL_MAPPING';
  END IF;
END $$;

CREATE TABLE economic_activity_scopes (
  id TEXT PRIMARY KEY,
  scope_key TEXT NOT NULL UNIQUE,
  country_code CHAR(2) NOT NULL CHECK (country_code ~ '^[A-Z]{2}$'),
  region_name TEXT,
  province_name TEXT,
  municipality_name TEXT,
  destination_spot_id TEXT REFERENCES spots(id) ON DELETE RESTRICT,
  activity_kind TEXT NOT NULL CHECK (activity_kind IN ('visit', 'photo', 'qr', 'ar', 'multi_step')),
  activity_fingerprint TEXT NOT NULL,
  summary TEXT NOT NULL,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  proposed_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reviewed_by TEXT REFERENCES users(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'approved', 'rejected', 'retired')),
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (char_length(trim(scope_key)) > 0 AND char_length(trim(summary)) > 0 AND
         char_length(trim(activity_fingerprint)) > 0 AND jsonb_typeof(evidence) = 'object'),
  CHECK ((status = 'proposed' AND reviewed_by IS NULL AND reviewed_at IS NULL) OR
         (status <> 'proposed' AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL)),
  CHECK (reviewed_by IS NULL OR reviewed_by <> proposed_by)
);
CREATE UNIQUE INDEX economic_activity_fingerprint_unique
  ON economic_activity_scopes(country_code, coalesce(region_name,''), coalesce(province_name,''),
    coalesce(municipality_name,''), coalesce(destination_spot_id,''), activity_kind, activity_fingerprint)
  WHERE status <> 'rejected';

CREATE TABLE economic_reward_policies (
  id TEXT PRIMARY KEY,
  policy_key TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  asset_code TEXT NOT NULL REFERENCES economic_assets(code) ON DELETE RESTRICT,
  reward_minor BIGINT NOT NULL CHECK (reward_minor > 0),
  reservation_seconds INTEGER NOT NULL CHECK (reservation_seconds BETWEEN 300 AND 604800),
  appeal_seconds INTEGER NOT NULL CHECK (appeal_seconds BETWEEN 0 AND 2592000),
  effective_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ,
  terms_snapshot JSONB NOT NULL,
  proposed_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  approved_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  approved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (policy_key, version),
  CHECK (proposed_by <> approved_by),
  CHECK (expires_at IS NULL OR expires_at > effective_at),
  CHECK (jsonb_typeof(terms_snapshot) = 'object')
);

CREATE TABLE economic_quest_scope_bindings (
  id TEXT PRIMARY KEY,
  quest_id TEXT NOT NULL REFERENCES quests(id) ON DELETE RESTRICT,
  quest_version INTEGER NOT NULL CHECK (quest_version > 0),
  scope_id TEXT NOT NULL REFERENCES economic_activity_scopes(id) ON DELETE RESTRICT,
  proposed_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reviewed_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reviewed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  rationale TEXT NOT NULL,
  UNIQUE (quest_id, quest_version),
  CHECK (proposed_by <> reviewed_by AND char_length(trim(rationale)) > 0)
);
CREATE INDEX economic_quest_scope_bindings_scope_idx ON economic_quest_scope_bindings(scope_id);

CREATE FUNCTION economic_review_actor_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE reviewer_id TEXT;
DECLARE quest_author TEXT;
BEGIN
  IF TG_TABLE_NAME = 'economic_activity_scopes' THEN
    IF TG_OP = 'INSERT' THEN
      IF NEW.status <> 'proposed' THEN reviewer_id := NEW.reviewed_by; END IF;
    ELSIF OLD.status = 'proposed' AND NEW.status <> 'proposed' THEN
      reviewer_id := NEW.reviewed_by;
    END IF;
  ELSIF TG_TABLE_NAME = 'economic_reward_policies' THEN
    reviewer_id := NEW.approved_by;
  ELSE
    reviewer_id := NEW.reviewed_by;
    SELECT author_id INTO quest_author FROM quests WHERE id = NEW.quest_id;
    IF quest_author IS NOT NULL AND quest_author <> NEW.proposed_by THEN
      RAISE EXCEPTION 'QUEST_AUTHOR_MISMATCH';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM economic_activity_scopes
      WHERE id = NEW.scope_id AND status = 'approved') THEN
      RAISE EXCEPTION 'APPROVED_ACTIVITY_SCOPE_REQUIRED';
    END IF;
  END IF;
  IF reviewer_id IS NOT NULL AND NOT EXISTS
    (SELECT 1 FROM users WHERE id = reviewer_id AND role = 'admin') THEN
    RAISE EXCEPTION 'ADMIN_REVIEW_REQUIRED';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER economic_activity_review_actor_guard BEFORE INSERT OR UPDATE ON economic_activity_scopes
FOR EACH ROW EXECUTE FUNCTION economic_review_actor_guard();
CREATE TRIGGER economic_policy_review_actor_guard BEFORE INSERT ON economic_reward_policies
FOR EACH ROW EXECUTE FUNCTION economic_review_actor_guard();
CREATE TRIGGER economic_binding_review_actor_guard BEFORE INSERT ON economic_quest_scope_bindings
FOR EACH ROW EXECUTE FUNCTION economic_review_actor_guard();

ALTER TABLE reward_pools ADD COLUMN scope_id TEXT REFERENCES economic_activity_scopes(id) ON DELETE RESTRICT;
ALTER TABLE reward_pools ADD COLUMN policy_id TEXT REFERENCES economic_reward_policies(id) ON DELETE RESTRICT;
ALTER TABLE reward_pools ADD COLUMN activated_at TIMESTAMPTZ;
CREATE UNIQUE INDEX reward_pools_one_active_scope_idx ON reward_pools(scope_id) WHERE status = 'active';

ALTER TABLE reward_reservations ADD COLUMN attempt_id TEXT REFERENCES quest_attempts(id) ON DELETE RESTRICT;
ALTER TABLE reward_reservations ADD COLUMN scope_id TEXT REFERENCES economic_activity_scopes(id) ON DELETE RESTRICT;
ALTER TABLE reward_reservations ADD COLUMN policy_id TEXT REFERENCES economic_reward_policies(id) ON DELETE RESTRICT;
ALTER TABLE reward_reservations ADD COLUMN quest_binding_id TEXT REFERENCES economic_quest_scope_bindings(id) ON DELETE RESTRICT;
ALTER TABLE reward_reservations ADD COLUMN submitted_at TIMESTAMPTZ;
CREATE UNIQUE INDEX reward_reservations_attempt_unique ON reward_reservations(attempt_id) WHERE attempt_id IS NOT NULL;

ALTER TABLE submissions ADD COLUMN economic_attempt_id TEXT REFERENCES quest_attempts(id) ON DELETE RESTRICT;
CREATE INDEX submissions_economic_attempt_idx ON submissions(economic_attempt_id)
  WHERE economic_attempt_id IS NOT NULL;

ALTER TABLE reward_awards ADD COLUMN scope_id TEXT REFERENCES economic_activity_scopes(id) ON DELETE RESTRICT;
CREATE UNIQUE INDEX reward_awards_canonical_scope_unique ON reward_awards(user_id, scope_id) WHERE scope_id IS NOT NULL;

CREATE FUNCTION economic_reviewed_pool_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE scope_row economic_activity_scopes%ROWTYPE;
DECLARE policy_row economic_reward_policies%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.activated_at IS NOT NULL THEN
    IF (NEW.quest_id, NEW.asset_code, NEW.scope_key, NEW.policy_version,
      NEW.reward_minor, NEW.reservation_seconds, NEW.appeal_seconds,
      NEW.scope_id, NEW.policy_id, NEW.activated_at) IS DISTINCT FROM
      (OLD.quest_id, OLD.asset_code, OLD.scope_key, OLD.policy_version,
       OLD.reward_minor, OLD.reservation_seconds, OLD.appeal_seconds,
       OLD.scope_id, OLD.policy_id, OLD.activated_at) THEN
      RAISE EXCEPTION 'ACTIVE_POOL_AUTHORITY_IMMUTABLE';
    END IF;
    IF (OLD.status = 'closed' AND NEW.status <> 'closed') OR
       (OLD.status = 'active' AND NEW.status = 'draft') THEN
      RAISE EXCEPTION 'REVIEWED_POOL_INVALID_STATUS_TRANSITION';
    END IF;
    -- A timely held proof keeps its snapshotted terms even after a quest edit
    -- or policy expiry. Balance movements on the already-approved pool must
    -- remain possible; reactivation from paused still requires review.
    IF OLD.status = 'active' AND NEW.status <> 'active' OR
       OLD.status = 'active' AND NEW.status = 'active' OR
       OLD.status = 'closed' THEN RETURN NEW; END IF;
  END IF;
  IF NEW.status <> 'active' THEN RETURN NEW; END IF;
  IF NEW.scope_id IS NULL OR NEW.policy_id IS NULL THEN
    RAISE EXCEPTION 'REVIEWED_SCOPE_AND_POLICY_REQUIRED';
  END IF;
  SELECT * INTO scope_row FROM economic_activity_scopes WHERE id = NEW.scope_id;
  SELECT * INTO policy_row FROM economic_reward_policies WHERE id = NEW.policy_id;
  IF scope_row.status <> 'approved' OR scope_row.scope_key <> NEW.scope_key THEN
    RAISE EXCEPTION 'APPROVED_ACTIVITY_SCOPE_REQUIRED';
  END IF;
  IF policy_row.asset_code <> NEW.asset_code OR policy_row.reward_minor <> NEW.reward_minor OR
     policy_row.reservation_seconds <> NEW.reservation_seconds OR
     policy_row.appeal_seconds <> NEW.appeal_seconds OR
     policy_row.id <> NEW.policy_version OR
     policy_row.effective_at > clock_timestamp() OR
     (policy_row.expires_at IS NOT NULL AND policy_row.expires_at <= clock_timestamp()) THEN
    RAISE EXCEPTION 'APPROVED_REWARD_POLICY_REQUIRED';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM economic_quest_scope_bindings b JOIN quests q ON q.id = b.quest_id
    WHERE b.quest_id = NEW.quest_id AND b.scope_id = NEW.scope_id AND b.quest_version = q.version) THEN
    RAISE EXCEPTION 'REVIEWED_QUEST_REVISION_BINDING_REQUIRED';
  END IF;
  IF NEW.activated_at IS NULL THEN NEW.activated_at := clock_timestamp(); END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER economic_reviewed_pool_guard_trigger BEFORE INSERT OR UPDATE ON reward_pools
FOR EACH ROW EXECUTE FUNCTION economic_reviewed_pool_guard();

CREATE FUNCTION economic_reservation_authority_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE pool_row reward_pools%ROWTYPE;
DECLARE attempt_row quest_attempts%ROWTYPE;
DECLARE binding_row economic_quest_scope_bindings%ROWTYPE;
DECLARE proof_row submissions%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE' AND
     (NEW.pool_id, NEW.user_id, NEW.scope_key, NEW.quest_version, NEW.amount_minor,
      NEW.attempt_id, NEW.scope_id, NEW.policy_id, NEW.quest_binding_id,
      NEW.expires_at, NEW.created_at) IS DISTINCT FROM
     (OLD.pool_id, OLD.user_id, OLD.scope_key, OLD.quest_version, OLD.amount_minor,
      OLD.attempt_id, OLD.scope_id, OLD.policy_id, OLD.quest_binding_id,
      OLD.expires_at, OLD.created_at) THEN
    RAISE EXCEPTION 'RESERVATION_SNAPSHOT_IMMUTABLE';
  END IF;
  SELECT * INTO pool_row FROM reward_pools WHERE id = NEW.pool_id;
  IF pool_row.scope_id IS NULL OR pool_row.policy_id IS NULL THEN
    RAISE EXCEPTION 'REVIEWED_POOL_REQUIRED';
  END IF;
  IF TG_OP = 'INSERT' AND pool_row.status <> 'active' THEN
    RAISE EXCEPTION 'ACTIVE_REVIEWED_POOL_REQUIRED';
  END IF;
  IF NEW.scope_id IS DISTINCT FROM pool_row.scope_id OR
     NEW.policy_id IS DISTINCT FROM pool_row.policy_id OR
     NEW.scope_key <> pool_row.scope_key OR NEW.amount_minor <> pool_row.reward_minor OR
     NEW.attempt_id IS NULL OR NEW.quest_binding_id IS NULL THEN
    RAISE EXCEPTION 'RESERVATION_AUTHORITY_MISMATCH';
  END IF;
  SELECT * INTO attempt_row FROM quest_attempts WHERE id = NEW.attempt_id;
  SELECT * INTO binding_row FROM economic_quest_scope_bindings WHERE id = NEW.quest_binding_id;
  IF attempt_row.id IS NULL OR attempt_row.user_id <> NEW.user_id OR
     attempt_row.quest_id <> pool_row.quest_id OR attempt_row.version <> NEW.quest_version OR
     binding_row.id IS NULL OR binding_row.quest_id <> pool_row.quest_id OR
     binding_row.quest_version <> NEW.quest_version OR binding_row.scope_id <> NEW.scope_id THEN
    RAISE EXCEPTION 'ATTEMPT_BINDING_MISMATCH';
  END IF;
  IF NEW.status IN ('submitted','appeal','paid') THEN
    SELECT * INTO proof_row FROM submissions WHERE id = NEW.submission_id;
    IF proof_row.id IS NULL OR proof_row.economic_attempt_id IS DISTINCT FROM NEW.attempt_id OR
       proof_row.user_id <> NEW.user_id OR proof_row.quest_id <> pool_row.quest_id OR
       NEW.submitted_at IS NULL OR NEW.submitted_at < NEW.created_at OR
       NEW.submitted_at > NEW.expires_at OR NEW.submitted_at IS DISTINCT FROM proof_row.created_at THEN
      RAISE EXCEPTION 'ATTEMPT_PROOF_MISMATCH';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER economic_reservation_authority_guard_trigger
BEFORE INSERT OR UPDATE ON reward_reservations
FOR EACH ROW EXECUTE FUNCTION economic_reservation_authority_guard();

CREATE FUNCTION economic_award_scope_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE reservation_row reward_reservations%ROWTYPE;
DECLARE proof_row submissions%ROWTYPE;
BEGIN
  SELECT * INTO reservation_row FROM reward_reservations WHERE id = NEW.reservation_id;
  SELECT * INTO proof_row FROM submissions WHERE id = reservation_row.submission_id;
  IF reservation_row.id IS NULL OR reservation_row.status <> 'paid' OR
     reservation_row.user_id <> NEW.user_id OR reservation_row.scope_key <> NEW.scope_key OR
     reservation_row.amount_minor <> NEW.awarded_minor OR reservation_row.scope_id IS NULL OR
     proof_row.status <> 'approved' OR proof_row.economic_attempt_id IS DISTINCT FROM reservation_row.attempt_id THEN
    RAISE EXCEPTION 'AWARD_RESERVATION_MISMATCH';
  END IF;
  NEW.scope_id := reservation_row.scope_id;
  RETURN NEW;
END $$;
CREATE TRIGGER economic_award_scope_guard_trigger BEFORE INSERT ON reward_awards
FOR EACH ROW EXECUTE FUNCTION economic_award_scope_guard();

-- Approved policy and reviewed binding facts are append-only. A retired scope
-- can stop future starts without rewriting historical reservations and awards.
CREATE FUNCTION economic_review_fact_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'ECONOMIC_REVIEW_FACT_IMMUTABLE'; END $$;
CREATE TRIGGER economic_reward_policies_immutable BEFORE UPDATE OR DELETE ON economic_reward_policies
FOR EACH ROW EXECUTE FUNCTION economic_review_fact_immutable();
CREATE TRIGGER economic_quest_scope_bindings_immutable BEFORE UPDATE OR DELETE ON economic_quest_scope_bindings
FOR EACH ROW EXECUTE FUNCTION economic_review_fact_immutable();
CREATE FUNCTION economic_approved_scope_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'proposed' AND (NEW.id, NEW.scope_key, NEW.country_code,
    NEW.region_name, NEW.province_name, NEW.municipality_name, NEW.destination_spot_id,
    NEW.activity_kind, NEW.activity_fingerprint, NEW.summary, NEW.evidence,
    NEW.proposed_by, NEW.reviewed_by, NEW.reviewed_at) IS DISTINCT FROM
    (OLD.id, OLD.scope_key, OLD.country_code, OLD.region_name, OLD.province_name,
    OLD.municipality_name, OLD.destination_spot_id, OLD.activity_kind,
    OLD.activity_fingerprint, OLD.summary, OLD.evidence, OLD.proposed_by,
    OLD.reviewed_by, OLD.reviewed_at) THEN
    RAISE EXCEPTION 'APPROVED_ACTIVITY_SCOPE_IMMUTABLE';
  END IF;
  IF (OLD.status = 'approved' AND NEW.status NOT IN ('approved','retired')) OR
     (OLD.status IN ('rejected','retired') AND NEW.status <> OLD.status) THEN
    RAISE EXCEPTION 'REVIEWED_SCOPE_INVALID_STATUS_TRANSITION';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER economic_approved_scope_immutable_trigger BEFORE UPDATE ON economic_activity_scopes
FOR EACH ROW EXECUTE FUNCTION economic_approved_scope_immutable();
