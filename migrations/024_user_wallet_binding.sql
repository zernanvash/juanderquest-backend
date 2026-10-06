-- Migration 024: Add wallet_address column to users table and unique index for progressive Web3 binding

ALTER TABLE users ADD COLUMN IF NOT EXISTS wallet_address VARCHAR(42);

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_wallet_address_lower
    ON users (LOWER(wallet_address))
    WHERE wallet_address IS NOT NULL;
