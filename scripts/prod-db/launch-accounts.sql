-- Plan 116 launch accounts (owner 2026-11-20: "we start over the accounts, every user to 0 xp,
-- 0 tokens, 0 all"; "remove test seeded accounts and everyone has to login again"). One transaction.
-- Run after the carry, before finalize. Progress/economy tables are already empty (carry manifest D2).
\set ON_ERROR_STOP on
BEGIN;
-- 1. Seeded fixture accounts: no password and no login identity, so nobody can sign in as them.
WITH gone AS (
  DELETE FROM users u
   WHERE NOT EXISTS (SELECT 1 FROM password_credentials p WHERE p.user_id = u.id)
     AND NOT EXISTS (SELECT 1 FROM auth_identities a WHERE a.user_id = u.id)
  RETURNING 1)
SELECT count(*) AS fixture_accounts_removed FROM gone;

-- 2. Everyone starts at zero. Profile (name, handle, avatar, home town) is kept.
WITH z AS (
  UPDATE users SET demo_points = 0, scout_reputation = 0, featured_badges = '{}', favorite_spot_id = NULL,
                   updated_at = now()
   WHERE demo_points <> 0 OR scout_reputation <> 0 OR cardinality(featured_badges) > 0 OR favorite_spot_id IS NOT NULL
  RETURNING 1)
SELECT count(*) AS accounts_zeroed FROM z;

-- 3. Everyone signs in again: bump the session epoch so any token issued by the old database is
--    refused (sessions/refresh tokens are not carried either).
WITH s AS (UPDATE users SET session_epoch = session_epoch + 1 RETURNING 1)
SELECT count(*) AS sessions_invalidated FROM s;

-- Proof: nothing left that holds progress or money for a user.
SELECT (SELECT count(*) FROM users) AS users,
       (SELECT count(*) FROM users WHERE demo_points <> 0 OR scout_reputation <> 0) AS users_nonzero,
       (SELECT count(*) FROM progression_totals) AS progression_rows,
       (SELECT count(*) FROM stamp_balances) AS stamp_rows,
       (SELECT count(*) FROM economic_accounts WHERE user_id IS NOT NULL OR balance_minor <> 0) AS money_rows,
       (SELECT count(*) FROM user_cosmetics) AS cosmetics_rows,
       (SELECT count(*) FROM achievement_awards) AS badge_rows;
COMMIT;
