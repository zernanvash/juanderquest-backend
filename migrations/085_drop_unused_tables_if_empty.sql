-- Plan 85c (D6): Drop the two unused tables only if they are empty.

DO $$
BEGIN
  IF to_regclass('auth_sessions') IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM auth_sessions LIMIT 1) THEN
      DROP TABLE auth_sessions;
    END IF;
  END IF;

  IF to_regclass('lgu_operator_scopes') IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM lgu_operator_scopes LIMIT 1) THEN
      DROP TABLE lgu_operator_scopes;
    END IF;
  END IF;
END $$;
