# Task T07: Document Sync Server (Hocuspocus & Yjs)

> **Task**: T07 — Document Sync Server  
> **Status**: Completed  
> **Requirements Addressed**: `ED-2`, `ED-6`, `PER-1`, `ED-4`, `ROOM-4`, `CONC-1`, `CONC-2`, `ATTR-1`, `SEC-1`, `SEC-2`, `AD-1`  
> **Primary Components Built**: Hocuspocus Sync Server (`hocuspocus.ts`), In-Memory Sync Registry (`syncRegistry.ts`), Persistence & Durability Engine (`persistence.ts`), Origin Verifier (`origin.ts`), Subnet Rate Limiter (`rateLimiter.ts`), Session Principal Resolver (`sessionPrincipal.ts`), Author Attribution Engine (`clientMapRepo.ts` & `models/client_map.ts`)

---

## 1. Overview & Requirements Fulfillment

Task T07 implements the real-time collaborative document synchronization engine for PairPrep. Built upon **Hocuspocus 4.7.1** and **Yjs 13.6.33**, the sync server attaches directly to the existing Node.js HTTP server at path `/sync`, sharing port and process with Express per PRD Architectural Decision 1 (`AD-1`).

### Requirement Mappings

| Requirement ID | PRD Specification | Implementation Detail | Status |
| :--- | :--- | :--- | :--- |
| **`ED-2`** | Conflict-free live editing (server convergence). | Hocuspocus Yjs WebSocket server at `/sync` synchronizes CRDT state vectors and document updates with immediate in-memory convergence. | **Verified** |
| **`ED-6`** | Server-enforced read-only for viewers & candidates. | `onAuthenticate` sets `connectionConfig.readOnly = true` for viewers and pre-interview candidates; `beforeHandleMessage` sets `connection.readOnly = true` when room is locked; updates are natively dropped without dropping the connection. | **Verified** |
| **`ROOM-3`** | Live permission coordination with REST API. | Room REST mutations coordinate with `syncRegistry` within 1s: member demotion sets `readOnly: true`, kick terminates WebSocket (4003), end locks room, delete terminates all (1000) and cleans `client_map`. | **Verified** |
| **`ROOM-6`** | Interview lifecycle candidate permissions. | Candidate is restricted to read-only while room is `open`; transitioning to `live` activates editing dynamically on already-connected sockets without requiring reconnect. | **Verified** |
| **`PER-1`** | Document persistence & crash recovery within 2s. | `queueUpdate` uses a fixed 2,000 ms durability deadline with flat arrival-order writes to `doc_updates`; abrupt `SIGKILL` child process crash tests verify state recovery. | **Verified** |
| **`ROOM-4`** | Strict room capacity: max 6 members & 6 connections. | `SyncRegistry` synchronously reserves slots in `onAuthenticate`; enforces $\le 6$ distinct members, $\le 6$ total connections, and $\le 3$ connections per member. | **Verified** |
| **`CONC-1`** | Up to 6 participants typing concurrently. | Non-blocking in-memory CRDT processing allows all 6 participants to type simultaneously without locking or race conditions. | **Verified** |
| **`CONC-2`** | Duplicate update delivery is harmless. | Yjs CRDT idempotency ensures duplicate frames produce identical state without duplicate text insertion. | **Verified** |
| **`ATTR-1`** | Trusted author mapping to `client_map`. | Unique compound index `{ roomId: 1, clientId: 1 }` on `client_map` with atomic `$setOnInsert` for first-claim-wins; server context derives `doc_updates.authorId`; forged clientIds are logged as warnings and cannot hijack attribution. | **Verified** |
| **`SEC-1`** | Origin header verification. | Upgrade requests require allowed `Origin` headers matching `APP_URL` or localhost dev origins; unauthorized origins are rejected with HTTP 403. | **Verified** |
| **`SEC-2`** | IP rate limiting & proxy spoofing defense. | `proxy-addr` inspects `X-Forwarded-For` strictly from trusted subnets (`loopback`, `linklocal`, `uniquelocal`, `10.0.0.0/8`, `172.16.0.0/12`); sliding window limits failed upgrades to 60/min. | **Verified** |
| **`AD-1`** | Shared Node.js HTTP process on `/sync`. | HTTP `upgrade` listener delegates WebSocket handshakes on `/sync` to Hocuspocus via internal `crossws.handleUpgrade`. | **Verified** |

---

## 2. Architecture & Design Decisions

```
                           +---------------------------+
                           |   Client (Browser / IDE)   |
                           +-------------+-------------+
                                         |
                                         | WebSocket ws://host/sync
                                         v
+-----------------------------------------------------------------------------------+
| Node.js HTTP Server (Port 3000 / $PORT)                                           |
|                                                                                   |
|  httpServer.on("upgrade")                                                         |
|    |                                                                              |
|    +--> 1. Path Check: pathname === "/sync"                                       |
|    +--> 2. Origin Check: isAllowedOrigin(origin) -> 403 Forbidden                 |
|    +--> 3. IP Rate Limiter: syncUpgradeRateLimiter.consume(clientIp) -> 429       |
|    +--> 4. Delegate: server.crossws.handleUpgrade(req, socket, head)              |
|                                                                                   |
|  Hocuspocus Server Hooks                                                          |
|    |                                                                              |
|    +--> onAuthenticate(data)                                                      |
|    |      - Validate ObjectId (24 hex characters)                                 |
|    |      - syncRegistry.reserveSlot(roomId, socketId) [Max 6 total]              |
|    |      - resolvePrincipalFromCookies(cookieHeader, roomId)                      |
|    |      - syncRegistry.checkDistinctMemberLimit(roomId, memberId) [Max 6]       |
|    |      - syncRegistry.checkMemberLimit(roomId, memberId) [Max 3/member]        |
|    |      - Read-only role evaluation (viewer or candidate before start)          |
|    |      - Cancel reservation on ANY error / failure path                        |
|    |                                                                              |
|    +--> connected(data)                                                           |
|    |      - syncRegistry.promoteReservation(socketId, roomId, memberId, ...)      |
|    |                                                                              |
|    +--> onLoadDocument(data)                                                      |
|    |      - loadDocument(roomId, doc) [Snapshot + updates replay]                 |
|    |      - startSnapshotInterval(roomId, doc) [5-minute interval]                |
|    |                                                                              |
|    +--> onAwarenessUpdate(data)                                                   |
|    |      - Extract Yjs clientIds from added and states                           |
|    |      - Register client mapping via clientMapRepo with first-claim-wins       |
|    |                                                                              |
|    +--> beforeHandleMessage(data)                                                 |
|    |      - Frame size <= 1 MB check                                              |
|    |      - Drop edits if connection or room is read-only                         |
|    |                                                                              |
|    +--> onChange(data)                                                            |
|    |      - Derive authorId strictly from server authenticated session context    |
|    |      - queueUpdate(roomId, authorId, update, doc)                            |
|    |      - Register update clientIds in client_map with first-claim-wins         |
|    |                                                                              |
|    +--> onDisconnect(data)                                                         |
|           - flushRoom(roomId, true)                                               |
|           - syncRegistry.unregisterConnection(roomId, socketId)                   |
|           - When clientsCount === 0: stop timer, takeSnapshot, unloadDocument     |
+-----------------------------------------------------------------------------------+
```

### 2.1 Connection Lifecycle & Capacity Guarantees (`ROOM-4`)
- Slots are reserved **synchronously** in `onAuthenticate` before performing asynchronous I/O (session resolution, DB checks).
- Any failure, rejection, or exception during handshake releases the reservation immediately (`syncRegistry.cancelReservation`).
- Promotion from reservation to active connection occurs in `connected(data)`.
- Disconnections unregister active connections and free member capacity.

### 2.2 Durability Bound & Flat Arrival-Order Writes (`PER-1`)
- In-memory updates are enqueued into a flat arrival-order queue: `{ authorId: string, update: Uint8Array, ts: Date }[]`.
- Coalescing or merging updates is deliberately avoided to preserve granular replay and attribution fidelity.
- Fixed 2,000 ms durability deadline (`MAX_UNFLUSHED_AGE_MS`) guarantees that updates are flushed to MongoDB within 2 seconds of the first unflushed edit.
- On write failures, `requeueUpdates` prepends unflushed updates while preserving the original `firstUnflushedAt` timestamp, ensuring durability timers do not reset.

### 2.3 Periodic Snapshots & Memory Unload
- Snapshots are triggered every 5 minutes of activity via `startSnapshotInterval` and on final client disconnect.
- Snapshots store `{ roomId, seq, ts, state, text }`.
- When all clients disconnect (`clientsCount === 0`), `takeSnapshot` is performed, snapshot intervals are cleared, and the document is evicted from Hocuspocus memory via `unloadDocument`.

### 2.4 Server-Enforced Read-Only Rules (`ED-6`)
- Evaluated on authentication based on room status (`ended`, `archived`), member role (`viewer`), and interview candidate status before start.
- `beforeHandleMessage` verifies both connection `readOnly` and `syncRegistry.isRoomReadOnly(roomId)`. Any update frame from a read-only socket is dropped before CRDT application or peer broadcast.

### 2.5 Author Attribution & Identity Mapping (`ATTR-1`)
- **First-Claim-Wins (`client_map`)**: When a client establishes an awareness state or submits an edit, its Yjs `clientId` is registered with the authenticated `actorId` via `clientMapRepo.registerClient(roomId, clientId, actorId)`.
- **Atomic Upsert & Unique Compound Index**: `ClientMapModel` defines a unique compound index on `{ roomId: 1, clientId: 1 }`. Registration executes an atomic `findOneAndUpdate` with `$setOnInsert`. If another actor later submits updates or awareness claiming that same `clientId`, the server detects the conflict, safely logs a warning, and retains the original mapping.
- **Cryptographic Independence**: Yjs client IDs are arbitrary 32-bit integers generated client-side and are NEVER treated as cryptographic proof of identity. The write path for `doc_updates` populates `authorId` strictly from the server-side authenticated connection context (`context.principal.id`), preventing attribution forgery even if a client forges its local Yjs `clientID`.

---

## 3. Core Modules & Implementation Details

### 3.1 `apps/server/src/sync/hocuspocus.ts`
- **Responsibilities**: Attaches Hocuspocus to Node HTTP server, manages hook lifecycle (`onAuthenticate`, `connected`, `onLoadDocument`, `onAwarenessUpdate`, `beforeHandleMessage`, `onChange`, `onDisconnect`).
- **Startup Runtime Guard**:
  ```ts
  const crossws = (syncInstance.server as unknown as Record<string, unknown>)["crossws"] as
    | { handleUpgrade: (req: IncomingMessage, sock: Duplex, head: Buffer) => void }
    | undefined;
  if (!crossws?.handleUpgrade) {
    throw new Error("Hocuspocus internal crossws adapter not found — check version");
  }
  ```

### 3.2 `apps/server/src/sync/persistence.ts`
- **Responsibilities**: Room mutex, read-only document loader, arrival-order update queue, failure recovery, 5-minute recurring snapshots, and snapshot pruning.
- **Key Exports**:
  - `RoomMutex`: FIFO serialized promise chain per room.
  - `loadDocument(roomId, targetDoc)`: Replays snapshot + subsequent updates.
  - `queueUpdate(roomId, authorId, update, document)`: Enqueues edit with 250ms debounce and 2,000ms hard deadline.
  - `requeueUpdates(roomId, failedBatch, originalFirstUnflushedAt, document)`: Restores failed writes without resetting durability timers.
  - `flushRoom(roomId, forceSnapshot)`: Writes arrival-order batch to MongoDB.
  - `startSnapshotInterval(roomId, doc)` / `stopSnapshotInterval(roomId)`: 5-minute periodic snapshot lifecycle.

### 3.3 `apps/server/src/sync/syncRegistry.ts`
- **Responsibilities**: Tracks active sockets, reservations, member associations, and read-only rooms.
- **Key Methods**:
  - `reserveSlot(roomId, socketId)`: Atomically reserves 1 of 6 connections.
  - `promoteReservation(...)`: Transitions reservation to active connection when `connected` hook fires.
  - `getConnection(socketId)`: Retrieves active connection metadata by socket ID.
  - `checkDistinctMemberLimit(roomId, memberId)`: Enforces max 6 distinct members per room.
  - `checkMemberLimit(roomId, memberId)`: Enforces max 3 connections per member.
  - `closeConnectionsForMember(roomId, memberId, code, reason)`: Closes all sockets for a member with a specific code.
  - `setRoomReadOnly(roomId)` / `setRoomWritable(roomId)`: Dynamically toggles read-only mode for all sockets in a room.

### 3.4 `apps/server/src/repos/clientMapRepo.ts` & `models/client_map.ts`
- **Responsibilities**: Manages the persistent mapping of Yjs `clientId` to authenticated user/guest IDs.
- **Key Methods**:
  - `registerClient(roomId, clientId, actorId)`: Enforces first-claim-wins using `$setOnInsert` and handles duplicate-key races.
  - `findByClient(roomId, clientId)`: Retrieves the verified author for a given Yjs client ID.
  - `deleteByRoom(roomId)`: Cascades deletion when a room is destroyed.

### 3.5 `apps/server/src/sync/rateLimiter.ts` & `origin.ts`
- **Trusted Proxies**: `["loopback", "linklocal", "uniquelocal", "10.0.0.0/8", "172.16.0.0/12"]`.
- **Allowed Origins**: `APP_URL`, `http://localhost:3000`, `http://127.0.0.1:3000`.
- **IP Rate Limiter**: 60 rejected upgrade attempts per minute per derived client IP.

---

## 4. Verification Evidence & Test Suite Summary

### 4.1 Test Suite Breakdown (`apps/server/src/__tests__/sync/`)

| Test File | Tests | Focus Area | Status |
| :--- | :---: | :--- | :--- |
| **`spike.test.ts`** | 1 | Minimal Hocuspocus attach at `/sync` with real `@hocuspocus/provider` client. | **PASS** |
| **`handshake.test.ts`** | 16 | Session resolution, cookie signing, ObjectId validation, allowed origins, subnet IP extraction, upgrade rate limits. | **PASS** |
| **`registry.test.ts`** | 8 | Room connection limits, distinct member tracking, member connection limits, reservation expiration, read-only rooms. | **PASS** |
| **`capacity.test.ts`** | 2 | End-to-end 6-connection room capacity saturation, 7th connection rejection, slot release on disconnect/failure. | **PASS** |
| **`persistence.test.ts`** | 6 | Read-only loading, snapshot reconstruction, flat arrival-order writes, monotonic sequences, requeue durability, 3-snapshot pruning, 2 MB cap. | **PASS** |
| **`persistenceCrash.test.ts`** | 1 | Continuous typing across 2 separate child processes with `SIGKILL` crash and MongoDB recovery within 2.0s durability bound. | **PASS** |
| **`disconnect.test.ts`** | 1 | Disconnect lifecycle: immediate flush on disconnect, unregister connection, snapshot on exit, and document memory unload. | **PASS** |
| **`concurrency.test.ts`** | 3 | 6 concurrent participants typing without conflict (`CONC-1`), idempotent duplicate updates (`CONC-2`), read-only enforcement in `beforeHandleMessage` (`ED-6`). | **PASS** |
| **`attribution.test.ts`** | 7 | Client identity attribution (`ATTR-1`), first-claim-wins `$setOnInsert`, duplicate-key concurrency, identity hijacking prevention. | **PASS** |
| **`livePermissions.test.ts`** | 6 | Live permission coordination (`ROOM-3`, `ROOM-6`, `ED-6`): demote to viewer (<1s revocation), promote to editor, kick termination (4003), room end read-only, room delete cascade (1000), interview candidate lifecycle. | **PASS** |

**Total T07 Tests:** 10 test files, 51 passing tests, 0 failures.  
**Full Monorepo Suite:** 48 test files, 328 passing tests, 0 failures.

---

## 5. Git Commit History (`task/T07-sync-server`)

```text
e592a32 docs(sync): add comprehensive T07 document sync technical note
4ca477e test(sync): full integration test suite, disconnect lifecycle and concurrency
3b86a3d fix(sync): arrival-order writes, 5-min snapshot interval, requeue durability and unload on disconnect
c30f5a2 feat(sync): persistence, durability bound, document snapshots and crash recovery
05d9e9f feat(sync): connection guard, sync registry, and room capacity enforcement
633a498 feat(sync): handshake auth, session principal, allowed origins and ip rate limiting
5a0238a spike(sync): minimal hocuspocus attach with provider test
```
