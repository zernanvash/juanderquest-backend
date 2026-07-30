# UI/UX Specification & Flow Map — JuanderQuest Prototype

**Target Platforms:** Android 8.0+ (API 26+) & Web Admin Dashboard  

---

## 1. Flutter Mobile App Screen Inventory

```
+-----------------------------------------------------------------------------------+
|                                 App Navigation Map                                |
+-----------------------------------------------------------------------------------+

                          ┌───────────────────────┐
                          │   Demo Login Screen   │
                          └───────────┬───────────┘
                                      │ (Select Seed User)
                                      ▼
                        ┌───────────────────────────┐
                        │   Main Shell (Tab Bar)    │
                        └─────┬─────────────────┬───┘
                              │                 │
             ┌────────────────┴───┐         ┌───┴────────────────┐
             │ Quest List Screen  │         │  Profile Screen    │
             └────────┬───────────┘         └────────────────────┘
                      │ (Tap Quest Card)
                      ▼
             ┌────────────────────┐
             │ Quest Detail Screen│
             └────────┬───────────┘
                      │ (Tap "Launch AR Experience")
                      ▼
             ┌──────────────────────────┐
             │  AR Experience Camera    │
             └────────┬─────────────────┘
                      │ (Marker Tracked & GPS Captured)
                      ▼
             ┌──────────────────────────┐
             │ Submission Confirm Screen│
             └────────┬─────────────────┘
                      │ (Submit Proof)
                      ▼
             ┌──────────────────────────┐
             │ Submission History Screen│
             └──────────────────────────┘
```

---

## 2. Screen Specifications & States

### 2.1 Demo Login Screen
- **Purpose:** Quick authentication without wallet signing for prototype evaluators.
- **UI Elements:**
  - App Logo & Pangasinan background graphic.
  - Dropdown or cards to select pre-seeded account (`Juan Dela Cruz (User)` or `Admin`).
  - "Continue to App" button.
- **States:** Loading (authenticating), Error (server unreachable).

### 2.2 Quest List Screen
- **Purpose:** Browse available Pangasinan quests.
- **UI Elements:**
  - Category Filter Chips (`All`, `Eco`, `Cultural`, `Food & Trade`).
  - Search bar.
  - Quest Cards showing thumbnail, title, category badge, reward points, location name.
- **States:** 
  - **Loading:** Shimmer skeletons.
  - **Error:** Error icon + "Failed to load quests" + Retrying button.
  - **Empty:** "No quests found in this category."

### 2.3 Quest Detail Screen
- **Purpose:** Review destination information before launching AR.
- **UI Elements:**
  - Banner image, title, category tag, reward points badge.
  - Target GPS coordinates & location name.
  - Step-by-step instructions ("1. Go to location", "2. Scan printed marker", "3. Collect AR badge").
  - Primary CTA: "Launch AR Experience".
- **Permission Pre-Check:** On tapping CTA, requests Camera & Fine Location permissions if not already granted.

### 2.4 AR Experience Camera Screen
- **Purpose:** Interactive marker detection and GPS payload capture.
- **UI Elements:**
  - Real-time camera viewfinder.
  - Reticle / target box overlay for marker alignment.
  - AR Overlay: Upon marker tracking, renders a 3D animated coin/badge object above the physical marker.
  - Real-time HUD showing current device GPS coordinates and accuracy (e.g., `± 4.5m`).
  - Secondary CTA: "Collect Proof & Submit".

### 2.5 Submission Confirmation & History Screens
- **Purpose:** Confirm payload details before submission and view past status.
- **Status Badges:**
  - `PENDING` (Orange chip) — "Under admin verification"
  - `APPROVED` (Green chip) — "+50 points awarded!"
  - `REJECTED` (Red chip) — Includes rejection reason text callout.

---

## 3. AR Marker Tracking & Overlay Specifications

- **Target Physical Marker Format:** Printed high-contrast 2D image target (e.g., Pangasinan tourism eco-seal).
- **Recognition Behavior:** Camera tracks target image position ($x, y, z$) in 3D camera space.
- **3D Overlay Object:** A floating 3D rotating gold badge / JuanderQuest coin rendered directly over the physical marker center.
- **Fallback Mechanism:** If AR marker tracking fails after 15 seconds, a "Manual QR Code / Geo-check Fallback" prompt becomes available.

---

## 4. Web Admin Dashboard Screen Inventory (`dashboard/`)

1. **Admin Login:** Seed ID authentication.
2. **Pending Submissions Queue:**
   - Table displaying: User Name, Quest Title, Captured Coordinates vs. Target Coordinates, Distance Offset ($m$), Timestamp, Actions (`Approve`, `Reject`).
3. **Rejection Modal:** Text box for specifying mandatory reason when rejecting.
