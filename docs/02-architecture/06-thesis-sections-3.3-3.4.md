# Thesis Paper — Sections 3.3 and 3.4

---

## 3.3 Systems Architecture

System architecture is the structured design of a system that shows how all components interact and work together to achieve system functions. JuanDerQuest follows a four-layer client-server architecture with blockchain integration, comprising the Presentation Layer, Application Layer, Data Layer, and Blockchain Layer. The system employs an offline-first strategy where the mobile application maintains a local cache for core functionality and synchronizes with the backend when network connectivity becomes available.

**Figure 3.1** presents the system architecture diagram of JuanDerQuest.

*[Insert system-architecture.svg here]*

**Figure 3.1. System Architecture of JuanDerQuest**

### Presentation Layer

The Presentation Layer serves as the user-facing interface of the system and consists of two components: the Mobile Application and the Admin Dashboard.

The Mobile Application is a cross-platform Flutter application supporting Android 8.0 (API 26) and iOS 15.0 and above. It utilizes Riverpod for state management and communicates with the backend through a REST API. The application integrates WalletConnect for Web3 wallet operations and viem for direct blockchain read operations. Augmented reality functionalities are powered by ARCore for Android devices and ARKit for iOS devices, enabling QR code-triggered AR interactions at quest destinations.

The Admin Dashboard is a web-based interface built with Next.js that provides administrators with the tools to manage quests, verify user submissions, mint tokens, and view platform analytics. It consumes the same REST API as the mobile application.

### Application Layer

The Application Layer consists of the Backend API Server, built with Node.js and TypeScript using the Express framework. This layer is responsible for authentication through Sign-In with Ethereum (SIWE), quest CRUD operations, cryptographic verification of AR proof submissions, user management, and the orchestration of smart contract calls for automated token reward distribution. The backend serves as the intermediary between the mobile application, the database, and the blockchain network.

### Data Layer

The Data Layer comprises three storage components. The Relational Database, implemented using PostgreSQL hosted on Supabase, stores persistent data including user identities, quest definitions, submission records, reward transactions, merchant profiles, badge definitions, and DAO governance data. Decentralized Storage is provided by the InterPlanetary File System (IPFS) through Pinata or Web3.Storage, used for storing badge metadata, AR 3D assets, quest photographs, and other media files with content-addressed retrieval. Device Local Storage, implemented using either Hive or SQLite, maintains an offline cache of quest data and a synchronized queue for quest completions submitted without internet connectivity.

### Blockchain Layer

The Blockchain Layer is deployed on the Base Layer 2 network, an EVM-compatible rollup chain. It consists of four smart contracts. The JDQ Token contract is an ERC-20 mintable utility token serving as the reward currency, with its minting controlled by the platform treasury. The Quest Reward contract automates the distribution of JDQ tokens to users upon admin-approved quest completions. The NFT Badge contract implements the ERC-5192 soulbound token standard, minting non-transferable achievement badges when users reach milestone criteria defined by administrators. The DAO Governance contract enables token-weighted voting on community fund allocation proposals, allowing JDQ token holders to participate in platform governance decisions.

---

## 3.4 Hardware and Software Requirements

The successful development, deployment, and operation of JuanDerQuest require specific hardware configurations and software tools across development machines, end-user mobile devices, and server infrastructure. This section specifies the minimum and recommended requirements for each category.

### Development Machine Requirements

The development environment requires a computer system capable of running the Flutter SDK, Node.js runtime, smart contract development tools, and database management software. Table 3.1 presents the hardware requirements for the development machine.

**Table 3.1. Development Machine Hardware Requirements**

| Component | Minimum Specification | Recommended Specification |
|-----------|---------------------|--------------------------|
| Processor | Intel Core i5 or AMD Ryzen 5 (4 cores) | Intel Core i7 or AMD Ryzen 7 (8 cores) |
| Random Access Memory | 8 GB | 16 GB |
| Storage | 50 GB free space (SSD) | 100 GB free space (SSD) |
| Operating System | Windows 10 / macOS 12 / Ubuntu 22.04 | Windows 11 / macOS 14 / Ubuntu 24.04 |
| Display Resolution | 1920 × 1080 | 2560 × 1440 |

### Mobile Device Requirements

End users require a mobile device with sufficient hardware capabilities to run the Flutter application, access the device camera for QR code scanning and optional photography, utilize GPS for location verification, and support augmented reality features through ARCore or ARKit. Table 3.2 presents the hardware requirements for end-user mobile devices.

**Table 3.2. Mobile Device Hardware Requirements**

| Component | Minimum Specification | Recommended Specification |
|-----------|---------------------|--------------------------|
| Operating System | Android 8.0 (API 26) or iOS 15.0 | Android 12.0 or iOS 17.0 |
| Random Access Memory | 3 GB | 6 GB |
| Available Storage | 100 MB | 500 MB |
| Rear Camera | 8 megapixels | 12 megapixels or higher |
| GPS | A-GPS with GLONASS | A-GPS with GLONASS and Galileo |
| Augmented Reality | ARCore-compatible (Android) / iPhone 6s or later (iOS) | ARCore-certified (Android) / iPhone XR or later (iOS) |
| Network Connectivity | Wi-Fi 802.11n or 4G LTE | Wi-Fi 802.11ac or 5G |
| Battery Capacity | 3,000 mAh | 4,000 mAh or higher |

The application requires a stable internet connection for blockchain transactions, database synchronization, and IPFS uploads. Core features such as quest browsing and QR code scanning remain functional during offline periods through local caching and queued synchronization.

### Server Requirements

The server infrastructure hosts the backend API, the admin dashboard, and the database. Table 3.3 presents the server hardware requirements for both minimal viable deployment and production-scale operation.

**Table 3.3. Server Hardware Requirements**

| Component | Minimum (MVP) | Recommended (Production) |
|-----------|---------------|--------------------------|
| Virtual CPUs | 2 vCPU | 4 vCPU |
| Random Access Memory | 4 GB | 8 GB |
| Storage | 20 GB SSD | 50 GB SSD |
| Network Bandwidth | 1 TB per month | 5 TB per month |
| Operating System | Ubuntu 22.04 LTS | Ubuntu 24.04 LTS |

### Software Requirements

The development and deployment of JuanDerQuest require a specific set of software tools, frameworks, and libraries. Table 3.4 presents the software requirements categorized by their role in the system.

**Table 3.4. Software Requirements**

| Category | Software | Version | Purpose |
|----------|----------|---------|---------|
| Mobile Framework | Flutter SDK | 3.x | Cross-platform mobile application framework |
| Programming Language | Dart | 3.x | Application logic for Flutter |
| | TypeScript | 5.x | Backend and dashboard programming |
| | Solidity | 0.8.x | Smart contract programming |
| Backend Runtime | Node.js | 20 LTS | Server-side JavaScript runtime |
| Web Framework | Express or Fastify | Latest | REST API HTTP server |
| | Next.js | Latest | Admin dashboard React framework |
| Database | PostgreSQL | 16 | Relational database management system |
| Blockchain Tools | Hardhat | Latest | Smart contract development and deployment |
| | WalletConnect v2 | Latest | Web3 wallet pairing protocol |
| | viem | Latest | Ethereum RPC communication and wallet operations |
| Authentication | Sign-In with Ethereum (SIWE) | Latest | Wallet-based server-side authentication |
| Decentralized Storage | Pinata or Web3.Storage | Latest | IPFS file pinning and content delivery |
| Version Control | Git | Latest | Source code management |
| Continuous Integration | GitHub Actions | — | Automated testing and deployment |
| Error Monitoring | Sentry | — | Application error tracking and reporting |

### Mobile Application Dependencies

Table 3.5 lists the primary Flutter packages used in the mobile application.

**Table 3.5. Flutter Package Dependencies**

| Package | Purpose |
|---------|---------|
| flutter_riverpod | State management |
| walletconnect_flutter_v2 | Web3 wallet connectivity |
| viem (Dart implementation) | Ethereum blockchain interactions |
| qr_code_scanner | QR code scanning at quest destinations |
| arcore_flutter_plugin | Android ARCore integration |
| arkit_flutter_plugin | iOS ARKit integration |
| hive or sqflite | Local device storage for offline cache |
| dio | HTTP client for REST API communication |
| flutter_secure_storage | Secure storage for wallet credentials and tokens |

### Network Requirements

Table 3.6 specifies the network performance requirements for each communication pathway in the system.

**Table 3.6. Network Requirements**

| Communication Pathway | Minimum Bandwidth | Maximum Acceptable Latency |
|-----------------------|-------------------|---------------------------|
| Mobile Application to Backend API | 1 Mbps | 500 milliseconds |
| Backend to Blockchain RPC Provider | 5 Mbps | 1 second |
| Backend to IPFS Pinning Service | 10 Mbps | 2 seconds |
| Admin Dashboard to Backend API | 5 Mbps | 300 milliseconds |

### Deployment Infrastructure

Table 3.7 lists the recommended cloud service providers for each infrastructure component.

**Table 3.7. Recommended Deployment Services**

| Component | Recommended Provider | Purpose |
|-----------|---------------------|---------|
| Source Code Repository | GitHub | Version control and collaboration |
| Continuous Integration | GitHub Actions | Automated build, test, and deployment |
| Backend API Hosting | Railway or Fly.io | Node.js application server |
| Admin Dashboard Hosting | Vercel | Next.js static and server-side rendering |
| Database Hosting | Supabase or Neon | Managed PostgreSQL database |
| IPFS Pinning Service | Pinata or Web3.Storage | Decentralized content storage |
| Blockchain RPC Provider | Alchemy or Infura | Base Layer 2 network access |
| Error Monitoring | Sentry | Application error tracking |
