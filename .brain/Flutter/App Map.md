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
│   └── router.dart     # GoRouter configuration
├── core/
│   └── network/
│       └── api_client.dart
└── features/
    ├── auth/          # Demo Login with role cards (Traveler/Admin) & token balance
    ├── quests/        # Pangasinan quest list, category filters, featured event hero & detail screens
    ├── submissions/   # Proof creation, idempotency UUID, status language history
    └── ar_experience/ # Camera view, marker tracking, 3D gold coin overlay, GPS capture
```

## Screen Flow
1. **Demo Login Screen:** Role cards (Traveler `user-1` vs Admin `admin-1`), logo header, product summary, prototype disclosure footer.
2. **Quest List Screen:** Top bar with `1,250 PTS` token badge, greeting, search input, category filters (`All`, `Eco`, `Cultural`, `Food & Trade`), featured discovery banner, adventure list.
3. **Quest Detail Screen:** Banner image, reward badge, 3-step instructions card, GPS radius validation check, AR trigger button.
4. **AR Experience Screen:** Reticle target, 3D rotating gold coin, simulated marker scan, live GPS accuracy HUD.
5. **Submission History Screen:** Clear status language (`Awaiting administrator review`, `Quest approved — +50 points awarded`, `Proof rejected`).
6. **Profile Screen:** Traveler avatar, off-chain demo points balance card, future NFT achievement placeholders (`Eco Pioneer`, `Heritage Keeper`, `Food Explorer`).
