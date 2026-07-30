# Prototype API Specification — JuanderQuest

**Base URL:** `/api/v1`  
**Content-Type:** `application/json`  

---

## 1. Overview & Standard Envelopes

### Success Envelope
```json
{
  "success": true,
  "data": { ... }
}
```

### Error Envelope
```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Human-readable description",
    "details": [
      { "field": "idempotency_key", "issue": "Must be a valid UUID" }
    ]
  }
}
```

### Error Codes
| HTTP | Code | Trigger |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Missing or invalid parameters in request |
| 401 | `UNAUTHORIZED` | Missing or expired JWT bearer token |
| 403 | `FORBIDDEN` | Valid JWT but user lacks `admin` role |
| 404 | `NOT_FOUND` | Resource ID does not exist |
| 409 | `DUPLICATE_SUBMISSION` | Quest already approved for user or idempotency collision |
| 500 | `INTERNAL_ERROR` | Server exception |

---

## 2. Authentication Endpoints

### `POST /auth/demo-login`
Authenticate using a preset seed ID. Generates a signed JWT access token.

**Request Body:**
```json
{
  "seed_id": "user-1"
}
```
*Allowed `seed_id` values:* `"user-1"` (Regular traveler), `"admin-1"` (Platform Administrator).

**Response `200 OK`:**
```json
{
  "success": true,
  "data": {
    "token": "eyJhbGciOiJIUzI1Ni...",
    "user": {
      "id": "11111111-1111-1111-1111-111111111111",
      "display_name": "Juan Dela Cruz",
      "email": "juan@juanderquest.ph",
      "avatar_url": "https://raw.githubusercontent.com/JuanderQuest/assets/main/avatars/juan.png",
      "role": "user",
      "demo_points": 150
    }
  }
}
```

---

### `GET /auth/me`
Retrieve currently logged-in user profile & demo points balance.

**Headers:** `Authorization: Bearer <JWT>`

**Response `200 OK`:**
```json
{
  "success": true,
  "data": {
    "id": "11111111-1111-1111-1111-111111111111",
    "display_name": "Juan Dela Cruz",
    "email": "juan@juanderquest.ph",
    "avatar_url": "https://raw.githubusercontent.com/JuanderQuest/assets/main/avatars/juan.png",
    "role": "user",
    "demo_points": 150,
    "created_at": "2026-07-30T00:00:00Z"
  }
}
```

---

## 3. Quests Endpoints

### `GET /quests`
List active Pangasinan quests.

**Headers:** `Authorization: Bearer <JWT>` (Optional)  
**Query Parameters:**  
- `category` (optional): `eco` | `cultural` | `food_trade`

**Response `200 OK`:**
```json
{
  "success": true,
  "data": [
    {
      "id": "q1111111-1111-1111-1111-111111111111",
      "title": "Hundred Islands Eco Trek",
      "description": "Explore Governor's Island and scan the eco-marker at the viewing deck.",
      "category": "eco",
      "location_name": "Alaminos City, Pangasinan",
      "gps_lat": 16.2063,
      "gps_lng": 119.9706,
      "reward_points": 50,
      "marker_code": "MARKER_HUNDRED_ISLANDS_01",
      "marker_image_url": "https://raw.githubusercontent.com/JuanderQuest/assets/main/markers/hundred_islands.png"
    }
  ]
}
```

---

### `GET /quests/:id`
Fetch detailed metadata for a single quest.

**Response `200 OK`:**
```json
{
  "success": true,
  "data": {
    "id": "q1111111-1111-1111-1111-111111111111",
    "title": "Hundred Islands Eco Trek",
    "description": "Explore Governor's Island and scan the eco-marker at the viewing deck.",
    "category": "eco",
    "location_name": "Alaminos City, Pangasinan",
    "gps_lat": 16.2063,
    "gps_lng": 119.9706,
    "radius_meters": 150,
    "reward_points": 50,
    "marker_code": "MARKER_HUNDRED_ISLANDS_01",
    "marker_image_url": "https://raw.githubusercontent.com/JuanderQuest/assets/main/markers/hundred_islands.png"
  }
}
```

---

## 4. Submissions Endpoints

### `POST /submissions`
Submit an AR quest verification proof.

**Headers:** `Authorization: Bearer <JWT>`

**Request Body:**
```json
{
  "idempotency_key": "c39a818e-4a6d-4952-b13c-0e8cb5d54a2b",
  "quest_id": "q1111111-1111-1111-1111-111111111111",
  "scanned_marker_code": "MARKER_HUNDRED_ISLANDS_01",
  "captured_lat": 16.2065,
  "captured_lng": 119.9704,
  "captured_accuracy": 5.2
}
```

**Response `201 Created`:**
```json
{
  "success": true,
  "data": {
    "id": "sub_99999999-9999-9999-9999-999999999999",
    "quest_id": "q1111111-1111-1111-1111-111111111111",
    "user_id": "11111111-1111-1111-1111-111111111111",
    "status": "pending",
    "created_at": "2026-07-30T09:30:00Z"
  }
}
```

---

### `GET /submissions`
Get submission history for the authenticated user.

**Headers:** `Authorization: Bearer <JWT>`

**Response `200 OK`:**
```json
{
  "success": true,
  "data": [
    {
      "id": "sub_99999999-9999-9999-9999-999999999999",
      "quest_title": "Hundred Islands Eco Trek",
      "category": "eco",
      "status": "approved",
      "reward_points": 50,
      "created_at": "2026-07-30T09:30:00Z"
    }
  ]
}
```

---

## 5. Admin Endpoints

### `GET /admin/submissions`
List all submissions filtered by status.

**Headers:** `Authorization: Bearer <JWT>` (Admin role required)  
**Query Parameters:** `status` (optional: `pending` | `approved` | `rejected`)

**Response `200 OK`:**
```json
{
  "success": true,
  "data": [
    {
      "id": "sub_99999999-9999-9999-9999-999999999999",
      "user_name": "Juan Dela Cruz",
      "quest_title": "Hundred Islands Eco Trek",
      "scanned_marker_code": "MARKER_HUNDRED_ISLANDS_01",
      "captured_lat": 16.2065,
      "captured_lng": 119.9704,
      "target_lat": 16.2063,
      "target_lng": 119.9706,
      "distance_meters": 28.5,
      "status": "pending",
      "created_at": "2026-07-30T09:30:00Z"
    }
  ]
}
```

---

### `PATCH /admin/submissions/:id`
Approve or reject a submission.

**Headers:** `Authorization: Bearer <JWT>` (Admin role required)

**Request Body (Approve):**
```json
{
  "action": "approve"
}
```

**Request Body (Reject):**
```json
{
  "action": "reject",
  "rejection_reason": "GPS coordinates out of acceptable range."
}
```

**Response `200 OK`:**
```json
{
  "success": true,
  "data": {
    "id": "sub_99999999-9999-9999-9999-999999999999",
    "status": "approved",
    "reviewed_at": "2026-07-30T09:35:00Z",
    "awarded_points": 50
  }
}
```
