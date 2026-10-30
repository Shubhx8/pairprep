# Task Note: T03 - Database and Models

## What Changed

1. **Mongoose Database Integration (`apps/server/src/db/connection.ts`)**:
   - Integrated `mongoose@8.24.5` (pinned exact, published >14 days ago).
   - Implemented `connectDatabase()` with exponential backoff retry (up to 5 attempts) and `serverSelectionTimeoutMS: 5000`.
   - Wired `disconnectDatabase()` into `setupGracefulShutdown()` to close open connections cleanly upon SIGTERM/SIGINT.
   - Exposed `getDatabaseStatus()` returning `"ok"` or `"down"`.

2. **Stateless Healthcheck Cookie Fix (`apps/server/src/index.ts`)**:
   - Moved `/healthz` above `sessionMiddleware`. Health checks, uptime monitors, and load balancers now execute completely statelessly without triggering `res.cookie('pairprep_session', ...)` or polluting the database with guest records.
   - `/healthz` reports `"db": "ok"` or `"db": "down"` without exposing connection strings or credentials.

3. **10 Phase 1 Mongoose Models (`apps/server/src/models/*`)**:
   - `users`: Unique compound index on `{ provider: 1, providerId: 1 }`.
   - `guests`: 7-day TTL index on `{ expiresAt: 1 }` (`expireAfterSeconds: 0`).
   - `rooms`: Unique index on `slug`, compound index on `{ ownerId: 1, createdAt: -1 }`.
   - `room_members`: Unique compound index on `{ roomId: 1, memberId: 1 }`. **`color` field intentionally excluded**.
   - `doc_updates`: Unique compound index on `{ roomId: 1, seq: 1 }`.
   - `doc_snapshots`: Compound index on `{ roomId: 1, seq: -1 }`.
   - `messages`: Capped at 1,000 characters; compound index on `{ roomId: 1, ts: 1 }`.
   - `client_map`: Compound index on `{ roomId: 1, clientId: 1 }`.
   - `events`: Compound index on `{ roomId: 1, ts: 1 }`.
   - `idempotency_keys`: Unique compound index on `{ key: 1, actorId: 1, route: 1 }`, 24-hour TTL index on `{ createdAt: 1 }` (`expireAfterSeconds: 86400`).

4. **Strict Repository Query Layer (`apps/server/src/repos/*`)**:
   - All database queries are strictly encapsulated in repositories; no controllers or routes touch Mongoose models directly.
   - `roomRepo.generateSlug()`: Cryptographically secure 128-bit slug generated via `crypto.randomBytes(16).toString("base64url")`, producing URL-safe strings matching `/^[A-Za-z0-9_-]+$/`.
   - `roomMemberRepo.addMember()`: Programmatically enforces the 6-participant limit, rejecting additional joins with `RoomFullError` (`ROOM_FULL`).
   - `docUpdateRepo`: Strictly append-only. Only allows `appendUpdate`, `getUpdatesSince`, and `deleteByRoom` (cascade). Exposes no `updateOne`, `deleteOne`, or modification methods.

5. **Shared DTO Schemas (`packages/shared/src/index.ts`)**:
   - `UserPrivateDto`: Includes `email`; used strictly for `GET /me`.
   - `UserPublicDto`: Omits `email` entirely; used everywhere else to prevent accidental email leaks across the API.
   - Updated `HealthResponseSchema` with `db: z.enum(["ok", "down"])`.

6. **Local Test Environment & CI Integration**:
   - Added `infra/docker-compose.test.yml` running `mongo:7.0` on port 27017 with `tmpfs` for in-memory disposable execution.
   - Added `npm run db:test:up` and `npm run db:test:down` scripts.
   - Added MongoDB 7.0 service container to GitHub Actions CI (`.github/workflows/ci.yml`).

---

## Architectural Decisions & Trade-offs

### 1. Exclusion of `color` from `room_members`

- **Decision**: The `color` property was removed from the persistent `room_members` database schema.
- **Why**: Color assignment is an ephemeral, session-bound visual preference for cursor and highlight identification. It belongs to live awareness state transmitted via Yjs WebSockets (T08), not persisted relational data. Storing it in MongoDB would introduce cache synchronization overhead and persistent schema coupling for temporary client display choices.

### 2. Compile-Time Privacy Guarantee (`UserPrivateDto` vs `UserPublicDto`)

- **Decision**: Separated user serialization into two distinct Zod schemas.
- **Why**: Relying on runtime property deletion (`delete user.email`) is error-prone. By creating `UserPrivateDto` (used solely for `GET /me`) and `UserPublicDto` (used for room participants, author attribution, and user listings), any route handler attempting to serialize a public user object with an email field will fail schema validation and TypeScript typechecking.

### 3. Append-Only Document Updates

- **Decision**: `docUpdateRepo` provides no update or single-delete methods (`updateOne` and `deleteOne` are undefined).
- **Why**: Document synchronization depends on immutable CRDT update logs. Permitting modifications to update records would invalidate client state vectors, cause non-convergent editing divergence, and corrupt session replay. Only room deletion is permitted to cascade-clean updates.

### 4. 128-Bit Base64URL Slugs

- **Decision**: Room slugs are generated using `crypto.randomBytes(16).toString("base64url")`.
- **Why**: 16 bytes of cryptographically secure random bytes provide 128 bits of entropy ($2^{128} \approx 3.4 \times 10^{38}$ possibilities), preventing brute-force room enumeration. Encoding as `base64url` ensures that no URL reserved characters (`+`, `/`, `=`) appear, preventing routing issues in REST paths.

---

## How to Explain This in an Interview

"In this task, we designed the core data layer for a real-time collaborative system with high durability and security guarantees.

1. **Security & Privacy by Design**: We separated client DTOs into private and public schemas so that sensitive user fields (like email addresses) cannot be accidentally leaked to peers in a collaborative room.
2. **Immutable CRDT Logging**: For collaborative editing, updates must be append-only. We enforced this at the repository layer, deliberately omitting update and single-record delete primitives so that the CRDT log cannot be mutated.
3. **Stateless Health Checks**: We isolated health checking from session middleware. Previously, monitoring probes triggered guest session creation, which would fill the database with thousands of orphan records. Moving the route before session middleware solved this cleanly.
4. **Resilient Connection Lifecycle**: The database connection implements exponential backoff retry and a 5-second selection timeout, combined with graceful shutdown hooks that drain in-flight queries before closing connections."
