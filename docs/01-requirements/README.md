# Requirements — JuanderQuest

## Overview

| Item | Decision |
|------|----------|
| Platform | Flutter mobile app (Android 8+ API 26, iOS 15+) |
| Auth | Wallet connect only — user must connect existing Web3 wallet (MetaMask, WalletConnect, etc.) |
| Token | JDQ utility token on Base L2 (or best-fit EVM L2) |
| Token funding | Admin/treasury mint — admin mints initial supply |
| Quest creation | Admin-only at launch (community proposals deferred) |
| Quest categories | Eco + Cultural + Food/Trade |
| Quest verification | QR scan → AR interaction → signed proof (primary); GPS + QR-only fallback for non-AR devices |
| Merchant role | Offer token discounts — users spend JDQ at merchant locations |
| Merchant verification | QR code scan at merchant location |
| Rewards per quest | Dynamic/TBD — decided during tokenomics phase |
| Offline | Offline-first — local cache + sync when connected |
| AR engine | ARCore (Android) / ARKit (iOS) |
| Prototype heritage | Old prototype was React + Viction — scrapped entirely |
| Paper | Written by thesis team separately; this doc is for the prototype build |
| Diagrams | Flowcharts expected in this doc |

## Functional requirements

### 1. Authentication & Wallet
- FR1: User connects existing Web3 wallet (MetaMask, WalletConnect) on first launch
- FR2: User can view wallet balance (JDQ tokens, NFT badges)
- FR3: User can disconnect and reconnect to same wallet
- FR4: Session persists across app restarts until explicit disconnect

### 2. Quest System
- FR5: User browses available quests — filterable by category (Eco / Cultural / Food-Trade) and location
- FR6: User selects a quest and views details (name, description, GPS location, AR preview)
- FR7: User starts a quest — app navigates to destination GPS coordinates
- FR8: At destination, user scans the site's QR code to trigger AR interaction
- FR9: AR marker/object appears — user must interact (tap/collect) to generate signed proof
- FR10: Signed proof submitted to backend — auto-verify if proof is valid
- FR11: On approval, smart contract auto-distributes JDQ tokens to user's wallet
- FR12: User can view their quest history (completed, pending, rejected)
- FR13: Devices without ARCore support fall back to QR + GPS verification

### 3. Roles & Permissions
- FR14: **User** — browse quests, complete quests (QR + AR), earn JDQ tokens, view leaderboard, view own profile and badges
- FR15: **Admin** — create/manage quests, generate QR codes + AR markers for quest locations, verify submissions, manage users, mint tokens, view platform analytics
- FR16: **Merchant** — register business location, set JDQ discount rates, receive a unique QR for their location, view visitor analytics

### 4. NFT Achievement Badges
- FR17: Non-transferable (soulbound) NFT badges minted for milestone completions
- FR18: Badges displayed on user profile
- FR19: Criteria for badges defined by admin (e.g. "Complete 10 Eco quests")

### 5. DAO Governance
- FR20: Token holders vote on community fund allocation proposals
- FR21: Admin creates proposals; token-weighted voting determines outcome (1 token = 1 vote)
- FR22: Voting parameters (quorum, period, thresholds) TBD during blockchain phase

### 6. Leaderboard
- FR23: Community leaderboard ranking users by total quests completed and total JDQ earned
- FR24: Leaderboard syncs from server when online

### 7. Merchant Discounts
- FR25: Merchants register a location and receive a unique QR code
- FR26: User scans merchant QR to verify visit and learn about active discounts
- FR27: User shows JDQ balance at merchant to avail discount off-chain

### 8. Offline Mode
- FR28: App caches quest data locally — user can browse quests offline
- FR29: Quest completion (AR proof) queued locally when offline, syncs on reconnect
- FR30: Leaderboard, wallet balance, and badge data stale when offline, refreshed on sync
- FR31: Blockchain transactions (token rewards) require connectivity — queued if offline

## Non-functional requirements

- NFR1: AR interaction triggers within X meters of destination GPS boundary
- NFR2: Smart contract transactions confirm within Base L2 expected block times
- NFR3: User location data encrypted at rest and in transit
- NFR4: Offline-first — core UX (browse, AR scan) works without internet; sync is background/eventual
- NFR5: Local storage limit defined (e.g. cache last 50 quests)
- NFR6: QR codes rotated or have expiry for security
- NFR7: Fallback path for devices without ARCore support (QR + GPS verification only)

## User flows (flowcharts)

> Flowcharts to be inserted — one per major flow:
> - Account connection flow
> - Quest browse → QR scan → AR interact → reward flow
> - Fallback quest completion (non-AR devices)
> - Admin verification flow
> - Merchant registration + discount flow
> - Offline queue → sync flow

## Open questions

- Initial JDQ token supply and distribution schedule
- Reward amount per quest or per category
- QR code regeneration policy (permanent vs time-limited)
- AR interaction type (marker scan, geotriggered object, pattern match)
- GPS tolerance for AR trigger boundary
- DAO quorum, voting period, proposal threshold
- Local database tech (Hive, SQLite, etc.)
