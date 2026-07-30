# Prototype Scaffold Plan — JuanderQuest

**Created:** 2026-07-30 09:26
**Status:** Approved — proceed to documentation gate

---

## Goal

Deliver one demonstrable end-to-end showcase flow:

> **Seeded login → browse quest → scan marker → show AR overlay → capture GPS → submit proof → admin approves in web dashboard → user receives demo points**

Blockchain, wallet login, tokens, NFTs, DAO, merchants, and offline sync are deferred.

---

## Prototype Boundary

| Include | Exclude |
|---|---|
| Demo seeded user login | WalletConnect / SIWE |
| Quest list & detail | Blockchain contracts |
| Marker-tracking AR overlay | Base / Base Sepolia integration |
| GPS capture with explicit permission | JDQ token minting / transfer |
| Quest submission with idempotency key | NFT badges |
| Admin approve / reject via web dashboard | DAO proposals & voting |
| Off-chain demo points | Merchant payment / redemption |
| Local PostgreSQL | IPFS |
| Express REST API | Push notifications |
| React + Vite admin dashboard | Production deployment / monitoring |
| Android API 26+ | iOS AR validation (iOS scaffold only) |
| | Photo uploads / image recognition |
| | Offline queue |
| | Full admin analytics |

---

## Quest & Submission State Machine

```
                 ┌──────────┐
                 │  PENDING │
                 └────┬─────┘
                      │
              ┌───────┴───────┐
              ▼               ▼
         ┌─────────┐    ┌─────────┐
         │APPROVED │    │REJECTED │
         └─────────┘    └─────────┘
```

- Every submission starts `pending`.
- Admin may transition to `approved` or `rejected`.
- One approved submission per user per quest (enforced server-side).
- Approval awards demo points.

---

## Phases

### 1. Documentation Gate

Before any code:

1. Write `docs/01-requirements/prototype-scope.md` — explicit deferral list.
2. Update API docs — replace wallet auth with demo-login, strip blockchain fields.
3. Update database schema — trim to `users`, `quests`, `submissions`, add off-chain points.
4. Finalize seeded-demo-user model (role, name, avatar fields).
5. Define AR marker specs (printed marker format, overlay type).
6. Write UI/UX flow doc — screen inventory, navigation map, permission states.
7. Update security doc — GPS radius, QR challenge lifetime, JWT duration.
8. Write `docs/07-testing/prototype-acceptance.md` — one-pass criteria.
9. Reconcile offline contradiction (online-only for prototype).

### 2. Backend Foundation

`backend/`

- Node.js 20, TypeScript 5, Express
- tsx for dev runner
- Zod request validation
- PostgreSQL via `pg` + SQL migrations (no ORM yet)
- Environment validation with `envalid`
- CORS, rate limiting, JSON error envelope
- Health endpoint `GET /api/v1/health`

**Tables:** `users`, `quests`, `submissions`

**Seed data:** 1 admin, 1 regular user, 5+ Pangasinan quests with AR marker references and GPS coordinates.

**API surface:**

```
POST   /api/v1/auth/demo-login    → set demo user by seed ID
GET    /api/v1/auth/me            → current user + demo points

GET    /api/v1/quests             → list (filterable by category)
GET    /api/v1/quests/:id         → detail with AR/QR metadata

POST   /api/v1/submissions        → create (idempotency UUID)
GET    /api/v1/submissions        → user's own submissions
GET    /api/v1/submissions/:id    → single submission detail

GET    /api/v1/admin/submissions  → all pending submissions
PATCH  /api/v1/admin/submissions/:id  → approve / reject
```

**Tests:** minimal Jest suite — auth flow, quest fetch, submission creation, admin state change.

### 3. Admin Dashboard

`dashboard/` — React 18 + Vite + TypeScript

**Screens:**

- Demo admin login (seed ID input)
- Pending submissions list (status filterable)
- Submission detail (proof metadata, GPS coordinates, AR marker info)
- Approve / reject action with optional reason
- Basic quest list (read-only)

No analytics, charts, merchant management, or content creation.

### 4. Flutter Foundation

`juanderquest_app/` — Flutter stable, Android target API 26+, iOS scaffold present.

**Dependencies (minimum):**

- `flutter_riverpod` / `riverpod`
- `dio` for HTTP
- `go_router` for routing
- `geolocator` for GPS
- `permission_handler`
- marker-tracking AR package (spike in Phase 5)

**Feature structure:**

```
lib/
├── app/
│   ├── app.dart
│   └── router.dart
├── core/
│   └── network/
│       └── api_client.dart
└── features/
    ├── auth/
    │   ├── models/
    │   ├── providers/
    │   └── screens/
    ├── quests/
    │   ├── models/
    │   ├── providers/
    │   └── screens/
    ├── submissions/
    │   ├── models/
    │   ├── providers/
    │   └── screens/
    └── profile/
        ├── providers/
        └── screens/
```

**Initial screens:**

- Demo login screen (select seeded user)
- Quest list (cards with category, difficulty, points)
- Quest detail (description, marker info, AR launch button)
- AR experience screen (camera view with marker recognition + overlay)
- Submission confirmation screen
- Submission history list
- Profile screen (points, badges placeholder)

**States:** loading, error, empty — every screen.

### 5. AR Spike

High-risk, earliest validation.

1. Pick a Flutter marker-tracking package
2. Confirm Android API 26 compatibility
3. Print a reference marker
4. Recognise marker → display a static image overlay
5. Test on the actual showcase device
6. If marker tracking fails, add manual QR fallback

### 6. Integration

Connect all pieces for an end-to-end test:

1. Lab demo user login
2. Load quests from Express
3. Open quest, scan marker, AR overlay
4. Capture GPS (explicit permission)
5. Submit proof
6. Open admin dashboard, view pending submission
7. Approve submission
8. Refresh Flutter — history shows approved, points increased

---

## Acceptance Criteria

- [ ] Flutter loads API-backed quests
- [ ] Showcase device recognises the printed marker
- [ ] GPS permission and failure states work
- [ ] Duplicate submissions do not award points twice
- [ ] Only admin account can review/verify submissions
- [ ] Approval updates submission status and demo points
- [ ] Rejection records a reason (shown to user)
- [ ] Backend, dashboard, and Flutter checks pass
- [ ] `.brain/` reflects the implemented architecture

---

## Deferred (explicitly out of scope)

| Item | Rationale |
|---|---|
| Solidity contracts & Base network | Blockchain excluded per brief |
| WalletConnect / SIWE | No wallet integration in prototype |
| JDQ token | No on-chain assets |
| NFT badges | Requires token + IPFS + contract |
| DAO proposals & voting | Governance out of scope |
| Merchant redemption flow | Merchant role deferred |
| Offline queue | Online-only for reliability |
| Photo uploads / IPFS | AR replaces photo evidence |
| Push notifications | No notification infra |
| Full admin analytics | KPI dashboard deferred |
| iOS AR validation | Android-first prototype |
| Cultural quizzes | No quiz entity or flow in prototype |

---

## File Likely Created

- `implementation_plans/01-prototype-scaffold-plan.md`
- `docs/01-requirements/prototype-scope.md`
- `backend/package.json`, `tsconfig.json`, `.env.example`
- `backend/src/app.ts`, `server.ts`, `config/`, `db/`, `middleware/`, `routes/`
- `backend/migrations/001_init.sql`
- `backend/seeds/development.sql`
- `dashboard/package.json`, `vite.config.ts`
- `dashboard/src/App.tsx`, `screens/`, `components/`
- `juanderquest_app/pubspec.yaml`, `analysis_options.yaml`
- `juanderquest_app/lib/main.dart`, `app/`, `core/`, `features/`
- `.brain/Flutter/App Map.md`, `.brain/Backend/API Map.md` (updated)

---

**Next step:** Begin Phase 1 — write prototype-scope.md and reconcile existing docs.
