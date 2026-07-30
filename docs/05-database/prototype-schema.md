# Prototype Database Schema — JuanderQuest

**Database Engine:** PostgreSQL 15+  

---

## 1. Entity Relationship Overview

```
users (1) <─────── (N) submissions (N) ───────> (1) quests
```

---

## 2. Table Schemas

### 2.1 `users`
Stores demo users, roles, and accumulative off-chain demo points.

```sql
CREATE TYPE user_role AS ENUM ('user', 'admin');

CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    seed_id VARCHAR(50) UNIQUE NOT NULL,
    display_name VARCHAR(100) NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    avatar_url TEXT,
    role user_role NOT NULL DEFAULT 'user',
    demo_points INT NOT NULL DEFAULT 0 CHECK (demo_points >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_users_seed_id ON users(seed_id);
```

---

### 2.2 `quests`
Stores Pangasinan tourist destinations, categories, target GPS coordinates, and AR marker references.

```sql
CREATE TYPE quest_category AS ENUM ('eco', 'cultural', 'food_trade');

CREATE TABLE quests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title VARCHAR(200) NOT NULL,
    description TEXT NOT NULL,
    category quest_category NOT NULL,
    location_name VARCHAR(200) NOT NULL,
    gps_lat DOUBLE PRECISION NOT NULL,
    gps_lng DOUBLE PRECISION NOT NULL,
    radius_meters INT NOT NULL DEFAULT 200,
    reward_points INT NOT NULL DEFAULT 50,
    marker_code VARCHAR(100) UNIQUE NOT NULL,
    marker_image_url TEXT NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_quests_category ON quests(category);
CREATE INDEX idx_quests_active ON quests(is_active) WHERE is_active = TRUE;
```

---

### 2.3 `submissions`
Stores verification proofs submitted by mobile users and administrative review outcomes.

```sql
CREATE TYPE submission_status AS ENUM ('pending', 'approved', 'rejected');

CREATE TABLE submissions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    idempotency_key UUID UNIQUE NOT NULL,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    quest_id UUID NOT NULL REFERENCES quests(id) ON DELETE CASCADE,
    scanned_marker_code VARCHAR(100) NOT NULL,
    captured_lat DOUBLE PRECISION NOT NULL,
    captured_lng DOUBLE PRECISION NOT NULL,
    captured_accuracy DOUBLE PRECISION NOT NULL,
    status submission_status NOT NULL DEFAULT 'pending',
    rejection_reason TEXT,
    reviewed_by UUID REFERENCES users(id),
    reviewed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_submissions_user ON submissions(user_id);
CREATE INDEX idx_submissions_quest ON submissions(quest_id);
CREATE INDEX idx_submissions_status ON submissions(status);

-- Enforce strictly ONE approved submission per user per quest
CREATE UNIQUE INDEX idx_submissions_unique_approved 
ON submissions(user_id, quest_id) 
WHERE status = 'approved';
```

---

## 3. Seed SQL Data (`seeds/development.sql`)

```sql
-- Seed Users
INSERT INTO users (id, seed_id, display_name, email, avatar_url, role, demo_points) VALUES
('11111111-1111-1111-1111-111111111111', 'user-1', 'Juan Dela Cruz', 'juan@juanderquest.ph', 'https://api.dicebear.com/7.x/avataaars/svg?seed=Juan', 'user', 100),
('22222222-2222-2222-2222-222222222222', 'admin-1', 'Pangasinan Admin', 'admin@pangasinan.gov.ph', 'https://api.dicebear.com/7.x/avataaars/svg?seed=Admin', 'admin', 0);

-- Seed Pangasinan Quests
INSERT INTO quests (id, title, description, category, location_name, gps_lat, gps_lng, radius_meters, reward_points, marker_code, marker_image_url) VALUES
(
  'q1111111-1111-1111-1111-111111111111',
  'Hundred Islands Eco Trek',
  'Visit Governor''s Island viewing deck in Alaminos City and scan the eco-marker.',
  'eco',
  'Alaminos City, Pangasinan',
  16.2063,
  119.9706,
  150,
  50,
  'MARKER_HUNDRED_ISLANDS_01',
  'https://raw.githubusercontent.com/JuanderQuest/assets/main/markers/hundred_islands.png'
),
(
  'q2222222-2222-2222-2222-222222222222',
  'Bolinao Lighthouse Cultural Heritage',
  'Explore Cape Bolinao Lighthouse built in 1905 and scan the heritage marker.',
  'cultural',
  'Bolinao, Pangasinan',
  16.3885,
  119.9095,
  200,
  75,
  'MARKER_BOLINAO_LIGHTHOUSE_01',
  'https://raw.githubusercontent.com/JuanderQuest/assets/main/markers/bolinao_lighthouse.png'
),
(
  'q3333333-3333-3333-3333-333333333333',
  'Manaoag Shrine Pilgrimage',
  'Visit the Minor Basilica of Our Lady of the Rosary of Manaoag.',
  'cultural',
  'Manaoag, Pangasinan',
  16.0436,
  120.4867,
  100,
  60,
  'MARKER_MANAOAG_SHRINE_01',
  'https://raw.githubusercontent.com/JuanderQuest/assets/main/markers/manaoag.png'
),
(
  'q4444444-4444-4444-4444-444444444444',
  'Lingayen Gulf Beach & Capitol Park',
  'Discover the historic Pangasinan Provincial Capitol and beach park.',
  'cultural',
  'Lingayen, Pangasinan',
  16.0232,
  120.2312,
  250,
  40,
  'MARKER_LINGAYEN_CAPITOL_01',
  'https://raw.githubusercontent.com/JuanderQuest/assets/main/markers/lingayen.png'
),
(
  'q5555555-5555-5555-5555-555555555555',
  'Dagupan Bangus Taste & Trade Trail',
  'Scan the culinary marker at the famous Dagupan City fish port marketplace.',
  'food_trade',
  'Dagupan City, Pangasinan',
  16.0433,
  120.3334,
  150,
  50,
  'MARKER_DAGUPAN_BANGUS_01',
  'https://raw.githubusercontent.com/JuanderQuest/assets/main/markers/dagupan_bangus.png'
);
```
