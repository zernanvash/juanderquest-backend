# Dev Journal

## 2026-07-30 — Navigation overhaul + map migration

- Replaced inline `BottomNavigationBar` in every screen with shared `MainShell` + `StatefulShellRoute.indexedStack` (5 tabs: Home, Map, Vote, Shop, Profile).
- `PopScope` double-back-to-exit at Home root; re-tab pops to branch root.
- `AuthRefreshNotifier` (ChangeNotifier) — `GoRouter` constructed once with `refreshListenable`, redirect reads `ref.read(authProvider)`. No more router recreation on logout.
- Demo login / logout no longer calls `router.go(...)` — redirect handles it.
- AR screen → `context.push('/history')` instead of router.go.
- `QuestDetailScreen` accepts optional `questId` string, fetches `GET /quests/:id` when no `QuestModel` via `extra`.
- `LifecycleCoordinator` observes `AppLifecycleState.resumed` — refreshes profile + submissions.
- `maplibre_gl` 0.26.2: renamed `MaplibreMap` → `MapLibreMap` and `MaplibreMapController` → `MapLibreMapController`.
- APK built, deployed to VM (commit `0554704`). Backend tests 10/10, analyze clean, dashboard builds.

## 2026-07-29 — QA high-severity fixes, deployed

- Auth guards (router redirect null token → `/`), deep-link crash fix (null-safe `state.extra`), dashboard 401/403 auto-logout, quest provider fake data removal, search field wired, dashboard login error + disabled buttons.
- Commitment to offline-first foundation but only contracts (no SQLite yet).
- Notification contracts (SSE in foreground, future FCM, ID routing).
- Backpack decision notes.
- Deployed commit `d2e1666`.

## 2026-07-28 — Thesis showcase

- Application exhibited live to panelists on an Android device.
- Backend API, admin dashboard, and Flutter app functional end-to-end.
- Offline-first foundation and notification system deferred — no hard deadline.

## 2026-07-25 — Prototype functional, deployed

- Express backend: demo login, quest CRUD, GPS radius validation, submission + admin review, off-chain points.
- Flutter: login, quest list, simulated AR, GPS proof capture (camera), submission history, profile.
- React dashboard: login, pending submissions list, approve/reject.
- All deployed via Azure VM + Nginx + pm2 + Let's Encrypt.
- PostgreSQL configured but in-memory store active.
- All blockchain/crypto features deferred.
