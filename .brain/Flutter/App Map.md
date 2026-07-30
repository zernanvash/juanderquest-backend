# Flutter Mobile App Map

**Project Root:** `juanderquest_app/`  
**Target:** Android API 26+ (Showcase device)  
**State Management:** Riverpod  
**Routing:** GoRouter  
**Networking:** Dio  

## Feature Structure
```
lib/
├── app/
│   ├── app.dart
│   └── router.dart
├── core/
│   └── network/
│       └── api_client.dart
└── features/
    ├── auth/          # Seeded demo user login & profile points state
    ├── quests/        # Pangasinan quest list & detail screens
    ├── submissions/   # Proof creation, idempotency UUID, submission history
    └── ar_experience/ # Camera view, marker tracking, 3D overlay, GPS capture
```

## Screen Flow
1. **Demo Login Screen:** Select seeded user (`user-1` or `admin-1`).
2. **Quest List Screen:** Pangasinan quest cards filterable by category (`eco`, `cultural`, `food_trade`).
3. **Quest Detail Screen:** Description, target coordinates, AR launch trigger.
4. **AR Experience Screen:** Marker tracking + 3D JuanderQuest coin overlay + live GPS HUD.
5. **Submission Confirmation / History Screen:** Submission status badges (`PENDING`, `APPROVED`, `REJECTED`).
