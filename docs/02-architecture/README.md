# Architecture — JuanderQuest

## High-level architecture

```
┌──────────────────────────────────────────────────────────────┐
│                    Mobile App (Flutter)                        │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────────┐ │
│  │ Auth     │  │ Quest    │  │ Wallet   │  │ Offline      │ │
│  │ (Wallet  │  │ (Browse, │  │ (Balance,│  │ Cache        │ │
│  │ Connect) │  │ QR, AR)  │  │ NFTs)    │  │ (Hive/SQLite)│ │
│  └──────────┘  └──────────┘  └──────────┘  └──────────────┘ │
│  ┌──────────────┐  ┌──────────────┐                           │
│  │ AR Engine    │  │ Sync Engine  │                           │
│  │ (ARCore/     │  │ (background  │                           │
│  │  ARKit)      │  │  isolate)    │                           │
│  └──────┬───────┘  └──────────────┘                           │
│         │                                                     │
│         ▼                                                     │
│  ┌────────────────────────────────────┐                       │
│  │ API Client + viem (Web3)          │                       │
│  └────┬──────────────────────┬───────┘                       │
└───────┼──────────────────────┼───────────────────────────────┘
        │ REST                 │ RPC
        ▼                      ▼
┌──────────────────────────────────────────────────────────────┐
│                   Cloud Backend (Node/TS)                     │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────────┐ │
│  │ Auth     │  │ Quest    │  │ User     │  │ AR Proof     │ │
│  │ (SIWE)   │  │ CRUD     │  │ Mgmt     │  │ Verification │ │
│  └──────────┘  └──────────┘  └──────────┘  └──────────────┘ │
│  ┌──────────────────────────────────────────────────────────┐│
│  │                  Admin Dashboard (Next.js)                ││
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐               ││
│  │  │ Quest    │  │ Verify   │  │ Analytics│               ││
│  │  │ Manager  │  │ Queue    │  │ Dashboard│               ││
│  │  └──────────┘  └──────────┘  └──────────┘               ││
│  └──────────────────────────────────────────────────────────┘│
│                          │                                    │
│                          ▼                                    │
│                   ┌──────────────┐                           │
│                   │ Database (DB)│                           │
│                   └──────────────┘                           │
└──────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌──────────────────────────────────────────────────────────────┐
│                  Blockchain Layer (Base L2)                   │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────────────┐ │
│  │ JDQ Token    │  │ Quest Reward │  │ DAO Governance    │ │
│  │ (ERC-20)     │  │ (Automated)  │  │ (Voting Contract) │ │
│  └──────────────┘  └──────────────┘  └────────────────────┘ │
│  ┌──────────────────────────────────────────────────────────┐│
│  │ NFT Badge (ERC-721 Soulbound / ERC-5192)                 ││
│  └──────────────────────────────────────────────────────────┘│
└──────────────────────────────────────────────────────────────┘
```

## Technology stack

| Layer | Technology | Purpose |
|-------|------------|---------|
| Mobile | Flutter 3.x | Cross-platform Android/iOS app |
| State | Riverpod | Compile-safe state management |
| Local DB | Hive or SQLite | Offline cache for quests, user data |
| Wallet connect | WalletConnectFlutter + viem | Web3 wallet pairing and tx signing |
| AR Engine | ARCore (Android) / ARKit (iOS) | Device-specific AR interaction |
| Backend | Node.js / TypeScript + Express/Fastify | REST API for app data |
| Dashboard | Next.js | Admin web interface |
| Database | PostgreSQL (or Supabase) | Persistent storage |
| Blockchain | Base L2 (EVM) | Smart contract execution |
| Smart contracts | Solidity + Hardhat | Token, rewards, governance contracts |
| Auth flow | Sign-In with Ethereum (SIWE) | Verify wallet ownership server-side |
| API style | REST | Mobile app ↔ Backend communication |

## Flutter app package structure

```
juanderquest_app/
├── lib/
│   ├── main.dart
│   ├── app/
│   │   └── app.dart                  # App widget, router, theme
│   ├── core/
│   │   ├── network/                  # API client, interceptors
│   │   ├── web3/                     # viem wrappers
│   │   ├── ar/                       # ARCore/ARKit abstraction layer
│   │   ├── storage/                  # Local DB abstraction
│   │   └── sync/                     # Offline queue & sync engine
│   ├── features/
│   │   ├── auth/                     # Wallet connect, SIWE
│   │   │   ├── presentation/         # Screens, providers
│   │   │   └── data/                 # Repos, data sources
│   │   ├── quest/                    # Browse, QR scan, AR interact
│   │   │   ├── presentation/
│   │   │   └── data/
│   │   ├── wallet/                   # Balance, NFTs
│   │   │   ├── presentation/
│   │   │   └── data/
│   │   ├── leaderboard/              # Rankings
│   │   │   ├── presentation/
│   │   │   └── data/
│   │   ├── merchant/                 # Merchant QR scan
│   │   │   ├── presentation/
│   │   │   └── data/
│   │   └── profile/                  # User profile, badges
│   │       ├── presentation/
│   │       └── data/
│   └── shared/
│       ├── models/                   # Shared domain models
│       └── widgets/                  # Reusable UI components
```

## Data flow: Quest completion

```
User arrives at destination GPS boundary
        │
        ▼
App triggers AR mode — camera view with marker/object
        │
        ▼
User scans site QR code → AR marker renders 3D object
        │
        ▼
User interacts (tap/collect) → app generates signed proof
(proof = QR nonce + GPS coords + interaction data + user wallet sig)
        │
        ▼
┌── Online? ──► Submit signed proof to Backend API
│                   │
│                   ▼
│               Backend verifies proof signature + nonce + GPS
│                   │
│           ┌── Valid? ──► Auto-approve → call smart contract
│           │               │
│           │               ▼
│           │           JDQ tokens distributed to user's wallet
│           │
│           └── Invalid ──► Flag for admin manual review
│
└── Offline? ──► Save signed proof to local queue
                    │
                    ▼
                Sync on reconnect (verify + process batch)
```

### Fallback (non-AR devices)

```
User scans QR code → GPS captured → signed proof (QR + GPS only)
        │
        ▼
Backend receives proof → admin reviews → approve/reject → contract
```

## Offline sync strategy

| Data type | Strategy |
|-----------|----------|
| Quest list | Pre-fetched and cached locally, refresh on connect |
| AR proof submissions | Queued locally (signed), batch-sent on reconnect |
| Wallet balance | Read from chain when online, stale cache when offline |
| Leaderboard | Network-only, cached snapshot for offline view |
| NFT badges | On-chain read when online, cached locally |

Sync engine: background isolate processes the queue FIFO on connectivity restore. Failed items retry with exponential backoff (max 3 attempts), then flagged for manual resolution.

## AR subsystem design

```
┌─────────────────────────────────────┐
│        AR Abstraction Layer          │
│  (core/ar/)                          │
│                                      │
│  ┌─────────────────────────────┐    │
│  │ ARService (interface)       │    │
│  │  - init()                   │    │
│  │  - scanQR()                 │    │
│  │  - renderMarker()           │    │
│  │  - captureInteraction()     │    │
│  │  - generateProof()          │    │
│  └─────────────────────────────┘    │
│         ▲           ▲               │
│         │           │               │
│  ┌──────────┐ ┌──────────┐         │
│  │ ARCore   │ │ ARKit    │         │
│  │ Impl     │ │ Impl     │         │
│  └──────────┘ └──────────┘         │
│  (Android)     (iOS)               │
│  ar_service_   ar_service_         │
│  android.dart  ios.dart            │
└─────────────────────────────────────┘
```

- Platform channels or Flutter AR plugin (e.g. `arcore_flutter_plugin`) bridge to native SDKs
- Proof format: `{ questId, qrNonce, gpsCoords, interactionHash, userAddress, signature }`
- Proof verified server-side: nonce uniqueness, GPS bounding, signature recovery matches user

## Smart contract architecture

| Contract | Type | Role |
|----------|------|------|
| JDQToken | ERC-20 (ownable/mintable) | Utility token, minted by admin treasury |
| QuestReward | Custom | Holds reward config, called by backend after admin approval |
| BadgeNFT | ERC-5192 (soulbound NFT) | Non-transferable achievement badges |
| DAOGovernance | Custom (token-weighted voting) | Proposal creation, voting, fund allocation |

Contracts deployed on Base L2. Hardhat for development, testing, deployment.

## Security considerations

- SIWE for server-side wallet verification (prevents wallet spoofing)
- QR codes contain signed nonces to prevent replay attacks
- AR proof includes interaction hash unique to each session
- API requests authenticated with wallet-signed JWT
- Smart contracts use OpenZeppelin audited base implementations
- Admin dashboard requires separate admin wallet auth
- Offline queue stored encrypted on device
- AR proof verification server-side — proof tampering detectable via signature mismatch

## Related documents

| Document | Path |
|----------|------|
| System architecture (text) | `docs/02-architecture/03-system-architecture.md` |
| System architecture diagram | `docs/02-architecture/system-architecture.svg` |
| Hardware & software requirements | `docs/02-architecture/04-hardware-software-requirements.md` |
