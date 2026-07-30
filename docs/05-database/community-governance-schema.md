# Community Governance Persistence Schema

**Current prototype:** in-memory implementation
**Required production store:** PostgreSQL
**Financial unit:** `BIGINT` mJDQ

This schema is the migration target. Financial and lifecycle mutations must execute in serializable or appropriately locked database transactions.

## Core tables

### `community_proposals`

| Column | Type | Rule |
|---|---|---|
| `id` | UUID | primary key |
| `organizer_user_id` | UUID | FK users, not null |
| `title`, `description`, `location_name` | text | not null |
| `category` | quest category enum | not null |
| `gps_lat`, `gps_lng` | double precision | required before voting |
| `state` | governance state enum | not null |
| `active_duration_days` | smallint | default 30 |
| `screening_reason` | text | |
| `screening_evidence_reference` | text | |
| `terms_locked_at` | timestamptz | prevents later material edits |
| `created_at`, `updated_at` | timestamptz | not null |

Indexes: state, organizer, category, coordinates, created time.

### `proposal_recipients`

| Column | Type | Rule |
|---|---|---|
| `id`, `proposal_id`, `user_id` | UUID | PK and FKs |
| `role` | enum | organizer/manager/merchant |
| `duty` | text | not null |
| `share_bps` | integer | 1–10,000 |
| `consented_at` | timestamptz | required before voting |

A deferred constraint/transaction check requires shares per proposal to total exactly 10,000. The organizer recipient must exist.

### `governance_rounds`

| Column | Type | Rule |
|---|---|---|
| `id`, `proposal_id` | UUID | PK/FK |
| `round_type` | enum | proposal/feedback |
| `status` | enum | pending/open/passed/failed/expired/disputed |
| `eligible_snapshot` | integer | immutable after open |
| `quorum_required` | integer | immutable after open |
| `positive_votes`, `negative_votes` | integer | derived/cacheable |
| `fee_mjdq`, `burn_bps` | bigint/integer | versioned config snapshot |
| `opens_at`, `closes_at`, `closed_at` | timestamptz | |

Unique `(proposal_id, round_type)`.

### `governance_eligibility`

Stores the immutable membership snapshot.

| Column | Type | Rule |
|---|---|---|
| `round_id`, `user_id` | UUID | composite primary key |
| `basis` | enum | approved_completion/quest_participant |
| `basis_reference_id` | UUID | submission/completion evidence |
| `snapshotted_at` | timestamptz | not null |

### `governance_votes`

| Column | Type | Rule |
|---|---|---|
| `id`, `round_id`, `voter_user_id` | UUID | PK/FKs |
| `choice` | enum | positive/negative |
| `rating` | smallint | feedback only, 1–5 |
| `comment` | varchar(500) | feedback only |
| `fee_transaction_group_id` | UUID | unique, not null |
| `idempotency_key` | varchar(128) | not null |
| `created_at` | timestamptz | not null |

Unique `(round_id, voter_user_id)` and `(voter_user_id, idempotency_key)`.

### `organizer_bonds`

| Column | Type | Rule |
|---|---|---|
| `id`, `proposal_id`, `organizer_user_id` | UUID | PK/FKs |
| `amount_mjdq` | bigint | positive |
| `status` | enum | locked/refunded/slashed_50/slashed_100 |
| `lock_transaction_group_id` | UUID | unique |
| `resolution_transaction_group_id` | UUID | unique nullable |
| `resolved_by`, `resolved_at` | UUID/timestamptz | |
| `reason`, `evidence_reference` | text | required for slash |

Unique proposal bond.

## Financial tables

### `jdq_accounts`

Accounts represent users, merchants, burn, treasury, issuance, bond escrow, and proposal escrow. Account type and owner ID are immutable.

### `jdq_transaction_groups`

| Column | Type | Rule |
|---|---|---|
| `id` | UUID | primary key |
| `transaction_type` | enum | controlled ledger vocabulary |
| `reference_type`, `reference_id` | text/UUID | business source |
| `actor_user_id` | UUID | nullable for system |
| `idempotency_key`, `payload_hash` | text | unique pair per actor |
| `reason`, `metadata` | text/jsonb | |
| `created_at` | timestamptz | immutable |

### `jdq_ledger_entries`

| Column | Type | Rule |
|---|---|---|
| `id`, `transaction_group_id`, `account_id` | UUID | PK/FKs |
| `amount_mjdq` | bigint | signed, non-zero |
| `created_at` | timestamptz | immutable |

Every transaction group must sum to zero. Database permissions deny updates/deletes. Balances are calculated from entry sums or maintained in a transactionally checked cache.

### `quest_payouts`

Stores pool size, release percent, distributed/treasury amounts, status, and resolution evidence. `quest_payout_recipients` stores exact computed mJDQ per locked recipient.

## Operations and merchant tables

- `community_quest_runs`: schedule, proof settings, GPS radius, participant reward, and operational status.
- `merchant_profiles`: identity, business location, owner, verification status, and evidence.
- `proposal_merchants`: proposal, merchant, duty, consent, and marketing disclosure.
- `quest_sponsorships`: sponsor, purpose, JDQ/in-kind amount, funding transaction, status.
- `merchant_vouchers`: JDQ price, inventory, validity, terms, merchant, and status.
- `voucher_redemptions`: user, voucher, code hash, financial transaction, issued/redeemed/expired/refunded state.
- `governance_disputes`: category, status, proposed/final release, bond action, public reason, private notes, and evidence.
- `governance_controls`: versioned pause flags, operator, reason, effective time.
- `governance_config_versions`: fee/burn/bond/window/quorum constants and effective time.
- `governance_audit_events`: append-only actor/action/subject/reason/evidence/metadata/time.
- `governance_risk_alerts`: code, severity, source metrics, state, assignee, resolution, timestamps.

## Required database invariants

1. No negative user or merchant account balance.
2. Every ledger group balances to zero.
3. Recipient shares total 10,000 bps before terms lock.
4. One bond, proposal round, and feedback round per proposal.
5. One eligibility row and one vote per user per round.
6. One reward issuance per approved submission.
7. One final payout per proposal.
8. Configuration and eligibility snapshots are immutable after round opening.
9. Closed ledger/audit records cannot be updated or deleted.
10. Scheduled jobs acquire a row lock and record completion so retries are idempotent.

## Migration sequence

1. Create account, transaction-group, ledger, audit, configuration, and control tables.
2. Reconcile prototype user balances and import them as one documented genesis transaction.
3. Import proposals and recipients without claiming prior mock upvotes as paid votes.
4. Enable dual-read verification, then switch balance reads to ledger sums.
5. Switch reward issuance, governance fees, bonds, treasury, vouchers, and payouts to PostgreSQL transactions.
6. Run reconciliation and backup/restore tests before enabling real-value settlement.
