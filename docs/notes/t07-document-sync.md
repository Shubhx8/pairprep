# Task T07: Document Sync Server (Hocuspocus & Yjs)

> **Task**: T07 — Document Sync Server  
> **Status**: Completed  
> **Requirements Addressed**: `ED-2`, `ED-6`, `PER-1`, `ED-4`, `ROOM-4`, `CONC-1`, `CONC-2`, `ATTR-1`, `SEC-1`, `SEC-2`, `AD-1`  
> **Primary Components Built**: Hocuspocus Sync Server (`hocuspocus.ts`), In-Memory Sync Registry (`syncRegistry.ts`), Persistence & Durability Engine (`persistence.ts`), Origin Verifier (`origin.ts`), Subnet Rate Limiter (`rateLimiter.ts`), Session Principal Resolver (`sessionPrincipal.ts`)

---

## 1. Overview & Requirements Fulfillment

Task T07 implements the real-time collaborative document synchronization engine for PairPrep. Built upon **Hocuspocus 4.7.1** and **Yjs 13.6.33**, the sync server attaches directly to the existing Node.js HTTP server at path `/sync`, sharing port and process with Express per PRD Architectural Decision 1 (`AD-1`).

### Requirement Mappings

| Requirement ID | PRD Specification | Implementation Detail | Status |
| :--- | :--- | :--- | :--- |
| **`ED-2`** | Conflict-free live editing (server convergence). | Hocuspocus Yjs WebSocket server at `/sync` synchronizes CRDT state vectors and document updates with immediate in-memory convergence. | **Verified** |
| **`ED-6`** | Server-enforced read-only for viewers & candidates. | `onAuthenticate` sets `connectionConfig.readOnly = true` for viewers and pre-interview candidates; `beforeHandleMessage` drops edits from read-only sockets. | **Verified** |
| **`PER-1`** | Document persistence & crash recovery within 2s. | `queueUpdate` uses a fixed 2,000 ms durability deadline with flat arrival-order writes to `doc_updates`; abrupt `SIGKILL` child process crash tests verify state recovery. | **Verified** |
| **`ROOM-4`** | Strict room capacity: max 6 members & 6 connections. | `SyncRegistry` synchronously reserves slots in `onAuthenticate`; enforces $\le 6$ distinct members, $\le 6$ total connections, and $\le 3$ connections per member. | **Verified** |
| **`CONC-1`** | Up to 6 participants typing concurrently. | Non-blocking in-memory CRDT processing allows all 6 participants to type simultaneously without locking or race conditions. | **Verified** |
| **`CONC-2`** | Duplicate update delivery is harmless. | Yjs CRDT idempotency ensures duplicate frames produce identical state without duplicate text insertion. | **Verified** |
| **`ATTR-1`** | Actor attribution per update. | Every update is stored with resolved `authorId`, timestamp `ts`, and sequence number in `doc_updates`. | **Verified** |
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
|    |      - Promote reservation to active connection with live data.connection    |
|    |                                                                              |
|    +--> onLoadDocument(data)                                                      |
|    |      - Replay doc_snapshots (latest) + doc_updates (since snapshot seq)      |
|    |      - startSnapshotInterval(roomId, document) [5-minute periodic timer]     |
|    |                                                                              |
|    +--> beforeHandleMessage(data)                                                 |
|    |      - Reject frames > 1,048,576 bytes (1 MB limit)                          |
|    |      - Reject edits if connection.readOnly or room is read-only              |
|    |                                                                              |
|    +--> onChange(data)                                                            |
|    |      - queueUpdate(roomId, authorId, data.update, data.document)             |
|    |      - Flat arrival-order array with 250ms debounce & 2,000ms hard deadline  |
|    |                                                                              |
|    +--> onDisconnect(data)                                                        |
|           - flushRoom(roomId, true)                                               |
|           - syncRegistry.unregisterConnection(roomId, socketId)                   |
|           - When clientsCount === 0:                                              |
|               * stopSnapshotInterval(roomId)                                      |
|               * takeSnapshot(roomId, document, true)                              |
|               * data.instance.unloadDocument(document)                            |
+-----------------------------------------------------------------------------------+
                                         |
                                         v
                           +---------------------------+
                           |     MongoDB Database      |
                           |                           |
                           |  - doc_updates (ordered)  |
                           |  - doc_snapshots (max 3)  |
                           +---------------------------+
```

### 2.1 Shared HTTP Process Architecture (`AD-1`)
- **Challenge**: Running a separate sync process would double deployment complexity, require multi-port coordination, and complicate cookie authentication.
- **Solution**: Shared the existing Node.js HTTP server. An `upgrade` handler intercepts requests on pathname `/sync`, performs fast perimeter security checks (Origin and IP rate limit), and forwards to Hocuspocus via `crossws.handleUpgrade`. A startup runtime guard validates that Hocuspocus exposes `crossws.handleUpgrade`, failing immediately at boot if dependencies change unexpectedly.

### 2.2 Synchronous Slot Reservation (`ROOM-4`)
- **Challenge**: Multiple simultaneous WebSocket upgrade attempts could exceed the strict 6-connection room limit if capacity is only checked after async database lookups.
- **Solution**: Implemented `syncRegistry.reserveSlot(roomId, socketId)`. Capacity is checked synchronously inside `onAuthenticate` before async session resolution. If the room has 6 connections/reservations, the 7th attempt is rejected immediately with code `4409` (`room_capacity_exceeded`). Reservations automatically expire after 10 seconds if not promoted, and are canceled synchronously in the `catch` block on any authentication error or permission rejection.

### 2.3 Strict Replay Fidelity & Flat Arrival-Order Writes (`PER-1`)
- **Challenge**: Coalescing updates per author with `Y.mergeUpdates` before writing to disk saves database rows but destroys chronological replay order across multiple concurrent authors and complicates incremental audit logging.
- **Solution**: Updates are stored in a flat arrival-order array: `{ authorId, update, ts }[]`. During flush under the per-room promise mutex (`RoomMutex`), each incremental update is written as an individual record in `doc_updates` with a strictly increasing sequence number (`seq`). This preserves full deterministic replay fidelity while maintaining the 2.0-second durability bound.

### 2.4 Atomic Queue Replacement & Failure Durability
- **Challenge**: If a database write fails, in-flight edits must not be dropped. Conversely, deleting the queue after the write risks race conditions with newly arriving edits.
- **Solution**: Inside the `roomMutex`, the pending queue is atomically replaced with a new empty queue before starting the database write. If the write fails, `requeueUpdates(roomId, failedBatch, originalFirstUnflushedAt, document)` prepends the failed batch in front of any newly arrived edits (preserving arrival order), restores the original `firstUnflushedAt`, and reschedules the deadline timer for the remaining time.

### 2.5 5-Minute Periodic Snapshots & Disconnect Lifecycle
- **Challenge**: Long-running collaboration sessions accumulate thousands of incremental update records in `doc_updates`, slowing down future document load times.
- **Solution**:
  - `SNAPSHOT_INTERVAL_MS = 5 * 60 * 1000`: A 5-minute recurring timer captures binary document snapshots into `doc_snapshots`.
  - Older snapshots are automatically pruned to keep strictly the **3 latest snapshots** per room.
  - When the last client disconnects (`data.clientsCount === 0`), the timer is cleared, a final snapshot is taken, and `data.instance.unloadDocument(data.document)` unloads the document from Hocuspocus memory.

### 2.6 Server-Enforced Read-Only Mode (`ED-6`)
- **Challenge**: Client-side read-only flags can be bypassed by malicious actors sending raw Yjs update frames over WebSocket.
- **Solution**:
  - Room status (`ended`, `archived`), member role (`viewer`), and interview candidate status before start are evaluated in `onAuthenticate`.
  - Read-only connections have `data.connectionConfig.readOnly = true`.
  - `beforeHandleMessage` verifies `data.connection.readOnly` and `syncRegistry.isRoomReadOnly(roomId)`. Any update frame from a read-only socket is dropped with an error before Hocuspocus CRDT application or peer broadcast.

---

## 3. Core Modules & Implementation Details

### 3.1 `apps/server/src/sync/hocuspocus.ts`
- **Responsibilities**: Attaches Hocuspocus to Node HTTP server, manages hook lifecycle (`onAuthenticate`, `connected`, `onLoadDocument`, `beforeHandleMessage`, `onChange`, `onDisconnect`).
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
  - `checkDistinctMemberLimit(roomId, memberId)`: Enforces max 6 distinct members per room.
  - `checkMemberLimit(roomId, memberId)`: Enforces max 3 connections per member.
  - `closeConnectionsForMember(roomId, memberId, code, reason)`: Closes all sockets for a member with a specific code.
  - `setRoomReadOnly(roomId)` / `setRoomWritable(roomId)`: Dynamically toggles read-only mode for all sockets in a room.

### 3.4 `apps/server/src/sync/rateLimiter.ts` & `origin.ts`
- **Trusted Proxies**: `["loopback", "linklocal", "uniquelocal", "10.0.0.0/8", "172.16.0.0/12"]`.
- **Allowed Origins**: `APP_URL`, `http://localhost:3000`, `http://127.0.0.1:3000`.
- **IP Rate Limiter**: 60 rejected upgrade attempts per minute per derived client IP.

---

## 4. Verification Evidence & Test Suite Summary

### 4.1 Test Suite Breakdown (`apps/server/src/__tests__/sync/`)

| Test File | Tests | Focus Area | Status |
| :--- | :---: | :--- | :---: |
| **`spike.test.ts`** | 1 | Minimal Hocuspocus attach at `/sync` with real `@hocuspocus/provider` client. | **PASS** |
| **`handshake.test.ts`** | 16 | Session resolution, cookie signing, ObjectId validation, allowed origins, subnet IP extraction, upgrade rate limits. | **PASS** |
| **`registry.test.ts`** | 8 | Room connection limits, distinct member tracking, member connection limits, reservation expiration, read-only rooms. | **PASS** |
| **`capacity.test.ts`** | 2 | End-to-end 6-connection room capacity saturation, 7th connection rejection, slot release on disconnect/failure. | **PASS** |
| **`persistence.test.ts`** | 6 | Read-only loading, snapshot reconstruction, flat arrival-order writes, monotonic sequences, requeue durability, 3-snapshot pruning, 2 MB cap. | **PASS** |
| **`persistenceCrash.test.ts`** | 1 | Continuous typing across 2 separate child processes with `SIGKILL` crash and MongoDB recovery within 2.0s durability bound. | **PASS** |
| **`disconnect.test.ts`** | 1 | Disconnect lifecycle: immediate flush on disconnect, unregister connection, snapshot on exit, and document memory unload. | **PASS** |
| **`concurrency.test.ts`** | 3 | 6 concurrent participants typing without conflict (`CONC-1`), idempotent duplicate updates (`CONC-2`), read-only enforcement in `beforeHandleMessage` (`ED-6`). | **PASS** |

**Total T07 Tests:** 8 test files, 38 passing tests, 0 failures.  
**Full Monorepo Suite:** 46 test files, 315 passing tests, 0 failures.

---

## 5. Git Commit History (`task/T07-sync-server`)

```text
4ca477e test(sync): full integration test suite, disconnect lifecycle and concurrency
3b86a3d fix(sync): arrival-order writes, 5-min snapshot interval, requeue durability and unload on disconnect
c30f5a2 feat(sync): persistence, durability bound, document snapshots and crash recovery
05d9e9f feat(sync): connection guard, sync registry, and room capacity enforcement
633a498 feat(sync): handshake auth, session principal, allowed origins and ip rate limiting
5a0238a spike(sync): minimal hocuspocus attach with provider test
```
