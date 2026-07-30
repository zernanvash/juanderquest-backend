# Prototype Security & Validation Specification — JuanderQuest

**Version:** Prototype Scaffold 1.0  

---

## 1. Overview

This document specifies the security controls, validation rules, and threat mitigations enforced in the JuanderQuest prototype build.

---

## 2. Validation & Security Controls

### 2.1 Server-Side GPS Radius Validation
While the mobile client captures device GPS, the backend calculates the geodesic distance using the Haversine formula between captured coordinates $(lat_1, lng_1)$ and target quest coordinates $(lat_2, lng_2)$:

$$d = 2r \arcsin\left(\sqrt{\sin^2\left(\frac{\Delta \phi}{2}\right) + \cos(\phi_1)\cos(\phi_2)\sin^2\left(\frac{\Delta \lambda}{2}\right)}\right)$$

- **Threshold:** Distance $d$ must be $\le \text{quest.radius\_meters}$ (default: $200\text{ meters}$).
- **Flagging:** Submissions exceeding the radius threshold are flagged in the admin dashboard with a warning badge showing the exact distance offset.

### 2.2 AR Marker Code Binding
- The payload must include `scanned_marker_code`.
- The server validates that `scanned_marker_code == quest.marker_code`.
- Submissions with mismatched marker codes are rejected immediately (`400 VALIDATION_ERROR`).

### 2.3 Idempotency & Replay Prevention
- **Client-Generated UUID:** Every submission payload includes a unique `idempotency_key` generated on the device before transmission.
- **Backend Lock:** If a request with an existing `idempotency_key` is received, the backend returns the existing submission record without re-processing.
- **Unique Approved Constraint:** Database schema includes a partial unique index `idx_submissions_unique_approved` preventing more than one `approved` status per `(user_id, quest_id)`.

### 2.4 JWT Demo Authentication
- Demo JWT access tokens are signed using `HS256` with a server secret `JWT_SECRET`.
- Tokens expire after 24 hours in development.
- Admin routes (`/api/v1/admin/*`) inspect the decoded token's `role` claim and reject non-admin users with `403 FORBIDDEN`.

---

## 3. Reconciliation of Offline Contradiction

- **Prototype Constraint:** The prototype scaffold operates **online-only**.
- **Rationale:** Prevents stale challenge nonces and complex sync collision edge cases during prototype demonstration.
- **Handling:** If the device loses internet connectivity during quest completion, the app displays a clear banner: *"Internet connection required to submit quest proof."*
