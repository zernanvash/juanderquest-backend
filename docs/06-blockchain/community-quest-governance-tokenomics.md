# Community Quest Governance and JDQ Tokenomics

**Status:** Approved implementation specification
**Initial implementation:** Off-chain prototype ledger
**Future settlement:** Base L2-compatible JDQ ERC-20 contracts
**Last updated:** 2026-07-30

## 1. Purpose

Community Quests let verified JuanDerQuest travelers propose tourism activities, let the community decide which proposals deserve support, operate approved quests for a fixed period, and release the accumulated governance pool only after participant feedback.

The design has five goals:

1. make proposal and feedback votes economically meaningful;
2. remove JDQ from circulation through a predictable burn;
3. fund organizers and verified collaborators transparently;
4. let merchants sponsor destinations and sell useful vouchers without buying governance control; and
5. give administrators enough visibility and emergency control to contain fraud without silently overriding community decisions.

This specification supersedes the earlier mock “upvote” proposal behavior. It does not claim that the prototype ledger is a blockchain. Every prototype transaction must be recorded in a form that can later map to an on-chain event.

## 2. Roles and authority

### Traveler

- Has a verified JuanDerQuest account.
- Becomes governance-eligible after at least one approved quest completion.
- May submit a proposal, pay a proposal vote, and inspect public governance accounting.
- May submit final feedback only after completing the specific Community Quest.

### Organizer

- Is the user who submits and accepts responsibility for a proposal.
- Supplies the schedule, location, safety plan, operating plan, collaborators, merchants, reward budget, and payout shares.
- Locks a 25 JDQ performance bond after administrative pre-screening and before public voting.
- Cannot change payout recipients or shares after voting opens.

### Co-manager

- Is a verified user named before voting for an operational responsibility.
- May receive a disclosed payout share.
- Does not gain extra voting power.

### Merchant

- Must have a verified merchant profile and consent to being attached to a proposal.
- May sponsor participant rewards, operations, or vouchers.
- May receive a disclosed management share only when the proposal states a real operational duty.
- Receives JDQ paid for redeemed vouchers. A listing or sponsorship alone does not grant a governance-pool share.

### Administrator

- Performs safety, identity, feasibility, duplicate, location, merchant-consent, and budget pre-screening.
- Cannot mark a screened proposal community-approved without the required vote result.
- Resolves disputed payouts using predefined outcomes and a mandatory public reason/evidence reference.
- Can pause financial processing during an incident. Emergency actions must be audited and cannot edit or delete earlier ledger entries.

## 3. Lifecycle

| State | Meaning | Allowed next states |
|---|---|---|
| `draft` | Organizer may edit an unsubmitted proposal | `screening`, `cancelled` |
| `screening` | Awaiting administrative checks | `voting`, `rejected`, `cancelled` |
| `voting` | Public proposal vote is open | `approved`, `rejected`, `expired` |
| `approved` | Vote passed and funds remain escrowed | `scheduled`, `cancelled` |
| `rejected` | Admin screening or community vote failed | terminal |
| `expired` | Voting closed without quorum | terminal |
| `scheduled` | Dates and operating details are locked | `active`, `cancelled` |
| `active` | Travelers may complete the Community Quest | `feedback`, `cancelled` |
| `feedback` | Approved participants may vote on delivery | `payout_pending`, `disputed` |
| `payout_pending` | Feedback passed and payout is ready | `completed`, `disputed` |
| `disputed` | Administrator must issue an audited resolution | `completed`, `cancelled` |
| `completed` | Payout resolution and bond outcome are final | terminal |
| `cancelled` | Quest stopped before normal completion | `disputed` or terminal after refund/slash resolution |

State changes are append-only audit events. Dates are stored in UTC; interfaces display the user’s local timezone.

### Standard timeline

1. Organizer creates a draft and names recipients whose shares total exactly 100%.
2. Organizer submits it for administrative screening.
3. Administrator checks required evidence and either rejects it with reasons or approves it for voting.
4. The organizer’s 25 JDQ bond is locked atomically when voting opens.
5. The system snapshots the number of eligible voters and opens a 7-day proposal vote.
6. A passing proposal is scheduled and then runs for 30 days by default.
7. At the quest end, the system snapshots approved participants and opens 7-day feedback.
8. Passing feedback releases the pool by the locked payout shares and refunds the organizer bond.
9. Failed quorum, a non-passing result, cancellation, reported fraud, or operating failure creates a dispute.

Administrative screening may approve a different active duration only before voting opens. The chosen duration is visible to voters and immutable after opening.

## 4. Governance eligibility and voting

### Proposal voting

- Eligibility requires a verified active account and at least one approved quest completion at the instant voting opens.
- The eligible-voter count is snapshotted. Later completions do not change that round’s denominator.
- One user may cast exactly one immutable `yes` or `no` vote.
- Voting power is one vote per eligible user. Token balance does not increase voting power.
- A proposal vote costs 5 JDQ.
- Quorum is `max(5, ceiling(eligible voter snapshot × 10%))`.
- A proposal passes only when quorum is met and `yes > no`.
- A tie fails.
- No quorum produces `expired`; quorum with a non-passing result produces `rejected`.
- Totals may be shown while voting is open, but voter identity and individual choice remain private to normal users. Administrators may access identity only for abuse investigations, with the access audited.

### Final feedback

- Eligibility requires an approved completion submission for that exact Community Quest before the feedback snapshot.
- One participant may cast exactly one immutable `approve` or `disapprove` feedback vote.
- Feedback costs 2 JDQ.
- Quorum is `max(5, ceiling(eligible participant snapshot × 10%))`.
- Feedback passes only when quorum is met and `approve > disapprove`.
- Participants may include a bounded comment and rating metadata, but only the binary vote determines payout.
- No quorum or a non-passing result creates a dispute; it never destroys the payout automatically.

### Idempotency and concurrency

- Every financial mutation requires an idempotency key.
- Repeating the same key and payload returns the original result.
- Reusing a key with a different payload is rejected.
- Balance debit, vote creation, burn, and escrow/treasury allocation are one database transaction.
- A unique constraint on `(round_id, voter_id)` prevents duplicate votes during concurrent requests.
- Server time is authoritative for window boundaries.

## 5. JDQ accounting

The off-chain MVP uses integer **milli-JDQ** (`1 JDQ = 1,000 mJDQ`). API amounts include both `amount_mjdq` and formatted `amount_jdq`; application calculations never use floating point.

### Vote fee allocation

| Event | Fee | Burn (20%) | Allocation (80%) |
|---|---:|---:|---:|
| Proposal vote on eventual winner | 5 JDQ | 1 JDQ | 4 JDQ to quest escrow |
| Proposal vote on rejected/expired proposal | 5 JDQ | 1 JDQ | 4 JDQ to community treasury |
| Final feedback vote | 2 JDQ | 0.4 JDQ | 1.6 JDQ to quest escrow |

The proposal fee initially enters proposal escrow. When the round closes, the non-burned portion remains quest escrow for a winner or moves to the community treasury for a rejected/expired proposal.

### Ledger requirements

The ledger is append-only and records reward credits, vote debits, burns, escrow and treasury credits, sponsorship, vouchers, bonds, payouts, recipient credits, and paired administrative adjustments.

Each entry includes transaction group ID, account, signed amount, reference type/ID, actor, timestamp, idempotency key when applicable, and metadata. Entries are never updated or deleted.

The following invariant must always hold:

`issued JDQ = user balances + locked bonds + all escrows + treasury + merchant balances + burned JDQ`

Analytics must flag any non-zero reconciliation difference.

### Organizer bond

- Amount: 25 JDQ.
- Community rejection or expiration: refund 100%.
- Successful completion: refund 100%.
- Documented negligent non-delivery: slash 50%; refund the remainder.
- Proven fraud or abandonment: slash 100%.
- Slashed funds enter the community treasury.
- Only an administrator can select a slash outcome, and the reason plus evidence reference are mandatory.

### Payout

- Payout recipients and basis-point shares are visible before proposal voting.
- Shares must total 10,000 basis points.
- The system calculates every share in mJDQ.
- Integer remainder is assigned deterministically to the organizer so total credits exactly equal the escrow debit.
- A passing feedback round releases 100% of available payout escrow and refunds the bond.
- A disputed resolution may release 0–100% in whole percentage points. The released amount follows the locked recipient shares; the remainder goes to the community treasury.
- Payout and bond resolution are separate transaction groups but one audited administrative action.

### Supply controls

- Prototype JDQ is not freely mintable through public endpoints.
- Reward issuance must be tied to an approved quest completion and be idempotent.
- Dashboard analytics show issued, circulating, locked bonds, proposal/feedback escrow, community treasury, merchant-held, rewards distributed, payouts distributed, and reconciliation difference.
- Burn is represented as an irreversible burn-account balance in the MVP.
- No administrator may edit a balance directly. Corrections use paired adjustment entries with a reason.

## 6. Merchants, sponsorships, and vouchers

Merchant verification records business identity, location, owner/user, contact, status, and consent evidence.

A verified merchant may fund participant rewards, contribute to the organizer payout pool, provide disclosed in-kind support, create fixed-cost inventory-limited vouchers, and be featured only with documented consent.

Voucher redemption atomically validates status/inventory/balance, debits the user, credits the merchant, issues a single-use code, and records any refund as compensating ledger entries. Sponsorship never increases voting power.

## 7. Administrative controls

### Screening checklist

- organizer account verified and in good standing;
- location and coordinates validated within Pangasinan;
- duplicate/overlap check completed;
- property, venue, or LGU permission attached when needed;
- safety and accessibility risks documented;
- schedule, proof method, GPS radius, staffing, and reward funding are feasible;
- every collaborator and merchant has consented;
- recipient duties and shares are disclosed and total 100%;
- prohibited, misleading, or exploitative marketing is absent.

### Guardrails

- Independent pause switches for votes, payouts, vouchers, and all financial mutations.
- Alerts for rapid vote bursts, repeated failed debits, treasury spikes, unusual payout concentration, and reconciliation differences.
- No destructive admin operation; corrections are compensating entries.
- Two-person approval is required in production for treasury spending, token issuance, contract upgrades, and high-value payouts.
- Prototype high-value actions must be visibly labeled as single-admin and unsafe for production.

### Disputes

Categories are `failed_quorum`, `poor_feedback`, `fraud`, `abandonment`, `safety`, `merchant_dispute`, and `operational_failure`.

Resolution requires a release percentage, bond action, public explanation, evidence reference, administrator identity, and timestamp. Released funds follow locked shares; unreleased funds go to treasury.

## 8. Dashboard requirements

### Governance overview

- proposals by lifecycle state;
- screening backlog and aging;
- active votes with countdown, snapshot, quorum target, turnout, yes/no totals, fee volume, burn, and escrow;
- scheduled/active quests and feedback windows;
- disputed and payout-pending counts;
- conversion funnel from submitted to completed.

### Token control center

- total issued, circulating, burned, locked bonds, proposal/feedback escrow, treasury, merchant-held, rewards distributed, payouts distributed, and reconciliation difference;
- inflow/outflow and burn trends;
- treasury history, largest balances, and payout concentration;
- ledger explorer filterable by account, type, reference, actor, and date;
- prominent reconciliation warnings.

### Proposal and quest operations

- organizer, eligibility, screening evidence, location, timeline, proof rules, reward budget, merchants, sponsorships, recipients/shares, bond, vote round, audit history, and financial entries;
- checklist-backed screening actions and immutable locked terms;
- completion counts, reward liability, safety reports, feedback results, pool value, projected payout, and dispute-resolution preview.

### Merchant, risk, and audit views

- merchant verification, consent, sponsorships, voucher inventory/redemptions/revenue/exceptions;
- pause controls, alerts, immutable audit stream, and versioned governance configuration;
- configuration changes apply only to rounds opened after their effective date.

## 9. API surface

User routes cover governance configuration, proposal draft/submission/voting, Community Quest detail/feedback, wallet balance, and wallet ledger. Admin routes cover governance overview, proposal screening and transition, dispute resolution, tokenomics analytics/ledger, audit events, controls, merchants, and vouchers.

All financial mutation responses include the resulting state, fee/burn/allocation, transaction group IDs, and server timestamp.

## 10. Analytics definitions

- **Turnout:** unique valid votes ÷ eligible snapshot.
- **Approval rate:** positive votes ÷ all valid votes.
- **Proposal conversion:** completed Community Quests ÷ submitted proposals.
- **Burn rate:** JDQ burned ÷ JDQ debited for governance.
- **Treasury runway:** treasury balance ÷ trailing 30-day treasury spending.
- **Payout concentration:** share received by the largest and top five recipients.
- **Merchant conversion:** redeemed vouchers ÷ issued vouchers.
- **Reconciliation difference:** issued minus all balance buckets; must equal zero.

## 11. Security and production migration

The in-memory prototype cannot safely hold real value. Production requires PostgreSQL transactions and constraints, wallet authentication and Sybil controls, role separation, two-person approvals, monitoring, backups, contract/economic audits, and Base contract settlement for burn, escrow, treasury, bonds, vouchers, sponsorships, and payouts.

No prototype burn, balance, vote, or payout may be represented as an on-chain transaction.

## 12. Supporting implementation contracts

- Exact REST payloads, transitions, responses, and error codes: `docs/04-api/community-governance-api.md`
- PostgreSQL migration target, tables, constraints, and invariants: `docs/05-database/community-governance-schema.md`
