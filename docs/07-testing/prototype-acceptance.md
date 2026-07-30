# Prototype Acceptance Criteria & Test Plan — JuanderQuest

**Created:** 2026-07-30  
**Status:** Approved Acceptance Specification  

---

## 1. Single-Pass Showcase Acceptance Scenario

The prototype is deemed successful when the following single end-to-end scenario executes without manual database edits or code restarts:

1. **User Authentication:**
   - Evaluator opens Flutter app, selects seeded `Juan Dela Cruz (user-1)`, and logs in.
   - App displays active user profile with initial `100 demo_points`.

2. **Quest Discovery:**
   - Quest list loads from Express API displaying 5 Pangasinan quests.
   - Evaluator taps **"Hundred Islands Eco Trek"** detail page.

3. **AR & Geolocation Capture:**
   - Evaluator grants Camera and Location permissions.
   - App opens AR camera viewfinder.
   - Camera scans printed `MARKER_HUNDRED_ISLANDS_01` marker target.
   - 3D animated JuanderQuest coin overlay appears over marker.
   - App captures real-time GPS coordinates ($16.2065, 119.9704$).

4. **Proof Submission:**
   - Evaluator taps "Submit Proof".
   - App sends `POST /api/v1/submissions` with idempotency UUID.
   - Submission state enters `pending`. Flutter displays pending status chip.

5. **Admin Verification:**
   - Evaluator opens Web Admin Dashboard (`dashboard/`), logs in as `admin-1`.
   - Admin pending queue displays Juan's submission for "Hundred Islands Eco Trek".
   - Admin inspects distance offset ($28.5m$) and taps **"Approve"**.
   - API updates submission state to `approved` and increments Juan's `demo_points` by $50$.

6. **Points Awarded:**
   - Evaluator refreshes or navigates back to profile on Flutter app.
   - Submission history shows status `APPROVED`.
   - Total demo points balance updates from $100 \rightarrow 150$.

---

## 2. Quantitative Acceptance Checklist

- [ ] `GET /api/v1/health` returns HTTP 200 `{ "status": "ok" }`.
- [ ] Backend Jest test suite passes with 100% coverage on core submission flow.
- [ ] Duplicate submission for an already approved quest returns HTTP 409 `DUPLICATE_SUBMISSION`.
- [ ] Non-admin user attempting `PATCH /api/v1/admin/submissions/:id` receives HTTP 403 `FORBIDDEN`.
- [ ] React admin dashboard compiles without TypeScript errors.
- [ ] Flutter app compiles for Android API 26+ without build warnings.
- [ ] `.brain/` Obsidian vault notes updated to match implemented prototype architecture.
