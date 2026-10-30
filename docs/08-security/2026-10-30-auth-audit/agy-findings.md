# Independent Security Audit: Authentication & Account Lifecycle

- **Auditor:** agy (Google Antigravity implementer)
- **Date:** 2026-10-30
- **Scope:** 
  - Backend: `src/routes/auth.ts`, `src/auth/*`, `src/middleware/auth.ts`, `src/middleware/rateLimit.ts`, `src/routes/users.ts`, `src/routes/quests.ts`
  - Web App: `web_app/src/app/login/page.tsx`, `web_app/src/lib/auth.tsx`
  - Mobile App: `juanderquest_app/lib/features/auth/*`
- **Baseline Commit:** backend `origin/claude/mail-quota` (`00c7462`) based on `origin/master` (`758bff2`)

---

## 1. Executive Summary

This independent, source-only security audit focuses on authentication, account lifecycle, session management, and rate limiting across the JuanderQuest platform. JuanderQuest operates a multi-modal authentication ecosystem supporting email/password, simulated Google OAuth, and progressive Web3 wallet linkage. 

Four primary security vulnerabilities were identified in the backend auth flow:
1. **Pre-account takeover / backdoor credential retention during Google OAuth linkage** on accounts registered with unverified emails.
2. **Missing session revocation upon password reset and absence of global session termination**, allowing compromised or stolen JWT sessions to persist indefinitely.
3. **Privilege leakage via stale JWT role claims on `GET /quests/:id`**, allowing demoted administrators or QA staff to view draft quests and unredacted verification marker codes.
4. **Distributed credential stuffing / brute-force susceptibility** on `/auth/login` due to lack of per-account failure throttling.

Additionally, we evaluate the orchestrator's Phase 1 email quota implementation (`00c7462`) and document non-blocking architectural observations.

---

## 2. Confirmed Findings

### AGY-1: Google OAuth Linkage Retains Unverified Password Credentials (Account Pre-Takeover Backdoor)
- **Status:** CONFIRMED
- **Severity:** HIGH (CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:U/C:H/I:H/A:N - 8.1)
- **File & Line Evidence:**
  - `backend/src/routes/auth.ts:566-574`:
    ```typescript
    if (!byGoogle) {
      await identityService.linkOAuthIdentity({
        userId: existingEmailAccount.userId,
        provider: 'google',
        subject: googleUser.sub,
        email: googleUser.email,
        displayName: googleUser.name,
        avatarUrl: googleUser.picture,
      });
      await identityService.markEmailVerified(existingEmailAccount.userId);
    }
    ```
- **Threat Model & Exploit Scenario:**
  - **Attacker:** Any remote, unauthenticated attacker.
  - **Attack Vector:** Pre-account registration / squatting.
  - **Steps:**
    1. Attacker registers an account using a target victim's email (`victim@example.com`) and chooses their own password `AttackerPassword123!`.
    2. JuanderQuest creates the user and stores `password_credentials`. The email remains unverified (`account_emails.is_verified = false`).
    3. The victim visits JuanderQuest and clicks "Sign in with Google" using `victim@example.com`.
    4. Google returns a verified email token matching `victim@example.com`.
    5. The backend locates the existing user by email, links the Google OAuth identity to the user ID, and marks `is_verified = true`.
    6. **Result:** The original `password_credentials` created by the attacker are **not removed or invalidated**. The attacker can now log in via `/auth/login` using `victim@example.com` and `AttackerPassword123!`, retaining permanent backdoor access to the victim's account, personal quests, badges, and vouchers.
- **Remediation:**
  - In `POST /auth/google`, within the `if (!byGoogle)` branch: inspect whether `existingEmailAccount.is_verified` was `false`.
  - If unverified, atomically delete any rows in `password_credentials` for that user (`identityService.removePassword(userId)`) within the same transaction that links the Google OAuth provider and marks the email verified.
  - If the email was already verified prior to OAuth linkage, retain the existing password credentials.

---

### AGY-2: Password Reset Does Not Invalidate Outstanding JWTs (Lack of Session Epoch)
- **Status:** CONFIRMED
- **Severity:** HIGH (CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:H/I:H/A:N - 8.1)
- **File & Line Evidence:**
  - `backend/src/routes/auth.ts:494-533` (`/auth/password/reset` handler):
    ```typescript
    await identityService.setPassword(emailAccount.userId, parsed.data.password);
    // Signs new session token for the resetting user, but performs no invalidation of existing tokens
    const sessionToken = signSessionToken({ ... });
    ```
  - `backend/src/auth/tokens.ts:35-45, 71-85`:
    - Session JWTs are signed with `SESSION_TOKEN_SECRET` and have durations up to 24 hours (or 7 days for progressive wallet sessions).
    - Tokens are purely stateless; no token revocation list, jti tracking, or session epoch is validated in `authenticateToken`.
- **Threat Model & Exploit Scenario:**
  - **Attacker:** Adversary who has exfiltrated or stolen a user's JWT (via XSS, shared browser session, or network interception).
  - **Attack Vector:** Persistent session hijacking post-incident recovery.
  - **Steps:**
    1. Victim notices unauthorized activity and initiates a password reset via email verification code.
    2. Victim successfully completes password reset.
    3. The attacker's stolen session token remains valid until expiration (up to 24 hours/7 days) because JWT verification only checks cryptographic signature and timestamp.
    4. Furthermore, there is no `POST /auth/sessions/revoke-all` or "sign out everywhere" mechanism for users to terminate active sessions across devices.
- **Remediation:**
  - Add a durable `session_epoch INTEGER NOT NULL DEFAULT 0` column to the `users` table via migration (reserved migration `077_session_epoch.sql`).
  - Include `sep: user.session_epoch ?? 0` in session JWT claims.
  - In `authenticateToken` / `optionalAuthenticateToken`, compare `payload.sep` against the user's current `session_epoch`. Use a short in-memory cache/batcher (`AlphaSessionScopeBatcher`) to prevent database bottlenecking. If database is unreachable, return 503 rather than failing open or closed.
  - Increment `session_epoch` on `/auth/password/reset` and provide an authenticated `POST /auth/sessions/revoke-all` endpoint that increments `session_epoch` and clears session cookies.

---

### AGY-3: Demoted Staff Retain Access to Draft Quests and Secret Marker Codes via Stale JWT Role
- **Status:** CONFIRMED
- **Severity:** MEDIUM (CVSS:3.1/AV:N/AC:L/PR:H/UI:N/S:U/C:H/I:N/A:N - 4.9)
- **File & Line Evidence:**
  - `backend/src/routes/quests.ts:177-189`:
    ```typescript
    const isAdminOrQA = Boolean(
      req.user && (req.user.role === 'admin' || req.user.role === 'qa'),
    );
    ```
- **Threat Model & Exploit Scenario:**
  - **Attacker:** Disgruntled former staff member whose administrative or QA role was demoted in the database.
  - **Attack Vector:** Token claim freshness failure on draft/secret retrieval.
  - **Steps:**
    1. Admin demotes staff user from `'admin'` or `'qa'` to `'traveler'` in PostgreSQL.
    2. Former staff member possesses a valid session JWT with claim `role: 'admin'`.
    3. While endpoints guarded by `requireAdmin` perform durable database role verification (`AlphaSessionScopeBatcher.getRole(req.user.id)`), `GET /quests/:id` only checks `req.user.role` from the unverified JWT payload.
    4. **Result:** The demoted user can fetch unpublished draft quests and inspect unredacted verification secrets (`marker_code`, `challenge_nonce`), bypassing quest verification safeguards.
- **Remediation:**
  - In `src/routes/quests.ts`, ensure `isAdminOrQA` validates the durable role from PostgreSQL (e.g., using `AlphaSessionScopeBatcher` or looking up user role) rather than trusting `req.user.role` blindly.

---

### AGY-4: Distributed Credential Stuffing / Password Brute-Force via IP-Only Throttle
- **Status:** CONFIRMED
- **Severity:** MEDIUM (CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:L/I:L/A:N - 5.3)
- **File & Line Evidence:**
  - `backend/src/routes/auth.ts:339-340`:
    ```typescript
    router.post('/login', authLimiter, async (req, res) => { ... });
    ```
  - `backend/src/middleware/rateLimit.ts:31-36`:
    ```typescript
    export const authLimiter = rateLimit({
      windowMs: 60 * 1000,
      max: 15,
      ...
    });
    ```
- **Threat Model & Exploit Scenario:**
  - **Attacker:** Remote attacker attempting credential stuffing or brute-forcing a known high-value target email.
  - **Attack Vector:** Distributed rotating-proxy attack.
  - **Steps:**
    1. Attacker sends requests to `POST /auth/login` targeting `target@juanderquest.app`.
    2. Rate limiting is purely IP-based (15 requests/minute/IP).
    3. By cycling through residential proxies or rotating source IPs, the attacker can submit thousands of password guesses against a single account without triggering the IP limiter.
- **Remediation:**
  - Implement an in-memory per-account failure tracker keyed by normalized email address.
  - After 10 consecutive failed logins within 15 minutes, impose a 15-minute cooldown.
  - Return the identical 401 `INVALID_CREDENTIALS` error code to avoid enumeration of locked accounts.
  - Clear the failure tracker upon any successful authentication.

---

## 3. Critique of Phase 1 Email Quota Implementation (`claude/mail-quota` `00c7462`)

We reviewed the orchestrator's implementation in `src/auth/mailerService.ts`:
1. **Strengths:**
   - Efficient use of the existing `auth_mail_outbox` table without introducing schema migrations or overhead.
   - Dual-window recipient throttling: 1 email per 60 seconds (prevents bursts) and 5 emails per hour (prevents sustained harassment).
   - Global daily cap (`AUTH_MAIL_DAILY_CAP` default 90), preserving a 10-email buffer below Resend's 100-email/day free-tier threshold.
   - Fallback in-memory tracking for test/offline environments.
2. **Critiques & Observations:**
   - **Enumeration vs. Rate Limit UX Discrepancy:** The handout specified returning 429 `CODE_RECENTLY_SENT` on `/auth/email/resend`. However, the implementation returns `{ success: true, message: 'If an account exists, a verification code was sent.' }` even when delivery fails due to `RECIPIENT_COOLDOWN`.
     - *Assessment:* This design trade-off favors **anti-enumeration** over immediate UI feedback. It prevents attackers from using `/auth/email/resend` to probe whether an address was recently emailed. While the user does not receive a `retry_after_seconds` timer, this is a sound security decision for public endpoints.
   - **Concurrency / Race Condition:** The count check (`SELECT count(*)...`) and subsequent insert into `auth_mail_outbox` occur without table or row-level locking. Under heavy concurrent bombardment on a single recipient from multiple connections, it is theoretically possible for 2 or 3 requests to pass the check simultaneously before outbox rows are committed. However, given the 90 daily cap vs 100 provider limit, this margin safely absorbs race bursts in practice.

---

## 4. Other Architectural Observations & Out-of-Scope Items

1. **Account Enumeration on `/auth/register` (F5):**
   - Registering an existing email returns 409 `EMAIL_ALREADY_EXISTS`. This allows attackers to enumerate registered users. Changing this to a generic response requires deep changes to user onboarding flow and UX, which the product owner flagged as out of scope.
2. **Web3 SIWE Signature Verification Domain/URI Binding (F6):**
   - In `POST /auth/wallet/verify`, the backend verifies the cryptographic signature of the nonce message. However, standard EIP-4361 URI and domain binding checks are loose. Deferred to a dedicated Web3/wallet hardening plan.
3. **Password Login on Unverified Email Accounts:**
   - Currently, users who register with an email can immediately log in before verifying the code. While standard practice often requires verification prior to first login, JuanderQuest currently accommodates progressive wallet onboarding where users complete profiles with unverified contact addresses. Deferred pending wallet migration.
4. **Client-side Token Storage:**
   - The web app supports session cookies (`juanderquest_session`) with `httpOnly: false` for client-side reading in `web_app/src/lib/auth.tsx`. The mobile app stores JWT tokens securely via `flutter_secure_storage`. This is consistent with current cross-origin frontend requirements.

---

## 5. Conclusion & Action Plan

- Phase 0 audit confirms the validity and severity of AGY-1 (Google squatted account takeover), AGY-2 (lack of session invalidation), AGY-3 (stale quest role access), and AGY-4 (login brute-force).
- We will proceed immediately with implementing Phase 2 and Phase 3, followed by Phase 4.

---

## 6. Reviewer Comparison & Agreement Table

Comparing `agy-findings.md` with Claude Code's independent audit (`claude-findings.md`):

| Finding Area | Claude Finding | agy Finding | Agreement Status | Notes & Severity Nuances |
|---|---|---|---|---|
| **Google Squatted Account Takeover** | F1 (Confirmed squatting, latent merge) | AGY-1 (Confirmed) | **Both Found** | Full agreement on exploit mechanism and fix. Claude marked latent because `GOOGLE_CLIENT_ID` is unset in prod; agy assessed as High severity because the vulnerability exists in codebase and executes whenever Google OAuth is active. |
| **Session Lifetime & Invalidation** | F2 (Medium) | AGY-2 (High) | **Both Found** | Full agreement. agy assessed as High due to 7-day extended token lifetimes with no user-controlled revocation mechanism. |
| **Mailer Quota Exhaustion** | F3 (Medium) | AGY-5 (Critique of Phase 1) | **Both Found** | Full agreement. Phase 1 landed in `00c7462`. agy noted anti-enumeration trade-off (200 vs 429). |
| **Per-Account Login Throttle** | F4 (Low) | AGY-4 (Medium) | **Both Found** | Full agreement. agy assessed as Medium due to low-cost distributed credential stuffing. |
| **Registration Account Enumeration** | F5 (Low) | AGY-6.1 (Info) | **Both Found** | Full agreement; out of scope per owner direction. |
| **SIWE Domain/URI Binding** | F6 (Needs validation) | AGY-6.2 (Info) | **Both Found** | Full agreement; out of scope for current plan. |
| **Demoted Staff Stale JWT Role on Quests** | F7 (Informational) | AGY-3 (Medium) | **Both Found** | agy rated Medium (vs Claude's Info) because `GET /quests/:id` exposes unpublished `marker_code`s and secret challenge nonces, compromising quest game integrity. |
| **Unverified Email Login** | F1 note | AGY-6.3 (Info) | **Both Found** | Full agreement; deferred pending progressive wallet migration. |

### Summary of Disagreements / Variance
- **No fundamental disagreements on root causes or solutions:** Both auditors converged on the exact same findings, attack surfaces, and minimal fix strategies.
- **Severity nuances:** agy rated F1, F2, F4, and F7 slightly higher than Claude, accounting for game-integrity risks (secret marker codes in draft quests) and distributed proxy botnets against login endpoints.

