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
}
```
Unlike systems that merge updates per-author or debounce across clients, updates are stored in strict arrival order to maintain exact replay fidelity and timestamp precision.

### 2.2 Durability Deadline (2 Seconds)
- **Debounce**: Writes are scheduled with a 250 ms debounce (`FLUSH_DEBOUNCE_MS`).
- **Hard Durability Bound**: The time between the first unflushed edit and database insertion never exceeds 2,000 ms (`MAX_UNFLUSHED_AGE_MS`).
- **Requeue with Age Preservation**: If a MongoDB write fails, `requeueUpdates` prepends the failed batch back into the room queue while preserving the original `firstUnflushedAt` timestamp. The timer fires for the remaining durability window rather than restarting the full 2 seconds.

### 2.3 Per-Room Promise Mutex (`RoomMutex`)
To guarantee gapless sequence numbering and eliminate concurrent flush races, all database operations (`flushRoom`, `saveSnapshot`, `loadDocument`) execute under a FIFO promise mutex keyed by `roomId`.

---

## 3. Snapshots, Recovery & Memory Management

### 3.1 Snapshots
- **Frequency**: Every 5 minutes of active editing (`SNAPSHOT_INTERVAL_MS = 300,000`) and when the last client disconnects (`clientsCount === 0`).
- **Watermark Consistency**: A snapshot records the exact sequence watermark `seq` corresponding to the state vector of the flushed document.
- **Pruning**: Only the latest 3 snapshots are retained per room (`MAX_SNAPSHOTS_TO_KEEP = 3`).

### 3.2 Document Loading & Crash Recovery
- When a document is opened (`onLoadDocument`):
  1. The server loads the latest snapshot from `doc_snapshots`.
  2. If a snapshot exists, its binary state is applied to the Yjs document (`Y.applyUpdate(targetDoc, snapshot.state)`).
  3. All incremental updates with `seq > snapshot.seq` are loaded from `doc_updates` and applied in order.
- **SIGKILL Crash Recovery**: In automated tests, an abrupt child process crash (`SIGKILL`) loses at most the last 2.0 seconds of edits, with complete document convergence upon restart.

### 3.3 Memory Unload on Inactivity
When all participants disconnect from a room (`clientsCount === 0`):
1. Pending updates are flushed to MongoDB.
2. A final snapshot is generated.
3. The 5-minute recurring snapshot timer is cleared.
4. The document is evicted from Hocuspocus memory (`hocuspocusInstance.unloadDocument(doc)`).

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
   - Flushes all pending room queues to MongoDB under room mutexes.
   - Writes consistent final document snapshots to `doc_snapshots`.
   - Asserts that zero unflushed updates remain (`stats.pendingUpdates === 0`).
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

