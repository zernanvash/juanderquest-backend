# Key Architecture Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Mobile framework | Flutter | Cross-platform, single codebase for Android/iOS |
| Blockchain | Base L2 (or best-fit EVM L2) | Low gas fees, EVM-compatible, migrating from Viction |
| Auth | Seeded demo login (`/auth/demo-login`) | Zero friction prototype showcase |
| Git Repositories | 3 Independent Repos | `juanderquest-backend.git`, `juanderquest-web.git`, `juanderquest-mobile.git` |
| Network Topology | Azure WireGuard VPN | Phone: `10.9.0.3/24`, Laptop: `10.9.0.2/24` |
| Flutter API URL | `--dart-define=API_BASE_URL` | Configurable per build target |
| GPS Verification | Server-side Haversine formula | Enforces max distance radius ($\le \text{quest.radius\_meters}$) |
| Idempotency | User-scoped UUID | Idempotency key checked per `(key, user_id)` pair |
| State Machine | `PENDING` → `APPROVED` / `REJECTED` | Idempotent transition matrix, single point allocation |
| Local DB | Memory Store & Postgres DDL | Dual-mode persistence for zero-dependency execution |
| Backend | Node.js 20 / TypeScript + Express | REST API, Zod validation |
| Admin Dashboard | React 18 + Vite | Modern dark-mode moderation control room |
| Mobile permissions | Fine/Coarse Location, Camera, Cleartext Traffic | Real GPS capture & AR marker scanner |
