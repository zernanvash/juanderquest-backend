# JuanderQuest Development Journal

**Started:** 2026-07-30
**Format:** Reverse chronological — newest entries first.

## 2026-07-30

### Refined Stitch UI & Design System Implemented across Mobile & Dashboard

- **Stitch Assets & Screens Fetched:** Retained and downloaded original & refined screen code & screenshots from Stitch project `4769727332745673840` into `docs/stitch_assets/` (`demo_login.html`, `quest_discovery_refined.html`, `quest_detail_refined.html`, `profile_refined.html`, asset images).
- **Flutter UI Redesign (`juanderquest_app/`):**
  - Applied Stitch design tokens: Epilogue + Plus Jakarta Sans typography, Reward Gold (`#FFB703`), Tropical Green (`#3F6653`), Wood Brown (`#582F0E`), Deep Ink (`#0D1B2A`), Warm Background (`#FAF9F5`).
  - Redesigned `DemoLoginScreen` with role selector cards (Traveler vs Admin), product summary card, and prototype disclosure footer.
  - Redesigned `QuestListScreen` with live PTS token balance pill, greeting, search input, category filter pills (`All`, `Eco`, `Cultural`, `Food & Trade`), featured discovery hero banner, nearby adventure cards, and 3-tab bottom navigation bar.
  - Redesigned `QuestDetailScreen` with destination banner, reward pill, 3-step objective guide cards, local tip callout box, and wood gradient primary CTA button.
  - Redesigned `SubmissionHistoryScreen` with status language (`Awaiting administrator review`, `Quest approved — +50 points awarded`, `Proof rejected`).
  - Redesigned `ProfileScreen` with traveler avatar, demo points card, and future NFT achievement placeholders (`Eco Pioneer`, `Heritage Keeper`, `Food Explorer`).
- **React Admin Web Dashboard (`dashboard/`):**
  - Updated `index.html`, `src/index.css`, and `src/App.tsx` with Stitch design system tokens.
  - Added logo asset branding, control room header with region active status pill, distance offset threshold tags, and rejection reason modal.
  - Verified via `npm run build` (1505 modules transformed, 0 errors, 5.66s).
- **Figma Interactive Prototype Reference Linked:**
  - Linked official Figma prototype (`https://www.figma.com/proto/iMNm3VkAJBUous8NLoZHSj/JuanDerQuest?node-id=70-251`) in `AGENTS.md`, `docs/03-ui-ux/prototype-ui-ux.md`, and `docs/03-ui-ux/figma-design-system.md`.
  - Updated Obsidian second-brain vault note `.brain/Architecture/Design System.md`.
- **Verification:** `flutter analyze` (0 issues), `flutter test` (All tests passed), Git commits recorded.

### Figma Prototype Linked

Linked official interactive Figma prototype for JuanderQuest:
- URL: `https://www.figma.com/proto/iMNm3VkAJBUous8NLoZHSj/JuanDerQuest?node-id=70-251`

### Design handoff brief written

Wrote `docs/03-ui-ux/design-handoff-brief.md` — full design brief for Stitch/OpenDesign covering all 10 screens, 32-frame inventory, seeded data, visual direction, and a paste-ready tool instruction.

### Subdomain migrated to jdq.zernanvash.dev

Restored `zernanvash.dev` to serve the user's personal site from `/var/www/zernanvash.dev`. Created `jdq.zernanvash.dev` as the JuanderQuest subdomain:

- SSL cert obtained via Certbot
- Nginx reverse-proxy `/api/` → `localhost:4000`
- Dashboard served from `~/app/dashboard/dist`
- Backend CORS updated to `https://jdq.zernanvash.dev`

APK rebuilt: `--dart-define=API_BASE_URL=https://jdq.zernanvash.dev/api/v1`

### Full stack deployed to Azure VM

pushed the git repo to a bare repo on the Azure VM, cloned to `~/app`, installed deps, built both projects, configured Nginx with SSL, and started the backend via pm2.

- Backend: `npm install && npm run build`, pm2 `juanderquest-backend`
- Dashboard: `npm install && npm run build`, served by Nginx
- pm2 startup configured for systemd

### Git initialized

Created the project git repo with 153 files. Remote `vm` points to `ssh://azureuser@zernanvash.dev/home/azureuser/juanderquest.git`.

### VPN switched to Tailscale

Abandoned Azure WireGuard (China region issues). Moved to Tailscale mesh:

- Laptop: `100.105.235.94`
- Phone: `100.120.240.58`

Azure VM migration from East Asia to Southeast Asia skipped in favor of Tailscale + public domain SSL.

### QA blocker fixes (batch #1)

All fixes applied to source files:

| # | Fix | Files |
|---|---|---|
| 1 | Configurable API URL via `--dart-define` | `api_client.dart` |
| 2 | Removed fabricated GPS fallback | `ar_experience_screen.dart` |
| 3 | Removed fake login success on network error | `auth_provider.dart` |
| 4 | Removed fake submission fallback | `submission_provider.dart` |
| 5 | GPS radius enforced server-side (422 OUT_OF_RANGE) | `routes/submissions.ts` |
| 6 | Idempotency scoped per user | `db/index.ts`, `routes/submissions.ts` |
| 7 | State transitions enforced (pending → only) | `db/index.ts`, `routes/admin.ts` |
| 8 | Duplicate completions blocked (409 ALREADY_COMPLETED) | `routes/submissions.ts` |
| 9 | Added missing `findSubmissionById` method | `db/index.ts` |
| 10 | Fixed submit button disabled when GPS unavailable | `ar_experience_screen.dart` |

### Platform scaffolding generated

Generated Android (`android/`) and iOS (`ios/`) platform directories. Added:

- AndroidManifest: INTERNET, FINE_LOCATION, COARSE_LOCATION, CAMERA permissions
- `android:usesCleartextTraffic="true"` (VPN-only prototype)
- iOS Info.plist: NSLocationWhenInUseUsageDescription, NSCameraUsageDescription
- Replaced generated widget test with proper `JuanderQuestApp` smoke test

### QA audit (read-only)

Read-only QA revealed critical issues fixed in batch #1. Findings documented in `implementation_plans/02-network-and-qa-fixes.md`.

### Implementation plans written

- `implementation_plans/01-prototype-scaffold-plan.md` — 6-phase plan: documentation gate, backend, dashboard, Flutter, AR spike, integration
- `implementation_plans/02-network-and-qa-fixes.md` — VPN setup (originally WireGuard Azure, later Tailscale), 7 QA blocker fixes, build commands, verification checklist

### Prototype planning

Week-long planning phase concluded. Key decisions:

- End-to-end flow: seeded login → quests → AR (simulated marker) → GPS → submit → admin dashboard approval → demo points
- Blockchain, wallet, tokens, NFTs, DAO, merchants, offline queue: all deferred
- AR: simulated marker overlay (not real camera tracking) for prototype
- Authentication: seeded demo users (user-1, admin-1)
- Connectivity: online-only
- Admin review: separate React+Vite web dashboard
- Backend: Express + local PostgreSQL (or in-memory for now)
- Flutter: Android-first, iOS scaffold only
