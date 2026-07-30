# Community Governance and Tokenomics Implementation Plan

**Specification:** `docs/06-blockchain/community-quest-governance-tokenomics.md`
**Target:** Off-chain prototype with an API-backed management dashboard

## Delivery order

1. Establish the append-only mJDQ ledger and replace direct point mutations with ledgered credits/debits.
2. Expand proposals into the governed lifecycle, paid binary votes, eligibility snapshots, bonds, escrow, and audit events.
3. Add administrative screening, state transition, dispute resolution, controls, reconciliation, and analytics endpoints.
4. Replace dashboard mock governance data with the management control center.
5. Add integration tests for lifecycle, accounting, permissions, idempotency, and dashboard build verification.
6. Update API/database/architecture references and the dev journal.

## Backend

- Keep the current `MemoryDb` prototype boundary while representing financial activity as immutable ledger entries measured in mJDQ.
- Seed demonstration governance state without weakening documented production rules.
- Implement fixed configuration, pause controls, proposal screening, paid votes, state transitions, audit events, and analytics.
- Preserve existing quest/submission endpoints and response compatibility.

## Dashboard

- Add an API-backed Governance Control Center with overview, proposals, tokenomics, ledger/audit, operations, merchants, and risk/control views.
- Surface voter snapshots, quorum, turnout, vote direction, burn, escrow, treasury, bonds, sponsors, payout shares, and reconciliation.
- Require reasons for screening decisions and display prototype/off-chain warnings.
- Retain existing proof-review and quest views with responsive behavior.

## Acceptance checks

- Existing backend tests remain green.
- Tests prove vote uniqueness, fee allocation, insufficient balance, permissions, screening, quorum outcomes, bond handling, and reconciliation.
- Dashboard builds with no hard-coded governance or tokenomics analytics.
- Documentation and implementation changes are recorded in `docs/dev-journal.md`.
