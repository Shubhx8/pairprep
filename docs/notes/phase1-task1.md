# Phase 1 — Task 1: Room Lifecycle, Unguessable Slugs, Roles & Guest Identity

## Overview & PRD Compliance

Implements the room model, lifecycle management, cryptographically unguessable slugs, role assignment, participant limits, and guest identity as specified in PRD sections 6.1 (`AUTH-3`, `AUTH-4`), 6.2 (`ROOM-1` to `ROOM-5`), 6.6 (`CONC-3`), and 13.1.

---

## Technical Specifications & Decisions

### 1. 128-bit Unguessable Slug Generation (`ROOM-1`)

- **Requirement**: Slugs must carry at least 128 bits of randomness to prevent brute-force room enumeration or link crawling (`SEC-1`).
- **Implementation**: `crypto.randomBytes(16).toString("hex")` produces a URL-safe 32-character hexadecimal string with exactly 128 bits of entropy ($2^{128} \approx 3.4 \times 10^{38}$ combinations).

### 2. Participant Cap & Role Model (`ROOM-3`, `ROOM-4`)

- **Participant Limit**: Max 6 participants per room. When a 7th user attempts to join, the server rejects the request with HTTP 409 Conflict (`ROOM_FULL`).
- **Roles**:
  - `owner`: Room creator. Has permission to change member roles, remove members, and end the room.
  - `interviewer`: Can run, view private tests, score, and control session timer.
  - `candidate`: Can edit code, test, and submit.
  - `editor`: Default collaborative peer in practice rooms.
  - `viewer`: Read-only observer. Cannot mutate code or execute runs.
- **Color-Blind-Safe Palette**: Cycles through 6 distinct accessible colors (`#3B82F6`, `#10B981`, `#F59E0B`, `#8B5CF6`, `#EC4899`, `#14B8A6`) and pairs with initials.

### 3. Guest Session Cookie Middleware (`AUTH-3`, `AUTH-4`)

- **Mechanism**: Extracts `pairprep_session` cookie. If not present, generates `guest_<uuid>` and sets an `HttpOnly`, `SameSite=Lax`, `Secure` cookie with a 7-day TTL.
- **Purpose**: Enables frictionless 1-click room creation and link-based joining with zero signup barriers while preserving stable user identity and authorship across browser refreshes.

### 4. Idempotency Support (`CONC-3`)

- Supports optional `x-idempotency-key` header on room creation. Cached for 24 hours to prevent duplicate room creation on network retries.

---

## Verification Evidence

### 1. Vitest Test Suite (34/34 Passing)

- `packages/shared/src/__tests__/schemas.test.ts`: 14 tests verifying Zod schemas, 128-bit slug bounds, 6-member limit.
- `apps/server/src/__tests__/rooms.test.ts`: 10 integration tests verifying room creation, slug randomness, idempotency, guest join, 6-participant overflow rejection (409), role transitions, and owner permissions.
- Total test suites: 5 passed (34 tests).

### 2. Live Production Verification (Azure VM)

- **Host**: `https://pairprep-live.eastasia.cloudapp.azure.com`
- **Room Creation**:
  ```json
  {
    "id": "04f318e8-4e54-43c0-b10d-16f24b3dbae8",
    "slug": "db6e833a322ee86b154b7600dcbe7e2b",
    "title": "Live Production Practice Room",
    "status": "open",
    "members": [
      {
        "displayName": "Anonymous Host",
        "role": "owner",
        "color": "#3B82F6",
        "isGuest": true
      }
    ]
  }
  ```
- **Guest Join**:
  ```json
  {
    "displayName": "Candidate Rohan",
    "role": "editor",
    "color": "#10B981",
    "isGuest": true
  }
  ```
- **Public API Resolution**: `GET /api/v1/rooms/db6e833a322ee86b154b7600dcbe7e2b` returns HTTP 200 with both participants.
