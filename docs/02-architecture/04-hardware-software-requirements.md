# 3.4 Hardware and Software Requirements

## Hardware Requirements

### Development Machine

| Component | Minimum | Recommended |
|-----------|---------|-------------|
| CPU | Intel Core i5 / AMD Ryzen 5 (4 cores) | Intel Core i7 / AMD Ryzen 7 (8 cores) |
| RAM | 8 GB | 16 GB |
| Storage | 50 GB free (SSD) | 100 GB free (SSD) |
| OS | Windows 10 / macOS 12 / Ubuntu 22.04 | Windows 11 / macOS 14 / Ubuntu 24.04 |
| Display | 1920x1080 | 2560x1440 |

### Mobile Device (User)

| Component | Minimum | Recommended |
|-----------|---------|-------------|
| OS | Android 8.0 (API 26) / iOS 15.0 | Android 12+ / iOS 17+ |
| RAM | 3 GB | 6 GB |
| Storage | 100 MB free | 500 MB free |
| Camera | 8 MP (rear) | 12+ MP (rear) |
| GPS | A-GPS + GLONASS | A-GPS + GLONASS + Galileo |
| AR Support | ARCore compatible (Android) / ARKit compatible (iPhone 6s+) | ARCore certified (Android) / iPhone XR+ |
| Network | Wi-Fi 802.11n / 4G LTE | Wi-Fi 802.11ac / 5G |
| Battery | 3000 mAh | 4000 mAh+ |

### Server (Backend API + Database)

| Component | Minimum (MVP) | Recommended (Production) |
|-----------|---------------|--------------------------|
| CPU | 2 vCPU | 4 vCPU |
| RAM | 4 GB | 8 GB |
| Storage | 20 GB (SSD) | 50 GB (SSD) |
| Bandwidth | 1 TB/month | 5 TB/month |
| OS | Ubuntu 22.04 LTS | Ubuntu 24.04 LTS |

## Software Requirements

### Development Tools

| Software | Version | Purpose |
|----------|---------|---------|
| Flutter SDK | 3.x | Mobile app framework |
| Dart | 3.x | Flutter programming language |
| Node.js | 20 LTS | Backend runtime |
| TypeScript | 5.x | Backend programming language |
| PostgreSQL | 16 | Relational database |
| Hardhat | Latest | Smart contract development & deployment |
| Solidity | 0.8.x | Smart contract programming |
| Git | Latest | Version control |
| VS Code | Latest | Code editor (recommended) |

### Mobile App Dependencies (Flutter)

| Package | Purpose |
|---------|---------|
| flutter_riverpod | State management |
| walletconnect_flutter_v2 | Web3 wallet connectivity |
| viem (Dart port) | Ethereum interactions |
| qr_code_scanner | QR code scanning |
| arcore_flutter_plugin / arkit_flutter_plugin | AR integration |
| hive / sqflite | Local storage (offline cache) |
| dio | HTTP client for REST API |
| json_annotation | JSON serialization |
| flutter_secure_storage | Secure wallet/token storage |

### Backend Dependencies (Node.js/TS)

| Package | Purpose |
|---------|---------|
| express / fastify | HTTP server framework |
| viem | Ethereum interaction & RPC |
| siwe | Sign-In with Ethereum verification |
| typeorm / drizzle | Database ORM |
| postgres.js / pg | PostgreSQL driver |
| multer / busboy | File upload handling |
| zod | Request validation |
| jsonwebtoken | JWT for session management |
| pinata-web3 | IPFS upload client |

### Admin Dashboard Dependencies (Next.js)

| Package | Purpose |
|---------|---------|
| next | React framework |
| react | UI library |
| tailwindcss | Styling |
| viem | Wallet connection & RPC |
| wagmi | React hooks for Ethereum |
| recharts | Analytics charts |

### Infrastructure & Deployment

| Service | Purpose | Recommended Provider |
|---------|---------|---------------------|
| Source control | Code repository | GitHub |
| CI/CD | Automated testing & deployment | GitHub Actions |
| Backend hosting | API server | Railway / Fly.io |
| Dashboard hosting | Admin web app | Vercel |
| Database hosting | PostgreSQL | Supabase / Neon |
| IPFS pinning | Decentralized storage | Pinata / Web3.Storage |
| RPC provider | Blockchain access | Alchemy / Infura |
| Monitoring | Error tracking | Sentry |

### Network Requirements

| Connection | Bandwidth | Latency |
|-----------|-----------|---------|
| Mobile app → Backend API | 1 Mbps minimum | < 500ms |
| Backend → Blockchain RPC | 5 Mbps | < 1s (Base L2 block time ~2s) |
| Backend → IPFS | 10 Mbps | < 2s |
| Admin Dashboard → Backend | 5 Mbps | < 300ms |

## Local Development Setup

```
# Mobile app
flutter doctor                     # Verify Flutter setup
cd juanderquest_app && flutter pub get
flutter run                        # Run on connected device/emulator

# Backend
cd backend && npm install
cp .env.example .env               # Configure DB, RPC, IPFS credentials
npm run dev                        # Start dev server

# Admin dashboard
cd dashboard && npm install
npm run dev                        # Start Next.js dev server

# Smart contracts
cd contracts && npm install
npx hardhat compile                # Compile Solidity
npx hardhat test                   # Run contract tests
npx hardhat run scripts/deploy.js  # Deploy to testnet
```
