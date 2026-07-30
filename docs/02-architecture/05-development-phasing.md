# Development Phasing — JuanderQuest

## Team

| Developer | Role | Stack |
|-----------|------|-------|
| Alyana | Mobile Developer (Dev 1) | Flutter, Dart, Riverpod, ARCore/ARKit |
| Zernan | Backend + Blockchain Developer (Dev 2) | Node/TS, Next.js, Solidity, Hardhat, PostgreSQL |

## Milestones

| Date | Milestone |
|------|-----------|
| Jul 22 | Documentation phase ends, development begins |
| Aug 24–29 | Alpha Test |
| Oct 12–17 | Beta Test |
| November | Final Defense |

---

## Phase 0 — Documentation Finalization (Jul 22–31)

| Alyana | Zernan |
|--------|--------|
| Confirm Flutter plugin compatibility (AR, QR scanner, WalletConnect) | Write smart contract specifications and tokenomics |
| Review API spec from mobile perspective | Write testing plan |
| Set up Flutter project scaffolding | Set up backend, dashboard, contracts repos |
| | Configure CI/CD (GitHub Actions) |

**Deliverables:** All repos scaffolded. CI/CD pipelines configured.

---

## Phase 1 — Foundation (Aug 1–10)

| Alyana | Zernan |
|--------|--------|
| App shell, theme, navigation, routing | Database schema + migrations |
| WalletConnect + SIWE auth screens | Auth endpoints (nonce, login, JWT) |
| Core widget library (cards, lists, buttons) | Dashboard shell + login page |
| Mock data layer with Riverpod providers | Hardhat project + JDQToken contract |

**Parallel tracks:** Both devs work independently this phase. Mobile has mock data, backend builds real API.

---

## Phase 2 — Core Features (Aug 11–24)

Focus: complete the primary user flow — login → browse → scan → submit → verify.

| Alyana | Zernan |
|--------|--------|
| Quest list + detail + category filter screens | Quest CRUD endpoints |
| QR scanner integration | Quest management in dashboard |
| Submission flow (scan → sign → send) | Submission endpoints |
| Offline queue with local storage | Verification queue in dashboard |
| Connect to real API endpoints | QuestReward contract (write + deploy Sepolia) |

**Alpha Test deliverable:**
- User can connect wallet, browse quests, scan QR code at destination, submit completion proof
- Admin can see pending submissions in dashboard and approve/reject
- QuestReward contract deployed on Sepolia testnet
- Core mobile, backend, and dashboard integrated end-to-end

---

## Phase 3 — Blockchain + Remaining Features (Aug 25–Sep 15)

| Alyana | Zernan |
|--------|--------|
| Wallet balance + transaction history (real on-chain reads via viem) | BadgeNFT soulbound contract |
| Reward confirmation UI | DAO governance contract |
| NFT badge display on profile | Backend → all contracts integration |
| Photo fallback (camera capture → IPFS upload) | NFT badge minting flow |
| Push notification handling (FCM) | Admin mint + badge creation UI in dashboard |
| Leaderboard screen | IPFS upload endpoint |

---

## Phase 4 — Merchant & Polish (Sep 16–30)

| Alyana | Zernan |
|--------|--------|
| Merchant QR scan + discount flow UI | Merchant API endpoints + dashboard |
| Push notification integration | On-chain token payment for merchants |
| AR interaction refinement | DAO proposal + voting dashboard |
| Edge cases, error states, empty states | API documentation |
| Offline sync reliability | Rate limiting, error handling |

---

## Phase 5 — Beta Test Preparation (Oct 1–12)

| Alyana | Zernan |
|--------|--------|
| End-to-end integration testing | Dashboard analytics + stats page |
| Performance optimization | Contract test suite |
| Bug fixes | Load testing |

**Beta Test deliverable:** Full feature set stable on Sepolia testnet, ready for external testers.

---

## Phase 6 — Final Defense Preparation (Oct 13–November)

| Alyana | Zernan |
|--------|--------|
| Bug fixes from beta feedback | Bug fixes from beta feedback |
| Screen recording for demo | Deploy contracts to Base mainnet |
| Presentation slides | Production environment setup |
| System documentation for defense paper | Finalize admin dashboard |

**Final Defense deliverable:** Production system deployed on Base mainnet. Presentation ready.
