# Flutter Mobile App Map

**Project Root:** `juanderquest_app/`  
**Target:** Android API 26+ (Showcase device)  
**State Management:** Riverpod  
**Routing:** GoRouter  
**Networking:** Dio  
**Design System:** Stitch Traveler Experience (Epilogue + Plus Jakarta Sans, Gold `#FFB703`, Tropical Green `#3F6653`, Wood Brown `#582F0E`, Warm Surface `#FAF9F5`)

## Feature Structure
```
lib/
├── app/
│   ├── app.dart        # Theme tokens & typography pairing
│   └── router.dart     # GoRouter (5-tab shell + standalone routes)
├── core/
│   ├── network/
│   │   └── api_client.dart
│   └── widgets/
│       └── error_dialog.dart # Global popup dialog (OUT_OF_RANGE, permissions)
└── features/
    ├── auth/          # Demo Login with role cards (Traveler/Admin) & token balance
    ├── quests/        # Home Tab — Pangasinan quest list, category filters & detail
    ├── map/           # Map Tab — Interactive destination pins & bottom sheet
    ├── vote/          # Vote Tab — DAO Governance destination proposals & voting
    ├── shop/          # Shop Tab — Partner merchant voucher store & redemption
    ├── profile/       # Profile Tab — Traveler avatar, points balance & history action
    ├── submissions/   # Submissions History Function — Standalone review status view
    └── ar_experience/ # AR Camera view, reticle target, 3D coin overlay, GPS HUD
```

## 5-Tab Navigation System
1. **Home Tab (`/quests`):** Existing Quest Discovery Feed with category filters & featured event card. Top bar includes **Submissions History** icon action button.
2. **Map Tab (`/map`):** Interactive Pangasinan tourist map with destination pins and quick-view bottom sheets.
3. **Vote Tab (`/vote`):** Community DAO governance for voting on future Pangasinan quest proposals.
4. **Shop Tab (`/shop`):** Merchant voucher redemption store to spend demo points on food, tour, and craft discounts.
5. **Profile Tab (`/profile`):** Traveler profile with Demo Points balance, Submissions History tile, and NFT achievement placeholders.

## Standalone Action Routes
- **`/history`:** Submissions & Proof History standalone view.
- **`/ar`:** Live AR Camera experience with real GPS capture.
- **`/quests/:id`:** Destination details & 3-step objective guide.
