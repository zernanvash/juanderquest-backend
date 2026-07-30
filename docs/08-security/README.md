# Security Design — JuanDerQuest

## Scope

This document defines the security controls for the Flutter application, admin dashboard, backend API, PostgreSQL database, IPFS assets, offline synchronization, and Base L2 smart contracts. Blockchain records do not make off-chain inputs trustworthy; quest proofs must be validated before any reward transaction is submitted.

## Trust Boundaries

| Boundary | Trusted component | Untrusted input |
|----------|-------------------|-----------------|
| Mobile → Backend | Backend verification logic | Wallet signatures, GPS, QR and AR proof payloads |
| Dashboard → Backend | Role-based API authorization | Browser requests and uploaded files |
| Backend → Database | Parameterized application queries | User-controlled text and JSON payloads |
| Backend → IPFS | Validated upload service | Photos, avatars, metadata and AR assets |
| Backend → Base L2 | Deployed contract addresses and RPC responses | Transaction requests and external contract calls |
| Offline queue → Sync API | Server validation and idempotency rules | Delayed or modified local submissions |

## Assets to Protect

- User wallet identity, profile and location data
- Admin and treasury signing authority
- Quest QR secrets, challenge nonces and completion proofs
- JDQ token supply, reward treasury and merchant payments
- Badge ownership and DAO voting integrity
- Database credentials, RPC keys, IPFS credentials and JWT secrets

## Threats and Required Controls

| Threat | Required controls |
|--------|-------------------|
| Wallet impersonation | SIWE signature verification, domain/URI/chain checks, single-use nonce with five-minute expiry |
| JWT theft | HTTPS only, short-lived access tokens, secure device storage, server-side role checks on every protected endpoint |
| QR copying or replay | Signed QR payload, unique challenge nonce, quest/site binding, expiry and one approved completion per user/quest |
| GPS spoofing | Server-side radius check, device accuracy value, impossible-travel checks, AR or photo evidence, manual review for suspicious proofs |
| AR proof fabrication | Bind interaction hash to quest, wallet, nonce, timestamp and coordinates; verify the wallet signature server-side |
| Offline proof replay | Encrypted queue, immutable client submission ID, idempotency key, server nonce tracking and stale-proof review |
| Admin account compromise | Wallet allowlist and role checks, environment-seeded super admin, multisig treasury recommended before mainnet |
| Backend signer compromise | Store keys in a managed secret/KMS, never in source code, database, logs or mobile builds; restrict contract roles |
| API abuse | Schema validation, parameterized queries, rate limits, payload limits, CORS allowlist and audit logging |
| Malicious uploads | MIME/signature validation, size limits, malware scanning where available, EXIF removal and CID verification |
| Smart-contract exploit | OpenZeppelin contracts, least-privilege roles, checks-effects-interactions, reentrancy protection where needed, pause controls and tests |

## Authentication and Authorization

1. Client requests a nonce from `POST /api/v1/auth/nonce`.
2. Backend generates a cryptographically random nonce tied to the wallet address; it expires after five minutes and is consumed once.
3. Wallet signs the complete SIWE message.
4. Backend verifies signature recovery, nonce, domain, URI, issued time and allowed chain ID before issuing a JWT.
5. Backend derives authorization from the current database role, not from a role supplied by the client or embedded indefinitely in a stale token.

The first administrator wallet is supplied through a deployment secret. Only authorized administrators may promote another wallet. Admin routes must enforce authorization server-side even when the dashboard hides the corresponding controls.

## Quest-Proof Security

The signed proof envelope is:

```json
{
  "submission_id": "client-generated UUID",
  "quest_id": "UUID",
  "wallet_address": "0x...",
  "proof_type": "ar | qr_gps | qr_gps_photo",
  "qr_nonce": "single-use challenge",
  "gps_lat": 16.2063,
  "gps_lng": 119.9706,
  "gps_accuracy_m": 12.4,
  "captured_at": "ISO-8601 timestamp",
  "interaction_hash": "0x...",
  "photo_cid": "optional IPFS CID",
  "signature": "0x..."
}
```

The backend must reconstruct the canonical signed message and verify all bound fields. It must reject duplicate submission IDs, consumed nonces, invalid signatures and already-approved user/quest pairs.

Physical QR signage contains a signed site identifier, not a reusable reward authorization. Online clients obtain a short-lived challenge nonce after scanning. Offline proofs are queued, synchronized later and may require manual review because the client cannot receive a fresh online challenge.

## Offline-First Security

- Store JWTs and wallet session secrets in platform secure storage, not the general local database.
- Encrypt queued proof payloads and remove them after acknowledged synchronization.
- Treat all local data as untrusted when synchronized; repeat validation on the server.
- Use client-generated UUIDs as idempotency keys to prevent duplicate rewards after retries.
- Display cached wallet balances, badges and leaderboards as potentially stale while offline.
- Blockchain rewards and merchant payments cannot finalize offline.

## API and Backend Security

- Require TLS for all deployed endpoints.
- Validate requests and responses with Zod or equivalent schemas.
- Use parameterized SQL through the selected database library.
- Enforce the documented rate limits, including stricter limits for auth and submission routes.
- Restrict CORS to the production dashboard and approved development origins.
- Do not log signatures, JWTs, secrets, full location histories or uploaded file contents.
- Record immutable audit events for role changes, quest changes, approvals, rejections, minting and contract administration.
- Use separate development, test and production credentials and contract addresses.

## Database and Privacy

- The backend service account is the only general database writer; public database access is disabled.
- Apply least-privilege credentials and Supabase Row Level Security if clients ever access Supabase directly.
- Encrypt database connections and managed backups.
- Store only quest-completion coordinates required for verification; do not continuously track users.
- Define retention periods before production for rejected proofs, location records, audit logs and deleted profiles.
- Wallet addresses and on-chain activity are public pseudonymous data, not anonymous data.

## IPFS Security

IPFS content is publicly retrievable by CID and cannot be treated as private storage. Do not upload identity documents, secrets, precise location history or other private data. Strip EXIF metadata from photos, validate AR assets and metadata before pinning, and store only the resulting CID in PostgreSQL and contract metadata.

## Smart-Contract Security

| Contract | Controls |
|----------|----------|
| `JDQToken` | Cap or explicitly govern minting; restrict `MINTER_ROLE`; emit mint events; use 18 decimals |
| `QuestReward` | Authorized backend/relayer role, unique submission hash, pause switch, no duplicate payout |
| `BadgeNFT` | Restrict minting, enforce ERC-5192 non-transferability, prevent duplicate badge awards |
| `DAOGovernance` | Snapshot voting power, proposal threshold, quorum, voting delay/period and protected execution |

Deploy and test contracts on Base Sepolia before Base mainnet. Mainnet ownership should use a multisig rather than one developer wallet. Deployment addresses, constructor arguments and verified source code must be recorded.

## Secrets Management

Required secrets include the database URL, JWT signing secret, WalletConnect project ID, RPC API key, IPFS pinning credential, push-service credential and backend signer credential. Commit only `.env.example`; CI/CD and hosting provider secret stores hold real values. Rotate any credential exposed in source code, logs, screenshots or shared documents.

## Security Verification Gates

Before alpha:

- SIWE rejects reused or expired nonces.
- Protected API routes enforce roles.
- Duplicate quest submissions cannot create duplicate rewards.

Before beta:

- Offline retries are idempotent.
- Upload validation and EXIF removal are tested.
- Contract unit tests cover access control, replay prevention, pause behavior and failure paths.
- Dependency, secret and static-analysis scans run in CI.

Before mainnet:

- Resolve all high/critical findings from contract review.
- Move privileged ownership to multisig.
- Verify contracts and record deployment details.
- Complete backup restore and incident-response tests.

## Open Security Decisions

- GPS acceptance radius and accuracy threshold
- QR challenge lifetime and offline-proof maximum age
- JWT lifetime and session revocation mechanism
- Treasury multisig signers and approval threshold
- Data-retention periods
- DAO quorum, proposal threshold and voting period
