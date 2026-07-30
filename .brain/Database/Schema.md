# Database Schema Summary

**Active Engine:** PostgreSQL 15+ & Memory Fallback Store  
**DDL Reference:** [prototype-schema.md](file:///C:/Users/HP/Desktop/Code/JuanderQuest/docs/05-database/prototype-schema.md)  

## Prototype Tables & Indexes

### `users`
- `id` (UUID PK)
- `seed_id` (VARCHAR UNIQUE, indexed)
- `display_name`, `email`, `avatar_url`, `role` (`user` | `admin`)
- `demo_points` (INT, default 0)

### `quests`
- `id` (UUID PK)
- `title`, `description`, `category` (`eco` | `cultural` | `food_trade`)
- `location_name`, `gps_lat`, `gps_lng`, `radius_meters`
- `reward_points`, `marker_code` (VARCHAR UNIQUE), `marker_image_url`

### `submissions`
- `id` (UUID PK)
- `idempotency_key` (UUID UNIQUE)
- `user_id` (FK → users.id)
- `quest_id` (FK → quests.id)
- `scanned_marker_code`, `captured_lat`, `captured_lng`, `captured_accuracy`
- `status` (`pending` | `approved` | `rejected`)
- `rejection_reason`, `reviewed_by`, `reviewed_at`

### Unique Constraints
- `idx_submissions_unique_approved`: Partial unique index on `(user_id, quest_id)` WHERE `status = 'approved'`.
