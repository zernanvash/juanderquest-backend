-- Runtime prototype tables: merchants, vouchers, redemptions, governance snapshot.

CREATE TABLE IF NOT EXISTS merchants (
    id TEXT PRIMARY KEY,
    name VARCHAR(200) NOT NULL,
    location VARCHAR(200) NOT NULL,
    description TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS vouchers (
    id TEXT PRIMARY KEY,
    merchant_id TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    title VARCHAR(200) NOT NULL,
    description TEXT NOT NULL,
    cost_points INT NOT NULL CHECK (cost_points > 0),
    is_active BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS redemptions (
    id TEXT PRIMARY KEY,
    voucher_id TEXT NOT NULL REFERENCES vouchers(id),
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code VARCHAR(50) UNIQUE NOT NULL,
    cost_points INT NOT NULL,
    idempotency_key TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_redemptions_user ON redemptions(user_id);

-- Single-row JSONB snapshot of the governance store (off-chain prototype durability).
CREATE TABLE IF NOT EXISTS governance_snapshot (
    id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    data JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed merchants + vouchers (prototype off-chain redemptions)
INSERT INTO merchants (id, name, location, description) VALUES
('m1', 'Bangus Street Grill', 'Dagupan City, Pangasinan', 'Local grill house serving the famous Dagupan bangus (milkfish).'),
('m2', 'Bolinao Lighthouse Cafe', 'Bolinao, Pangasinan', 'Cafe beside Cape Bolinao Lighthouse with coastal views.'),
('m3', 'Alaminos Souvenir Hub', 'Alaminos City, Pangasinan', 'Souvenir shop near the Hundred Islands ferry port.')
ON CONFLICT (id) DO NOTHING;

INSERT INTO vouchers (id, merchant_id, title, description, cost_points, is_active) VALUES
('v1', 'm1', 'P50 Off Bangus Meal', 'Discount voucher valid for one meal at Bangus Street Grill.', 100, TRUE),
('v2', 'm2', 'Free Iced Coffee', 'Free iced coffee at Bolinao Lighthouse Cafe.', 60, TRUE),
('v3', 'm3', '15% Off Souvenirs', '15% discount on a single souvenir item at Alaminos Souvenir Hub.', 80, TRUE)
ON CONFLICT (id) DO NOTHING;
