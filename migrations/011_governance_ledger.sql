-- Migration 011: Normalized Governance Ledger and Audit Tables
-- Provides durable, row-level concurrency for financial and token transactions

CREATE TABLE IF NOT EXISTS governance_ledger (
    id TEXT PRIMARY KEY,
    transaction_group_id TEXT NOT NULL,
    type VARCHAR(50) NOT NULL,
    account TEXT NOT NULL,
    amount_mjdq BIGINT NOT NULL,
    reference_type VARCHAR(50) NOT NULL,
    reference_id TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    idempotency_key TEXT,
    metadata JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_governance_ledger_account ON governance_ledger(account);
CREATE INDEX IF NOT EXISTS idx_governance_ledger_group ON governance_ledger(transaction_group_id);
CREATE INDEX IF NOT EXISTS idx_governance_ledger_reference ON governance_ledger(reference_type, reference_id);
CREATE INDEX IF NOT EXISTS idx_governance_ledger_idempotency ON governance_ledger(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_governance_ledger_created ON governance_ledger(created_at DESC);

CREATE TABLE IF NOT EXISTS governance_audit (
    id TEXT PRIMARY KEY,
    action VARCHAR(100) NOT NULL,
    actor_id TEXT NOT NULL,
    subject_type VARCHAR(50) NOT NULL,
    subject_id TEXT NOT NULL,
    reason TEXT,
    evidence_reference TEXT,
    metadata JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_governance_audit_subject ON governance_audit(subject_type, subject_id);
CREATE INDEX IF NOT EXISTS idx_governance_audit_created ON governance_audit(created_at DESC);

-- Ensure singleton row 1 exists in governance_snapshot with full defaults so SELECT ... FOR UPDATE locks deterministically
INSERT INTO governance_snapshot (id, data)
VALUES (1, '{"proposals":[],"votes":[],"feedbackVotes":[],"balances":{},"ledger":[],"audit":[],"burnedMjdq":0,"treasuryMjdq":0,"issuedMjdq":0,"idempotency":[],"controls":{"pause_all_financial":false,"pause_votes":false,"pause_payouts":false,"audit_only":false}}'::jsonb)
ON CONFLICT (id) DO NOTHING;

