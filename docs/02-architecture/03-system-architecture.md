# 3.3 Systems Architecture

JuanDerQuest follows a four-layer client-server architecture with blockchain integration: Presentation Layer, Application Layer, Data Layer, and Blockchain Layer. The system employs an offline-first strategy where the mobile app maintains a local cache for core functionality and synchronizes with the backend when connectivity is available.

## Layer Descriptions

### Presentation Layer
- **Mobile App (Flutter)** — Cross-platform mobile application supporting Android 8+ (API 26) and iOS 15+. Built with Flutter using Riverpod for state management. Communicates with the backend via REST API and with the blockchain via WalletConnect + viem for Web3 wallet operations. Integrates ARCore (Android) and ARKit (iOS) for AR-based quest verification.
- **Admin Dashboard (Next.js)** — Web-based administrative interface for managing quests, verifying user submissions, viewing analytics, and minting tokens. Consumes the same backend API as the mobile app.

### Application Layer
- **Backend API Server (Node.js/TypeScript + Express)** — Central REST API responsible for authentication (Sign-In with Ethereum), quest CRUD operations, AR proof verification, user management, and orchestrating smart contract calls for reward distribution.

### Data Layer
- **Relational Database (PostgreSQL/Supabase)** — Stores users, quests, submissions, proof records, and platform configuration.
- **Decentralized Storage (IPFS)** — Stores badge metadata, AR assets, and quest media files. Content-addressed hashes are stored in the database for retrieval.
- **Device Local Storage (Hive/SQLite)** — Offline cache for quest data and sync queue for quest completions made without internet connectivity.

### Blockchain Layer (Base L2)
- **JDQ Token (ERC-20)** — Mintable utility token serving as the reward currency. Admin treasury controls minting.
- **Quest Reward Contract** — Auto-distributes JDQ tokens to users upon admin-approved quest completions.
- **NFT Badge (ERC-5192 Soulbound)** — Non-transferable achievement badges minted when users reach milestone criteria.
- **DAO Governance Contract** — Token-weighted voting for community fund allocation proposals.

See `system-architecture.svg` for the visual diagram.
