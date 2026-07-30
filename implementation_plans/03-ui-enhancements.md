# UI Enhancements & Design System Plan — JuanderQuest

**Created:** 2026-07-30 15:00  
**Status:** Completed & Executed  

---

## 1. Overview & Objectives

This plan details the comprehensive visual redesign and architectural navigation enhancements across the **JuanderQuest** platform based on Stitch design project `4769727332745673840` and the official interactive [Figma Prototype](https://www.figma.com/proto/iMNm3VkAJBUous8NLoZHSj/JuanDerQuest?node-id=70-251).

### Key Objectives
1. **Design System Integration:** Adopt unified typography (Epilogue + Plus Jakarta Sans) and brand color tokens across mobile and web interfaces.
2. **5-Tab Navigation System:** Restructure mobile app navigation into a 5-tab shell (**Home**, **Map**, **Vote**, **Shop**, **Profile**), refactoring Submissions History as a standalone action feature.
3. **MapLibre Vector Map:** Integrate `maplibre_gl` with the OpenMapTiles provider to display interactive Pangasinan quest pins and detail drawers.
4. **Global Error Dialog System:** Replace generic snackbars with a structured modal dialog (`GlobalErrorDialog`) for location, permission, and submission errors.
5. **Admin Web Dashboard Redesign:** Update the React admin portal with Stitch design tokens, region active status pills, and distance offset validation tags.

---

## 2. Design System Tokens & Brand Colors

| Token Name | Hex Code | Role & Usage |
|---|---|---|
| **Reward Gold** | `#FFB703` | Primary CTA buttons, points badges, active event highlights |
| **On-Primary Container** | `#6B4B00` | High-contrast dark text on gold elements |
| **Tropical Green** | `#3F6653` | Category filter chips, bottom navigation active indicators |
| **Green Container** | `#BEEAD1` | Background for eco badges and user identity chips |
| **Success Emerald** | `#2D6A4F` | Completed quest badges, approved review callouts |
| **Wood Brown** | `#582F0E` | Heritage typography headings, quest titles, card headers |
| **Deep Ink** | `#0D1B2A` | Contrast headers, backdrop overlays |
| **Warm Background** | `#FAF9F5` | Non-glare scaffold background for mobile outdoor readability |
| **Surface Container** | `#EFEEEA` | Card sub-panels, input fields, step indicator badges |
| **Border Outline** | `#D5C4AC` | Card borders, dividers, chip outlines |
| **Error Red** | `#BC4749` | Rejection alerts, location radius errors, permission dialogs |

---

## 3. Flutter Mobile App Redesign (`juanderquest_app/`)

### 3.1. 5-Tab Navigation System
- **Home Tab (`/quests`):** Quest discovery feed with search input, category filter chips (`All`, `Eco`, `Cultural`, `Food & Trade`), featured discovery hero banner, nearby adventure cards, and a top bar **Submissions History** action button.
- **Map Tab (`/map`):** Vector map powered by MapLibre GL & OpenMapTiles (`https://demotiles.maplibre.org/style.json`), centered over Pangasinan (`LatLng(16.0350, 120.3330)`), featuring quest pins and selection bottom sheets.
- **Vote Tab (`/vote`):** Community DAO governance portal allowing travelers to vote on proposed future Pangasinan quest destinations.
- **Shop Tab (`/shop`):** Merchant voucher store where travelers spend earned demo points to redeem local food, tour, and craft discounts.
- **Profile Tab (`/profile`):** Traveler profile displaying Demo Points balance, Submissions History action tile, and future NFT achievement placeholders (*Eco Pioneer*, *Heritage Keeper*, *Food Explorer*).

### 3.2. Submissions History Refactoring
- **Submissions** removed from main bottom navigation bar.
- Re-architected as a standalone action feature accessible via:
  - Top App Bar history icon button on **Home** (`/quests`).
  - Submissions & Proof History tile on **Profile** (`/profile`).
  - Navigation button inside submission confirmation and error pop-up dialogs.

### 3.3. Global Error Dialog System (`lib/core/widgets/error_dialog.dart`)
- **Location Error (`OUT_OF_RANGE` — HTTP 422):** Displays `Icons.location_off_rounded`, title *"Outside Quest Radius"*, distance offset info, and *"Got It"* action.
- **Duplicate Completion (`ALREADY_COMPLETED` — HTTP 409):** Displays `Icons.check_circle_outline`, title *"Quest Already Completed"*, and *"View History"* action.
- **Pending Review (`SUBMISSION_PENDING` — HTTP 409):** Displays `Icons.hourglass_top_rounded`, title *"Submission Awaiting Review"*, and *"View History"* action.
- **GPS Signal Missing:** Displays `Icons.gps_off_rounded`, title *"GPS Signal Required"*, and *"Retry GPS"* action.
- **Missing Permissions:** Displays `Icons.security_rounded`, title *"Permissions Required"*, and *"Open Device Settings"* action.

---

## 4. React Admin Web Dashboard Redesign (`dashboard/`)

### 4.1. Visual & Layout Enhancements
- **Typography:** Configured Google Fonts **Epilogue** & **Plus Jakarta Sans** in `index.html`.
- **Branding Assets:** Added `/logo.png` and `/jdq-token.png` logo assets to `public/`.
- **Theme Tokens (`src/index.css`):** Applied `#FAF9F5` warm background, `#582F0E` wood brown headers, `#FFB703` gold action buttons, and `#3F6653` green indicators.
- **Control Room Header:** Added `PANGASINAN REGION ACTIVE` status pill and logo header.
- **Queue Navigation:** Styled tabs with Stitch pill choices (**Pending Queue**, **All Submissions**, **Pangasinan Quests**).
- **Submissions Cards:** Added distance offset validation tags (`Valid Radius` vs `Exceeds Threshold`) and styled status chips (`Awaiting Review`, `APPROVED`, `REJECTED`).

---

## 5. Verification & Testing Checklist

### 5.1. Static Analysis & Unit Tests
- `cd juanderquest_app && flutter analyze` $\rightarrow$ **No issues found!**
- `cd juanderquest_app && flutter test` $\rightarrow$ **All tests passed!**
- `cd dashboard && npm run build` $\rightarrow$ **Built dist in 5.66s (0 errors)!**

### 5.2. Git Commits & Remote Sync
- Mobile App: Pushed `5d11d09` to `https://github.com/zernanvash/juanderquest-mobile.git`.
- REST API: Pushed `master` to `https://github.com/zernanvash/juanderquest-backend.git`.
- Admin Web: Pushed `4d8a888` to `https://github.com/zernanvash/juanderquest-web.git`.

---

## 6. Documented Assets & References

- **Figma Interactive Prototype:** `https://www.figma.com/proto/iMNm3VkAJBUous8NLoZHSj/JuanDerQuest?node-id=70-251`
- **Stitch Assets Directory:** `docs/stitch_assets/`
- **Figma Design System Spec:** `docs/03-ui-ux/figma-design-system.md`
- **Agent Knowledge Vault:** `.brain/Architecture/Design System.md` & `.brain/Flutter/App Map.md`
