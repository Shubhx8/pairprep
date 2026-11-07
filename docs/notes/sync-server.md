# Document Sync Server Architecture & Operations (T07)

## 1. System Architecture

The PairPrep Document Sync Server is built on **Hocuspocus 4.7.1** and **Yjs 13.6.33**, co-hosted within the Express Node.js HTTP server at route `/sync` (Architectural Decision `AD-1`). This design eliminates external real-time brokers (such as Redis or standalone WebSocket microservices) while satisfying resource limits on free-tier infrastructure.

### 1.1 Ingress & Protocol Upgrade Flow
1. **HTTP Upgrade**: An incoming WebSocket handshake triggers `httpServer.on("upgrade")`.
2. **Endpoint Validation**: Only requests directed to pathname `/sync` are processed; others are ignored or passed to other handlers.
3. **Subnet-Aware Client IP Extraction**: Client IP is extracted via `proxy-addr` configured with trusted upstream proxies (`loopback`, `linklocal`, `uniquelocal`, `10.0.0.0/8`, `172.16.0.0/12`). Direct connections cannot forge client IP via `X-Forwarded-For`.
4. **IP Rate Limiting**: Bounded sliding window tracking rejected handshake attempts (max 60 rejections/minute/IP). Excess rejections receive `429 Too Many Requests`.
5. **Origin Verification**: Handshakes validate the `Origin` header against `APP_URL`, `CLIENT_ORIGIN`, and development origins. Untrusted origins are rejected with `403 Forbidden`.
6. **CrossWS Delegation**: Valid upgrades are handed off to Hocuspocus's internal `crossws` adapter with a startup runtime guard.

### 1.2 Authentication & Capacity Guard (`onAuthenticate`)
- **Document ID Validation**: Document names are strictly validated as 24-character hexadecimal MongoDB ObjectIds.
- **Atomic Capacity Reservation**: Before performing asynchronous database or cookie lookups, the server reserves a slot in the in-memory `SyncRegistry`. A room permits a maximum of 6 concurrent WebSocket connections and 6 distinct members, with at most 3 connections per member (`ROOM-4`).
- **Principal Resolution**: Handshake cookies are validated against Express sessions (`pairprep.sid`) or signed guest tokens (`pairprep.guest`).
- **Room & Membership Check**: Verifies that the room exists in MongoDB and the user is an active room member.
- **Fail-Safe Cleanup**: Any error, rejection, or exception during `onAuthenticate` immediately releases the reserved slot (`syncRegistry.cancelReservation`).

---

## 2. Document Persistence & Sequence Monotonicity (`PER-1`)

### 2.1 Flat Arrival-Order Update Queue
Incoming edits are enqueued in `pendingQueues.get(roomId)` as flat arrival-order records:
```ts
interface QueuedUpdate {
  authorId: string;
  update: Uint8Array;
  ts: Date;
  seq?: number;
}
```
Unlike systems that merge updates per-author or debounce across clients, updates are stored in strict arrival order to maintain exact replay fidelity and timestamp precision.

### 2.2 Durability Deadline (2 Seconds), Retry Backoff & Unique Index Idempotency
- **Debounce**: Writes are scheduled with a 250 ms debounce (`FLUSH_DEBOUNCE_MS`).
- **Hard Durability Bound**: The time between the first unflushed edit and database insertion never exceeds 2,000 ms (`MAX_UNFLUSHED_AGE_MS`).
- **Requeue with Age & Sequence Preservation**: If a MongoDB write fails, `requeueUpdates` prepends the failed batch back into the room queue while preserving the original `firstUnflushedAt` timestamp and stable assigned sequence numbers (`seq`).
- **Bounded Retry Backoff with Jitter**: Consecutive database flush failures back off exponentially (`MIN_RETRY_BACKOFF_MS = 250`, `MAX_RETRY_BACKOFF_MS = 5000`, factor 2 with random jitter) instead of spinning in a 0 ms unthrottled loop. Success strictly resets the failure counter to zero only after complete logical batch confirmation.
- **Compound Unique Index & Ambiguous Ack Reconciliation**:
  - The `doc_updates` collection enforces a physical unique compound index on `{ roomId: 1, seq: 1 }` (`roomId_1_seq_1`).
  - Before retrying inserts after an ambiguous write or network timeout, the flush worker queries existing records in the sequence range (`{ roomId, seq: { $gte: minSeq, $lte: maxSeq } }`). Records whose `authorId` and binary payload match are recognized as committed and skipped; conflicting records trigger an explicit consistency error (`Consistency failure: conflicting record in roomId=... at seq=...`).
  - Concurrent insert races triggering MongoDB `E11000 duplicate key error` are intercepted: matching records reconcile cleanly without throwing, while conflicting records fail visibly.

### 2.3 Queue Bounding, In-Flight Accounting & Synchronous Write Backpressure
- **Combined Buffer Capacity Limits**: Each room's persistence queue evaluates combined pending and in-flight updates: strictly bounded at 1,000 updates (`MAX_PENDING_UPDATES_PER_ROOM`) or 4 MB of pending binary payload (`MAX_PENDING_BYTES_PER_ROOM`).
- **No Double-Counting on Requeue**: Updates currently in-flight to MongoDB are tracked in `inFlightUpdatesByRoom` and `inFlightBytesByRoom`. If a flush fails, `requeueUpdates` decrements the in-flight accounting and transfers the batch back to the pending queue without double-counting room capacity.
- **Synchronous Write Backpressure**: When queue bounds are breached, the server immediately marks the room backpressured in `syncRegistry.setRoomBackpressure(roomId, true)`. Late edits are rejected in `beforeHandleMessage` while preserving all already-accepted updates in the queue.
- **Hysteresis Recovery & Invariant Preservation**: Backpressure is released once the combined queue drains below 50% capacity (500 updates and 2 MB). Crucially, releasing backpressure does not blindly mark sockets writable: `syncRegistry.calculateEffectiveReadOnly` re-evaluates all orthogonal constraints per connection, ensuring viewers, candidates outside the live window, and demoted members remain read-only.

### 2.4 Per-Room Promise Mutex (`RoomMutex`)
To guarantee gapless sequence numbering and eliminate concurrent flush races, all database operations (`flushRoom`, `saveSnapshot`, `loadDocument`) execute under a FIFO promise mutex keyed by `roomId`. The mutex tracks tail promises to ensure completed queues are evicted from memory immediately without leakage.

---

## 3. Snapshots, Recovery & Memory Management

### 3.1 Snapshots, Microtask Lockstep Barrier & Deduplication
- **Frequency**: Every 5 minutes of active editing (`SNAPSHOT_INTERVAL_MS = 300,000`) and when the last client disconnects (`clientsCount === 0`).
- **Synchronous Revision Tracking**: The server attaches a synchronous `doc.on("update")` listener in `registerLoadedDocument`. This tracks `roomAppliedUpdates` immediately on the Yjs callstack, before Hocuspocus schedules its asynchronous `onChange` microtask.
- **Watermark Lockstep Consistency**: `takeSnapshotLocked` executes under the `RoomMutex`:
  1. Flushes all pending updates to MongoDB (`flushRoomLocked`).
  2. Yields execution via microtask (`await new Promise((r) => setTimeout(r, 0))`) to allow any in-flight Hocuspocus `onChange` enqueuing to settle.
  3. If new updates arrived during the yield, loops back to drain them before snapshotting.
  4. Once `roomAppliedUpdates === roomPersistedUpdates`, reads the exact matching sequence number from MongoDB.
  5. Captures the binary state via `Y.encodeStateAsUpdate(document)`.
  This guarantees zero async gap between the stored snapshot watermark `seq` and the document binary state.
- **Snapshot Deduplication**: If a room has experienced no new updates since its latest snapshot (`seq === lastSnapshot.seq`), redundant snapshot generation is skipped.
- **Deterministic Pruning**: Pruning sorts snapshots deterministically by `{ seq: -1, ts: -1, _id: -1 }`, retaining the latest 3 snapshots (`MAX_SNAPSHOTS_TO_KEEP = 3`).

### 3.2 Document Loading & Availability
- When a document is opened (`onLoadDocument`):
  1. Checks database connectivity (`mongoose.connection.readyState === 1`). If disconnected, throws immediately rather than serving a blank document that could overwrite historical work.
  2. Executes under `RoomMutex.runExclusive` to serialize concurrent room accesses.
  3. Registers the document in `activeLoadedDocuments` map.
  4. The server loads the latest snapshot from `doc_snapshots` using deterministic tie-breaking.
  5. If a snapshot exists, its binary state is applied to the Yjs document (`Y.applyUpdate(targetDoc, snapshot.state)`).
  6. All incremental updates with `seq > snapshot.seq` are loaded from `doc_updates` and applied in order.
- **SIGKILL Crash Recovery**: In automated tests, an abrupt child process crash (`SIGKILL`) loses at most the last 2.0 seconds of edits, with complete document convergence upon restart.

### 3.3 Disconnect Lifecycle & Memory Unload
- **Intermediate Disconnects**: When a participant leaves but other participants remain (`clientsCount > 0`), the room flushes pending updates (`flushRoom(roomId, false)`) without generating an intermediate snapshot.
- **Final Disconnect**: When all participants disconnect from a room (`clientsCount === 0`):
  1. Pending updates are flushed to MongoDB.
  2. Exactly one final snapshot is generated.
  3. The 5-minute recurring snapshot timer is cleared.
  4. The document is unregistered from `activeLoadedDocuments`.
  5. The document is evicted from Hocuspocus memory (`hocuspocusInstance.unloadDocument(doc)`).

### 3.4 Concurrent Document-Load Deduplication & Cohort Waiter Cleanup
- **Hocuspocus 4.7.1 In-Flight Deduplication**: In Hocuspocus 4.7.1, `createDocument()` deduplicates in-flight loads by document name (`this.loadingDocuments.get(documentName)`). Multiple concurrent incoming connections for the same document share a single in-flight `loadDocument()` promise after each independently reserving a room slot in `onAuthenticate`.
- **Cohort Waiter Tracking (`DocumentLoadWaiterRegistry`)**: To ensure no pending reservations or rate-limiter entries are orphaned if that shared load fails or is aborted during shutdown, the server registers each connection in `documentLoadWaiters` upon reservation.
- **Fail-Safe Cleanup on Load Failure**: If `onLoadDocument` throws (due to MongoDB error, corrupted snapshot, or shutdown abort), `cleanupFailedLoad` cancels reservations for the exact cohort of waiting sockets (`documentLoadWaiters.clearWaiters(roomId)`) via `syncRegistry.cancelReservation(sock, roomId)`, and cleans up each socket's rate-limiter state only if that physical socket has no other active document connections or pending reservations. Multi-document physical socket sharing is strictly preserved.

---

## 4. Client Identity Attribution & Security (`ATTR-1`)

### 4.1 First-Claim-Wins (`client_map`)
- Yjs client IDs are arbitrary 32-bit integers generated by browsers.
- When a client connects or emits awareness/edits, the server associates the Yjs `clientId` with the authenticated actor (`actorId`).
- **Unique Compound Index**: MongoDB collection `client_map` enforces uniqueness on `{ roomId: 1, clientId: 1 }`.
- **Atomic Upsert**: Uses `$setOnInsert` so existing mappings cannot be overwritten. If a rogue client or malicious script attempts to claim another user's `clientId`, the server detects the conflict, logs a structured warning, and retains the original attribution.

### 4.2 Cryptographic Independence
- Yjs client IDs are **never** treated as cryptographic proof of identity.
- In `doc_updates`, the `authorId` field is populated **strictly from the server-side authenticated connection context** (`context.principal.id`), never from the payload.

---

## 5. Live Permission Coordination & Room Lifecycle (`ROOM-3`, `ROOM-6`, `ED-6`)

### 5.1 Sub-Second Permission Revocation
Room REST APIs directly coordinate with the in-memory `SyncRegistry`:
- **Role Demotion (`PATCH /api/v1/rooms/:slug/members/:id`)**: When demoted to `viewer`, the member's active connections are set to `readOnly = true` immediately in memory without disconnecting the client. Hocuspocus natively drops edit frames (`writeSyncStatus(false)`) without terminating the socket. When promoted back to `editor`, connections are restored to `readOnly = false` instantly.
- **Member Removal (`DELETE /api/v1/rooms/:slug/members/:id`)**: Immediately terminates all active WebSocket connections for the removed member with WebSocket close code `4003` (`removed`).
- **Room End (`POST /api/v1/rooms/:slug/end`)**: Locks the room in `SyncRegistry.setRoomReadOnly(roomId)`, enforcing `readOnly: true` across all active and newly connected sockets.
- **Room Deletion (`DELETE /api/v1/rooms/:slug`)**: Closes all active connections with close code `1000` (`room_deleted`), marks the room read-only, and cascades deletion of `client_map` entries.
- **Interview Lifecycle (`ROOM-6`)**: In `interview` rooms, candidate connections start as `readOnly = true` while the room is `open`. When the interview starts (`live`), `syncRegistry.updateRoomLifecycle(roomId, "live")` dynamically enables editing on already-connected candidate sockets without requiring a reconnect.

### 5.2 Authoritative Effective Read-Only Calculation
To avoid race conditions and ensure no permission invariants are violated when room states transition or backpressure clears, `SyncRegistry` implements a centralized, multi-factor evaluation function: `calculateEffectiveReadOnly(active: ActiveConnection): boolean`.

It combines seven orthogonal factors in precedence order:
1. **Server Shutdown Barrier**: When `isShuttingDownState` is active, all connections are forced read-only.
2. **Permanent Room Read-Only**: Sockets are read-only if the room is locked (e.g. 2 MB soft cap reached).
3. **Queue Backpressure**: Sockets are temporarily read-only while `backpressuredRooms` contains `roomId`.
4. **Room Lifecycle State**: Sockets are read-only if room `status === "ended"` or `status === "archived"`.
5. **Member Role Assignment**: Sockets belonging to members with `role === "viewer"` are strictly read-only.
6. **Interview Candidate Window**: Sockets belonging to `interview` candidates are read-only while `status !== "live"`.
7. **Explicit Member Flag**: Sockets whose member ID is in `readOnlyMembers` are read-only.

When backpressure clears (`setRoomBackpressure(roomId, false)`), the registry does not set `readOnly = false` indiscriminately. Instead, it recomputes `calculateEffectiveReadOnly` for every active connection in the room, guaranteeing that viewers, candidates in open rooms, and demoted members remain read-only.

---

## 6. Per-Connection Rate Limiting & Flood Defense (`SEC-3`)

### 6.1 Dual Token Bucket Architecture
To defend against malicious message flooding, denial-of-service, or runaway scripts without impacting normal collaborative editing or initial synchronization, the sync server implements `ConnectionRateLimiter`:
- **Message Token Bucket**:
  - Burst Capacity: 100 messages.
  - Refill Rate: 50 messages/second.
- **Byte Token Bucket**:
  - Burst Capacity: 2,097,152 bytes (2 MB).
  - Refill Rate: 1,048,576 bytes/second (1 MB/second).

### 6.2 Hook Interception & Close Semantics
- Evaluated inside Hocuspocus `beforeHandleMessage` for **both** document synchronization updates (`MessageType.Sync`) and awareness frames (`MessageType.Awareness`).
- If either the message token bucket or byte token bucket is depleted:
  1. A structured warning log is emitted (`rootLogger.warn`).
  2. The underlying WebSocket is immediately severed at the transport layer (`ws.close(4029, reason)`).
  3. `RateLimitError` is thrown, halting Hocuspocus message processing, clearing the message queue (`messageQueue.length = 0`), and preventing any mutation or peer broadcast.
  4. The close event is delivered to the client with application close code `4029` and reason `message_rate_limit_exceeded` or `byte_rate_limit_exceeded`.
- State is cleared on disconnect (`onDisconnect`) and on handshake failure (`onAuthenticate` catch block).

### 6.3 Capacity Saturation & Connection Churn Defense
- The connection limiter tracks up to 10,000 active entries (`maxEntries`).
- When capacity is reached, entries past TTL (60s) are pruned. If the table remains full, untracked connections are rejected immediately with `rate_limiter_capacity_exceeded` (code 4029).
- Active connection entries are **never evicted** to accommodate new connections, preventing attackers from recycling token buckets or evading limits via rapid reconnection churn.
- Incoming socket identifiers are strictly verified: any missing, non-string, empty, or whitespace `socketId` is rejected with `invalid_socket_identity` (code 4029) without allocating rate-limiter resources.

---

## 7. Sync Server Statistics (`getSyncServerStats`)

The sync server exposes an internal diagnostic function `getSyncServerStats()` providing real-time visibility into server operational health without leaking sensitive credentials, session tokens, room slugs, or document contents:

```ts
interface SyncServerStats {
  status: "running" | "draining" | "drained" | "destroyed";
  uptimeSeconds: number;
  connections: {
    activeConnections: number;
    activeRooms: number;
    activeDocuments: number;
    pendingReservations: number;
    upgradeRejections: number;
    authenticationFailures: number;
    rateLimitTerminations: number;
  };
  capacity: {
    totalActiveRooms: number;
    totalActiveConnections: number;
    totalPendingReservations: number;
    maxConnectionsPerRoom: 6;
    roomsWithActiveConnections: number;
    rooms: Array<{
      roomId: string;
      activeConnections: number;
      pendingReservations: number;
      distinctMembers: number;
      isReadOnly: boolean;
      utilizationPct: number;
    }>;
  };
  persistence: {
    pendingUpdates: number;
    queuedUpdates: number;
    inFlightUpdates: number;
    roomsWithPendingUpdates: number;
    oldestPendingAgeMs: number;
    flushesCompleted: number;
    flushFailures: number;
    snapshotsSaved: number;
    snapshotFailures: number;
    activeSnapshotOperations: number;
  };
  rateLimiter: {
    activeTrackedConnections: number;
    maxTrackedCapacity: number;
    rejections: {
      messageRate: number;
      byteRate: number;
      capacitySaturated: number;
      invalidIdentity: number;
      total: number;
    };
  };
}
```

---

## 8. Graceful Shutdown & WebSocket Connection Drain

### 8.1 Shutdown Lifecycle & Phases
When the process receives a termination signal (`SIGTERM`, `SIGINT`) or calls `drainAndShutdown()`, the server executes a bounded 5-phase shutdown sequence:
1. **Phase A (Admission Barrier & Race Defenses)**:
   - Sets internal status to `"draining"`.
   - Rejects all subsequent HTTP `/sync` upgrades with `503 Service Unavailable` and `Retry-After: 30`.
   - **Multi-Step Handshake Guard**: Checks `isShuttingDown` at the beginning of `onAuthenticate` and rechecks after every awaited boundary (`resolvePrincipalFromCookies`, `roomRepo.findById`, `roomMemberRepo.findMember`). Handshakes paused in-flight during shutdown fail with `"Server is shutting down"`, cancelling pending slot reservations and clearing rate limiter entries immediately.
   - **Connected Hook Guard**: If an accepted handshake triggers `connected(data)` while shutting down, it immediately severs the socket with code 1001 `server_shutting_down`, cancels the slot reservation, cleans up rate limiter state, and aborts promotion to active connection.
   - **Document Loading Barrier & Reservation Cleanup**: `onLoadDocument` checks `isShuttingDown` upon entry and rechecks after `await loadDocument()`. If loading throws or shutdown commences while loading, `cleanupFailedLoad` releases the pending reservation via `syncRegistry.cancelReservation(socketId, roomId)` and cleans up limiter state if no other active connection shares that socket. Hocuspocus closes connections and destroys the document.
   - **Inbound Message & Awareness Barriers**: In `beforeHandleMessage`, late inbound messages during shutdown set `data.connection.readOnly = true`, causing Hocuspocus `MessageReceiver.apply` to reject edit frames without mutating the CRDT document or broadcasting to peers. In `beforeHandleAwareness`, incoming awareness frames during shutdown clear `data.states` and `data.removedClients`, ensuring zero additions, updates, or removals mutate server awareness or reach peers while fully preserving normal awareness behavior during normal operation.
   - Marks all active rooms read-only (`syncRegistry.setAllRoomsReadOnly()`).
2. **Phase B (Orderly WebSocket Drain)**:
   - Delivers WebSocket close code `1001` (`Going Away`) with reason `server_shutting_down` to all active connections.
   - Sockets remain tracked in `activeConnections` throughout the drain window so normal `onDisconnect` cleans them up while keeping the drain loop informed of remaining open sockets.
3. **Phase C (Hard Drain Barrier & Forced Termination)**:
   - Enforces a configurable drain timeout (default 5,000 ms).
   - Any surviving or unresponsive connections after `drainTimeoutMs` are forcefully terminated via `crossws.closeAll(1001, ..., true)` and socket termination (`ws.terminate()`).
   - Sets status to `"drained"`.
4. **Phase D (Persistence Drain & Consistent Final Snapshots)**:
   - Stops all recurring 5-minute snapshot intervals (`stopAllSnapshotIntervals()`).
   - Awaits in-flight snapshots and flushes.
   - **Multi-Room Error Isolation**: Iterates over all active loaded documents and pending room queues concurrently using `Promise.allSettled`. If Room A encounters a persistence failure, Room B is not blocked from completing its flush and snapshot.
   - Completed rooms persist final snapshots; failed rooms are recorded in an aggregate error. Shutdown refuses to mark global drain success if any unflushed updates remain in memory.
   - Active open rooms with zero pending updates still produce a consistent final snapshot.
   - Asserts that zero unflushed updates remain across healthy rooms (`stats.pendingUpdates === 0`).
5. **Phase E (Server Teardown & State Reset)**:
   - Awaits Hocuspocus `server.destroy()`.
   - Clears all registry connections and reservations.
   - Resets connection rate limiter tables.
   - Sets status to `"destroyed"`.

### 8.2 Deadlock Prevention & MongoDB Teardown
- Node.js's `http.Server.close(cb)` waits for all active TCP sockets to close before triggering its completion callback. Because upgraded WebSockets are active TCP connections, if WebSocket draining were deferred until inside `server.close()`, the HTTP server would deadlock until the hard 10s shutdown timeout.
- In `index.ts`, `setupGracefulShutdown` initiates `syncServer.drainAndShutdown()` concurrently with `server.close()`.
- MongoDB connection is disconnected strictly **after** `drainAndShutdown()` successfully flushes all pending updates, preventing write failures or unhandled rejections during server exit.

---

## 9. Operational Troubleshooting

| Symptom | Probable Cause | Remediation |
| :--- | :--- | :--- |
| **HTTP 403 on `/sync`** | Invalid or missing `Origin` header. | Verify client sends an allowed origin matching `APP_URL` or localhost in development. |
| **HTTP 429 on `/sync`** | More than 60 rejected upgrade attempts per minute from client IP. | Check for misconfigured authentication cookies causing rapid reconnection loops. |
| **WebSocket Close Code 4029** | Connection exceeded message rate limit (50 msgs/s), byte volume limit (1 MB/s), capacity saturation (`rate_limiter_capacity_exceeded`), or malformed identity (`invalid_socket_identity`). | Throttled client loop, excessive awareness updates, or large document paste. Back off transmission or investigate socket connection hygiene. |
| **`room_capacity_exceeded`** | Room already has 6 active connections or reservations. | Check for stale connections or multiple tabs from participants. |
| **`member_connection_limit_exceeded`** | Single member has 3 concurrent tabs/connections in one room. | Close duplicate browser tabs. |
| **Room locked in read-only** | Document size exceeded 2 MB soft cap or owner ended session. | Check document size or room status; inspect `doc_updates` size. |
| **Hocuspocus startup failure** | Mismatched Hocuspocus internal adapter version. | Verify `@hocuspocus/server` is locked to `4.7.1` and `crossws` is available. |

---

## 10. Operational Boundaries & System Limitations

| Boundary / Limitation | System Behavior & Invariant |
| :--- | :--- |
| **Durability Bound (2 Seconds)** | Edits accepted in memory are committed to MongoDB within 2,000 ms (`MAX_UNFLUSHED_AGE_MS`). In the event of an ungraceful hardware failure or unintercepted `SIGKILL`, at most 2.0 seconds of recent edits are exposed to loss. |
| **In-Flight Memory Bounds** | Memory growth under high write rates is strictly capped at 1,000 updates or 4 MB per room. Queue backpressure safely halts incoming client edits at the transport gate without crashing the process or corrupting historical document state. |
| **Crash Recovery Mechanics** | Document recovery relies exclusively on deterministic replay of the append-only `doc_updates` sequence log on top of the latest deterministic `doc_snapshots` base state. |
| **Single-Process Co-Hosting (`AD-1`)** | Sync is co-hosted with Express on a single Node.js process without Redis pub/sub. Horizontal scaling across multiple processes requires sticky routing to room instances or external pub/sub adapters. |

