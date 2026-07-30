# Gemini Canvas Guide — JuanDerQuest Thesis

Paste this whole file into Gemini and say: **"Use this to create thesis sections in Canvas."**

---

## Project Identity

- **System name:** JuanDerQuest (also spelled JuanderQuest interchangeably)
- **Full title:** A Gamified Blockchain-based System for Promoting Tourist Destinations in Pangasinan
- **Authors:** Ana Victoria V. Alentajan, Zernan Vash L. Arive, Clarissa Angel A. Gutlay, Carl Jacob Lavaro, Alyana Soriano
- **School:** School of Information Technology Education, Universidad de Dagupan
- **System type:** Mobile app (Flutter) + blockchain (Base L2) + backend (Node/TS) + admin dashboard (Next.js)

## Writing Rules

1. Output in formal academic English — third person, passive voice where appropriate, no contractions.
2. Every claim about the system must be supported by the documentation below. Do not invent features or capabilities.
3. Use APA 7th edition for any citations (none needed for sections below — these are system design sections).
4. Use **Figure X.Y** and **Table X.Y** numbering consistent with the section being written.
5. Output as plain Markdown (not Canvas rich format). I will paste into Canvas myself.
6. Do not include commentary, explanations, or meta-notes. Only output the thesis section content.
7. Academic paragraph style: topic sentence, supporting sentences, transition. Avoid bullet lists in prose paragraphs. Use tables for specifications.

## Thesis Section Requests

### Request 1: 3.3 Systems Architecture

**Opening sentence:** "System architecture is the structured design of a system that shows how all components interact and work together to achieve system functions."

**Architecture description (write as paragraphs, not bullets):**

JuanDerQuest follows a four-layer client-server architecture with blockchain integration, comprising the Presentation Layer, Application Layer, Data Layer, and Blockchain Layer. The system employs an offline-first strategy where the mobile application maintains a local cache for core functionality and synchronizes with the backend when network connectivity becomes available.

**Presentation Layer** — Two components:
- **Mobile App:** Flutter 3.x (Android 8+ API 26, iOS 15+). Riverpod state management. WalletConnect + viem for Web3. ARCore (Android) / ARKit (iOS) for AR. Communicates via REST API to backend.
- **Admin Dashboard:** Next.js web app. Quest management, submission verification, analytics, token minting. Consumes same REST API.

**Application Layer** — One component:
- **Backend API Server:** Node.js / TypeScript + Express. Authentication via Sign-In with Ethereum (SIWE). Quest CRUD, AR proof verification, user management, smart contract orchestration.

**Data Layer** — Three components:
- **PostgreSQL (Supabase):** Users, quests, submissions, rewards, merchants, badges, DAO data.
- **IPFS (Pinata/Web3.Storage):** Badge metadata, AR 3D assets, quest photographs. Content-addressed retrieval.
- **Device Local Storage (Hive/SQLite):** Offline quest cache + sync queue.

**Blockchain Layer (Base L2)** — Four contracts:
- **JDQ Token:** ERC-20 mintable utility token, admin treasury controls minting. 18 decimals.
- **Quest Reward:** Auto-distributes JDQ tokens on admin-approved completions.
- **NFT Badge:** ERC-5192 soulbound, non-transferable achievement badges.
- **DAO Governance:** Token-weighted voting on community fund allocation proposals.

**Figure reference:** *See system-architecture.svg — describe it as "Figure 3.1. System Architecture of JuanDerQuest"*

### Request 2: 3.4 Hardware and Software Requirements

**Opening sentence:** "The successful development, deployment, and operation of JuanDerQuest require specific hardware configurations and software tools across development machines, end-user mobile devices, and server infrastructure."

**Write 3-4 introductory paragraphs then create these tables:**

**Table 3.1. Development Machine Hardware Requirements**

| Component | Minimum | Recommended |
|-----------|---------|-------------|
| Processor | Intel Core i5 / AMD Ryzen 5 (4 cores) | Intel Core i7 / AMD Ryzen 7 (8 cores) |
| RAM | 8 GB | 16 GB |
| Storage | 50 GB SSD | 100 GB SSD |
| OS | Windows 10 / macOS 12 / Ubuntu 22.04 | Windows 11 / macOS 14 / Ubuntu 24.04 |
| Display | 1920×1080 | 2560×1440 |

**Table 3.2. Mobile Device Hardware Requirements**

| Component | Minimum | Recommended |
|-----------|---------|-------------|
| OS | Android 8.0 (API 26) / iOS 15.0 | Android 12+ / iOS 17+ |
| RAM | 3 GB | 6 GB |
| Storage | 100 MB free | 500 MB free |
| Camera | 8 MP rear | 12+ MP rear |
| GPS | A-GPS + GLONASS | A-GPS + GLONASS + Galileo |
| AR Support | ARCore-compatible / iPhone 6s+ | ARCore-certified / iPhone XR+ |
| Network | Wi-Fi n / 4G LTE | Wi-Fi ac / 5G |
| Battery | 3,000 mAh | 4,000 mAh+ |

**Table 3.3. Server Hardware Requirements**

| Component | MVP | Production |
|-----------|-----|------------|
| vCPU | 2 | 4 |
| RAM | 4 GB | 8 GB |
| Storage | 20 GB SSD | 50 GB SSD |
| Bandwidth | 1 TB/month | 5 TB/month |
| OS | Ubuntu 22.04 LTS | Ubuntu 24.04 LTS |

**Table 3.4. Software Requirements**

| Category | Software | Version | Purpose |
|----------|----------|---------|---------|
| Mobile Framework | Flutter SDK | 3.x | Cross-platform app framework |
| Language | Dart | 3.x | Mobile app logic |
| Language | TypeScript | 5.x | Backend + dashboard |
| Language | Solidity | 0.8.x | Smart contracts |
| Backend | Node.js | 20 LTS | Server runtime |
| API Framework | Express / Fastify | Latest | HTTP server |
| Dashboard | Next.js | Latest | Admin web app |
| Database | PostgreSQL | 16 | Relational DB |
| Blockchain Tools | Hardhat | Latest | Contract dev + deploy |
| Wallet Protocol | WalletConnect v2 | Latest | Wallet pairing |
| RPC Library | viem | Latest | Ethereum interaction |
| Auth | Sign-In with Ethereum | Latest | Server-side wallet auth |
| Storage | Pinata / Web3.Storage | Latest | IPFS pinning |
| CI/CD | GitHub Actions | — | Automation |
| Monitoring | Sentry | — | Error tracking |

**Table 3.5. Flutter Package Dependencies**

| Package | Purpose |
|---------|---------|
| flutter_riverpod | State management |
| walletconnect_flutter_v2 | Web3 wallet pairing |
| viem (Dart) | Ethereum RPC + wallet |
| qr_code_scanner | QR scanning |
| arcore_flutter_plugin | Android AR |
| arkit_flutter_plugin | iOS AR |
| hive / sqflite | Local offline cache |
| dio | HTTP client |
| flutter_secure_storage | Secure credential storage |

**Table 3.6. Network Requirements**

| Connection Path | Min Bandwidth | Max Latency |
|-----------------|--------------|-------------|
| Mobile App → Backend API | 1 Mbps | 500 ms |
| Backend → Blockchain RPC | 5 Mbps | 1 s |
| Backend → IPFS | 10 Mbps | 2 s |
| Dashboard → Backend API | 5 Mbps | 300 ms |

**Table 3.7. Recommended Deployment Services**

| Component | Provider | Purpose |
|-----------|----------|---------|
| Source Control | GitHub | Version control |
| CI/CD | GitHub Actions | Build + deploy automation |
| Backend Hosting | Railway / Fly.io | Node.js server |
| Dashboard Hosting | Vercel | Next.js hosting |
| Database Hosting | Supabase / Neon | Managed PostgreSQL |
| IPFS Pinning | Pinata / Web3.Storage | Decentralized storage |
| RPC Provider | Alchemy / Infura | Base L2 access |
| Monitoring | Sentry | Error tracking |

---

## Instructions for Gemini

1. Read all the documentation content above.
2. Generate ONLY the thesis section content. No greetings, no summaries, no "here is your output."
3. For 3.3: Write in academic paragraphs. Describe each layer with a topic sentence and 2-4 supporting sentences. Reference "Figure 3.1" at the start and end.
4. For 3.4: Write an introductory paragraph, then present each table with a brief explanatory sentence above it. Use formal table markdown.
5. Keep every factual claim traceable to the documentation above. Do not add features, tools, or specifications not listed.
6. Use "the system" or "JuanDerQuest" consistently (choose one per paragraph, not both mixed).
7. Output begins directly with "### 3.3 Systems Architecture" — no preamble.
