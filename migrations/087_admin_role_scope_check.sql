-- 087: one valid (role, admin_scope) pair per account. Behaviour-preserving:
-- 'admin' + 'area' already acted as a plain admin (scope.ts:29 -> platform, no perk controls).
INSERT INTO user_role_audit(id, actor_id, target_id, old_role, new_role, old_scope, new_scope, reason)
SELECT
  gen_random_uuid(),
  'system:migration-087',
  id,
  role::text,
  role::text,
  admin_scope,
  NULL,
  '087: Area admin option removed; access unchanged'
FROM users
WHERE role = 'admin' AND admin_scope = 'area';

UPDATE users SET admin_scope = NULL, updated_at = NOW()
 WHERE role = 'admin' AND admin_scope = 'area';

UPDATE users SET admin_scope = NULL, updated_at = NOW()
 WHERE role IN ('area_admin', 'user', 'qa') AND admin_scope IS NOT NULL;

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_admin_scope_check;
ALTER TABLE users ADD CONSTRAINT users_role_admin_scope_check CHECK (
  (role = 'admin' AND (admin_scope IS NULL OR admin_scope IN ('platform', 'developer')))
  OR (role IN ('area_admin', 'user', 'qa') AND admin_scope IS NULL)
);
