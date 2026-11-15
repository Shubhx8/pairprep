# Architecture Note: Room Events, Chat & Outbox (T09)

## 1. Overview & Purpose
PairPrep uses two distinct real-time channels:
1. **Hocuspocus (WebSocket)**: Dedicated exclusively to Yjs CRDT synchronization for collaborative Monaco editor documents and cursor awareness.
2. **Socket.IO (WebSocket)**: Dedicated to room-level control events: chat messaging, room presence (online/offline notices), live role transitions (`ROOM-3`), and room lifecycle broadcasts (`room:ended`, `room:deleted`).

This separation keeps high-frequency collaborative typing independent from transactional room events.

---

## 2. Core Subsystems

### A. Monotonic Chat Persistence (`CH-1`, `CH-2`, `SEC-1`)
- **Strict Ordering**: Monotonic sequence numbers allocated via atomic `$inc: { messageSeq: 1 }` on `RoomModel`.
- **Deduplication**: Client-provided UUID (`clientMsgId`) enforced via partial unique index `(roomId, authorId, clientMsgId)`.
- **Sanitization**: Unicode NFC normalization, control code stripping, and bidirectional override removal.
- **Rate Limiting**: Sliding-window rate limiter enforcing 20 messages / 10s per user, with an IP-level cap of 100 messages / 10s for campus NAT networks. Rejections include `retryAfter` in integer seconds (`Math.ceil(retryAfterMs / 1000)`).
- **History & Pagination**: Cursor-based backward (`beforeSeq`) and forward (`afterSeq`) REST endpoints at `/api/v1/rooms/:slug/messages` default to 50 messages, clamped to a maximum of 200 messages per request (requests > 200 are rejected with 400 `VALIDATION_ERROR`).
- **Viewer Role Permissions**: Viewers may join and participate in room chat (`chat:send` permitted for all roles: owner, editor, viewer, interviewer, candidate). Viewers are read-only for the collaborative document only (`ED-6`), enforced authoritatively on the sync server; viewer status does not disable chat sending.

### B. Durable System Event Outbox (`CH-3`, `ROOM-3`, `ROOM-6`, `SEC-7`)
To ensure zero lost system messages and zero duplicate broadcasts during server crashes, room mutations follow a 7-step compare-and-set (CAS) state machine:
```
intent_recorded --> applied --> persisted --> published --> completed
       |
       +--> abandoned (on precondition failure or supersede)
```
- **Evidence Stamping**: Operations stamp unique `opId` tokens into target collections (`RoomModel.appliedOpIds`, `RoomMemberModel.roleOps`, `RoomModel.removedMembers`).
- **Idempotent Reconciliation**: On startup and periodic intervals, pending operations are reconciled. If domain mutation evidence exists, the reconciler advances to `persisted` and `published`; if absent, it safely marks the operation `abandoned`.
- **TTL Retention**: Operations in terminal state (`completed` or `abandoned`) are retained for 7 days via a MongoDB partial TTL index on `updatedAt`.
- **Terminal Cleanup**: When operations resolve, evidence arrays in domain documents are pruned via `$pull` to keep document sizes bounded.

### C. Room Mutation Admission Barrier (`H-1`, `H-2`)
- **Single-Process Barrier**: In-memory admission barrier (`roomMutationBarrier`) tracks active mutations and permits immediate write fencing upon room deletion (`404 ROOM_NOT_FOUND`).
- **Re-entrant Leases**: Node.js `AsyncLocalStorage` allows nested operations within the same logical lease without deadlocks or counter double-counting.
- **Fail-Safe Draining**: `drainRoomMutations` allows in-flight operations to finish with a bounded timeout; on timeout, `DrainTimeoutError` is raised while preserving the closed barrier.
- **Yjs Synchronization**: Deletion immediately invokes `abortRoomPersistence(roomId)` to cancel debounced queues, clear snapshot intervals, and abort pending document flushes under `roomMutex`.

### D. Presence & Multi-Tab Debouncing (`ROOM-5`)
- In-memory socket tracker counts active connections per participant.
- Broadcasts `presence:update` only across $0 \to 1$ (online) and $1 \to 0$ (offline) transitions.
- Connecting clients receive an authoritative `presence:snapshot` directly on `room:join`.

---

## 3. Bounded Document Growth & BSON Limits
To prevent unbounded array growth in high-turnover rooms:
1. **Pre-mutation Capacity Checks**:
   - `RoomMemberModel.roleOps`: Checked prior to updates; rejects if pending unresolved operations exceed 50.
   - `RoomModel.removedMembers`: Checked prior to removal; rejects if pending unresolved removals exceed 100.
   - `RoomModel.appliedOpIds`: Checked prior to status updates; rejects if pending unresolved operations exceed 100.
2. **Terminal Evidence Cleanup**:
   - `clearOperationEvidence` removes `opId` upon terminal resolution, keeping production documents compact (< 1 KiB, well below MongoDB's 256 KiB target and 16 MiB maximum BSON cap).

---

## 4. What We Could Delete If We Simplified (Option B Analysis)
If PairPrep simplified from Option A (Keep and Harden) to Option B (Minimal Direct Broadcast), the following components could be eliminated:

1. **Durable Operations Collection & Reconciler**:
   - Delete `durable_operations.ts`, `outboxService.ts`, and `reconciler.ts`.
   - *Trade-off*: A server crash between a database write (e.g. role change) and WebSocket emission would drop the system message. Clients would rely on reconnect polling.
2. **Room Mutation Admission Barrier**:
   - Delete `roomMutationBarrier.ts` and `AsyncLocalStorage` lease tracking.
   - Rely solely on database-level status queries (`{ status: { $ne: "deleted" } }`).
   - *Trade-off*: In-flight requests racing with room deletion could experience partial writes before encountering database errors.
3. **Embedded Evidence Arrays**:
   - Remove `roleOps`, `removedMembers`, and `appliedOpIds` from Mongoose schemas.
   - *Trade-off*: Crash recovery could not deterministically distinguish whether a crashed operation had completed its primary write.
4. **Yjs Persistence Flush Drain**:
   - Simplify `abortRoomPersistence` to an uncoordinated in-memory queue clear.
   - *Trade-off*: An in-flight debounced flush could recreate a document after deletion.

---

## 5. How to Explain This in an Interview
1. **Why two WebSocket servers instead of one?**
   "Hocuspocus speaks binary Yjs update protocols for Monaco editor synchronization. Socket.IO handles application-level JSON events with rooms, acknowledgements, and presence. Keeping them separate isolates collaborative editing latency from chat traffic."
2. **How is atomic message ordering guaranteed without Redis or distributed locks?**
   "MongoDB document-level atomic `$inc: { messageSeq: 1 }` guarantees strictly monotonic sequence numbers within a single room. The compound index `(roomId, seq)` guarantees uniqueness."
3. **How does the system prevent phantom messages after crashes?**
   "We implement an outbox pattern with deterministic evidence stamping. Before broadcasting, the system records intent. If a crash occurs, the reconciler checks domain evidence (`appliedOpIds`). If the mutation did not occur, the intent is abandoned; no phantom message is ever broadcast."
4. **How are memory leaks prevented with embedded arrays?**
   "We use a two-tier strategy: pre-mutation capacity gating rejects operations if pending arrays exceed safe limits, and terminal resolution cleans up evidence via `$pull`. A 1,000-operation benchmark confirms room documents remain under 1 KiB."

