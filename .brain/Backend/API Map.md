# API Endpoint Map

Base: `/api/v1`

## Active Prototype Endpoints (`backend/src/routes/`)

### Authentication
- `POST /auth/demo-login` → seed ID auth (`user-1` or `admin-1`), returns signed JWT.
- `GET /auth/me` → current user profile & demo points balance.

### Quests
- `GET /quests` → list active Pangasinan quests (optional `?category=eco|cultural|food_trade`).
- `GET /quests/:id` → detailed quest metadata & target marker info.

### Submissions
- `POST /submissions` → submit AR verification proof with idempotency UUID (`idempotency_key`, `quest_id`, `scanned_marker_code`, `captured_lat`, `captured_lng`, `captured_accuracy`).
- `GET /submissions` → user submission history.

### Admin Dashboard API
- `GET /admin/submissions` → list all submissions (optional `?status=pending|approved|rejected`).
- `PATCH /admin/submissions/:id` → approve or reject pending submission (updates status, calculates distance offset, awards demo points).

---

## Complete System Reference (Full Target System)
See `docs/04-api/README.md` for full production specifications (SIWE, Base L2, Merchants, DAO).
