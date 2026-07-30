# Prototype Scope & Requirements — JuanderQuest

**Created:** 2026-07-30  
**Status:** Approved Specification  

---

## 1. Executive Summary

This document defines the exact scope, boundaries, and state transitions for the **JuanderQuest Scaffold Prototype**.

The single primary objective of this prototype is to showcase one complete, verifiable end-to-end user loop:
> **Seeded User Login → Browse Quest List & Detail → Scan Marker → Display AR Overlay → Capture Device GPS → Submit Verification Proof → Admin Reviews Submission in Dashboard → User Earns Off-Chain Demo Points**

All web3/blockchain interactions, smart contracts, token minting, NFT soulbound badges, DAO governance, merchant redemptions, and offline queues are explicitly deferred to subsequent phases.

---

## 2. In-Scope vs. Out-of-Scope (Boundary Matrix)

| Domain | Included in Prototype | Explicitly Excluded (Deferred) |
|---|---|---|
| **Authentication** | Seeded demo user login (Select preset user ID) | WalletConnect / SIWE (Sign-In with Ethereum) |
| **Blockchain** | None (100% off-chain) | Smart contracts, Base L2 network, RPC integration |
| **Tokenomics** | Off-chain demo points database counter | JDQ ERC-20 token minting or transfer |
| **NFT & Badges** | Badge UI placeholder on user profile | ERC-5192 soulbound NFT minting, IPFS CIDs |
| **Governance** | None | DAO proposals, voting, token weighting |
| **Merchants** | None | Merchant role registration, discount scanning |
| **AR & Verification** | Printed marker tracking + static 3D image/overlay | Dynamic IPFS 3D models, AI photo validation |
| **Geolocation** | Real-time device GPS capture with permission check | High-precision spoofing countermeasures |
| **Network & Sync** | Online-only REST API interactions | Offline-first sync, local SQLite/Hive queue |
| **Admin Dashboard** | React web app for submission approval/rejection | Full analytics, KPI charts, quest editor |
| **Platform Support** | Android API 26+ (Showcase device) | iOS AR validation (iOS scaffold present) |

---

## 3. Core Workflow & State Machine

### 3.1 Quest Submission State Machine

```
                 ┌──────────────────┐
                 │     PENDING      │
                 └────────┬─────────┘
                          │
                  ┌───────┴───────┐
                  ▼               ▼
           ┌──────────┐     ┌──────────┐
           │ APPROVED │     │ REJECTED │
           └──────────┘     └──────────┘
```

1. **Submission Creation:** User submits proof (`proof_type: "ar"`). Backend assigns status `pending` and records an idempotency UUID.
2. **Server-Side Enforcement:** Only one `approved` submission is allowed per `(user_id, quest_id)` pair.
3. **Admin Review:** Admin views pending submissions in web dashboard.
   - **Approve:** State becomes `approved`, user points incremented by `quest.reward_points`.
   - **Reject:** State becomes `rejected`, requiring a human-readable `rejection_reason`.

---

## 4. User Roles in Prototype

1. **User (`role: "user"`)**
   - Selects a seeded account to log in.
   - Views quest feed (filtered by Pangasinan categories: Eco, Cultural, Food/Trade).
   - Views quest details (coordinates, description, target marker).
   - Launches AR marker camera view, scans marker, captures GPS coordinates.
   - Submits proof to backend.
   - Views history of submissions and updated demo points total.

2. **Administrator (`role: "admin"`)**
   - Logs into web dashboard using admin seed ID.
   - Views queue of pending quest submissions.
   - Evaluates submission metadata (captured GPS vs. target GPS, timestamp, marker ID).
   - Approves or rejects submissions.

---

## 5. Reconciled Architectural Assumptions

- **Online-Only Flow:** Early thesis notes mentioned offline-first sync. For the prototype scaffold, online connectivity is required to guarantee reliable state synchronization and prevent mock complex edge cases.
- **Off-Chain Points:** Rewards are represented as integer `demo_points` stored in PostgreSQL.
- **Seeded Auth:** JWT tokens are issued via a simplified `/auth/demo-login` route without cryptographic wallet signatures.

---

## 6. Deferral Rationale

| Feature | Reason for Deferral |
|---|---|
| Solidity Smart Contracts | Avoids RPC latency & testnet faucet complexity during core UX validation |
| WalletConnect / SIWE | Reduces login friction for non-Web3 demo evaluators |
| Offline Queue | Requires complex conflict resolution unnecessary for prototype demo |
| Merchant Discount Flow | Requires onboarding separate business stakeholders |
| IPFS Asset Pinning | Static bundled assets suffice for local AR marker validation |
