# Community Governance API Contract

**Base:** `/api/v1`
**Auth:** Bearer JWT unless marked public
**Financial unit:** integer `mJDQ`; `1,000 mJDQ = 1 JDQ`
**Settlement:** off-chain prototype

All successful responses use `{ "success": true, "data": ... }`. Errors use `{ "success": false, "error": { "code": "...", "message": "...", "details": [] } }`.

## Public and traveler routes

### `GET /proposals`

Public. Lists proposals with lifecycle state, vote totals, snapshot/quorum, deadlines, bond, escrow, and locked payout recipients.

### `GET /proposals/config`

Public. Returns vote fees, burn basis points, bond, windows, quorum rule, vote-power rule, and settlement label.

### `GET /proposals/:id`

Public. Returns one proposal. Individual voter identities and choices are never included.

### `POST /proposals`

Creates an editable draft.

```json
{
  "title": "Patar Coastal Stewardship Quest",
  "location_name": "Bolinao, Pangasinan",
  "category": "eco",
  "description": "A guided cleanup and local ecology activity.",
  "proposed_lat": 16.324,
  "proposed_lng": 119.783,
  "recipients": [
    {
      "user_id": "user-uuid",
      "display_name": "Organizer",
      "role": "organizer",
      "duty": "Planning and operations",
      "share_bps": 7000
    },
    {
      "user_id": "merchant-user-uuid",
      "display_name": "Local Guide Cooperative",
      "role": "merchant",
      "duty": "Guides and participant safety",
      "share_bps": 3000
    }
  ]
}
```

Recipient shares must total 10,000 basis points. If omitted, the organizer receives 100%.

### `POST /proposals/:id/submit`

Moves the authenticated organizer’s `draft` to `screening`. No body.

### `POST /proposals/:id/votes`

```json
{
  "choice": "yes",
  "idempotency_key": "client-generated-unique-key"
}
```

The user must belong to the opening eligibility snapshot, have sufficient JDQ, and not have voted. The response includes `charged_mjdq`, `burned_mjdq`, `escrowed_mjdq`, `balance_mjdq`, and the updated proposal.

`POST /proposals/:id/vote` is retired and returns `410 PAID_VOTE_REQUIRED` so old clients cannot bypass economic disclosure.

### `GET /community-quests/:id`

Public. Returns a proposal after it reaches `scheduled`, including dates, feedback state, recipients, and accounting.

### `POST /community-quests/:id/feedback`

```json
{
  "choice": "approve",
  "rating": 5,
  "comment": "The organizer delivered the stated activities safely.",
  "idempotency_key": "client-generated-unique-key"
}
```

Only an approved participant in the exact quest may vote. The response reports the 2 JDQ charge, 0.4 JDQ burn, 1.6 JDQ escrow allocation, and resulting balance.

## Administrative routes

All routes below require `admin`.

### `GET /admin/governance/overview`

Returns state counts, screening backlog, active vote/quest/feedback/dispute queues, fixed governance configuration, current pause controls, and active risk alerts.

### `GET /admin/governance/proposals`

Lists complete management records.

### `GET /admin/governance/proposals/:id`

Returns proposal terms, organizer, recipients, bond, voting/feedback statistics, deadlines, screening record, and accounting.

### `POST /admin/governance/proposals/:id/screen`

```json
{
  "decision": "approve",
  "reason": "Identity, safety, location, consent, budget, and recipient checks completed.",
  "evidence_reference": "SCREEN-2026-001",
  "checklist_complete": true
}
```

Approval atomically locks the 25 JDQ organizer bond, snapshots eligible voters, calculates quorum, and opens the seven-day round. Rejection records the reason and evidence without charging a bond.

### `POST /admin/governance/proposals/:id/transition`

```json
{ "action": "close_voting", "force": false }
```

Supported actions:

| Action | Required state | Result |
|---|---|---|
| `close_voting` | `voting` | `approved`, `rejected`, or `expired` |
| `schedule` | `approved` | creates inactive quest and enters `scheduled` |
| `activate` | `scheduled` | activates quest completion |
| `open_feedback` | `active` | deactivates quest, snapshots participants, enters `feedback` |
| `close_feedback` | `feedback` | `payout_pending` or `disputed` |
| `finalize_payout` | `payout_pending` | pays locked recipients, refunds bond, enters `completed` |
| `mark_disputed` | `feedback` or `payout_pending` | enters `disputed` |

`force` exists only for prototype demonstrations and must not be exposed as a normal production action.

### `POST /admin/governance/proposals/:id/resolve`

```json
{
  "release_percent": 50,
  "bond_action": "slash_50",
  "reason": "Half of the documented program was delivered.",
  "evidence_reference": "DISPUTE-2026-004"
}
```

Release is 0–100 whole percent. Allowed bond actions are `refund`, `slash_50`, and `slash_100`. Released funds follow the locked shares; the remainder and any slash enter treasury.

### `GET /admin/tokenomics/analytics`

Returns:

- total issued;
- circulating user balance;
- burned;
- locked bonds;
- proposal and feedback escrow;
- community treasury;
- merchant-held;
- rewards and governance payouts distributed;
- governance fee volume and burn rate;
- top balances;
- reconciliation difference.

The reconciliation difference must be zero.

### `GET /admin/tokenomics/ledger`

Returns append-only entries newest first. Each contains entry ID, transaction group, type, account, signed mJDQ amount, reference, actor, idempotency key, metadata, and timestamp.

### `GET /admin/governance/audit`

Returns immutable governance events newest first, including action, actor, subject, reason, evidence reference, metadata, and time.

### `GET /admin/governance/controls`

Returns the four independent pause flags and last operator/time.

### `PUT /admin/governance/controls`

```json
{
  "pause_votes": true,
  "reason": "Investigating an abnormal vote burst."
}
```

Accepts one or more of `pause_votes`, `pause_payouts`, `pause_vouchers`, and `pause_all_financial`. A reason is always required.

## Error codes

| Code | Meaning |
|---|---|
| `PROPOSAL_NOT_FOUND` | Unknown proposal |
| `INVALID_TRANSITION` | Lifecycle action not allowed |
| `INVALID_PAYOUT_SHARES` | Recipient shares do not total 10,000 bps |
| `SCREENING_EVIDENCE_REQUIRED` | Screening reason/evidence missing |
| `CHECKLIST_INCOMPLETE` | Approval attempted without completed checks |
| `INSUFFICIENT_JDQ` | User cannot cover fee/bond |
| `NOT_ELIGIBLE` | User is absent from required eligibility set |
| `ALREADY_VOTED` | One-vote rule violation |
| `VOTING_CLOSED` / `FEEDBACK_CLOSED` | Round not open |
| `WINDOW_OPEN` | Normal close attempted before deadline |
| `IDEMPOTENCY_CONFLICT` | Key reused with a different payload |
| `VOTES_PAUSED` | Vote pause is active |
| `PAYOUTS_PAUSED` | Payout pause is active |
| `FINANCIAL_ACTIVITY_PAUSED` | Global financial pause is active |
| `RESOLUTION_EVIDENCE_REQUIRED` | Dispute record incomplete |
