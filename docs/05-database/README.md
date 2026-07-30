# Database Schema — JuanderQuest

## Naming conventions

- Tables: `snake_case`, plural
- Columns: `snake_case`
- Primary keys: `id UUID DEFAULT gen_random_uuid()`
- Timestamps: `created_at`, `updated_at` on every table
- Soft delete: `deleted_at TIMESTAMPTZ` (null = active)

## Entity Relationship

```
users ──1:N──> submissions ──N:1── quests
users ──1:N──> rewards ──N:1─── quests
users ──1:N──> user_badges ──N:1── badge_definitions
users ──1:1──> merchants
users ──1:N──> dao_votes
admins ──1:N──> dao_proposals
```

---

## Tables

### `users`

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `id` | `UUID` | PK, default `gen_random_uuid()` | |
| `wallet_address` | `VARCHAR(42)` | UNIQUE, NOT NULL | Checksummed hex address |
| `display_name` | `VARCHAR(50)` | | Nullable until user sets it |
| `avatar_url` | `TEXT` | | IPFS URL or null |
| `role` | `user_role` | NOT NULL, DEFAULT `'user'` | ENUM: `user`, `admin`, `merchant` |
| `siwe_nonce` | `VARCHAR(64)` | | Current valid nonce, null if none active |
| `nonce_expires_at` | `TIMESTAMPTZ` | | Nonce expiry (5 min after issue) |
| `last_login_at` | `TIMESTAMPTZ` | | |
| `created_at` | `TIMESTAMPTZ` | NOT NULL, DEFAULT `now()` | |
| `updated_at` | `TIMESTAMPTZ` | NOT NULL, DEFAULT `now()` | |
| `deleted_at` | `TIMESTAMPTZ` | | Soft delete |

```sql
CREATE TYPE user_role AS ENUM ('user', 'admin', 'merchant');

CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    wallet_address VARCHAR(42) UNIQUE NOT NULL,
    display_name VARCHAR(50),
    avatar_url TEXT,
    role user_role NOT NULL DEFAULT 'user',
    siwe_nonce VARCHAR(64),
    nonce_expires_at TIMESTAMPTZ,
    last_login_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ
);

CREATE INDEX idx_users_wallet ON users(wallet_address);
CREATE INDEX idx_users_role ON users(role);
```

### `quests`

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `id` | `UUID` | PK | |
| `title` | `VARCHAR(200)` | NOT NULL | |
| `description` | `TEXT` | NOT NULL | |
| `category` | `quest_category` | NOT NULL | ENUM: `eco`, `cultural`, `food_trade` |
| `gps_lat` | `DOUBLE PRECISION` | NOT NULL | |
| `gps_lng` | `DOUBLE PRECISION` | NOT NULL | |
| `difficulty` | `SMALLINT` | NOT NULL, DEFAULT `1` | Hidden tier 1-5 |
| `reward_amount` | `NUMERIC(78,0)` | NOT NULL, DEFAULT `0` | In wei (18 decimals) |
| `qr_secret_hash` | `VARCHAR(64)` | UNIQUE, NOT NULL | SHA-256 of QR secret |
| `qr_image_url` | `TEXT` | | Generated QR code image URL |
| `ar_asset_cid` | `TEXT` | | IPFS CID for AR 3D asset |
| `is_active` | `BOOLEAN` | NOT NULL, DEFAULT `true` | |
| `created_by` | `UUID` | FK → users.id, NOT NULL | Admin who created it |
| `created_at` | `TIMESTAMPTZ` | NOT NULL, DEFAULT `now()` | |
| `updated_at` | `TIMESTAMPTZ` | NOT NULL, DEFAULT `now()` | |
| `deleted_at` | `TIMESTAMPTZ` | | Soft delete |

```sql
CREATE TYPE quest_category AS ENUM ('eco', 'cultural', 'food_trade');

CREATE TABLE quests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title VARCHAR(200) NOT NULL,
    description TEXT NOT NULL,
    category quest_category NOT NULL,
    gps_lat DOUBLE PRECISION NOT NULL,
    gps_lng DOUBLE PRECISION NOT NULL,
    difficulty SMALLINT NOT NULL DEFAULT 1,
    reward_amount NUMERIC(78,0) NOT NULL DEFAULT 0,
    qr_secret_hash VARCHAR(64) UNIQUE NOT NULL,
    qr_image_url TEXT,
    ar_asset_cid TEXT,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_by UUID NOT NULL REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ
);

CREATE INDEX idx_quests_category ON quests(category);
CREATE INDEX idx_quests_gps ON quests(gps_lat, gps_lng);
CREATE INDEX idx_quests_active ON quests(is_active) WHERE is_active = true;
```

### `submissions`

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `id` | `UUID` | PK | |
| `user_id` | `UUID` | FK → users.id, NOT NULL | |
| `quest_id` | `UUID` | FK → quests.id, NOT NULL | |
| `proof_type` | `proof_type` | NOT NULL | ENUM: `ar`, `qr_gps`, `qr_gps_photo` |
| `proof_payload` | `JSONB` | NOT NULL | Contains nonce, GPS, interaction_hash, photo_cid |
| `signature` | `VARCHAR(132)` | NOT NULL | User's wallet signature |
| `status` | `submission_status` | NOT NULL, DEFAULT `'pending_review'` | ENUM: `pending_review`, `approved`, `rejected` |
| `reviewed_by` | `UUID` | FK → users.id | Admin who reviewed |
| `rejection_reason` | `TEXT` | | Required if rejected |
| `reviewed_at` | `TIMESTAMPTZ` | | |
| `created_at` | `TIMESTAMPTZ` | NOT NULL, DEFAULT `now()` | |
| `updated_at` | `TIMESTAMPTZ` | NOT NULL, DEFAULT `now()` | |

```sql
CREATE TYPE proof_type AS ENUM ('ar', 'qr_gps', 'qr_gps_photo');
CREATE TYPE submission_status AS ENUM ('pending_review', 'approved', 'rejected');

CREATE TABLE submissions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id),
    quest_id UUID NOT NULL REFERENCES quests(id),
    proof_type proof_type NOT NULL,
    proof_payload JSONB NOT NULL,
    signature VARCHAR(132) NOT NULL,
    status submission_status NOT NULL DEFAULT 'pending_review',
    reviewed_by UUID REFERENCES users(id),
    rejection_reason TEXT,
    reviewed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_submissions_user ON submissions(user_id);
CREATE INDEX idx_submissions_quest ON submissions(quest_id);
CREATE INDEX idx_submissions_status ON submissions(status);
-- Prevent duplicate approved submissions
CREATE UNIQUE INDEX idx_submissions_unique_approved ON submissions(user_id, quest_id) WHERE status = 'approved';
```

### `rewards`

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `id` | `UUID` | PK | |
| `user_id` | `UUID` | FK → users.id, NOT NULL | |
| `quest_id` | `UUID` | FK → quests.id, NOT NULL | |
| `submission_id` | `UUID` | FK → submissions.id, UNIQUE, NOT NULL | One reward per approved submission |
| `amount` | `NUMERIC(78,0)` | NOT NULL | In wei |
| `tx_hash` | `VARCHAR(66)` | | On-chain transaction hash, null if pending |
| `status` | `reward_status` | NOT NULL, DEFAULT `'pending'` | ENUM: `pending`, `confirmed`, `failed` |
| `retry_count` | `SMALLINT` | NOT NULL, DEFAULT `0` | |
| `created_at` | `TIMESTAMPTZ` | NOT NULL, DEFAULT `now()` | |
| `updated_at` | `TIMESTAMPTZ` | NOT NULL, DEFAULT `now()` | |

```sql
CREATE TYPE reward_status AS ENUM ('pending', 'confirmed', 'failed');

CREATE TABLE rewards (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id),
    quest_id UUID NOT NULL REFERENCES quests(id),
    submission_id UUID UNIQUE NOT NULL REFERENCES submissions(id),
    amount NUMERIC(78,0) NOT NULL,
    tx_hash VARCHAR(66),
    status reward_status NOT NULL DEFAULT 'pending',
    retry_count SMALLINT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_rewards_user ON rewards(user_id);
CREATE INDEX idx_rewards_status ON rewards(status);
```

### `merchants`

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `id` | `UUID` | PK | |
| `user_id` | `UUID` | FK → users.id, UNIQUE, NOT NULL | One merchant profile per user |
| `business_name` | `VARCHAR(200)` | NOT NULL | |
| `description` | `TEXT` | | |
| `gps_lat` | `DOUBLE PRECISION` | NOT NULL | |
| `gps_lng` | `DOUBLE PRECISION` | NOT NULL | |
| `discount_rate` | `NUMERIC(5,2)` | NOT NULL | Percentage e.g. 10.00 |
| `discount_description` | `TEXT` | | Terms e.g. "10% off with 50 JDQ" |
| `discount_token_cost` | `NUMERIC(78,0)` | | JDQ cost to unlock discount, in wei |
| `qr_secret_hash` | `VARCHAR(64)` | UNIQUE, NOT NULL | |
| `qr_image_url` | `TEXT` | | Generated QR for merchant |
| `is_active` | `BOOLEAN` | NOT NULL, DEFAULT `true` | |
| `created_at` | `TIMESTAMPTZ` | NOT NULL, DEFAULT `now()` | |
| `updated_at` | `TIMESTAMPTZ` | NOT NULL, DEFAULT `now()` | |
| `deleted_at` | `TIMESTAMPTZ` | | |

```sql
CREATE TABLE merchants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID UNIQUE NOT NULL REFERENCES users(id),
    business_name VARCHAR(200) NOT NULL,
    description TEXT,
    gps_lat DOUBLE PRECISION NOT NULL,
    gps_lng DOUBLE PRECISION NOT NULL,
    discount_rate NUMERIC(5,2) NOT NULL,
    discount_description TEXT,
    discount_token_cost NUMERIC(78,0),
    qr_secret_hash VARCHAR(64) UNIQUE NOT NULL,
    qr_image_url TEXT,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ
);

CREATE INDEX idx_merchants_gps ON merchants(gps_lat, gps_lng);
```

### `badge_definitions`

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `id` | `UUID` | PK | |
| `name` | `VARCHAR(100)` | NOT NULL | |
| `description` | `TEXT` | NOT NULL | |
| `image_uri` | `TEXT` | NOT NULL | IPFS URL |
| `criteria` | `JSONB` | NOT NULL | `{ "type": "quest_count", "category": "eco", "count": 10 }` |
| `is_active` | `BOOLEAN` | NOT NULL, DEFAULT `true` | |
| `created_by` | `UUID` | FK → users.id, NOT NULL | Admin who defined it |
| `created_at` | `TIMESTAMPTZ` | NOT NULL, DEFAULT `now()` | |
| `updated_at` | `TIMESTAMPTZ` | NOT NULL, DEFAULT `now()` | |

```sql
CREATE TABLE badge_definitions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(100) NOT NULL,
    description TEXT NOT NULL,
    image_uri TEXT NOT NULL,
    criteria JSONB NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_by UUID NOT NULL REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### `user_badges`

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `id` | `UUID` | PK | |
| `user_id` | `UUID` | FK → users.id, NOT NULL | |
| `badge_id` | `UUID` | FK → badge_definitions.id, NOT NULL | |
| `token_id` | `NUMERIC(78,0)` | UNIQUE | On-chain ERC-5192 token ID |
| `tx_hash` | `VARCHAR(66)` | | Mint transaction |
| `minted_at` | `TIMESTAMPTZ` | NOT NULL, DEFAULT `now()` | |

```sql
CREATE TABLE user_badges (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id),
    badge_id UUID NOT NULL REFERENCES badge_definitions(id),
    token_id NUMERIC(78,0) UNIQUE,
    tx_hash VARCHAR(66),
    minted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_user_badges_user ON user_badges(user_id);
CREATE UNIQUE INDEX idx_user_badges_unique ON user_badges(user_id, badge_id);
```

### `dao_proposals`

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `id` | `UUID` | PK | |
| `title` | `VARCHAR(200)` | NOT NULL | |
| `description` | `TEXT` | NOT NULL | |
| `target_amount` | `NUMERIC(78,0)` | | JDQ amount requested, in wei |
| `voting_start` | `TIMESTAMPTZ` | NOT NULL | |
| `voting_end` | `TIMESTAMPTZ` | NOT NULL | |
| `quorum_percent` | `NUMERIC(5,2)` | NOT NULL | |
| `status` | `proposal_status` | NOT NULL, DEFAULT `'active'` | ENUM: `active`, `passed`, `rejected`, `executed` |
| `created_by` | `UUID` | FK → users.id, NOT NULL | |
| `on_chain_id` | `INTEGER` | | Proposal ID on DAO contract |
| `created_at` | `TIMESTAMPTZ` | NOT NULL, DEFAULT `now()` | |
| `updated_at` | `TIMESTAMPTZ` | NOT NULL, DEFAULT `now()` | |

```sql
CREATE TYPE proposal_status AS ENUM ('active', 'passed', 'rejected', 'executed');

CREATE TABLE dao_proposals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title VARCHAR(200) NOT NULL,
    description TEXT NOT NULL,
    target_amount NUMERIC(78,0),
    voting_start TIMESTAMPTZ NOT NULL,
    voting_end TIMESTAMPTZ NOT NULL,
    quorum_percent NUMERIC(5,2) NOT NULL,
    status proposal_status NOT NULL DEFAULT 'active',
    created_by UUID NOT NULL REFERENCES users(id),
    on_chain_id INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_proposals_status ON dao_proposals(status);
```

### `dao_votes`

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `id` | `UUID` | PK | |
| `proposal_id` | `UUID` | FK → dao_proposals.id, NOT NULL | |
| `voter_address` | `VARCHAR(42)` | NOT NULL | Wallet address of voter |
| `weight` | `NUMERIC(78,0)` | NOT NULL | JDQ token balance at vote time |
| `choice` | `BOOLEAN` | NOT NULL | `true` = for, `false` = against |
| `tx_hash` | `VARCHAR(66)` | | On-chain vote transaction |
| `created_at` | `TIMESTAMPTZ` | NOT NULL, DEFAULT `now()` | |

```sql
CREATE TABLE dao_votes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    proposal_id UUID NOT NULL REFERENCES dao_proposals(id),
    voter_address VARCHAR(42) NOT NULL,
    weight NUMERIC(78,0) NOT NULL,
    choice BOOLEAN NOT NULL,
    tx_hash VARCHAR(66),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_votes_proposal ON dao_votes(proposal_id);
CREATE UNIQUE INDEX idx_votes_unique ON dao_votes(proposal_id, voter_address);
```

---

## Migration strategy

- Sequential SQL migration files: `001_init.sql`, `002_add_indexes.sql`, etc.
- Run via `node-pg-migrate` or `drizzle-kit` on backend startup
- Local dev: reset via `npm run db:reset` (drop + recreate + seed)

## Seed data

Required seeds for local development:

```sql
-- First admin (wallet set via env var in seed script)
INSERT INTO users (wallet_address, display_name, role)
VALUES ($ADMIN_WALLET, 'Platform Admin', 'admin');

-- Sample quests for testing
INSERT INTO quests (title, description, category, gps_lat, gps_lng, difficulty, reward_amount, qr_secret_hash, created_by)
VALUES
  ('Hundred Islands Eco Trek', '...', 'eco', 16.2063, 119.9706, 2, 50000000000000000000, 'abc...', $ADMIN_ID),
  ('Bolinao Falls Adventure', '...', 'eco', 16.3885, 119.9095, 3, 75000000000000000000, 'def...', $ADMIN_ID);
```

---

## TBD placeholders

| Item | Decided in |
|------|------------|
| GPS tolerance threshold (stored in app config, not DB) | Testing phase |
| QR code rotation policy | Blockchain/tokenomics phase |
| DAO quorum/voting period defaults | Blockchain phase |
| Tokenomics (reward amounts, supply) | Blockchain phase |
