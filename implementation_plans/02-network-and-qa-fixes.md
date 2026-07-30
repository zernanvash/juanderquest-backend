# Network & QA Fix Plan — JuanderQuest Prototype

**Created:** 2026-07-30 10:16
**Status:** Execution ready

---

## 1. Network Topology (Done)

```
Azure Linux VM (Hub)
  WireGuard: 10.9.0.1/24, UDP 51820
  ip_forward=1, FORWARD wg0→wg0 allowed
       │
       ├── Windows Laptop: 10.9.0.2/24
       │     Backend: TCP 4000
       │     Dashboard: TCP 3000 (localhost only)
       │     Firewall rule added: TCP 4000 from 10.9.0.0/24
       │
       └── Android Phone: 10.9.0.3/24
             Flutter API: http://10.9.0.2:4000/api/v1
```

**Verified:** Ping both directions, `/api/v1/health` reachable from phone.

---

## 2. Flutter API URL Configuration

**File:** `lib/core/network/api_client.dart`

Remove hard-coded `10.0.2.2` and `localhost` fallback. Use a `--dart-define` compile-time constant:

```dart
const String apiBaseUrl = String.fromEnvironment(
  'API_BASE_URL',
  defaultValue: 'http://10.0.2.2:4000/api/v1', // emulator fallback
);
```

Run commands:

| Target | Command |
|---|---|
| Emulator | `flutter run` |
| Physical phone | `flutter run --dart-define=API_BASE_URL=http://10.9.0.2:4000/api/v1` |
| Android APK | `flutter build apk --dart-define=API_BASE_URL=http://10.9.0.2:4000/api/v1` |

---

## 3. Android Project Scaffolding & Permissions

### Generate platform projects

```
flutter create --platforms=android,ios .
```

Do not overwrite `lib/`, `pubspec.yaml`, or `analysis_options.yaml`.

### AndroidManifest.xml

Ensure these permissions in `android/app/src/main/AndroidManifest.xml`:

```xml
<uses-permission android:name="android.permission.INTERNET"/>
<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION"/>
<uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION"/>
<uses-permission android:name="android.permission.CAMERA"/>
```

### Cleartext traffic (VPN-only prototype)

Add to the same `AndroidManifest.xml` `<application>` tag:

```xml
android:usesCleartextTraffic="true"
```

Or create a scoped `network_security_config.xml` that allows only `10.9.0.2`:

```xml
<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
    <domain-config cleartextTrafficPermitted="true">
        <domain includeSubdomains="false">10.9.0.2</domain>
    </domain-config>
</network-security-config>
```

### iOS (scaffold only, no AR validation)

Add location and camera usage descriptions to `ios/Runner/Info.plist`:

```xml
<key>NSLocationWhenInUseUsageDescription</key>
<string>GPS location is required for quest proof verification.</string>
<key>NSCameraUsageDescription</key>
<string>Camera is required for AR marker scanning.</string>
```

---

## 4. QA Blocker Fixes

### 4.1. Remove fabricated GPS fallback

**File:** `lib/features/ar_experience/screens/ar_experience_screen.dart`

- If GPS fails (permission denied, disabled, timeout), show an error state.
- Do not generate fake coordinates near the quest target.
- Let the user retry or cancel.

### 4.2. Remove fake login/submission fallbacks

**Files:**
- `lib/features/auth/providers/auth_provider.dart`
- `lib/features/submissions/providers/submission_provider.dart`

- On network error, propagate the exception instead of creating fake local records.
- UI should display an error banner and a retry action.
- A demo with network failure should visibly show the error, not silently succeed.

### 4.3. Backend: enforce quest GPS radius

**File:** `backend/src/routes/submissions.ts`

On submission creation (before persist), compute `haversine(lat, lng, quest.lat, quest.lng)`. Reject with `422` if the distance exceeds `quest.radius_meters`:

```text
Response 422:
{ "code": "OUT_OF_RANGE", "message": "Your location is too far from the quest destination." }
```

The admin dashboard may still review out-of-range edge cases, but the API must enforce by default unless the admin explicitly overrides.

### 4.4. Backend: scope idempotency keys per user

**File:** `backend/src/routes/submissions.ts` / `backend/src/db/index.ts`

Change the idempotency lookup from:

```sql
WHERE idempotency_key = $1
```

to:

```sql
WHERE idempotency_key = $1 AND user_id = $2
```

This prevents user A from discovering user B's submission.

### 4.5. Backend: prevent repeated approval and reward inflation

**File:** `backend/src/routes/admin.ts` / `backend/src/db/index.ts`

- Allow `approve` only if current status is `pending`.
- Allow `reject` only if current status is `pending`.
- Add points only on the first `pending → approved` transition.
- Re-approving an already-approved submission is a no-op (idempotent).
- Rejecting an already-rejected submission is a no-op.
- Rejecting an approved submission should either be disallowed or reverse the points.

### 4.6. Backend: prevent duplicate approved completions

**File:** `backend/src/routes/submissions.ts`

Before accepting a new submission, check if the user already has an approved submission for the same quest. If so, reject with `409`:

```text
Response 409:
{ "code": "ALREADY_COMPLETED", "message": "You have already completed this quest." }
```

### 4.7. Backend: validate state transitions

**File:** `backend/src/routes/admin.ts`

State machine:

```
pending  →  approved  (awards points)
pending  →  rejected  (no points, reason required)
approved →  approved  (no-op, idempotent)
rejected →  rejected  (no-op, idempotent)
approved →  rejected  (optional: reverse points or disallow)
rejected →  approved  (optional: allow if admin reconsiders)
```

### 4.8. Backend: points persistence

**Decision:** If PostgreSQL is not yet wired, the in-memory store is acceptable for the showcase IF the limitation is documented. Preferred: wire PostgreSQL now for proper persistence.

If persisting, add a `points_balance` column to the in-memory `users` or PostgreSQL `users` table. Update on approval, lock to prevent race conditions.

---

## 5. AR Marker Recognition

**Decision required from team:**

| Option | Risk | Effort |
|---|---|---|
| A. Real camera marker scanning | Package compatibility, device testing | High |
| B. Keep simulated 2-second animation, clearly labeled | None | None |

If Option B, add visible UI labels:

- "AR simulation — marker recognition not yet integrated"
- A manual "Simulate Scan" button replacing the 2-second auto-detect

---

## 6. Build & Verification

### 6.1. Backend

```powershell
cd backend
npm test
npm run build
```

Backend tests must cover:

- GPS radius enforcement
- Repeated approval rejection
- User-scoped idempotency
- Duplicate completion
- State transition constraints
- Auth middleware: valid/invalid/expired JWT, admin-only routes
- CORS headers

### 6.2. Dashboard

```powershell
cd dashboard
npm run build
```

No dashboard tests exist yet. Verify manually:

- Pending list loads approved/rejected correctly
- Approve/reject calls succeed
- Error states visible on failure

### 6.3. Flutter

```powershell
cd juanderquest_app
flutter pub get
flutter analyze
flutter test
flutter build apk --dart-define=API_BASE_URL=http://10.9.0.2:4000/api/v1
```

Flutter tests:

- Provider: login success/failure, quest list load, submission creation
- Widget: error banners render on network failure
- Integration (optional): login → quest list → submission → history

---

## 7. End-to-End Verification (Phone)

1. Install APK on phone.
2. Open app → demo login screen appears.
3. Select seeded user → quest list loads.
4. Select quest → details + AR simulation screen.
5. GPS permission prompt → accept.
6. Scan button / simulated scan → marker recognized.
7. Submit proof → confirmation screen with pending status.
8. Open laptop dashboard → login as admin → pending submission visible.
9. Approve → success.
10. Refresh Flutter history → status shows approved.
11. Profile screen → demo points increased.
12. Repeat same quest → "already completed" error.
13. Kill backend → app shows error banner, no fake record created.

---

## 8. Deferred Reminders

| Item | Status |
|---|---|
| Real camera/QR scanning | Deferred, decision pending |
| PostgreSQL persistence | Recommendation: wire now, or document in-memory limitation |
| iOS AR validation | Deferred, scaffold only |
| Dashboard tests | Deferred |
| Flutter integration tests | Deferred |
| Rate limiting | Not yet implemented |
| TLS | Deferred (HTTP inside VPN acceptable for prototype) |
| CORS restrict to dashboard origin | Deferred (currently `*`, limited risk inside VPN) |
| Rotate default JWT secret | Before any exposure beyond current team |
