# Security Overview

Source of truth: `docs/08-security/README.md`.

## Non-negotiable controls

- SIWE nonce is cryptographically random, single-use and expires after five minutes.
- Backend verifies every proof; blockchain immutability does not validate off-chain data.
- Quest proofs bind quest, wallet, nonce, coordinates, timestamp and AR/photo evidence.
- Offline submissions use encrypted queues and idempotency keys; rewards never settle offline.
- Admin and treasury keys never enter source, database, logs or mobile builds.
- IPFS is public: strip photo EXIF and never upload private data or secrets.
- Contract rewards prevent duplicate submission payouts and expose pause/access controls.
- Base mainnet ownership moves to multisig after testnet validation.

## Open decisions

- GPS radius/accuracy
- QR and offline-proof expiry
- JWT lifetime/revocation
- Multisig threshold
- Data retention
- DAO security parameters
