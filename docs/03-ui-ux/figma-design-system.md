# JuanderQuest Design System — Figma Prototype Reference

**Figma URL:** `https://www.figma.com/proto/iMNm3VkAJBUous8NLoZHSj/JuanDerQuest?node-id=70-251`  
**Status:** Integrated into Flutter Mobile App & React Admin Dashboard  

---

## 🎨 Color Palette & Roles

| Role | Color Code | Purpose |
|---|---|---|
| **Reward Gold** | `#FFB703` | Primary CTA buttons, points badges, active events, highlight focus |
| **Gold On-Container** | `#6B4B00` | Text/icons rendered on top of Reward Gold elements |
| **Tropical Green** | `#3F6653` | Category chips (Eco/Cultural), tab selection, secondary branding |
| **Green Container** | `#BEEAD1` | Backgrounds for green badges, role card avatars |
| **Success Emerald** | `#2D6A4F` | Completed quest status chips, approved review badges |
| **Wood Brown** | `#582F0E` | Primary headings, quest titles, logo lettering accents |
| **Deep Ink** | `#0D1B2A` | Dark contrast text, modal backdrop overlays |
| **Warm Surface** | `#FAF9F5` | Main application background for outdoor readability |
| **Surface Container** | `#EFEEEA` | Card sub-panels, input fields, step indicator badges |
| **Border Outline** | `#D5C4AC` | Subtle card borders, dividers, chip outlines |
| **Error Red** | `#BC4749` | Rejection alerts, missing permission warnings |

---

## 🔤 Typography Pairings

- **Headings & Headlines:** **Epilogue** (Bold 700 / ExtraBold 800)
  - Usage: App Title, Quest Titles, Section Headers, Dialog Headings.
- **Body & Labels:** **Plus Jakarta Sans** (Regular 400 / SemiBold 600 / Bold 700)
  - Usage: Subtitles, Quest Descriptions, Step Instructions, Status Badges, Buttons.

---

## 🧩 Reusable Component Library

### 1. Header & Points Pill
- **App Bar:** Warm background with brand logo & app title.
- **PTS Token Pill:** Pill-shaped badge containing the JDQ token icon and real-time point balance (e.g. `1,250 PTS`).

### 2. Category Filter Chips
- **Pills:** Rounded chips for filtering quests by tourism category (`All Quests`, `Eco`, `Cultural`, `Food & Trade`).
- **Icons:** Material Symbols (`apps`, `eco`, `museum`, `restaurant`).

### 3. Quest Cards
- **Featured Discovery Hero:** Full aspect-ratio card with destination photography, dark gradient overlay, `ACTIVE EVENT` chip, and reward points badge.
- **Standard Quest Card:** Compact row card featuring destination thumbnail/icon, title in Wood Brown, location pin, category tag, reward points, and status chip (`AVAILABLE`, `IN PROGRESS`, `COMPLETED`, `LOCKED`).

### 4. Step-by-Step Quest Instructions
- **Card Container:** Rounded white card with 3 circular numbered step indicators (`1`, `2`, `3`).
- **Instructions:**
  1. Travel to destination in Pangasinan.
  2. Locate the physical quest marker.
  3. Scan marker & submit GPS proof.

### 5. AR & GPS Verification HUD
- **Camera Viewfinder:** Fullscreen viewport with center reticle box.
- **GPS HUD:** Live accuracy meter showing GPS readiness (e.g., `Accuracy: ± 4.5m`).
- **3D Overlay:** Floating animated 3D JuanderQuest gold coin over physical marker target.

### 6. Status Language & Chips
- **Pending Review:** `Awaiting administrator review` (Warm Gold chip).
- **Approved:** `Quest approved — +50 points awarded` (Success Emerald chip).
- **Rejected:** `Proof rejected` with callout box displaying administrator's reason (Error Red chip).
