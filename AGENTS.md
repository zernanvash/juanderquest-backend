# JuanderQuest — AGENTS.md

## What this is

Flutter mobile app + Express REST API + React admin dashboard for "JuanDerQuest: A Gamified Blockchain-based System for Promoting Tourist Destinations in Pangasinan."

**Current status:** Prototype phase. Blockchain, tokens, NFTs, DAO, merchants, and offline sync are deferred. See `docs/01-requirements/prototype-scope.md` for the exact boundary.

## Authors

- Ana Victoria V. Alentajan, Zernan Vash L. Arive, Clarissa Angel A. Gutlay, Carl Jacob Lavaro, Alyana Soriano
- School of Information Technology Education, Universidad de Dagupan

## Prototype scope summary

| Layer | Status |
|---|---|
| Flutter mobile app (Android) | Built, APK ready |
| Express REST API (TypeScript) | Running on Azure VM |
| React admin dashboard | Deployed via Nginx |
| Seeded demo auth (user-1, admin-1) | Implemented |
| Quest CRUD (in-memory) | Implemented |
| GPS radius validation | Server-enforced |
| Submission + admin review | Implemented |
| Off-chain demo points | Implemented |
| Simulated AR marker experience | Placeholder (timer-based) |
| PostgreSQL | Configured but unused (in-memory store active) |
| **Blockchain, wallets, NFTs, DAO, merchants** | **Deferred** |

## Deployed endpoints

| Service | URL |
|---|---|
| API | `https://jdq.zernanvash.dev/api/v1` |
| Admin dashboard | `https://jdq.zernanvash.dev/` |
| Figma Prototype | `https://www.figma.com/proto/iMNm3VkAJBUous8NLoZHSj/JuanDerQuest?node-id=70-251` |
| Personal site | `https://zernanvash.dev/` |
| Flutter APK | `juanderquest_app/build/app/outputs/flutter-apk/app-debug.apk` |

Run the backend locally: `cd backend && npm run dev` (port 4000).  
Build APK with custom URL: `flutter build apk --debug --dart-define=API_BASE_URL=<url>`.

## Directory layout

```
JuanderQuest/
├── AGENTS.md                     ← this file
├── .gitignore
├── docs/                         ← system design documentation + dev tracking
│   ├── 01-requirements/          ← prototype-scope.md, requirements
│   ├── 02-architecture/          ← system diagrams, phasing
│   ├── 03-ui-ux/                 ← design-handoff-brief.md, UI specs
│   ├── 04-api/                   ← API contracts
│   ├── 05-database/              ← schema docs
│   ├── 06-blockchain/            ← (empty — blockchain deferred)
│   ├── 07-testing/               ← acceptance criteria
│   ├── 08-security/              ← threat model, security decisions
│   └── dev-journal.md            ← chronological development log
├── implementation_plans/         ← execution plans for each milestone
│   ├── 01-prototype-scaffold-plan.md
│   └── 02-network-and-qa-fixes.md
├── .brain/                       ← Obsidian second brain vault
│   ├── .obsidian/
│   ├── Architecture/
│   ├── Flutter/
│   ├── Blockchain/               ← (empty)
│   ├── Backend/
│   ├── Database/
│   ├── Testing/
│   ├── Security/
│   └── Workflow/
├── backend/                      ← Express + TypeScript REST API
│   ├── src/
│   ├── migrations/
│   ├── seeds/
│   ├── tests/
│   └── dist/
├── dashboard/                    ← React + Vite admin dashboard
│   └── src/
├── juanderquest_app/             ← Flutter project
│   ├── lib/
│   ├── android/
│   ├── ios/
│   └── test/
└── contracts/                    ← (empty — blockchain deferred)
```

## Key technical decisions

| Decision | Choice | Rationale |
|---|---|---|
| State management | Riverpod | Established Flutter standard |
| Navigation | go_router | Declarative, deep-link capable |
| HTTP client | Dio | Interceptors, timeouts, token injection |
| Backend framework | Express | Majority documented choice |
| API validation | Zod | Type-safe request validation |
| Backend runtime | Node.js 22 on Azure VM | pm2-managed, Nginx reverse-proxy |
| SSL | Let's Encrypt via Certbot | Automatic renewal |
| Deployment | Azure VM (Southeast Asia) | WireGuard → Tailscale → public domain |
| Mobile API config | `--dart-define=API_BASE_URL=` | Build-time constant, no runtime switching |
| AR | Simulated (2D timer animation) | Real AR deferred; QR package risk avoided |
| Storage | In-memory arrays | PostgreSQL configured but unwired for prototype speed |

## QA fixes applied (2026-07-30)

1. GPS radius enforced server-side (422 OUT_OF_RANGE)
2. Idempotency scoped per authenticated user
3. State transitions: pending → approved/rejected only (no double-approve)
4. Duplicate completions blocked (409 ALREADY_COMPLETED)
5. Removed fabricated GPS fallback coordinates
6. Removed fake login success on network error
7. Removed fake submission fallback (Hundred Islands mock)
8. Added `findSubmissionById` for admin transition checks
9. Submit button disabled when GPS unavailable
10. Platform permissions: INTERNET, FINE_LOCATION, COARSE_LOCATION, CAMERA
11. Cleartext HTTP permitted for VPN prototype

## Workflow notes

- **RTK (Rust Token Killer):** ALL agentic coding assistants (Antigravity, Claude Code, Gemini CLI, etc.) working in this codebase MUST use `rtk` to prefix shell commands (e.g. `rtk git status`, `rtk flutter analyze`, `rtk npm test`) to filter command output and save context tokens (see `.agents/rules/antigravity-rtk-rules.md`).
- **Plan first:** Implementation plans go in `implementation_plans/` before execution.
- **Log changes:** Append to `docs/dev-journal.md` with date heading.
- **Documentation-first still applies** for new features. Prototype code preceded some docs; catch up docs before expanding scope.
- When the backend is updated, push to VM: `git push vm master` then SSH and rebuild.
- `.brain/` should be updated when significant architecture changes occur.

## `docs/` vs `.brain/`

| Path | Purpose |
|------|---------|
| `docs/` | System design specs + dev journal |
| `.brain/` | Second-brain vault for agents — code summaries, architecture decisions, module maps, gotchas. Updated continuously during dev. |

## Repo conventions

- Flutter project: `juanderquest_app/`
- Backend: `backend/`
- Dashboard: `dashboard/`
- Smart contracts: `contracts/` (empty, deferred)
- Implementation plans: `implementation_plans/`
- Documentation: `docs/`
- Agentic reference: `.brain/` (Obsidian vault)
- Dev journal: `docs/dev-journal.md`
- `.brain/` is an Obsidian vault — open it directly in Obsidian
