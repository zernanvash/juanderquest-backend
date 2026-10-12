-- ECONOMY_REAL_PG_AUTHORITY
-- Narrow posting entry point. The caller never receives direct DML privileges
-- on economic_accounts, economic_transactions or economic_transfers.
-- A non-owner runtime role must be provisioned separately; this migration
-- creates no global role and grants no economic table writes to PUBLIC.
SELECT set_config('search_path', format('%I, pg_temp', current_schema()), true);

CREATE FUNCTION economic_post_transfer(
  p_transaction_id TEXT,
  p_event TEXT,
  p_operation TEXT,
  p_actor_id TEXT,
  p_policy_version TEXT,
  p_from_account_id TEXT,
  p_to_account_id TEXT,
  p_amount_minor BIGINT,
  p_subject_id TEXT,
  p_submission_id TEXT,
  p_idempotency_key TEXT DEFAULT NULL,
  p_request_hash TEXT DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE
  source_kind TEXT;
  source_user TEXT;
  destination_kind TEXT;
  destination_user TEXT;
  valid_source BOOLEAN := FALSE;
  reward_pool_id TEXT;
BEGIN
  IF p_amount_minor IS NULL OR p_amount_minor <= 0 OR
     p_from_account_id = p_to_account_id OR
     p_event IS NULL OR p_subject_id IS NULL THEN
    RAISE EXCEPTION 'ECONOMIC_POSTING_INVALID' USING ERRCODE = '22023';
  END IF;

  SELECT kind, user_id INTO source_kind, source_user
    FROM economic_accounts WHERE id = p_from_account_id AND asset_code = 'EXPLORER_COIN_SIM';
  SELECT kind, user_id INTO destination_kind, destination_user
    FROM economic_accounts WHERE id = p_to_account_id AND asset_code = 'EXPLORER_COIN_SIM';
  IF source_kind IS NULL OR destination_kind IS NULL THEN
    RAISE EXCEPTION 'ECONOMIC_ACCOUNT_UNAVAILABLE' USING ERRCODE = '22023';
  END IF;

  IF p_operation = 'reward' THEN
    SELECT pool_id INTO reward_pool_id FROM reward_reservations WHERE id = p_subject_id;
    PERFORM 1 FROM reward_pools WHERE id = reward_pool_id FOR UPDATE;
    PERFORM 1 FROM reward_reservations WHERE id = p_subject_id FOR UPDATE;
    IF p_event <> 'reward:' || p_subject_id OR
       p_from_account_id <> 'sim:issuance' OR source_kind <> 'issuance' OR
       destination_kind <> 'traveler' OR
       p_to_account_id <> 'sim:traveler:' || destination_user OR
       NOT EXISTS (SELECT 1 FROM users WHERE id = p_actor_id AND role = 'admin') THEN
      RAISE EXCEPTION 'ECONOMIC_REWARD_NOT_AUTHORIZED' USING ERRCODE = '42501';
    END IF;
    SELECT EXISTS (
      SELECT 1 FROM reward_reservations r
      JOIN reward_pools p ON p.id = r.pool_id
      JOIN submissions s ON s.id = p_submission_id
      WHERE r.id = p_subject_id AND r.user_id = destination_user
        AND r.status IN ('reserved', 'submitted', 'appeal')
        AND r.amount_minor = p_amount_minor AND r.scope_key = p.scope_key
        AND p.policy_version = p_policy_version AND p.asset_code = 'EXPLORER_COIN_SIM'
        AND s.user_id = r.user_id AND s.quest_id = p.quest_id
        AND s.status = 'approved'
        AND s.created_at BETWEEN r.created_at AND r.expires_at
        AND (r.submission_id IS NULL OR r.submission_id = s.id)
        AND NOT EXISTS (SELECT 1 FROM reward_awards a WHERE a.reservation_id = r.id)
    ) INTO valid_source;
  ELSIF p_operation = 'spend' THEN
    PERFORM 1 FROM users WHERE id = p_actor_id FOR UPDATE;
    IF p_event <> 'cosmetic:' || p_actor_id || ':' || p_subject_id OR
       p_policy_version <> 'cosmetic-pilot-v1' OR
       source_kind <> 'traveler' OR source_user <> p_actor_id OR
       p_from_account_id <> 'sim:traveler:' || p_actor_id OR
       p_to_account_id <> 'sim:retired' OR destination_kind <> 'retired' OR
       p_submission_id IS NOT NULL OR
       p_idempotency_key IS NULL OR length(p_idempotency_key) NOT BETWEEN 1 AND 120 OR
       p_request_hash IS NULL OR p_request_hash !~ '^[a-f0-9]{64}$' THEN
      RAISE EXCEPTION 'ECONOMIC_SPEND_NOT_AUTHORIZED' USING ERRCODE = '42501';
    END IF;
    SELECT EXISTS (
      SELECT 1 FROM economic_cosmetics c
      WHERE c.id = p_subject_id AND c.asset_code = 'EXPLORER_COIN_SIM'
        AND c.active = true AND c.cost_minor = p_amount_minor
        AND NOT EXISTS (
          SELECT 1 FROM economic_entitlements e
          WHERE e.user_id = p_actor_id AND e.cosmetic_id = c.id
        )
    ) INTO valid_source;
  ELSE
    RAISE EXCEPTION 'ECONOMIC_OPERATION_NOT_AUTHORIZED' USING ERRCODE = '42501';
  END IF;
  IF NOT valid_source THEN
    RAISE EXCEPTION 'ECONOMIC_SOURCE_NOT_ELIGIBLE' USING ERRCODE = '42501';
  END IF;

  -- Account locks have one order regardless of transfer direction.
  PERFORM 1 FROM economic_accounts
    WHERE asset_code = 'EXPLORER_COIN_SIM'
      AND id IN (p_from_account_id, p_to_account_id)
    ORDER BY id FOR UPDATE;

  INSERT INTO economic_transactions
    (id, asset_code, business_event, operation, actor_id, policy_version)
    VALUES (p_transaction_id, 'EXPLORER_COIN_SIM', p_event, p_operation, p_actor_id, p_policy_version);
  UPDATE economic_accounts SET balance_minor = balance_minor - p_amount_minor
    WHERE id = p_from_account_id
      AND (kind = 'issuance' OR balance_minor >= p_amount_minor);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'INSUFFICIENT_COINS' USING ERRCODE = '23514';
  END IF;
  UPDATE economic_accounts SET balance_minor = balance_minor + p_amount_minor
    WHERE id = p_to_account_id
      AND balance_minor::numeric + p_amount_minor::numeric <= 9223372036854775807;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'DESTINATION_ACCOUNT_UNAVAILABLE' USING ERRCODE = '23514';
  END IF;
  INSERT INTO economic_transfers
    (transaction_id, sequence, asset_code, from_account_id, to_account_id, amount_minor)
    VALUES (p_transaction_id, 1, 'EXPLORER_COIN_SIM', p_from_account_id, p_to_account_id, p_amount_minor);
  INSERT INTO economic_outbox (id, transaction_id, event_type, payload)
    VALUES (gen_random_uuid()::text, p_transaction_id, p_operation,
      jsonb_build_object('business_event', p_event, 'asset', 'EXPLORER_COIN_SIM', 'amount_minor', p_amount_minor::text));

  -- The privileged function owns the entire business transition. A caller
  -- cannot commit a transfer without its pool/award or entitlement/command.
  IF p_operation = 'reward' THEN
    UPDATE reward_pools
      SET reserved_minor = reserved_minor - p_amount_minor,
          paid_minor = paid_minor + p_amount_minor
      WHERE id = reward_pool_id AND reserved_minor >= p_amount_minor;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'REWARD_POOL_NOT_RESERVED' USING ERRCODE = '23514';
    END IF;
    UPDATE reward_reservations
      SET status = 'paid', submission_id = p_submission_id, updated_at = now()
      WHERE id = p_subject_id AND status IN ('reserved', 'submitted', 'appeal');
    IF NOT FOUND THEN
      RAISE EXCEPTION 'REWARD_RESERVATION_NOT_ACTIVE' USING ERRCODE = '23514';
    END IF;
    INSERT INTO reward_awards
      (id, reservation_id, user_id, scope_key, transaction_id, awarded_minor)
      SELECT gen_random_uuid()::text, r.id, r.user_id, r.scope_key,
        p_transaction_id, p_amount_minor
      FROM reward_reservations r WHERE r.id = p_subject_id;
  ELSE
    INSERT INTO economic_entitlements (id, user_id, cosmetic_id, transaction_id)
      VALUES (gen_random_uuid()::text, p_actor_id, p_subject_id, p_transaction_id);
    INSERT INTO economic_commands
      (actor_id, operation, idempotency_key, request_hash, transaction_id)
      VALUES (p_actor_id, 'spend', p_idempotency_key, p_request_hash, p_transaction_id);
  END IF;
END $$;

REVOKE ALL ON FUNCTION economic_post_transfer(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,BIGINT,TEXT,TEXT,TEXT,TEXT) FROM PUBLIC;
