# API Specification — JuanderQuest

## Base

```
Base URL: /api/v1
Content-Type: application/json
Auth: Bearer <JWT> (except /auth/*)
```

## Error format

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Human-readable description",
    "details": [
      { "field": "title", "issue": "Required" }
    ]
  }
}
```

| HTTP | Error code | When |
|------|-----------|------|
| 400 | `VALIDATION_ERROR` | Invalid request body |
| 401 | `UNAUTHORIZED` | Missing or invalid JWT |
| 403 | `FORBIDDEN` | Valid JWT but wrong role |
| 404 | `NOT_FOUND` | Resource doesn't exist |
| 409 | `CONFLICT` | Duplicate, already submitted |
| 429 | `RATE_LIMITED` | Too many requests |
| 500 | `INTERNAL_ERROR` | Server fault |

## Pagination

All list endpoints use cursor-based pagination.

**Request:**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `cursor` | string | — | Opaque cursor from previous response |
| `limit` | int | 20 | Max items (1-100) |

**Response:**

```json
{
  "data": [ ... ],
  "next_cursor": "eyJsYXN0X2lkIjoxMn0=",
  "has_more": false
}
```

---

## Authentication

### `POST /auth/nonce`

Get SIWE nonce for signing. Each nonce is single-use and expires after 5 minutes.

**Request:**
```json
{
  "wallet_address": "0x..."
}
```

**Response `200`:**
```json
{
  "nonce": "a1b2c3d4-e5f6-...",
  "message": "JuanderQuest wants you to sign in with your Ethereum account:\n0x...\n\nI accept the Terms of Service.\n\nURI: https://juanderquest.app\nVersion: 1\nChain ID: 8453\nNonce: a1b2c3d4-e5f6-...\nIssued At: 2026-07-22T00:00:00Z"
}
```

### `POST /auth/login`

Submit signed SIWE message to obtain JWT. Creates user if first time.

**Request:**
```json
{
  "wallet_address": "0x...",
  "signature": "0x...",
  "message": "JuanderQuest wants you to sign in...",
  "display_name": "TravelerJane"
}
```

`display_name` is required only on first registration (profile creation).

**Response `200`:**
```json
{
  "token": "eyJhbGciOiJIUzI1NiIs...",
  "user": {
    "id": "uuid",
    "wallet_address": "0x...",
    "display_name": "TravelerJane",
    "avatar_url": "https://ipfs.io/ipfs/Qm...",
    "role": "user",
    "created_at": "2026-07-22T00:00:00Z"
  }
}
```

### `GET /auth/me`

Get currently authenticated user profile.

**Auth:** Required

**Response `200`:**
```json
{
  "id": "uuid",
  "wallet_address": "0x...",
  "display_name": "TravelerJane",
  "avatar_url": null,
  "role": "user",
  "created_at": "2026-07-22T00:00:00Z"
}
```

### `PATCH /auth/me`

Update own profile.

**Auth:** Required

**Request:**
```json
{
  "display_name": "NewName",
  "avatar_url": "https://ipfs.io/ipfs/Qm..."
}
```

---

## Quests

### `GET /quests`

List quests with optional filters. Only returns active quests.

**Auth:** Optional

| Query | Type | Description |
|-------|------|-------------|
| `category` | enum | `eco`, `cultural`, `food_trade` |
| `difficulty` | int | Hidden difficulty tier (1-5) |
| `lat`, `lng` | float | Center point for proximity sort |
| `radius` | float | Max distance in km from center |
| `cursor` | string | Pagination cursor |
| `limit` | int | Items per page (default 20) |

**Response `200`:**
```json
{
  "data": [
    {
      "id": "uuid",
      "title": "Hundred Islands Eco Trek",
      "description": "Visit and document...",
      "category": "eco",
      "gps_lat": 16.2063,
      "gps_lng": 119.9706,
      "difficulty": 3,
      "reward_amount": "50",
      "qr_preview": "https://api.juanderquest.app/qrs/abc123.png",
      "ar_asset_cid": "Qm...",
      "is_active": true,
      "created_at": "2026-07-22T00:00:00Z"
    }
  ],
  "next_cursor": "eyJsYXN0X2lkIjoxMn0=",
  "has_more": false
}
```

### `GET /quests/:id`

Single quest detail.

**Auth:** Optional

**Response `200`:** Same shape as list item.

### `POST /quests`

Create a new quest.

**Auth:** Admin required

**Request:**
```json
{
  "title": "Hundred Islands Eco Trek",
  "description": "Visit and document the biodiversity...",
  "category": "eco",
  "gps_lat": 16.2063,
  "gps_lng": 119.9706,
  "difficulty": 3,
  "reward_amount": "50",
  "ar_asset_cid": "Qm..."
}
```

Server generates the QR secret hash internally on creation. Returns the generated QR image URL.

**Response `201`:** Full quest object.

### `PUT /quests/:id`

Update quest fields. Partial update — only included fields change.

**Auth:** Admin required

**Request:** Same body shape as POST, all fields optional.

### `DELETE /quests/:id`

Soft-delete a quest (sets `is_active = false`).

**Auth:** Admin required

**Response `204`:** No body.

---

## Submissions

### `POST /submissions`

Submit a quest completion proof.

**Auth:** Required

**Request:**
```json
{
  "quest_id": "uuid",
  "proof_type": "ar",          // "ar" | "qr_gps" | "qr_gps_photo"
  "proof_payload": {
    "qr_nonce": "abc123",
    "gps_lat": 16.2063,
    "gps_lng": 119.9706,
    "interaction_hash": "0x...",      // AR only
    "photo_cid": "Qm..."              // photo fallback only
  },
  "signature": "0x..."
}
```

Server verifies: signature validity, nonce uniqueness, GPS bounding. On auto-approval (AR proof), reward is queued for distribution. On manual (QR+GPS/photo), status stays `pending_review`.

**Response `201`:**
```json
{
  "id": "uuid",
  "status": "approved",          // "approved" | "pending_review"
  "created_at": "2026-07-22T00:00:00Z"
}
```

### `GET /submissions`

List submissions. Admin sees all; user sees own.

**Auth:** Required

| Query | Type | Description |
|-------|------|-------------|
| `status` | enum | `pending_review`, `approved`, `rejected` |
| `cursor` | string | Pagination |
| `limit` | int | Items per page |

**Response `200`:** Paginated list of submission objects.

### `GET /submissions/:id`

Single submission detail.

**Auth:** Required (own submission or admin)

### `PUT /submissions/:id/verify`

Approve or reject a pending submission. Triggers reward distribution on approval.

**Auth:** Admin required

**Request:**
```json
{
  "action": "approve",       // "approve" | "reject"
  "rejection_reason": "Photo does not match destination"   // required if reject
}
```

**Response `200`:**
```json
{
  "id": "uuid",
  "status": "approved",
  "reward_tx_hash": "0x...",
  "reviewed_at": "2026-07-22T00:00:00Z"
}
```

---

## Rewards

### `GET /rewards`

User's reward history.

**Auth:** Required

| Query | Type | Description |
|-------|------|-------------|
| `cursor` | string | Pagination |
| `limit` | int | Items per page |

**Response `200`:**
```json
{
  "data": [
    {
      "id": "uuid",
      "quest_title": "Hundred Islands Eco Trek",
      "amount": "50",
      "tx_hash": "0x...",
      "status": "confirmed",
      "created_at": "2026-07-22T00:00:00Z"
    }
  ],
  "next_cursor": "...",
  "has_more": false
}
```

### `GET /rewards/:id`

Single reward detail.

**Auth:** Required (own reward or admin)

---

## Merchants

### `POST /merchants`

Register as a merchant. The authenticated user's wallet becomes the merchant's on-chain payment address. Server generates the merchant QR code.

**Auth:** Required (role promoted to merchant on approval)

**Request:**
```json
{
  "business_name": "Cafe By The Sea",
  "description": "Beachfront cafe serving local delicacies",
  "gps_lat": 16.2100,
  "gps_lng": 119.9750,
  "discount_rate": "10",
  "discount_description": "10% off when paying with 50 JDQ"
}
```

**Response `201`:**
```json
{
  "id": "uuid",
  "business_name": "Cafe By The Sea",
  "qr_code_url": "https://api.juanderquest.app/merchant-qrs/abc123.png",
  "wallet_address": "0x...",
  "is_active": true
}
```

### `GET /merchants`

List active merchants.

**Auth:** Optional

| Query | Type | Description |
|-------|------|-------------|
| `lat`, `lng` | float | Proximity sort center |
| `cursor` | string | Pagination |
| `limit` | int | Items per page |

### `GET /merchants/:id`

Single merchant detail. Includes current active discount info.

**Auth:** Optional

---

## Blockchain (Admin)

### `POST /admin/mint`

Mint JDQ tokens to the platform treasury. Gas paid by admin wallet.

**Auth:** Admin required

**Request:**
```json
{
  "amount": "1000"
}
```

**Response `200`:**
```json
{
  "tx_hash": "0x...",
  "amount": "1000"
}
```

### `POST /admin/rewards/distribute`

Manually trigger reward payout for an approved submission (fallback if auto-distribute fails).

**Auth:** Admin required

**Request:**
```json
{
  "submission_id": "uuid"
}
```

### `POST /admin/badges`

Create a new badge definition.

**Auth:** Admin required

**Request:**
```json
{
  "name": "Eco Warrior",
  "description": "Complete 10 eco quests",
  "image_uri": "https://ipfs.io/ipfs/Qm...",
  "criteria": { "type": "quest_count", "category": "eco", "count": 10 }
}
```

### `POST /admin/badges/mint`

Mint a soulbound NFT badge to a specific user. Called when admin verifies criteria met, or triggered automatically by backend.

**Auth:** Admin required

**Request:**
```json
{
  "badge_id": "uuid",
  "user_id": "uuid"
}
```

### `POST /admin/proposals`

Create a new DAO governance proposal.

**Auth:** Admin required

**Request:**
```json
{
  "title": "Fund mangrove reforestation",
  "description": "Allocate 10000 JDQ to plant 500 mangroves...",
  "voting_period_days": 7,
  "quorum_percent": 10
}
```

---

## Leaderboard

### `GET /leaderboard`

Get community rankings.

**Auth:** Optional

| Query | Type | Default | Description |
|-------|------|---------|-------------|
| `period` | enum | `all_time` | `all_time` or `weekly` |
| `cursor` | string | — | Pagination |
| `limit` | int | 20 | Items per page |

**Response `200`:**
```json
{
  "data": [
    {
      "rank": 1,
      "wallet_address": "0x...",
      "display_name": "TravelerJane",
      "avatar_url": null,
      "quests_completed": 42,
      "total_earned": "2100"
    }
  ],
  "next_cursor": "...",
  "has_more": false
}
```

---

## Badges

### `GET /badges`

All badge definitions.

**Auth:** Optional

**Response `200`:**
```json
{
  "data": [
    {
      "id": "uuid",
      "name": "Eco Warrior",
      "description": "Complete 10 eco quests",
      "image_uri": "https://ipfs.io/ipfs/Qm...",
      "is_active": true
    }
  ]
}
```

### `GET /badges/mine`

Badges earned by the authenticated user.

**Auth:** Required

**Response `200`:**
```json
{
  "data": [
    {
      "badge": { "id": "uuid", "name": "Eco Warrior", ... },
      "token_id": "42",
      "minted_at": "2026-07-22T00:00:00Z"
    }
  ]
}
```

---

## Admin Stats

### `GET /admin/stats`

Platform analytics overview.

**Auth:** Admin required

**Response `200`:**
```json
{
  "total_users": 150,
  "total_quests": 25,
  "total_submissions": 320,
  "approved_submissions": 280,
  "tokens_minted": "50000",
  "tokens_distributed": "12500",
  "active_merchants": 8,
  "weekly_active_users": 45
}
```

---

## Push Notifications

Sent by backend on events:

| Event | Payload |
|-------|---------|
| Quest approved | `{ "type": "submission_approved", "quest_title": "...", "reward_amount": "50" }` |
| Reward confirmed | `{ "type": "reward_confirmed", "amount": "50", "tx_hash": "0x..." }` |
| New quest nearby | `{ "type": "new_quest", "quest_id": "uuid", "title": "..." }` |
| Badge earned | `{ "type": "badge_earned", "badge_name": "Eco Warrior" }` |

---

## Rate limits

| Endpoint group | Limit |
|----------------|-------|
| `/auth/*` | 10 req/min |
| `/submissions` | 5 req/min per user |
| `/admin/*` | 30 req/min |
| All other | 60 req/min |
