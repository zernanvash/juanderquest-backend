# JuanderQuest Mobile UI Design Brief

**Written:** 2026-07-30 11:11
**Audience:** Stitch / OpenDesign (design tool)
**Status:** Ready for brand execution

---

## Product Overview

| Field | Value |
|---|---|
| **Product name** | JuanderQuest |
| **Platform** | Flutter mobile application |
| **Primary target** | Android phones |
| **Location** | Pangasinan, Philippines |
| **Product type** | Gamified tourism and destination-discovery application |

JuanderQuest encourages tourists and residents to visit destinations around Pangasinan by completing location-based quests. Users browse destinations, visit a quest location, interact with an AR or marker-scanning experience, submit GPS-backed proof, and receive points after administrator approval.

The current work is a **prototype showcase**, not the full blockchain implementation.

---

## Design Objective

Create a cohesive, polished mobile interface based primarily on the uploaded brand images and mockups.

The interface should feel:

- Filipino and Pangasinan-inspired
- Adventurous and tourism-oriented
- Warm, welcoming, and culturally grounded
- Modern and gamified
- Credible enough for an academic system presentation
- Easy to understand for first-time travelers
- Distinct from generic cryptocurrency dashboards

Avoid making the application look like:

- A crypto trading platform
- A generic neon gaming dashboard
- A corporate administrative application
- A science-fiction HUD on every screen
- A generic travel-booking application

The uploaded logo and mockups are the primary visual source of truth. Existing implementation colors may be redesigned when they conflict with the supplied brand.

---

## Current Prototype Scope

### Include

- Seeded demonstration login
- Traveler profile
- Pangasinan quest discovery
- Quest categories
- Quest details
- Location and camera permission flows
- Simulated or future-facing AR marker interaction
- GPS proof capture
- Submission confirmation
- Submission history
- Pending, approved, and rejected states
- Off-chain demonstration points
- Profile and achievement placeholders
- Online REST API integration

### Exclude

Do not design operational interfaces for:

- Blockchain contracts
- WalletConnect or SIWE
- Cryptocurrency transactions
- JDQ token minting
- NFT ownership
- DAO proposals and voting
- Merchant redemption
- Leaderboards
- Offline synchronization
- Push notifications
- Photo or AI verification
- Full mobile administration

These may appear only in a separately labeled **Future Features** concept section.

---

## User Roles

### Traveler

The main mobile user. Travelers can:

- Log in using a seeded demonstration account
- Browse quests
- Filter quests by category
- View destination and quest information
- Grant camera and location permissions
- Interact with an AR marker experience
- Capture GPS proof
- Submit proof for review
- Monitor submission status
- View earned demonstration points
- View placeholder achievements
- Log out

### Administrator

Administrators review submissions through a separate web dashboard.

Do not create an administrator section inside the mobile application. If the seeded administrator is selected in the mobile login, explain that administration is available through the separate dashboard.

---

## Primary User Journey

```
Demo Login
→ Quest Discovery
→ Quest Detail
→ Permission Rationale
→ AR / Marker Experience
→ GPS Validation
→ Proof Confirmation
→ Submit for Review
→ Submission History
→ Admin Approval
→ Points Updated
```

The interaction must clearly communicate that points are not awarded immediately. A submitted proof first receives a `Pending Review` status.

---

## Navigation

Use a persistent three-tab mobile navigation system:

1. **Quests**
2. **Submissions**
3. **Profile**

Recommended structure:

```
Login
└── Main Mobile Shell
    ├── Quests
    │   ├── Quest List
    │   ├── Quest Detail
    │   ├── Permission Rationale
    │   ├── AR Experience
    │   └── Proof Confirmation
    ├── Submissions
    │   ├── History
    │   └── Submission Detail
    └── Profile
```

Preserve each tab's state and scroll position when switching tabs.

---

## Screen Requirements

### 1. Demo Login

**Purpose:** Allow evaluators to enter the prototype without account registration.

**Content:**

- JuanderQuest logo
- Pangasinan tourism background or illustration
- Short product description
- Profile selector:
  - Traveler demo account
  - Administrator demo account
- Primary button: `Start Demo Experience`
- Small prototype disclosure

**States:**

- Default
- Profile selector open
- Authenticating
- Network error
- Server unavailable

**Recommended disclosure:**

> Prototype demonstration account. No wallet or blockchain transaction is required.

If administrator is selected:

> Administrative review is available through the separate JuanderQuest web dashboard.

---

### 2. Quest Discovery

**Header:**

- Greeting or location-oriented heading
- Current demonstration points
- Optional avatar
- Short discovery message

**Search and Filters:**

- Search by quest title or location
- Category filters:
  - All
  - Eco
  - Cultural
  - Food & Trade

**Quest Card:**

Each card should include:

- Destination thumbnail
- Quest title
- Location
- Friendly category label
- Reward points
- Completion state
- Optional distance or availability

Possible states:

- Available
- Pending Review
- Completed
- Rejected, Retry Available
- Unavailable

Do not display raw enum values such as `FOOD_TRADE`.

**Quest Loading States:**

- Skeleton loading
- Results
- Empty category
- Search with no results
- Network failure
- Retry
- Pull-to-refresh

Do not silently replace unavailable API data with fake quests without notifying the user.

---

### 3. Quest Detail

**Content:**

- Destination banner image
- Quest title
- Location
- Category
- Reward points
- Description
- Acceptable GPS radius
- Quest status
- Three-step instructions

Suggested instructions:

1. Visit the destination.
2. Locate and scan the printed quest marker.
3. Complete the AR interaction and submit your GPS proof.

**Actions:**

- Primary: `Start Quest`
- Secondary: `View Location`
- Completed state: `Quest Completed`
- Pending state: `Proof Awaiting Review`
- Retry state: `Try Quest Again`

Avoid exposing raw marker identifiers to ordinary users.

---

### 4. Permission Rationale

Display an explanation before triggering operating-system permission prompts.

**Camera:**

> JuanderQuest uses your camera to recognize the printed destination marker and display the AR experience.

**Location:**

> Your current location and accuracy are captured only when submitting quest proof. JuanderQuest does not continuously track your location.

**States:**

- Continue
- Not Now
- Permission denied
- Permission permanently denied
- Open Settings
- Location services disabled
- Camera unavailable
- AR unsupported

The permission flow must remain understandable without technical terminology.

---

### 5. AR Marker Experience

**Product Intent:** The future experience recognizes a printed marker and displays an animated JuanderQuest object over the camera view. The current prototype may simulate this interaction. If simulated, label it honestly.

**Content:**

- Real or conceptual camera viewport
- Marker alignment reticle
- Quest name
- GPS readiness indicator
- Distance/readiness indicator
- Marker scanning status
- Close action
- Help action
- AR object after successful recognition
- Collect or continue action

**Marker States:**

- Preparing camera
- Searching for marker
- Marker detected
- Wrong marker
- Marker lost
- Scan timed out
- Camera unavailable
- Simulation mode

**GPS States:**

- Acquiring location
- Location ready
- Low accuracy
- Outside quest radius
- Inside quest radius
- Permission denied
- Services disabled
- Retry

Prefer showing:

> Within quest area
> Accuracy: ±8 m

Avoid showing exact coordinates unless required in a proof-details view.

**Simulation Disclosure:**

If real marker recognition is not active:

> AR Prototype Mode
> Marker recognition is simulated for this demonstration.

Use a deliberate `Simulate Marker Scan` action rather than pretending a real camera scan occurred automatically.

---

### 6. Proof Confirmation

Add a confirmation screen or bottom sheet before submission.

**Display:**

- Quest name
- Marker status
- Location readiness
- GPS accuracy
- Distance from destination
- Captured timestamp
- Reward available after approval
- Privacy summary

**Actions:**

- `Submit Proof`
- `Retake`
- `Cancel`

**Important Message:**

> Your proof will be reviewed by a JuanderQuest administrator. Points are awarded only after approval.

---

### 7. Submission Result

**Success:**

- Clear confirmation illustration
- `Proof Submitted`
- Pending-review badge
- Expected next step
- `View Submission`
- `Return to Quests`

**Errors:**

Design specific states for:

- Outside allowed quest radius
- Wrong marker
- Low GPS accuracy
- Duplicate completed quest
- Existing pending submission
- Network failure
- Server validation error

Do not report a failed request as successful.

---

### 8. Submission History

**Content:**

Each card should show:

- Quest image or icon
- Quest title
- Category
- Submitted date and time
- Status
- Reward points
- Rejection reason where applicable

**Status Language:**

- **Pending:** `Awaiting administrator review`
- **Approved:** `Quest approved — +50 points awarded`
- **Rejected:** `Proof rejected` (display the administrator's reason and retry availability)

**States:**

- Loading
- Empty
- Error
- Pending records
- Approved records
- Rejected records
- Pull-to-refresh
- Status filters

**Empty-State Action:**

> You have not submitted any quests yet.

Button: `Explore Quests`

---

### 9. Submission Detail

**Content:**

- Destination and quest
- Status timeline
- Submitted date and time
- Marker result
- GPS readiness or distance
- Accuracy
- Administrator decision
- Review timestamp
- Rejection reason
- Points awarded

Do not expose unnecessary exact location history.

---

### 10. Profile

**Content:**

- Avatar
- Display name
- Email
- Traveler role
- Off-chain prototype points
- Completed quest count
- Pending submission count
- Achievement preview
- Logout

**Points Terminology:**

Use one of:

- `Demo Points`
- `Quest Points`
- `Prototype Points`

Avoid calling the value a wallet or token balance because blockchain is not implemented.

**Achievement Section:**

Badge placeholders may appear, but label them as future functionality:

- Eco Pioneer
- Heritage Keeper
- Pangasinan Food Explorer

Possible badge states:

- Locked
- In progress
- Earned
- Future feature

---

## Seeded Prototype Data

Use these five quests in mockups.

### Hundred Islands Eco Trek

| Field | Value |
|---|---|
| Category | Eco |
| Location | Alaminos City, Pangasinan |
| Reward | 50 points |
| Radius | 150 meters |
| Theme | islands, marine environment, viewpoint |

### Bolinao Lighthouse Cultural Heritage

| Field | Value |
|---|---|
| Category | Cultural |
| Location | Bolinao, Pangasinan |
| Reward | 75 points |
| Radius | 200 meters |
| Theme | historic lighthouse and coastal heritage |

### Manaoag Shrine Pilgrimage

| Field | Value |
|---|---|
| Category | Cultural |
| Location | Manaoag, Pangasinan |
| Reward | 60 points |
| Radius | 100 meters |
| Theme | religious heritage and pilgrimage |

### Lingayen Gulf Beach & Capitol Park

| Field | Value |
|---|---|
| Category | Cultural |
| Location | Lingayen, Pangasinan |
| Reward | 40 points |
| Radius | 250 meters |
| Theme | provincial history, capitol architecture, beach |

### Dagupan Bangus Taste & Trade Trail

| Field | Value |
|---|---|
| Category | Food & Trade |
| Location | Dagupan City, Pangasinan |
| Reward | 50 points |
| Radius | 150 meters |
| Theme | bangus, local food culture, trade and marketplace |

---

## Visual Direction

### Existing Logo Direction

The current logo uses:

- Warm gold lettering
- Green accents
- Brown wood texture
- Filipino/native woven elements
- Adventure and heritage cues

Use the uploaded logo as the primary source of truth.

### Existing Prototype Palette

The current implementation uses:

| Role | Color |
|---|---|
| Dark background | `#0A0F1D` |
| Surface | `#131B2E` |
| Elevated surface | `#1C273E` |
| Cyan accent | `#00F2FE` |
| Blue accent | `#4FACFE` |
| Reward gold | `#FFB703` |
| Success | `#10B981` |
| Error | `#F43F5E` |
| Secondary text | `#94A3B8` |

This palette is not mandatory. It currently conflicts somewhat with the warmer logo.

### Recommended Direction

Create a **modern Philippine adventure identity** by combining:

- Warm gold or sun-yellow for rewards
- Deep forest or tropical green for eco-tourism
- Rich brown or wood tones from the logo
- Sea blue for Pangasinan's coastal destinations
- Neutral cream or deep ink backgrounds
- Restrained cyan only for technical GPS/AR feedback

Do not use neon cyan as the dominant personality unless the uploaded mockups clearly require it.

### Typography

Current implementation uses **Plus Jakarta Sans**.

Recommended pairing:

- Display/headings: expressive but readable travel or heritage-oriented face
- Body/interface: Plus Jakarta Sans or a similar clean sans-serif
- Avoid using the decorative logo lettering as body text

### Shape & Component Language

- Rounded cards
- Clear destination photography
- Layered tourism badges
- Friendly iconography
- Strong primary actions
- Compact status chips
- Accessible contrast
- Minimum 44–48 px touch targets
- Avoid excessive glows, glassmorphism, and tiny technical labels

---

## Design System Deliverables

Create reusable components for:

- App header
- Bottom navigation
- Quest card
- Featured quest card
- Category chip
- Points badge
- Status badge
- Destination image treatment
- Primary, secondary, and destructive buttons
- Search field
- Information row
- Permission panel
- GPS readiness panel
- Marker reticle
- Proof summary card
- Submission card
- Achievement badge
- Empty state
- Error state
- Loading skeleton
- Snackbar or toast
- Confirmation bottom sheet

Define:

- Color roles
- Typography scale
- Spacing scale
- Border radii
- Shadows
- Icon style
- Image aspect ratios
- Button states
- Form states
- Status semantics
- Accessibility contrast

---

## Required Frames

Produce mobile frames for:

1. Login
2. Login loading
3. Login error
4. Quest discovery
5. Quest search
6. Quest category empty
7. Quest loading
8. Quest network error
9. Quest detail
10. Quest pending state
11. Quest completed state
12. Permission rationale
13. Permission denied
14. Open settings
15. AR preparing
16. AR scanning
17. AR marker detected
18. AR GPS error
19. AR outside radius
20. AR simulation disclosure
21. Proof confirmation
22. Proof submitting
23. Submission successful
24. Submission failed
25. History loading
26. History empty
27. History pending
28. History approved
29. History rejected
30. Submission detail
31. Profile
32. Logout confirmation

Include a compact clickable prototype for:

```
Login → Quest List → Quest Detail → Permission Rationale
→ AR Scan → Proof Confirmation → Submission Success
→ History → Profile
```

---

## Implementation Constraints

The frontend will be implemented in Flutter.

Design for:

- Android phones first
- Approximately 360–430 px logical width
- Portrait orientation
- Responsive text and cards
- Safe areas
- Large text scaling
- Touch accessibility
- Dark and light image conditions
- Network latency and loading
- Permission interruptions
- Long Pangasinan place names
- English initially

Use conventional mobile behavior that maps cleanly to Flutter widgets. Avoid interactions that require custom rendering unless they are essential to the AR experience.

---

## Current Technical Context

| Concern | Detail |
|---|---|
| State management | Flutter Riverpod |
| Navigation | `go_router` |
| API protocol | REST over HTTPS |
| API base URL | `https://jdq.zernanvash.dev/api/v1` |
| Admin dashboard | `https://jdq.zernanvash.dev` (React, separate) |
| Auth | Seeded demonstration JWT |
| Connectivity | Online-only prototype |
| Backend persistence | In-memory (state resets on restart) |
| Admin updates | Not pushed to mobile; manual refresh required |

---

## Asset Requests

Use the uploaded images and mockups to establish the final visual direction.

Also define or propose:

- Transparent logo
- Symbol-only app icon
- Wordmark-only logo
- Dark-background logo
- Monochrome logo
- Android/iOS app icon
- Splash screen
- Pangasinan background illustration
- Five destination thumbnails
- Five destination banners
- Five printable marker designs
- AR reward coin or badge
- Category icon set
- Achievement badge set
- Empty/error/loading illustrations

Do not fabricate official government seals or imply government endorsement unless those assets are explicitly provided and authorized.

---

## Design Tool Instruction (paste with assets)

> Treat the uploaded logo, brand images, and mockups as the visual source of truth. Preserve recognizable brand characteristics while improving consistency, usability, accessibility, and mobile responsiveness. Do not replace the supplied identity with a generic neon gaming aesthetic. Show proposed changes as a coherent design system and complete traveler journey.

The main design decision still needed is whether you want a **warm culture-and-adventure interface** based on the logo or to preserve the current **dark cyan technology aesthetic**. The warm tourism direction with restrained technical accents is recommended.
