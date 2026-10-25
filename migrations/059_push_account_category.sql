-- 059: allow the 'account' push category (quest rewards, funding, sponsorships
-- from the in-app notification inbox). Additive: existing rows are unaffected.
ALTER TABLE push_deliveries DROP CONSTRAINT IF EXISTS push_deliveries_category_check;
ALTER TABLE push_deliveries ADD CONSTRAINT push_deliveries_category_check
  CHECK (category IN ('overtaken', 'friend_activity', 'social', 'weekly_recap', 'account'));
