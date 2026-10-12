-- ECONOMY_REAL_PG_LIFECYCLE: internal simulation only. No public notification,
-- merchant liability, demo-point conversion or chain broadcast is enabled.
ALTER TABLE economic_outbox ADD COLUMN status TEXT NOT NULL DEFAULT 'pending'
  CHECK (status IN ('pending','processing','completed','failed','dead_letter'));
ALTER TABLE economic_outbox ADD COLUMN lease_owner TEXT;
ALTER TABLE economic_outbox ADD COLUMN claim_token UUID;
ALTER TABLE economic_outbox ADD COLUMN lease_expires_at TIMESTAMPTZ;
ALTER TABLE economic_outbox ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 100);
ALTER TABLE economic_outbox ADD COLUMN next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE economic_outbox ADD COLUMN last_error TEXT;
ALTER TABLE economic_outbox ADD COLUMN dead_letter_at TIMESTAMPTZ;
UPDATE economic_outbox SET status = 'completed' WHERE delivered_at IS NOT NULL;
CREATE INDEX economic_outbox_due_idx ON economic_outbox(next_attempt_at, created_at)
  WHERE status IN ('pending','failed','processing');

CREATE TABLE economic_outbox_receipts (
  id TEXT PRIMARY KEY,
  outbox_id TEXT NOT NULL REFERENCES economic_outbox(id) ON DELETE RESTRICT,
  consumer_key TEXT NOT NULL,
  effect_hash TEXT NOT NULL CHECK (effect_hash ~ '^[a-f0-9]{64}$'),
  consumed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (outbox_id, consumer_key)
);
CREATE FUNCTION economic_outbox_receipt_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'ECONOMIC_OUTBOX_RECEIPT_IMMUTABLE'; END $$;
CREATE TRIGGER economic_outbox_receipt_immutable_trigger
BEFORE UPDATE OR DELETE ON economic_outbox_receipts FOR EACH ROW
EXECUTE FUNCTION economic_outbox_receipt_immutable();

CREATE FUNCTION economic_outbox_identity_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id, NEW.transaction_id, NEW.event_type, NEW.payload, NEW.created_at) IS DISTINCT FROM
     (OLD.id, OLD.transaction_id, OLD.event_type, OLD.payload, OLD.created_at) THEN
    RAISE EXCEPTION 'ECONOMIC_OUTBOX_IDENTITY_IMMUTABLE';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER economic_outbox_identity_guard_trigger BEFORE UPDATE ON economic_outbox
FOR EACH ROW EXECUTE FUNCTION economic_outbox_identity_guard();

CREATE TABLE reward_appeals (
  id TEXT PRIMARY KEY,
  reservation_id TEXT NOT NULL UNIQUE REFERENCES reward_reservations(id) ON DELETE RESTRICT,
  submission_id TEXT NOT NULL REFERENCES submissions(id) ON DELETE RESTRICT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  original_reviewer_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reason TEXT NOT NULL CHECK (char_length(trim(reason)) BETWEEN 10 AND 2000),
  status TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','approved','rejected')),
  requested_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  decided_at TIMESTAMPTZ,
  decided_by TEXT REFERENCES users(id) ON DELETE RESTRICT,
  decision_reason TEXT,
  CHECK ((status = 'submitted' AND decided_at IS NULL AND decided_by IS NULL AND decision_reason IS NULL)
      OR (status <> 'submitted' AND decided_at IS NOT NULL AND decided_by IS NOT NULL
          AND char_length(trim(decision_reason)) BETWEEN 10 AND 2000))
);

CREATE FUNCTION economic_appeal_source_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE reservation_row reward_reservations%ROWTYPE;
DECLARE submission_row submissions%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF (NEW.id, NEW.reservation_id, NEW.submission_id, NEW.user_id,
        NEW.original_reviewer_id, NEW.reason, NEW.requested_at)
       IS DISTINCT FROM
       (OLD.id, OLD.reservation_id, OLD.submission_id, OLD.user_id,
        OLD.original_reviewer_id, OLD.reason, OLD.requested_at) THEN
      RAISE EXCEPTION 'ECONOMIC_APPEAL_IDENTITY_IMMUTABLE';
    END IF;
    IF OLD.status <> 'submitted' THEN RAISE EXCEPTION 'ECONOMIC_APPEAL_TERMINAL'; END IF;
  END IF;
  SELECT * INTO reservation_row FROM reward_reservations WHERE id = NEW.reservation_id;
  SELECT * INTO submission_row FROM submissions WHERE id = NEW.submission_id;
  IF reservation_row.id IS NULL OR reservation_row.status <> 'appeal' OR
     reservation_row.user_id <> NEW.user_id OR
     reservation_row.submission_id IS DISTINCT FROM NEW.submission_id OR
     submission_row.id IS NULL OR submission_row.user_id <> NEW.user_id OR
     NEW.original_reviewer_id IS DISTINCT FROM submission_row.reviewed_by OR
     submission_row.status <> 'rejected' OR
     NEW.requested_at > reservation_row.appeal_until THEN
    RAISE EXCEPTION 'ECONOMIC_APPEAL_SOURCE_INVALID';
  END IF;
  IF NEW.decided_by IS NOT NULL AND NOT EXISTS
    (SELECT 1 FROM users WHERE id = NEW.decided_by AND role = 'admin') THEN
    RAISE EXCEPTION 'ADMIN_APPEAL_REVIEW_REQUIRED';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER economic_appeal_source_guard_trigger
BEFORE INSERT OR UPDATE ON reward_appeals FOR EACH ROW
EXECUTE FUNCTION economic_appeal_source_guard();
