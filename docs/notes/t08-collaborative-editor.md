# Task T08: Collaborative Code Editor (Phases 1, 2, 2.1, 2.2, 2.2.2, 2.2.3, 2.2.4, 2.2.5 & Phase 3)

> **Task**: T08 — Collaborative Code Editor
>
> **Status**: Implemented & Hardened; Production Acceptance Qualified (ED-1, ED-2, ED-3, ED-5, ED-6, ROOM-4, ROOM-5, CONC-1, AD-1 DONE; ED-4 Exceeds 200 ms P95 Threshold in Production WAN at 219.89 ms; PER-1 Retained as Partial Technical Debt)
>
> **PRD Requirements Addressed**: `ED-1`, `ED-2`, `ED-3`, `ED-4`, `ED-5`, `ED-6`, `ED-7`, `ROOM-4`, `ROOM-5`, `CONC-1`, `CONC-2`, `AD-1`, `PER-1`
>
> **Primary Components Built & Hardened**:
>
> - **Dependency & Worker Architecture**: Monaco Editor (`monaco-editor@0.52.2`), Yjs (`yjs@13.6.33`), `y-monaco@0.1.6`, Hocuspocus Provider (`@hocuspocus/provider@4.7.1`), Vite Web Worker bundler (`editor.worker.js`)
> - **Client Synchronization Hook**: `useRoomSync.ts` (`apps/web/src/hooks/useRoomSync.ts`) with browser `online`/`offline` lifecycle, explicit WebSocket provider connect/disconnect, and late callback race guards
> - **Monaco Editor Integration**: `CodeEditor.tsx` (`apps/web/src/components/CodeEditor.tsx`)
> - **Monaco Yjs Binding & Remote Cursors**: `useMonacoBinding.ts` (`apps/web/src/hooks/useMonacoBinding.ts`)
> - **Status Indicator (ED-5)**: `SyncStatusIndicator.tsx` (`apps/web/src/components/SyncStatusIndicator.tsx`)
> - **Collaborative Editor Shell**: `CollaborativeEditor.tsx` (`apps/web/src/components/CollaborativeEditor.tsx`)
> - **Room Page & Presence Shell**: `RoomPage.tsx` (`apps/web/src/pages/RoomPage.tsx`) with multi-tab deduplication, local vs. remote presence distinction (`Offline` vs `Unavailable`), and reconnect-triggered room refresh
> - **Utility & Validation Layer**: `syncUrl.ts`, `roomId.ts`, `syncErrors.ts` (`apps/web/src/lib/`)
> - **Hocuspocus Server Protocol & Security Layer**: `hocuspocus.ts` (`apps/server/src/sync/hocuspocus.ts`) with `beforeHandleMessage` read-only mutation dropping and minimal `onStateless` ping/pong relay
> - **ED-2 Provider-Level 100-Trial Convergence Test Suite**: `apps/server/src/__tests__/sync/ed2Convergence.test.ts` (100 trials, Mulberry32 PRNG, dual Hocuspocus providers over WebSockets, deterministic same-line concurrent typing, zero divergence, zero character loss)
> - **Stateless Relay Protocol & Security Test Suite**: `apps/server/src/__tests__/sync/statelessRelay.test.ts` (20 unit tests verifying schema, payload cap, nonce validation, rate limiting, and unicast delivery)
> - **Real-Stack E2E & Monaco Sync Test Suite**: Real Two-Client Collaborative Monaco Test (`test/e2e/support/__tests__/monacoSync.test.ts`), Real Browser Monaco Collaboration Spec (`test/e2e/editor-collaboration.spec.ts`), Native Browser-to-Vite WebSocket Proxy Spec (`test/e2e/sync-proxy.spec.ts`), Real Two-Client Collaborative Smoke Test (`test/e2e/support/__tests__/syncSmoke.test.ts`), Session Cookie Injection Harness (`test/e2e/support/sessionHarness.ts`)
> - **Dedicated Single-Clock ED-3 & ED-4 Latency Benchmark**: `test/e2e/ed3-ed4-latency.spec.ts` (Playwright benchmark sampling 200 text updates and 200 remote cursor updates across dual browser contexts with a single monotonic clock: ED-4 Text P95 = 25.72 ms, ED-3 Cursor P95 = 23.27 ms, both strictly under the 200 ms threshold)
> - **Remote Target Test Runner Configuration**: `playwright.config.ts` (`isRemoteTarget` conditional `webServer: undefined` suppressing local server processes and local port binding when `PAIRPREP_BASE_URL` is set)

---

## 1. Overview & Requirements Fulfillment

Task T08 implements the client-side collaborative code editor for PairPrep. It connects the React frontend (`@pairprep/web`) to the Hocuspocus Yjs synchronization backend built in Task T07 at `/sync`.

### Requirement Mappings (PRD Compliance Matrix)

| Requirement ID | PRD Specification | Implementation Detail in T08 | Status & Verification Qualification |
| :------------- | :---------------- | :--------------------------- | :---------------------------------- |
| **`ED-1`**     | **Monaco editor with syntax highlighting**: Python, C++ and JavaScript highlight correctly; language selectable per room. | `CodeEditor.tsx` built with `monaco-editor@0.52.2`, web worker lazy setup via `setupMonacoWorkers()`, custom `pairprep-dark` theme, ResizeObserver layout, and syntax highlighting for Python, C++, and JavaScript. Supported languages strictly validated with `isValidEditorLanguage` and synchronized across participants via `doc.getMap("roomConfig")`. Route-level lazy loading ensures Monaco is never loaded on `/dashboard`. | **DONE** — Verified in `CodeEditor.test.tsx`, `CollaborativeEditor.test.tsx`, and Playwright E2E `editor-collaboration.spec.ts`. |
| **`ED-2`**     | **Conflict-free live editing**: Two users typing in the same line concurrently end with identical text on both screens, with neither user's characters lost, in 100 out of 100 automated trials. | `useMonacoBinding.ts` binds Monaco model to canonical `doc.getText("code")` via `y-monaco`. Tested with two real Hocuspocus providers connected over WebSockets to sync server in `ed2Convergence.test.ts` across 100 trials of concurrent same-line edits with deterministic pseudo-random interleaving. | **DONE** — Evidence: 100 automated trials, 100 converged, 0 divergent, 0 missing insertions in `ed2Convergence.test.ts`. |
| **`ED-3`**     | **Live cursors and selections**: Each remote user's cursor and selection show in a distinct color with a name label, updating in under 200 ms at the 95th percentile. | `useMonacoBinding` propagates local selection and cursor to Yjs awareness with user name and safe color from `PARTICIPANT_PALETTE`. Injects scoped dynamic CSS with character sanitization (`escapeCssContent`) for remote cursors, selections, and name badges. Dedicated Playwright benchmark `test/e2e/ed3-ed4-latency.spec.ts` evaluated 200 live cursor propagation iterations across dual browser contexts: **P50 = 12.35 ms, P95 = 23.27 ms** (well below the 200 ms limit). | **DONE** — Evidence: 200 automated end-to-end iterations in `test/e2e/ed3-ed4-latency.spec.ts`. P95 = 23.27 ms (< 200 ms target). |
| **`ED-4`**     | **Sync latency**: Remote edit visible in under 200 ms at the 95th percentile on a normal broadband connection. | Minimal, strictly validated stateless `latency_ping`/`pong` handler retained (256-byte cap, exactly three keys, nonce <= 128, per-connection dual token-bucket rate limiting via `socketId`, unicast pong, read-only connections allowed). Local development benchmark (`test/e2e/ed3-ed4-latency.spec.ts`) recorded 200 remote text update samples: **P50 = 16.79 ms, P95 = 25.72 ms** (< 200 ms). However, live production benchmark across international WAN (India client to Azure East Asia VM) measured **P50 = 203.22 ms, P95 = 219.89 ms**, exceeding the 200 ms PRD threshold. | **QUALIFIED / EXCEEDS THRESHOLD (Production WAN)** — Localhost baseline passes (< 26 ms P95), but live cross-region production P95 is 219.89 ms (> 200 ms target). Full acceptance requires geographically co-located testing or an approved acceptance exception. |
| **`ED-5`**     | **Offline tolerance**: Disconnected edits stay in the local editor and merge on reconnect without data loss; a banner shows connection state. | Local edits continue in-memory while offline and merge deterministically upon reconnection via CRDT state vectors. Verified in Playwright E2E with browser context offline mode (`context.setOffline(true)`) and unit suites. Responsive status indicator reflects `Connecting`, `Synced`, `Syncing`, `Offline`, and `Error` states. `useRoomSync` handles browser `online`/`offline` events, explicitly manages underlying WebSocket provider sockets, and blocks late callback races. | **DONE** — Operates in-memory for the duration of the active browser tab session; does not persist across page reloads without IndexedDB persistent storage. |
| **`ED-6`**     | **Read-only for viewers**: Viewers cannot modify the document; attempts are rejected by the server, not just the UI. | `RoomPage.tsx` and `CollaborativeEditor.tsx` enforce read-only UI for viewers and ended rooms (`editor.updateOptions({ readOnly: true })`), backed by server-side authorization in Hocuspocus `beforeHandleMessage` dropping update frames on `connection.readOnly` sockets. Verified in Playwright E2E by executing direct programmatic Yjs mutations over WebSocket and confirming server rejection and owner immunity. | **DONE** — Verified at both UI and server protocol layers with genuine forced-edit WebSocket tests. |
| **`ROOM-4`**   | **Participant limit**: A room holds at most 6 participants; the 7th sees a _Room full_ message. | Strict capacity limits enforced at HTTP room admission, WebSocket connection authentication (`room_capacity_exceeded` / `room_member_limit_exceeded`), and web UI displaying friendly "Room is Full" empty state. Room ID validated with strict 24-character hexadecimal ObjectId regex. | **DONE** — Verified in server capacity unit tests and frontend error mapping tests. |
| **`ROOM-5`**   | **Participant list**: Everyone sees who is present, with name, color and role, updating live. | `RoomPage.tsx` sidebar participant list dynamically reflects room state, displaying participant names, distinct safe colors from `PARTICIPANT_PALETTE`, authoritative REST roles (`owner`, `editor`, `viewer`), `(You)` badge for local user, multi-tab presence deduplication, and distinction between `Offline` (current user disconnected) and `Unavailable` (remote members when local connectivity is lost). | **DONE** — Verified in Playwright real-browser multi-context test `editor-collaboration.spec.ts` and React unit tests `RoomPage.test.tsx`. |
| **`CONC-1`**   | Multi-client collaborative editing. | Verified across independent browser contexts and independent `HocuspocusProvider` instances with real session cookies. | **DONE** |
| **`AD-1`**     | Same-origin WebSocket proxying. | Vite dev server configured with `/sync` proxy (`ws: true`) forwarding native browser WebSocket connections to backend on port 3001. | **DONE** |
| **`PER-1`**    | Document persistence & crash recovery within 2s. | Backend persistence via Task T07 queues updates with 250ms debounce and 2,000ms scheduling deadline. Verified recovery of persisted state from MongoDB after SIGKILL. Client hook operates in-memory and does not provide offline persistence across page reloads. | **PARTIAL** — Verified state reconstruction after SIGKILL for tested edits confirmed in MongoDB; universal 2s durable commit SLA not established for arbitrary crash timings. |

---

## 2. Architecture & Design Decisions

```
+---------------------------------------------------------------------------------------------+
| Browser / Web Client (@pairprep/web)                                                        |
|                                                                                             |
|   +-------------------------------------------------------------------------------------+   |
|   | React Component Layer (RoomPage)                                                    |   |
|   |   useRoomSync({ roomId, enabled })                                                  |   |
|   |     │                                                                               |   |
|   |     ├── 1. Validates MongoDB ObjectId: /^[0-9a-fA-F]{24}$/                         |   |
|   |     ├── 2. Resolves Sync URL: ws(s)://${window.location.host}/sync                  |   |
|   |     ├── 3. Instantiates Y.Doc() (In-memory CRDT, preserved across disconnects)      |   |
|   |     ├── 4. Manages HocuspocusProvider & underlying HocuspocusProviderWebsocket      |   |
|   |     ├── 5. Explicit Attachment: activeProvider.attach() (for custom polyfill)       |   |
|   |     ├── 6. Handles window online/offline: disconnects/reconnects underlying socket  |   |
|   |     └── 7. Subscribes to status, synced, authFailed, close with late-callback guards|   |
|   +------------------------------------------+------------------------------------------+   |
|                                              │                                              |
|                                              │ Native WebSocket ws://localhost:5174/sync    |
|                                              │ (Ambient browser cookie pairprep.sid)        |
|                                              v                                              |
|   +-------------------------------------------------------------------------------------+   |
|   | Vite Development Server (Port 5174)                                                 |   |
|   |   server.proxy: { '/sync': { target: 'http://localhost:3001', ws: true } }          |   |
|   +------------------------------------------+------------------------------------------+   |
|                                              │ HTTP Upgrade to ws://127.0.0.1:3001/sync     |
|                                              v                                              |
|   +-------------------------------------------------------------------------------------+   |
|   | Node.js Backend Server (Port 3001)                                                  |   |
|   |   Hocuspocus Sync Server (T07 Backend)                                              |   |
|   |   ├── Validates Cookie: pairprep.sid / pairprep.guest                               |   |
|   |   ├── Verifies Room ID & User Membership in MongoDB                                 |   |
|   |   ├── Enforces Per-Connection Rate Limiting (ConnectionRateLimiter by socketId)     |   |
|   |   ├── Intercepts Unauthorized Mutations via beforeHandleMessage (readOnly drop)     |   |
|   |   ├── Processes Stateless Latency Diagnostics via onStateless (256B cap)            |   |
|   |   └── CRDT Synchronization & Decoupled Asynchronous Persistence (MongoDB)           |   |
|   +-------------------------------------------------------------------------------------+   |
+---------------------------------------------------------------------------------------------+
```

### 2.1 Hocuspocus Provider Version & Lifecycle Architecture (`@hocuspocus/provider@4.7.1`)

During Phase 2.1, a deep architectural audit of `@hocuspocus/provider@4.7.1` established the exact contract for custom WebSocket providers:

1. **Ownership & `manageSocket` Flag**:
   - In `HocuspocusProvider.ts` (lines 289–297), when `websocketProvider` is omitted, the provider creates its own `HocuspocusProviderWebsocket` and sets internal flag `this.manageSocket = true`.
   - When a custom `websocketProvider` is provided (e.g. for testing with custom headers, cookies, or `WebSocketPolyfill`), `this.manageSocket` remains `false`.
2. **Explicit Attachment Required**:
   - Line 264 of `HocuspocusProvider.ts` only automatically invokes `this.attach()` if `this.manageSocket` is true.
   - Therefore, supplying a custom `websocketProvider` **requires calling `activeProvider.attach()` explicitly** to register event listeners on the WebSocket and insert the provider into the WebSocket provider map.
3. **Dual Destruction & Disconnection Responsibilities**:
   - Calling `activeProvider.destroy()` or `activeProvider.disconnect()` only affects the physical WebSocket if `this.manageSocket === true` (lines 650–652).
   - When using a custom or externally managed `websocketProvider`, `activeProvider.disconnect()` merely detaches the document provider from the socket; it **does not close the underlying socket or halt reconnect timers**.
   - Therefore, to physically disconnect or destroy the socket, the caller must access the underlying WebSocket provider (`customWsProvider || activeProvider.configuration.websocketProvider`) and call `wsProvider.disconnect()` or `wsProvider.destroy()`.
   - `useRoomSync` cleanly implements this separation in its online/offline handlers, initial mount logic, effect cleanups, and error teardowns.

### 2.2 React StrictMode & Idempotent Cleanup

In React 18 and 19 development mode, effects are mounted, unmounted, and remounted synchronously. A naive WebSocket hook causes socket leaks, duplicate connections, and state updates on unmounted components.

`useRoomSync` solves this with:

- **`isCurrent` Generation Guard**: A local boolean flag set to `false` during effect cleanup. All asynchronous callbacks (`onStatus`, `onSynced`, `onAuthenticationFailed`, `onClose`, window `online`/`offline`) verify `if (!isCurrent) return;` before calling state dispatchers.
- **Idempotent Resource Teardown**: Effect cleanup systematically executes:
  ```typescript
  return () => {
    isCurrent = false;
    window.removeEventListener("online", handleOnline);
    window.removeEventListener("offline", handleOffline);
    if (activeProvider) activeProvider.destroy();
    if (customWsProvider) customWsProvider.destroy();
    activeDoc.destroy();
  };
  ```

### 2.3 E2E Test Isolation Architecture (`PAIRPREP_E2E`)

When running Playwright end-to-end tests, the test runner evaluates spec files in the main process before workers launch:

- Importing server modules (`apps/server/src/middleware/session.ts`) into test files loaded `apps/server/src/config.ts`, which executed `loadEnvFileSafely()` and polluted the test runner with root `.env` values.
- When the E2E test harness signed session cookies with the dev secret, but Playwright's `webServer` ran the server with the test secret, cookie verification failed with `401 Unauthorized`.
- Furthermore, setting `NODE_ENV="test"` in `webServer.env` caused `apps/server/src/index.ts` to skip `bootstrapServer()` and exit prematurely.

**Solution implemented in Phase 2.1**:

1. Added guard `if (process.env["NODE_ENV"] !== "test" && !process.env["PAIRPREP_E2E"])` to `apps/server/src/config.ts`.
2. Playwright exports `process.env["PAIRPREP_E2E"] = "1"`, ensuring `.env` is never parsed during E2E runs.
3. Aligned `E2E_MONGODB_URI` and `E2E_SESSION_SECRET` uniformly across both the Playwright runner and the `webServer[0].env` child process.
4. Isolated `test/e2e/sync-proxy.spec.ts` from backend imports, sourcing `SESSION_COOKIE_NAME` exclusively from `./support/sessionHarness.js`.

### 2.4 Single-Clock Dual-Context Latency Measurement Architecture (ED-3 & ED-4)

Attempting to measure sub-100 ms cross-client latency by timestamping an edit with `Date.now()` on Client A and subtracting it from `Date.now()` on Client B is scientifically invalid due to NTP clock skew (which commonly ranges from 5 ms to over 100 ms between systems).

To provide true measurement integrity:
1. **Single Monotonic Clock**: `test/e2e/ed3-ed4-latency.spec.ts` runs inside a single Node.js test process controlling two real browser contexts (`hostContext` and `guestContext`). The test uses `performance.now()` in the test process to capture elapsed propagation time directly.
2. **ED-4 Text Propagation Measurement**: Context A types a unique character. Context B's Monaco model text is polled via `waitForFunction` until the character appears, recording the monotonic delta.
3. **ED-3 Remote Cursor Propagation Measurement**: Host edit advances the cursor position. Context B's Monaco editor model decorations and awareness are polled via `waitForFunction` until Host's remote cursor reflects the advancing column position, recording the monotonic delta.
4. **Remote Target Mode (`isRemoteTarget`)**: In `playwright.config.ts`, when `PAIRPREP_BASE_URL` is set, `webServer` is set to `undefined`. This suppresses local Express and Vite processes, allowing tests to run directly against an already running server or remote deployment.

### 2.5 Stateless Diagnostic Relay & Per-Connection Rate Limiting (ED-4)

To support low-overhead transport latency diagnostics without polluting the CRDT document history:
1. **Protocol Design**: Clients emit stateless message `{"type":"latency_ping","nonce":"...","sentAt":123456789}`. The server responds with `{"type":"latency_pong","nonce":"...","sentAt":123456789,"serverTime":...}`.
2. **Strict Schema & Payload Cap**: Payload is capped at 256 bytes UTF-8 length. Must be valid JSON containing exactly three keys (`type`, `nonce`, `sentAt`). Nonce must be a non-empty string `<= 128` characters. `sentAt` must be a finite number.
3. **Unicast Delivery**: Sent exclusively to the originating socket via `connection.sendStateless(...)`. Broadcast is explicitly forbidden to prevent reflection amplification.
4. **Per-Connection Dual Token-Bucket Rate Limiting**: The server enforces `rateLimiter.consume(socketId, rateCost)` inside `onStateless`, where `socketId` is the connection identifier. It consumes message tokens and byte tokens (`rateCost = Math.max(1, byteLength)`), defending against socket-level message floods.
5. **Read-Only Permission**: Read-only connections (`connection.readOnly === true`) are permitted to execute latency pings since diagnostics do not mutate document state.

### 2.6 Scoped Dynamic CSS & Sanitization Architecture (ED-3)

`y-monaco` displays remote user names above cursors by injecting dynamic CSS pseudo-elements:
```css
.yRemoteSelectionHead-${clientId}::after {
  content: "${participantName}";
  background-color: ${participantColor};
}
```
If a malicious user registers with a name like `Test\A\22; } body { display:none; }`, raw string interpolation causes CSS injection and stylesheet poisoning.
- **Defense**: `useMonacoBinding.ts` implements `escapeCssContent()`, replacing control characters, newlines, quotes, and backslashes with escaped Unicode CSS hex sequences before stylesheet generation.
- **DOM Cleanup**: Dynamic stylesheets carry `data-pairprep-awareness="true"` and are cleanly removed from the DOM on unmount.

---

## 3. Editor Connectivity Indicator Architecture (ED-5)

The collaborative editor features a prominent, accessible, color-coded status badge (`SyncStatusIndicator.tsx`) mounted directly in the editor header. It translates low-level transport and protocol states into user-facing status indicators.

### 3.1 Dual Taxonomy: Hook Lifecycle Statuses vs. UI Badge Presentations

To eliminate architectural confusion between internal state and user presentation, PairPrep maintains a strict dual taxonomy:

1. **Hook Lifecycle Statuses (`RoomSyncStatus` in `useRoomSync.ts`)**: Represents the six core transport and protocol lifecycle states emitted by the React hook:
   - `"connecting"`: Transport connection in flight.
   - `"connected"`: WebSocket transport active and authenticated.
   - `"reconnecting"`: Connection lost after having connected; backoff retry active.
   - `"offline"`: Local operating system or browser network interface is down (`!navigator.onLine`).
   - `"disconnected"`: Inactive or unmounted room session; or socket closed prior to initial connection.
   - `"error"`: Fatal protocol, authentication, authorization, or room lifecycle failure.

2. **UI Badge Presentations (`SyncStatusIndicator.tsx`)**: The presentation component evaluates both the hook's `status` and the boolean `isSynced` flag. Because the `"connected"` state branches on `isSynced`, the component renders **seven distinct user-facing badge states**:
   - **Connecting** (`status === "connecting"`): Amber pulsing badge.
   - **Syncing** (`status === "connected" && !isSynced`): Primary blue pulsing badge.
   - **Synced** (`status === "connected" && isSynced`): Green solid badge.
   - **Reconnecting** (`status === "reconnecting"`): Amber pulsing badge.
   - **Offline** (`status === "offline"`): Amber warning solid badge.
   - **Sync Error** (`status === "error"`): Rose red solid badge.
   - **Disconnected** (`status === "disconnected"` / default fallback): Slate neutral solid badge.

#### Role of the "Disconnected" State
- **Independent Lifecycle State**: In `useRoomSync.ts`, `"disconnected"` is explicitly assigned when `!enabled || !roomId` (hook disabled or unmounted), or when the underlying WebSocket drops before an initial connection has ever succeeded (`!hasConnectedOnce`).
- **Visual Fallback State**: In `SyncStatusIndicator.tsx`, `case "disconnected":` and `default:` are handled together, ensuring any undefined, corrupted, or unmounted state safely defaults to the subtle gray `Disconnected` badge without throwing a runtime error.
- **Non-Terminal Nature**: Unlike fatal `"error"` states, `"disconnected"` is **never terminal**. Passing `enabled = true` with a valid `roomId` immediately initiates connection (`"disconnected" -> "connecting"`).

### 3.2 State Machine & Transition Diagram

```
                           ┌────────────────────────┐
                           │      Disconnected      │
                           └───────────┬────────────┘
                                       │ roomId & enabled provided
                                       v
        ┌──────────────────>┌────────────────────────┐
        │                   │       Connecting       │<────────────────────────┐
        │                   └───────────┬────────────┘                         │
        │                               │ wsStatus: Connected                  │
        │                               v                                      │
        │                   ┌────────────────────────┐                         │
        │                   │   Syncing (Connected)  │                         │
        │                   └───────────┬────────────┘                         │
        │                               │ isSynced: true                       │
        │                               v                                      │
        │                   ┌────────────────────────┐                         │
        │                   │         Synced         │                         │
        │                   └─────┬───────────┬──────┘                         │
        │                         │           │                                │
        │     navigator.offline   │           │ WebSocket disconnect           │
        │     event triggered     │           │ (server drop / transient blip) │
        │                         v           v                                │
        │                   ┌───────────┐┌───────────┐                         │
        │                   │  Offline  ││Reconnecting                         │
        │                   └─────┬─────┘└─────┬─────┘                         │
        │                         │            │                               │
        │        navigator.online │            │ reconnect attempt succeeds    │
        └─────────────────────────┴────────────┴───────────────────────────────┘
```

### 3.3 State Matrix (Complete 7-State Presentation Inventory)

| UI State | Hook & Sync Condition | Visual Appearance & UI Text | Editing Allowed? | Local Changes Preserved? | Remote Collaboration? | Possible Next States | Recovery Mechanism |
| :--- | :--- | :--- | :---: | :---: | :---: | :---: | :--- |
| **Connecting** | `status === "connecting"` | Amber dot with pulsing animation (`animate-pulse`); label: **"Connecting..."**; tooltip: _"Establishing connection to collaboration server."_ | Yes (in-memory) | Yes | No (queued locally) | `connected` (Syncing/Synced), `offline`, `error`, `disconnected` | Transitions automatically upon WebSocket handshake completion. |
| **Syncing** | `status === "connected"` AND `isSynced === false` | Blue dot (`bg-primary`) with pulse; label: **"Syncing..."**; tooltip: _"Exchanging document updates with server."_ | Yes | Yes | In progress | `Synced`, `reconnecting`, `offline`, `error` | Resolves to `Synced` once `onSynced({ state: true })` fires. |
| **Synced** | `status === "connected"` AND `isSynced === true` | Solid green dot (`bg-success`); label: **"Synced"**; tooltip: _"All changes synchronized with server."_ | Yes | Yes (persisted to server memory & scheduled for MongoDB) | Yes (full real-time bidirectional sync) | `connecting` (local edit pending sync), `reconnecting`, `offline`, `error` | Steady operating state. Local keystrokes briefly trigger ephemeral sync exchanges. |
| **Reconnecting** | `status === "reconnecting"` (WebSocket dropped after initial connection) | Amber dot with pulsing animation (`animate-pulse`); label: **"Reconnecting..."**; tooltip: _"Connection lost. Reconnecting to collaboration server."_ | Yes (in-memory edits applied to local `Y.Doc`) | Yes | No (buffered in CRDT memory) | `connected` (Syncing/Synced), `offline`, `error` | Hocuspocus provider exponential backoff retry loop or immediate reconnection upon `window.online`. |
| **Offline** | `status === "offline"` (`window.offline` event or initial mount with `!navigator.onLine`) | Solid amber dot (`bg-warning`, no pulse); label: **"Offline"**; tooltip: _"Network unavailable. Local edits preserved in memory."_ | Yes | Yes (in active `Y.Doc` memory) | No (buffered locally) | `connecting` / `reconnecting` (on `online` event) | Restoring network triggers browser `online` event -> explicitly invokes `wsProvider.connect()`. |
| **Sync Error** | `status === "error"` (fatal close code `4001`, `4003`, `4004`, `4029`, `1009`, or invalid 24-hex ObjectId) | Solid red dot (`bg-destructive`); label: **"Sync Error"**; tooltip: descriptive error message; sr-only screen reader alert. | Dependent on error (read-only for 4004/ended) | No server sync possible | No | None (terminal until user action or reload) | Explicit user navigation, re-authentication, or full room re-entry. |
| **Disconnected** | `status === "disconnected"` (room unmounted, `enabled === false`, or clean user exit) | Slate dot (`bg-text-subtle`); label: **"Disconnected"**; tooltip: _"Disconnected from room session."_ | No | N/A | No | `Connecting` | Re-enabling room sync or navigating into an active room (`enabled = true`). |

### 3.4 Transport Connectivity vs. Document Synchronization

A critical architectural distinction in collaborative systems:
- **Transport Connectivity (`status === "connected"`)**: Signifies only that the physical TCP/WebSocket connection has completed the HTTP 101 Switching Protocols upgrade and authentication handshake with Hocuspocus. At this point, the socket is open, but **no document data has been reconciled**.
- **Document Synchronization (`isSynced === true`)**: Signifies that the client and server have exchanged Yjs state vectors (`Y.encodeStateVector`), computed missing updates, applied binary diffs (`Y.applyUpdate`), and confirmed that the local CRDT state is in lockstep with the server's authoritative state.
- **Why this distinction matters**: Treating a connected socket as "synced" can cause users to assume their code has been saved or received by peers when it is still in flight. PairPrep guarantees that the badge only displays **Synced** when `isSynced` is strictly true.

---

## 4. Browser Offline/Online Lifecycle (`useRoomSync.ts`)

PairPrep's client synchronization hook (`apps/web/src/hooks/useRoomSync.ts`) implements a resilient offline/online lifecycle that protects the user's editing experience and preserves uncommitted local edits.

### 4.1 Navigator Detection & Mount Behavior
- When the hook initializes, it inspects `navigator.onLine` (with safe fallback for SSR/test environments: `typeof navigator !== "undefined" && !navigator.onLine`).
- If the browser is offline at mount time:
  - Initial state is set directly to `status = "offline"` and `isSynced = false`.
  - The `Y.Doc` is created immediately so the editor can mount and accept local typing.
  - The underlying WebSocket provider's connection is explicitly disconnected immediately (`wsProvider.disconnect()`), preventing pointless connection retries and console flood.

### 4.2 Browser `online` and `offline` Events
- Event listeners are attached to `window.addEventListener("online", handleOnline)` and `window.addEventListener("offline", handleOffline)`.
- **On Offline**:
  1. Sets internal flag `browserOffline = true`.
  2. Immediately sets React state `setIsSynced(false)` and `setStatus("offline")`.
  3. Locates the active WebSocket provider instance (`customWsProvider || activeProvider?.configuration?.websocketProvider`).
  4. Calls `wsProvider.disconnect()` to close the physical socket.
- **On Online**:
  1. Clears internal flag `browserOffline = false`.
  2. Sets React state `setIsSynced(false)` and `setStatus(hasConnectedOnce ? "reconnecting" : "connecting")`.
  3. Calls `wsProvider.connect()` on the underlying provider to re-establish the connection.

### 4.3 Underlying WebSocket Provider Disconnect & Connect
- **The Wrapper Provider Trap**: Calling `activeProvider.disconnect()` on `HocuspocusProvider` does **not** physically disconnect the socket if the socket is externally managed or if `manageSocket === false`. The wrapper merely detaches the document; the underlying `HocuspocusProviderWebsocket` keeps polling and attempting reconnections in the background.
- **The Correct Implementation**: `useRoomSync` directly accesses `wsProvider = customWsProvider || activeProvider?.configuration?.websocketProvider` and invokes `wsProvider.disconnect()` / `wsProvider.connect()`. This halts socket polling and cleanly suspends network activity while offline.

### 4.4 Race Condition & Stale Callback Defense

Asynchronous network events frequently arrive out of order during connectivity shifts. `useRoomSync` enforces strict race guards:
1. **Late `onStatus({ status: Connected })` Race**:
   - If the WebSocket completed a connection handshake right as the operating system detected network loss, a late `Connected` callback could override the user's `offline` badge.
   - Guard: `if (browserOffline) { setStatus("offline"); setIsSynced(false); wsProvider.disconnect(); return; }`.
2. **Late `onSynced({ state: true })` Race**:
   - A pending sync callback must never declare the editor "Synced" if the browser has since gone offline.
   - Guard: `if (!isCurrent || browserOffline) return;`.
3. **Late `onAuthenticationFailed` Race**:
   - Dropping offline can cause socket dropouts that some libraries misclassify as auth timeouts.
   - Guard: `if (!isCurrent || browserOffline) return;` prevents an auth failure error screen from replacing the valid offline state.
4. **Late `onClose` Race**:
   - Socket close events triggered by the browser going offline must not be classified as server errors.
   - Guard: `if (!isCurrent || browserOffline) return;`.

---

## 5. Local Editing & Yjs Document In-Memory Preservation

### 5.1 Uninterrupted In-Memory Local Editing
When the browser goes offline, Monaco Editor remains completely responsive. Keystrokes are intercepted by `useMonacoBinding.ts` and transacted into `doc.getText("code")`. Yjs generates local Item structs with monotonic clocks tied to the client's unique client ID.

### 5.2 Preservation of the Same `Y.Doc` Instance
- **Crucial Architectural Rule**: The hook **never destroys or recreates the `Y.Doc`** during offline/online transitions or WebSocket reconnections.
- Recreating the `Y.Doc` would destroy all in-memory keystrokes typed while offline.
- Instead, the `activeDoc` remains bound to Monaco across all connection states. It buffers the exact sequence of local offline operations.

### 5.3 Reconnection, State Vector Diffing & Eventual Convergence
1. When connectivity returns and the WebSocket reconnects, Hocuspocus executes the two-step state-vector handshake.
2. The client transmits `Y.encodeStateVector(activeDoc)`.
3. The server computes the delta of operations that occurred remotely while the client was away (`Y.encodeStateAsUpdate(serverDoc, clientVector)`) and transmits them to the client.
4. Concurrently, the client transmits its accumulated offline update chunk to the server.
5. Both sides apply the binary updates via `Y.applyUpdate()`.
6. Yjs's YATA algorithm deterministically orders concurrent operations, guaranteeing **Strong Eventual Consistency (SEC)** with zero character loss.

### 5.4 In-Memory Scope vs. Durable Disk Persistence
> [!IMPORTANT]
> PairPrep's client-side offline tolerance operates **in-memory for the duration of the active browser tab session**.
> - If the user stays on the page while offline and reconnects, 100% of their edits merge seamlessly.
> - However, client-side edits are **not** persisted to browser IndexedDB. A hard page reload (`F5`) or browser process crash while offline will lose unsynchronized local edits. Durable persistence occurs exclusively on the backend via MongoDB update queues once edits reach the server.

### 5.5 Conceptual Distinctions: Network Drop vs Server Outage vs Socket Drop vs Sync Pending

| Scenario | Browser Network (`navigator.onLine`) | WebSocket State | Server State | UI Badge | Document Behavior |
| :--- | :---: | :---: | :---: | :---: | :--- |
| **Browser Network Drop** | `false` | Disconnected | Unknown / Running | **Offline** | Local edits buffered in memory; socket explicitly halted. |
| **Collaboration Server Outage** | `true` | Reconnecting | Down / Unreachable | **Reconnecting...** | Local edits buffered; exponential backoff retries. |
| **Transient Socket Drop** | `true` | Reconnecting | Running | **Reconnecting...** | Instant retry; state vectors reconcile on reconnect. |
| **Sync Pending** | `true` | Connected | Running | **Syncing...** | Sockets exchanging state vector diffs before entering Synced. |

---

## 6. Participant Presence & Online Indicators (`RoomPage.tsx`)

### 6.1 Membership vs. Live Presence Architecture
PairPrep enforces a clean separation between **Durable Room Membership** and **Ephemeral Live Presence**:
- **Room Membership**: Stored in MongoDB (`room_members` collection). Represents the authoritative list of enrolled participants (up to 6 members). Disconnecting from the network or closing a tab **never removes room membership**.
- **Live Presence**: Derived in real time from active Hocuspocus WebSocket connections and Yjs awareness states. Ephemeral, non-durable, and garbage-collected on disconnect.

### 6.2 Distinct Member Counting (Multi-Tab & Multi-Connection Deduping)
- **The Multi-Tab Rule**: Online member count represents **unique authenticated user IDs**, not raw WebSocket connections or browser tabs.
- If a candidate opens the room in 3 separate browser tabs, they hold 3 WebSocket connections to the server, but the UI displays **1 online member**.
- Closing 2 tabs leaves the member **Online** (since 1 tab remains connected).
- Closing all 3 tabs transitions the member to **Offline**.
- Offline members continue to count toward the total room member limit (e.g. `2 online · 6 members`).

### 6.3 Local Participant (`Offline`) vs. Remote Participants (`Unavailable`)
When the local user's browser loses network connectivity:
1. **Local Participant**: Marked as **`Offline`** with a gray indicator dot. The local user knows with certainty that their own browser is disconnected.
2. **Remote Participants**: Marked as **`Unavailable`** (not "Offline").
   - **Why?** Because the local browser has lost network access, it cannot contact the server or receive awareness heartbeats. It has zero visibility into whether remote candidates are still typing or have left.
   - Claiming remote users are "Offline" would be false telemetry. Labeling them **`Unavailable`** accurately conveys that presence information is temporarily unreachable.
3. **Total Online Count**: Drops to **0 online** when the local client is disconnected (`isLocalConnected === false`), while preserving total membership count: `0 online · 6 members`.

### 6.4 UI Badges, A11y Attributes, and Visual Indicators
- In `RoomPage.tsx`:
  ```tsx
  const statusLabel = isLocalConnected
    ? isMemberOnline
      ? "Online"
      : "Offline"
    : isCurrent
      ? "Offline"
      : "Unavailable";
  ```
- Visual styling:
  - **Online**: Green dot (`bg-success`), text: `Online`, `aria-label="Online"`.
  - **Offline**: Gray dot (`bg-text-subtle/40`), text: `Offline`, `aria-label="Offline"`.
  - **Unavailable**: Subdued text: `Unavailable`, neutral pill styling.
  - Count display: `<span className="text-success font-medium">{onlineCount} online</span> · <span>{totalMembersCount} members</span>`.

### 6.5 Awareness Cleanup & Cursor Eviction on Disconnect
When a participant disconnects cleanly or times out (after ~30 seconds of missing awareness heartbeats):
- The server evicts their awareness state.
- Remote peers receive the updated awareness map.
- `useMonacoBinding.ts` removes the participant's remote cursor widget decoration and name badge (`.yRemoteSelectionHead-${clientId}`) from Monaco's DOM.
- The dynamic CSS rule for that `clientId` is pruned from the stylesheet.

---

## 7. Reconnection Lifecycle & Room Refresh

### 7.1 Reconnect State Progression
1. Operating system restores network -> browser fires `online` event.
2. `useRoomSync` transitions to `status = "reconnecting"` and invokes `wsProvider.connect()`.
3. WebSocket handshake succeeds (HTTP 101) -> Hocuspocus emits `onStatus({ status: "connected" })`.
4. `useRoomSync` transitions to `status = "connected"` (`isSynced = false`).
5. Hocuspocus exchanges state vectors, applies updates, and emits `onSynced({ state: true })`.
6. Status badge switches to **Synced**.

### 7.2 Post-Reconnect Metadata & Presence Refresh
While the client was offline, room events may have occurred outside the code editor:
- New participants may have joined or left.
- Participant roles may have been promoted/demoted (e.g. viewer promoted to editor).
- The room title, language, or status (e.g. room ended) may have changed.

To synchronize this REST metadata:
- `RoomPage.tsx` monitors the transition into `connected`:
  ```typescript
  const prevSyncStatusRef = useRef(sync.status);
  useEffect(() => {
    if (prevSyncStatusRef.current !== "connected" && sync.status === "connected") {
      void refreshRoom().catch(() => {});
    }
    prevSyncStatusRef.current = sync.status;
  }, [sync.status, refreshRoom]);
  ```

### 7.3 Edge-Triggered Refreshes & Deduping via `prevSyncStatusRef`
- **Deduping**: Status callbacks can pulse repeatedly during steady operation. Checking `prevSyncStatusRef.current !== "connected" && sync.status === "connected"` guarantees that `refreshRoom()` executes **strictly once per reconnect edge**.
- **Silent Refresh**: `refreshRoom()` executes in the background without triggering loading skeletons or unmounting the Monaco editor.
- **Resilience**: If the background refresh fails (e.g. temporary REST API blip), the editor continues operating uninterrupted via the live WebSocket CRDT channel.

---

## 8. Failure Scenarios & Edge Cases Matrix

| Failure Scenario | Immediate System Reaction | User Experience in UI | Recovery & Final State |
| :--- | :--- | :--- | :--- |
| **1. Browser starts offline** | `navigator.onLine` detects offline at mount. `wsProvider.disconnect()` halts connection attempts. | Status badge displays solid amber **Offline**. Monaco editor mounts with empty or default code. Local typing permitted. | Browser comes online -> `online` event connects socket -> state vectors sync -> badge becomes **Synced**. |
| **2. Browser drops offline during active typing** | `offline` event fires. Hook sets `isSynced = false`, status to **Offline**, and disconnects WebSocket. | Badge displays **Offline**. Monaco editor remains editable. Keystrokes accumulate in local `Y.Doc`. Participant list marks current user **Offline**, others **Unavailable**. | On `online` event -> provider reconnects -> sends offline edits -> merges remote edits -> badge becomes **Synced**. |
| **3. Browser comes back online** | `online` event fires. Hook sets status to **Reconnecting...**, calls `wsProvider.connect()`. | Badge pulses amber **Reconnecting...** -> briefly blue **Syncing...** -> solid green **Synced**. | Edge-trigger refetches room metadata via `refreshRoom()`. Participant list and online counts restore accurately. |
| **4. WebSocket closes unexpectedly** | Transport closes without browser offline event (e.g. transient proxy reset). | Hook receives `onClose` / `Disconnected` -> transitions status to **Reconnecting...**. Editor remains editable. | Hocuspocus provider's built-in exponential backoff reconnects automatically. Upon reconnect, state vectors reconcile. |
| **5. Collaboration server restarts** | All WebSocket connections drop simultaneously. | Badges show **Reconnecting...**. Monaco buffers local edits. Remote participant cursors disappear. | When server restarts, clients reconnect, re-authenticate via cookies, exchange state vectors, and restore sync. |
| **6. Server down, internet available** | Browser has active internet, but sync server endpoint `/sync` is unreachable. | Badge displays **Reconnecting...** (not Offline, since browser internet is active). | Retries with backoff until server recovers. If non-retryable 4xxx error returned, transitions to **Sync Error**. |
| **7. Late Connected callback while offline** | WebSocket emits `Connected` callback after browser `offline` event triggered. | Hook's `browserOffline` guard intercepts callback, forces status back to **Offline**, and immediately disconnects socket. | Remains cleanly **Offline** until genuine `online` event fires. |
| **8. Late Synced callback while offline** | WebSocket emits `onSynced({ state: true })` after network dropped. | Hook's `if (!isCurrent || browserOffline) return;` drops callback. | Badge never falsely reports **Synced** while offline. |
| **9. Late Auth Failure while offline** | Socket teardown during offline emits synthetic authentication failure. | Hook's `browserOffline` guard ignores `onAuthenticationFailed`. | User is not presented with a false authentication error screen while offline. |
| **10. Multiple tabs for one participant** | User opens room in Tab A and Tab B. Two WebSockets connect with same user session. | Sidebar displays user with **1 online count**. Both tabs sync keystrokes in real time. | Online count dedupes by authenticated user ID. |
| **11. Closes one tab, keeps second open** | User closes Tab A. Tab A's socket disconnects. Tab B's socket remains connected. | Sidebar continues to show user as **Online**. Total online count does not decrement. | Presence remains active until all tabs for that user disconnect. |
| **12. Closes all tabs** | User closes last open tab. All sockets for user terminate. | Remote peers observe awareness timeout or disconnect -> user transitions to **Offline** in sidebar. | User remains a room member (capacity preserved); online count decrements by 1. |
| **13. Reconnect succeeds, room refresh fails** | WebSocket reconnects and CRDT syncs, but background HTTP REST `refreshRoom()` fails (500). | Code editor displays **Synced** and live collaboration works. Participant sidebar logs warning but retains previous state. | Background polling or subsequent member activity retries REST refresh. |
| **14. Connected, sync pending** | Socket established (HTTP 101), but large document state vector diff is still transferring. | Status badge displays blue pulsing **Syncing...** (not Synced). | Once state vector diff is fully applied, `onSynced` fires -> badge switches to green **Synced**. |

---

## 9. Key Implementation Files Inventory

### 1. `apps/web/src/hooks/useRoomSync.ts`
Manages the complete Hocuspocus WebSocket connection and Yjs document lifecycle.
- Validates 24-character hexadecimal ObjectId.
- Dynamically derives WebSocket URL with protocol matching (`ws:` for `http:`, `wss:` for `https:`).
- Supports optional `WebSocketPolyfill` for Node/test environments with explicit `.attach()`.
- Exposes `status`, `isSynced`, `doc`, `provider`, and `error`.
- Handles browser `online`/`offline` transitions, explicitly disconnects/reconnects underlying sockets, and enforces late-callback race guards.

### 2. `apps/web/src/components/SyncStatusIndicator.tsx`
Visual connection indicator badge per PRD ED-5:
- Accessible `role="status"`, `aria-live="polite"` badge.
- Color-coded: green (`Synced`), blue pulsing (`Syncing...`), amber pulsing (`Connecting...` / `Reconnecting...`), solid amber (`Offline`), red (`Sync Error`), slate (`Disconnected`).

### 3. `apps/web/src/pages/RoomPage.tsx`
Main room shell coordinating editor, presence, and room metadata:
- Multi-tab presence deduplication.
- Participant status mapping: local user marked `Offline` when disconnected; remote members marked `Unavailable`.
- Edge-triggered `refreshRoom()` upon reconnecting via `prevSyncStatusRef`.

### 4. `apps/web/src/lib/syncUrl.ts`
Resolves the WebSocket URL for the document synchronization service (`ws://` / `wss://` matching same-origin host).

### 5. `apps/web/src/lib/roomId.ts`
Validates room identifiers with strict regex `/^[0-9a-fA-F]{24}$/`.

### 6. `apps/server/src/__tests__/sync/ed2Convergence.test.ts`
Dedicated provider-level 100-trial automated concurrent editing convergence suite (100/100 passed, 0 divergence).

### 7. `apps/server/src/sync/hocuspocus.ts` (`onStateless` & `beforeHandleMessage`)
Backend protocol and security hooks: read-only mutation dropping and 256-byte capped stateless ping/pong relay.

### 8. `apps/server/src/__tests__/sync/statelessRelay.test.ts`
20-test security suite verifying payload caps, nonces, rate limiting, and unicast delivery for diagnostics.

### 9. `test/e2e/ed3-ed4-latency.spec.ts`
Playwright single-clock dual-browser latency benchmark: 200 text updates (ED-4) and 200 remote cursor updates (ED-3).

---

## 10. Canonical Field Architecture & `getText()` Inventory

PairPrep establishes `"code"` as the canonical Yjs text field for editor content across all web and server components. Legacy documents created in earlier iterations with `"monaco"` are safely and idempotently migrated into `"code"`.

### Canonical Migration Rules
1. **Precedence**: `doc.getText("code")` is canonical. If `"code"` exists in `document.share` (even when intentionally empty `""`), it takes precedence over `"monaco"`. JavaScript truthiness (`"" || ...`) is strictly avoided to prevent resurrecting deleted code.
2. **Transparent Migration**: When `document.share.has("monaco")` is true but `document.share.has("code")` is false, `migrateLegacyDocFields()` transacts the legacy text into `"code"`.
3. **Snapshot Extraction**: `saveSnapshot()` uses `extractCanonicalDocText()`, writing the canonical document text directly into MongoDB `doc_snapshots.text`.

### Comprehensive `getText()` Inventory
| File Path | Line(s) | Target Field | Context / Purpose |
| :--- | :--- | :--- | :--- |
| `apps/server/src/sync/persistence.ts` | 941 | `"code"` | `extractCanonicalDocText`: returns canonical text if present in `document.share` |
| `apps/server/src/sync/persistence.ts` | 944 | `"monaco"` | `extractCanonicalDocText`: fallback to legacy field if `"code"` is absent |
| `apps/server/src/sync/persistence.ts` | 961 | `"monaco"` | `migrateLegacyDocFields`: reads legacy text |
| `apps/server/src/sync/persistence.ts` | 962 | `"code"` | `migrateLegacyDocFields`: populates canonical field |
| `apps/web/src/hooks/useMonacoBinding.ts` | 146 | `"monaco"` | Client-side migration: reads legacy text if `"code"` is absent before binding |
| `apps/web/src/hooks/useMonacoBinding.ts` | 149 | `"code"` | Client-side migration: writes legacy text into canonical field |
| `apps/web/src/hooks/useMonacoBinding.ts` | 154 | `fieldName` (`"code"`) | Primary Monaco editor binding to Y.Text |
| `apps/web/src/hooks/__tests__/useMonacoBinding.test.ts` | 50, 160, 161, 207, 208, 260 | `"code"` | Unit tests for Monaco binding and selection mapping |
| `apps/web/src/hooks/__tests__/useMonacoBinding.test.ts` | 240 | `"monaco"` | Unit test verifying legacy migration before mounting |
| `apps/server/src/__tests__/sync/legacyMigration.test.ts` | 20, 28, 62, 68, 74, 83, 87, 155 | `"code"` | Migration unit tests verifying canonical precedence |
| `apps/server/src/__tests__/sync/legacyMigration.test.ts` | 27, 39, 55, 67, 79, 138 | `"monaco"` | Migration unit tests verifying legacy handling |
| `apps/server/src/__tests__/sync/attribution.test.ts` | 376, 435, 436 | `"code"` | Server sync attribution tests |
| `apps/server/src/__tests__/sync/livePermissions.test.ts` | 243, 263, 264, 295, 296, 410, 608, 626, 834 | `"code"` | Server role-enforced editing tests |
| `apps/server/src/__tests__/sync/ed2Convergence.test.ts` | 169, 170, 210, 234, 235, 237, 238, 253, 254 | `"code"` | Provider-level 100-trial convergence benchmark |
| `test/e2e/support/__tests__/monacoSync.test.ts` | 223, 274, 413, 414 | `"code"` | Real two-client Monaco sync test |
| `test/e2e/support/__tests__/syncSmoke.test.ts` | 251, 252, 453, 457, 482, 483, 487, 512, 513, 742, 746, 770, 771, 777, 778, 783, 814, 846, 847 | `"code"` | Real-stack Hocuspocus sync smoke tests |
| `test/e2e/sync-proxy.spec.ts` | 312, 334, 358 | `"code"` | Native browser WebSocket proxy E2E spec |
| `test/e2e/editor-collaboration.spec.ts` | 439, 444 | `"code"` | Forced-edit server rejection E2E test |

---

## 11. Verification & Quality Gates

### 11.1 Automated Test Suite Verification

All 71 test files and 622 tests in the repository pass cleanly:

```bash
# 1. Full Monorepo Vitest Suite (71 files, 622 tests passed)
npm test
# Result: 71 passed (71), 622 passed (622) in 281.66s

# 2. Client Hook & Offline/Online Lifecycle Tests (25/25 passed)
npx vitest run apps/web/src/hooks/__tests__/useRoomSync.test.ts

# 3. Room Page Presence, Roles & Offline/Unavailable Tests (18/18 passed)
npx vitest run apps/web/src/pages/__tests__/RoomPage.test.tsx

# 4. Status Indicator Visual & A11y Tests (7/7 passed)
npx vitest run apps/web/src/components/__tests__/SyncStatusIndicator.test.tsx

# 5. ED-2 Provider-Level 100-Trial Automated Convergence Suite (100/100 passed)
npx vitest run apps/server/src/__tests__/sync/ed2Convergence.test.ts

# 6. Hocuspocus Stateless Latency Ping/Pong Handler Security Tests (20/20 passed)
npx vitest run apps/server/src/__tests__/sync/statelessRelay.test.ts

# 7. TypeScript Typecheck across all workspaces (0 errors)
npm run typecheck

# 8. Monorepo ESLint (0 errors, 0 warnings)
npm run lint

# 9. Prettier Code Style Check (Clean)
npm run format:check

# 10. Production Build (shared, server, web)
npm run build
```

### 11.2 Manual Two-Browser Verification
- **Host**: Standard Chrome window authenticated as user "Shraddha Patare" / "Shubham Sanap".
- **Guest**: Chrome Incognito window connected to the same practice room as a guest participant.
- **Network & WebSocket Endpoints**:
  - API requests verified against local development server (`http://localhost:5173/api/v1/...`).
  - WebSocket connection verified to local endpoint (`ws://localhost:5173/sync`) with HTTP 101 Switching Protocols.
  - Zero requests emitted to production or external endpoints.
  - Live editing verified in both directions.
- **Offline Walkthrough**:
  - Toggling DevTools "Offline" in Guest window immediately updated the status badge to **Offline**.
  - Local typing in Guest continued smoothly; edits were held in memory.
  - Toggling back to "No throttling" re-established the WebSocket, sent buffered keystrokes to Host, and merged edits cleanly with zero character loss.

### 11.3 ED-3 & ED-4 Quantitative Latency Benchmark Verification

The quantitative latency verification consists of two authoritative evaluation tiers:
1. **Local Development Stack Baseline**: Evaluates local Node.js server, Vite dev server, and Chromium execution without cross-country WAN jitter.
2. **Azure Production Deployment Benchmark**: Evaluates the live production environment (`https://pairprep-live.eastasia.cloudapp.azure.com`) over public internet WebSockets with real OAuth-authenticated host and guest peer sessions.

#### 11.3.1 Local Development Stack Benchmark (Localhost Baseline)

Conducted using `test/e2e/ed3-ed4-latency.spec.ts` running on Chromium against the live local development stack (`http://localhost:5173` frontend, `http://localhost:3000` backend, `ws://localhost:5173/sync`).

- **Test Harness**: Single Node.js test process driving two isolated browser contexts (`hostContext` and `guestContext`) in a shared practice room.
- **Timing Mechanism**: Single monotonic clock (`performance.now()`) within the test process, completely eliminating NTP clock skew.
- **Iterations**: 200 consecutive, automated typing and cursor advancement iterations.
- **Acceptance Threshold**: P95 latency strictly below 200 ms.

| Benchmark Metric | ED-4 Text Propagation Latency | ED-3 Remote Cursor Propagation Latency | PRD Target / Threshold | Status |
| :--- | :--- | :--- | :---: | :---: |
| **Total Samples** | **200** | **200** | 200 | **PASS** |
| **P50 (Median)** | **16.79 ms** | **12.35 ms** | < 100 ms (internal) | **PASS** |
| **P95** | **25.72 ms** | **23.27 ms** | **< 200.00 ms** | **PASS** |
| **Minimum** | **11.67 ms** | **8.45 ms** | - | - |
| **Maximum** | **1049.40 ms** | **1049.44 ms** | - | - |
| **Mean** | **28.25 ms** | **19.35 ms** | - | - |

*Analysis of Localhost Maximum Outlier (~1049 ms)*: Iterations 1 through 199 consistently recorded latencies between **8 ms and 26 ms**. The single outlier occurred on Iteration 0 due to cold Monaco Web Worker compilation and JIT tokenizer bootstrapping before reaching steady state.

---

#### 11.3.2 Azure Production Deployment Benchmark (Live Production Environment)

Conducted against the live production deployment at `https://pairprep-live.eastasia.cloudapp.azure.com` (Azure East Asia region) over secure WebSockets (`wss://pairprep-live.eastasia.cloudapp.azure.com/sync`).

- **Methodology & Authenticated Harness**:
  - Host session authenticated via genuine interactive OAuth login in Google Chrome connected via Chrome DevTools Protocol (CDP).
  - Practice room created on-demand via the production dashboard UI.
  - Isolated Guest peer connected via secondary browser context and enrolled via the guest join flow.
  - Single monotonic clock (`performance.now()`) in the runner process timing end-to-end propagation between dual client contexts.
  - **Warm-Up Execution**: A single 4-character string (`"INIT"`, logged as `5 keystrokes` in the runner output) was typed and confirmed synchronized before measurement collection started to prime Monaco tokenization and awareness listeners. (A previously reported figure of 10 warm-up iterations was not present in the runner implementation or execution log).
  - **Bidirectional Sampling**: Exactly 200 samples captured per metric, evenly split bidirectionally: 100 Host $\rightarrow$ Guest and 100 Guest $\rightarrow$ Host. All 200 iterations completed successfully with zero timeouts or dropped samples.
  - **Data Retention & Integrity**: Per-sample latency measurements were accumulated in runner memory to compute statistical percentiles (`P50`, `P95`, `min`, `max`, `mean`) which were serialized to `prod_benchmark_results.json`. Individual per-iteration sample arrays were not exported to a dedicated raw sample file during the test run; no raw data is fabricated.
  - **Teardown & Verification**: Temporary practice room automatically deleted via owner API (`DELETE /api/v1/rooms/:slug`) and confirmed absent from the dashboard.

| Production Benchmark Metric | Total Samples | Direction Split | P50 (Median) | P95 (Tail) | Min | Max | Mean | PRD Acceptance Target | Production Status |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **ED-3 Remote Cursor Propagation** | 200 | 100 H $\rightarrow$ G, 100 G $\rightarrow$ H | 15.23 ms | **23.56 ms** | 9.12 ms | 42.18 ms | 16.03 ms | P95 < 200.00 ms | **PASS** |
| **ED-3 Remote Selection Propagation** | 200 | 100 H $\rightarrow$ G, 100 G $\rightarrow$ H | 24.85 ms | **80.71 ms** | 11.54 ms | 295.87 ms | 42.42 ms | P95 < 200.00 ms | **PASS** |
| **ED-4 Collaborative Text Synchronization** | 200 | 100 H $\rightarrow$ G, 100 G $\rightarrow$ H | 203.22 ms | **219.89 ms** | 191.89 ms | 386.61 ms | 206.02 ms | P95 < 200.00 ms | **FAIL (Exceeds 200 ms threshold; WAN-affected)** |

#### Production Latency & Engineering Analysis:

1. **ED-3 Remote Cursor & Selection Propagation (PASS)**:
   - Remote cursor propagation achieved **P50 = 15.23 ms** and **P95 = 23.56 ms**, well within the 200 ms PRD threshold.
   - Remote selection propagation achieved **P50 = 24.85 ms** and **P95 = 80.71 ms**, fully satisfying PRD requirement `ED-3` (`P95 < 200 ms`).
   - Confirms that Hocuspocus awareness broadcasts and Monaco DOM decoration updates operate with minimal latency under real production conditions.

2. **ED-4 Collaborative Text Synchronization (FAIL — Exceeds 200 ms Target)**:
   - Measured text propagation latency achieved **P50 = 203.22 ms** and **P95 = 219.89 ms** (minimum **191.89 ms**, maximum **386.61 ms**, mean **206.02 ms**).
   - Because the PRD acceptance criterion requires P95 strictly below 200 ms, ED-4 is recorded as **FAIL / EXCEEDS THRESHOLD**.
   - **WAN Geographic Context**: The production Azure VM is deployed in the **East Asia (Hong Kong)** region, whereas the test runner executed from India (IST timezone) across international public internet transit.
   - **Absence of Independent Network Baseline**: No independent network RTT baseline (such as ICMP ping, TCP handshake timing, or HTTP round-trip probes) was captured during the benchmark execution window. Consequently, while geographic distance is the primary contributor to elevated round-trip times, server and application overhead cannot be quantitatively derived or decoupled from network transit without an empirical network baseline.
   - **Acceptance Status Qualification**: Although the local development stack baseline (Section 11.3.1) verified that local application synchronization overhead is well under 30 ms (P95 = 25.72 ms), end-to-end production latency under cross-region WAN conditions does not satisfy the unqualified 200 ms threshold. Full acceptance of ED-4 in production requires either re-benchmarking from a client co-located within the Azure East Asia region or a formal acceptance exception for cross-region WAN deployments.

3. **Lifecycle & Clean Room Verification**:
   - The temporary practice room was created using the production dashboard UI, verified with active multi-client CRDT collaboration, and immediately deleted via the owner REST endpoint.
   - Post-test dashboard inspection confirmed that the temporary room was completely purged from the database and UI with zero orphan resources remaining.

---

## 12. Non-Blocking Technical Debt

1. **Test-Fixture Rollback Boundary**: In `test/e2e/support/sessionHarness.ts`, partial fixture failure during multi-document seeding cleans up known entities via `try...finally`, but catastrophic process exits during failure-injection tests rely on subsequent test-suite teardown.
2. **Monaco Dynamic Import Code Splitting**: Implemented in Phase 3 via `React.lazy(() => import("../components/CollaborativeEditor.js"))` with Suspense fallback in `RoomPage.tsx`. The collaborative editor, Monaco bindings, and editor workers are split into on-demand chunks loaded exclusively upon room navigation. Route-level code-splitting guarantees that `/dashboard` and non-editor pages never download or evaluate Monaco. Future optimization (T15) may optionally dynamic-import extended language servers if full LSP support is added.
3. **Durable Client Offline Storage**: Client-side offline edits operate in memory. Integrating IndexedDB persistence (e.g. `y-indexeddb`) in a future milestone could allow offline edits to survive hard browser reloads or process crashes before reconnecting.

---

## 13. Deep Concepts & How Collaborative Editing Works (Under the Hood)

To master this architecture for placement interviews, you must understand the mathematical and systems concepts underlying real-time collaborative editing:

### 13.1 CRDT vs. Operational Transformation (OT)

When multiple users edit shared text concurrently, collaborative systems generally adopt either Operational Transformation (OT) or Conflict-Free Replicated Data Types (CRDTs):

| Architectural Property | Operational Transformation (OT) (e.g. Classical Client-Server / Google Docs) | Conflict-Free Replicated Data Types (CRDT) (e.g. Yjs / PairPrep) |
| :--- | :--- | :--- |
| **Coordination Model** | **Typically centralized**: Classical systems commonly employ an authoritative server (or shared serialization log) to assign a global sequence order and compute transformation functions between concurrent operations. | **Decentralized**: Operations commute mathematically over distributed state; updates can be applied in arbitrary order while guaranteeing identical convergence. |
| **Algorithmic Structure** | Pairwise transformation functions `T(op1, op2) -> (op1', op2')`. While simple for basic insertions, handling concurrent deletes, formatting, and offline branches introduces complex combinatorial state spaces. | Distributed data structure (e.g. Sequence CRDT). Each character item is immutable with explicit causal dependencies and unique identifier. |
| **Offline Synchronization** | Requires buffering and re-transforming client operations against all intervening server operations that occurred while disconnected. | Local edits accumulate as new CRDT items; upon reconnection, exchanging compact state vectors identifies missing operations and merges them directly. |
| **Architectural Trade-off** | Minimal memory overhead (stores plain text buffer), but high algorithmic transformation complexity. | Slightly higher memory footprint per character (struct metadata), but mathematically provable Strong Eventual Consistency (SEC) without central serialization. |

### 13.2 The YATA Algorithm & Conflict Resolution

Yjs implements the **YATA** (Yet Another Transformation Approach) algorithm for sequence CRDTs:
- Every character or slice inserted is represented as an **Item** struct with an ID consisting of `(client, clock)` where `client` is a unique 53-bit integer and `clock` is a monotonically increasing counter.
- Each item explicitly retains references to its `origin` (intended left neighbor) and `rightOrigin` (intended right neighbor) captured at creation time.
- **Causal Graph Ordering**: When concurrent insertions happen between the same two existing characters, YATA does not simply rely on arbitrary sorting. It traverses the causal origin graph between `origin` and `rightOrigin`, ensuring that dependencies (e.g., character insertions that depend on previous concurrent insertions) maintain their causal relative order.
- **Deterministic Tie-Breaking**: When two concurrent operations share identical origins and graph traversal cannot causally separate them, YATA uses a deterministic tie-breaker: comparing the unique client identifiers (`clientA > clientB`).
- Because every peer applies this identical deterministic traversal and tie-breaking rule, **all clients arrive at the exact same character sequence**, guaranteeing Strong Eventual Consistency (SEC).

### 13.3 State-vector-based Incremental Synchronization

Rather than transmitting full document copies or operation logs over WebSockets, Yjs uses a compact state-vector-based synchronization protocol:

1. **State Vector Representation (`Y.encodeStateVector(doc)`)**:
   - A State Vector represents a compact map of `{ [clientId]: maxContiguousClock }`.
   - It summarizes every operation a specific client or server has observed to date across all participating client streams.
2. **Incremental Update Generation (`Y.encodeStateAsUpdate(doc, targetStateVector)`)**:
   - Given a remote peer's State Vector, this function compares the local document's item stores against the remote vector.
   - It packages only the missing item structs (and tombstone markers) that the remote peer has not yet received into a compact, binary-encoded update payload.
3. **The Two-Step Handshake**:
   - **Step 1**: Client connects and transmits `Y.encodeStateVector(clientDoc)`.
   - **Step 2**: Server evaluates the vector against `serverDoc`, computes `Y.encodeStateAsUpdate(serverDoc, clientVector)`, and transmits the diff to the client.
   - Concurrently, the client computes and sends its own update diff to the server if the client possessed offline local edits.
   - Both peers invoke `Y.applyUpdate(...)` to achieve identical state.
4. **Real-time Keystroke Streaming**:
   - Subsequent local keystrokes generate small incremental update binary chunks that are broadcasted immediately over the WebSocket to peers.

### 13.4 Bi-Directional Monaco-to-Yjs Synchronization (`y-monaco`)

Monaco Editor operates on a traditional string buffer with line/column coordinates, whereas Yjs operates on a 1D CRDT character sequence (`Y.Text`).

`useMonacoBinding.ts` bridges them without triggering infinite event echo loops:
1. **Local Keystroke**:
   - User types in Monaco -> Monaco fires `onDidChangeModelContent`.
   - The binding intercepts the event, calculates the 1D offset from Monaco's range `(startLine, startColumn)`, and executes `yText.insert(offset, text)` inside a Yjs transaction tagged with `transaction.origin = binding`.
2. **Echo Prevention**:
   - The Yjs document fires `yText.observe(event)`.
   - The observer checks `if (event.transaction.origin === binding) return;`. It ignores transactions originated by itself, preventing an infinite feedback loop.
3. **Remote Update**:
   - When a remote update arrives over WebSocket, `transaction.origin` is the Hocuspocus provider.
   - The observer calculates the delta, maps the 1D character offset back to Monaco line/column coordinates, and invokes `editor.executeEdits(..., [ { range, text } ])`.

### 13.5 Awareness Protocol vs. Document CRDT

In PairPrep, real-time data is split into two distinct tiers:
1. **Persistent Document State (`Y.Doc`)**: Code text, room configurations, and durable content. Stored as CRDT structs, saved to MongoDB, and preserved across connections.
2. **Ephemeral Awareness State (`provider.awareness`)**: Cursor positions, active selections, user display names, and presence colors.
   - Awareness is **not** a CRDT; it is an in-memory key-value dictionary with client heartbeats managed over WebSockets.
   - **Heartbeats & Stale Expiry**: Connected clients periodically rebroadcast awareness state to maintain presence. If no update or heartbeat is received from a client for approximately 30 seconds (`awareness.outdatedTime`), remote peers automatically mark that client's presence state as stale and remove it.
   - **No Database Persistence**: Awareness is never written to MongoDB and does not use a database TTL index. On clean WebSocket disconnection, awareness state is immediately pruned in memory.

---

## 14. How to Explain This in an Interview

### System Overview & Elevator Pitch

"In Task T08, I built the client-side collaborative code editor architecture for PairPrep using Monaco Editor, Yjs CRDTs, and Hocuspocus. The system connects our React frontend to our Node.js synchronization backend over WebSockets, providing conflict-free live collaborative editing, sub-25ms local convergence, remote cursor and selection presence, offline resilience with in-memory preservation, and strict protocol-layer authorization so viewers cannot mutate code even via direct WebSocket injection."

---

### Key Technical Challenges, Architectural Decisions & Trade-offs

#### 1. Custom WebSocket Attachment & Ownership in Hocuspocus Provider v4
- **Problem**: When injecting a custom `websocketProvider` (such as in automated tests requiring custom headers or Node WebSocket polyfills), Hocuspocus Provider v4 treats the provider as externally managed (`this.manageSocket = false`). If you do not call `.attach()`, the provider never registers event listeners on the socket, resulting in silent connection hangs. Furthermore, destroying the main provider does not destroy the external WebSocket, creating invisible socket and timer leaks.
- **Solution**: In `useRoomSync`, we explicitly branch based on whether a custom WebSocket polyfill is provided. If provided, we instantiate `HocuspocusProviderWebsocket`, instantiate `HocuspocusProvider`, and explicitly call `activeProvider.attach()`. During teardown and error handling, we destroy both the main provider and the custom WebSocket provider in order.
- **Trade-off**: Requires conscious separation of socket ownership vs. document synchronization, but provides reliable teardown and resource release in both browser and test environments.

#### 2. React StrictMode Resilience & Idempotent WebSocket Teardown
- **Problem**: React 18/19 StrictMode mounts, unmounts, and remounts components immediately in development. If an active WebSocket connection is initiated in an effect, rapid unmounting can cause race conditions where stale callbacks update unmounted components, or multiple WebSockets stay alive against the same room.
- **Solution**: We implemented an `isCurrent` generation guard inside `useRoomSync`. The cleanup function synchronously sets `isCurrent = false`, unregisters all window listeners, and calls `.destroy()` on the provider and document. Every event handler (`onStatus`, `onSynced`, `onAuthenticationFailed`, `onClose`) aborts immediately if `!isCurrent`.
- **Trade-off**: Adds a small amount of boilerplate to effect callbacks, but prevents memory leaks and React state update warnings on unmounted components.

#### 3. Same-Origin WebSocket Proxying & Ambient Cookie Authentication
- **Problem**: In local development, Vite runs on port 5174 while Express runs on port 3001. Cross-origin WebSocket handshakes introduce cookie inconsistencies and diverge from the production architecture (`AD-1`).
- **Solution**: We routed client WebSocket connections through Vite's same-origin development proxy (`/sync` with `ws: true`). The browser connects to `ws://${window.location.host}/sync`, treating the connection as strictly same-origin. First-party `HttpOnly` session cookies (`pairprep.sid`) are transmitted reliably during the HTTP upgrade handshake.
- **Trade-off**: Requires dev proxy configuration in Vite, but mirrors the single-origin reverse-proxy architecture (Caddy) deployed in production.

#### 4. Server-Side Enforcement of Read-Only Sockets (ED-6)
- **Problem**: Client-side read-only flags (`editor.updateOptions({ readOnly: true })`) can be trivially bypassed by an attacker executing `window.__pairprep_sync.doc.getText("code").insert(...)` in the browser console.
- **Solution**: In `apps/server/src/sync/hocuspocus.ts`, we implemented the `beforeHandleMessage` hook. When a connection is authenticated as a `viewer` (`connection.readOnly === true`), the server intercepts incoming binary message frames, drops mutation packets, and logs security rejections, while still allowing read-only sync frames to pass through.
- **Trade-off**: Introduces protocol-level inspection overhead per message frame, but guarantees absolute authorization integrity regardless of client tampering.

#### 5. Measuring Latency Without Clock Skew (ED-3 & ED-4)
- **Problem**: Real-world clients have desynchronized local clocks (NTP drift can be 50–200ms). Comparing `Date.now()` on Client A with `Date.now()` on Client B yields inaccurate or negative latency numbers.
- **Solution**: We built `test/e2e/ed3-ed4-latency.spec.ts` using a single Playwright test process that drives two browser contexts. The test process uses its own monotonic clock (`performance.now()`) to time the round-trip from Context A typing to Context B's DOM decoration or Monaco model updating.
- **Trade-off**: End-to-end browser automation requires more test infrastructure than simple timestamp math, but provides scientifically defensible, reproducible latency metrics.

---

## 15. T08 Technical Interview Preparation — Collaborative Editor & Production Performance

This section provides a clear, interview-focused breakdown of PairPrep's real-time collaborative editor architecture, our live production benchmark results, and how to explain the engineering trade-offs in a technical interview.

---

### 15.1 Understanding P50 and P95 Latency

When evaluating real-time systems, single summary statistics like the arithmetic average (mean) can be misleading. In PairPrep, we evaluate latency using **P50** and **P95** percentiles calculated on a single monotonic clock:

- **P50 (Median)**: The 50th percentile represents the median latency of the system. Exactly half of the observed operations complete faster than the P50, and half take longer. It describes typical, everyday performance under normal conditions.
- **P95 (95th Percentile)**: The 95th percentile captures "tail latency." 95% of all measured operations complete faster than this number, while only the slowest 5% take longer. P95 accounts for intermittent network jitter, garbage collection pauses, main-thread microtasks, and transient queuing delays.
- **Why Lower Latency Matters**: In collaborative code editing, lower latency creates an instantaneous, tactile typing feel. When latency rises above 100–200 ms, users begin to perceive lag between remote edits and local cursor movements.
- **Why P95 Is More Useful Than Mean Alone**: An arithmetic mean can be heavily distorted by a single massive outlier (e.g., initial Web Worker cold-start) or conversely, it can conceal bursts of jitter. For example, if 190 edits take 15 ms and 10 edits stall for 500 ms, the mean might look acceptable (~39 ms), but 1 out of every 20 keystrokes would feel noticeably sluggish. P95 directly tells us what the worst 5% of operations feel like.

#### Concrete Example (200 Sequential Measured Edits)
Suppose we execute **200 sequential edits** between two connected browser sessions.
- We record the monotonic round-trip delta for each edit and sort all 200 values from lowest to highest.
- **P50** is the 100th value in that sorted array. If P50 is 15.23 ms, half of the 200 edits arrived in under 15.23 ms.
- **P95** is the 190th value in the sorted array ($200 \times 0.95 = 190$). If P95 is 23.56 ms, it guarantees that 190 out of the 200 edits completed in 23.56 ms or less, with only the remaining 10 edits exceeding that threshold.
*(Note: 200 samples represent 200 sequential edit operations performed between two browser sessions, not 200 concurrent users).*

---

### 15.2 Actual PairPrep Production Measurements

During our live production verification, we executed an automated benchmark driving two isolated browser sessions—a verified **Host** session and a **Guest** peer—connected to the live production deployment on Azure East Asia (`https://pairprep-live.eastasia.cloudapp.azure.com`) over secure WebSockets (`wss://pairprep-live.eastasia.cloudapp.azure.com/sync`).

The table below reflects the exact, unmanipulated production measurements recorded across 600 total bidirectional samples:

| Production metric | Samples | P50 | P95 | Minimum | Maximum | Mean |
|---|---:|---:|---:|---:|---:|---:|
| ED-3 Remote cursor | 200 | 15.23 ms | 23.56 ms | 9.12 ms | 42.18 ms | 16.03 ms |
| ED-3 Remote selection | 200 | 24.85 ms | 80.71 ms | 11.54 ms | 295.87 ms | 42.42 ms |
| ED-4 Collaborative text | 200 | 203.22 ms | 219.89 ms | 191.89 ms | 386.61 ms | 206.02 ms |

#### Performance Target Evaluation:
1. **ED-3 Remote Cursor Propagation (PASS)**:
   - Measured P95 is **23.56 ms**, which is well below the 200 ms target. Remote cursor movements feel near-instantaneous.
2. **ED-3 Remote Selection Propagation (PASS)**:
   - Measured P95 is **80.71 ms**, comfortably satisfying the 200 ms PRD threshold.
3. **ED-4 Collaborative Text Synchronization (FAIL / Exceeds Target)**:
   - Measured P95 is **219.89 ms** (P50 = 203.22 ms, Minimum = 191.89 ms).
   - This exceeds the original 200.00 ms threshold by **19.89 ms (approximately 9.95%)**.
   - ED-4 is therefore formally recorded as **exceeding the agreed threshold**, rather than marked as passing.

---

### 15.3 Collaborative Editing Architecture

PairPrep's real-time collaborative editor uses a modular architecture combining an industrial editor with Conflict-Free Replicated Data Types (CRDTs) and a dedicated WebSocket relay server.

#### The Real-Time Text Synchronization Data Flow (Step-by-Step):
1. **User Types**: A participant types or modifies code in the Monaco Editor interface.
2. **Binding Interception**: The `y-monaco` adapter listens to Monaco's `onDidChangeModelContent` event and translates the raw edit into a Yjs text operation.
3. **CRDT Item Creation**: Yjs records the insertion or deletion in its shared `doc.getText("code")` sequence CRDT, assigning an immutable `(clientId, clock)` coordinate and tracking causal origins.
4. **Binary Encoding & Transport**: Yjs encodes the document delta into a compact binary update payload, which is transmitted over the persistent WebSocket connection (`/sync`).
5. **Server Distribution**: The Hocuspocus backend server receives the binary frame, validates authorization in `beforeHandleMessage`, and broadcasts the update frame to all other connected peers in the room.
6. **Remote Ingestion**: The receiving peer's client receives the binary frame over its WebSocket and applies it to its local Yjs document (`Y.applyUpdate`).
7. **Model Synchronization**: `y-monaco` detects the Yjs transaction and executes an edit directly on the receiving Monaco model without triggering an echo event loop.
8. **Visual Update**: The remote participant immediately sees the updated code rendered in Monaco.

#### The Presence & Cursor Data Flow (Separate Pipeline):
- **Presence vs. Document State**: User cursor positions and text selections are transient presence information, not permanent document history.
- **Yjs Awareness Protocol**: Cursor coordinates, user display names, and assigned participant colors are distributed via the Yjs Awareness protocol (`provider.awareness`).
- **Separation of Concerns**: Awareness messages are lightweight, ephemeral JSON/binary state broadcasts that do not touch the document's CRDT causal graph or write to MongoDB.
- **DOM Decoration Rendering**: On the receiving client, `useMonacoBinding` extracts remote cursor coordinates and injects Monaco model decorations (`.yRemoteSelectionHead-${clientId}` and `.yRemoteSelection-${clientId}`) styled via dynamically injected CSS rules.

#### Component Responsibilities:
- **Monaco Editor**: Provides the front-end code editing interface, syntax highlighting, code folding, tokenizer worker threads, and visual DOM decoration rendering.
- **Yjs**: The underlying CRDT engine that guarantees Strong Eventual Consistency (SEC) across all peers without central lock coordination.
- **`y-monaco`**: The bidirectional binding bridge translating between Monaco's editor event model and Yjs's CRDT transactions.
- **Hocuspocus**: The Node.js WebSocket coordination server managing room lifecycles, connection authentication via session cookies, and protocol-level permission enforcement.
- **WebSocket**: The low-latency, full-duplex TCP transport connection carrying both binary document updates and awareness frames over a single connection.
- **MongoDB Persistence**: Asynchronous backend persistence that periodically serializes document CRDT snapshots to disk (with a 250 ms debounce and 2,000 ms max scheduling delay) for durable session storage. Awareness states are never persisted to MongoDB.

---

### 15.4 Why Text Synchronization Is Slower Than Cursor Propagation

In our production measurements, ED-3 remote cursor propagation achieved a P95 of **23.56 ms**, whereas ED-4 text synchronization recorded a P95 of **219.89 ms**. Understanding why this difference occurs is essential for technical interviews:

1. **Two Fundamentally Different Pipelines**:
   - **Cursor/Selection (Awareness Pipeline)**: Operates as an ephemeral presence broadcast. A cursor move simply updates a coordinate in memory, serializes a tiny awareness packet, broadcasts it over the socket, and renders a CSS decoration in Monaco. It completely bypasses document parsing, CRDT graphs, and persistence checks.
   - **Text Synchronization (Document Update Pipeline)**: Yjs creates and encodes document updates as edits occur, constructing CRDT items with causal origins and serializing binary update frames. (State vectors are not calculated on every keystroke; instead, state vectors summarize which operations a replica has observed and are used during synchronization to identify missing updates and exchange the differences). The update frame must travel over the network, pass through server-side message inspection and authorization hooks, merge into the receiver's CRDT graph, resolve any concurrent interleaving, execute a model edit in Monaco, and trigger tokenizer re-evaluation.

2. **Cross-Region Geographic Network Routing**:
   - Our test runner was executed from **India (IST timezone)**, while the Azure production VM is hosted in the **East Asia (Hong Kong)** region.
   - Round-trip internet traffic traversing international fiber routes, submarine cables, and public transit nodes incurs substantial physical propagation latency.

3. **Absence of Independent Network Baseline**:
   - While geographic distance and WAN routing are plausible contributors to the ~200 ms floor, **no independent network RTT baseline (such as ICMP ping or TCP handshake probes) was captured during the benchmark execution window**.
   - Therefore, engineering rigor requires that we do not claim an exact derived server overhead (e.g., claiming "< 15 ms application time") without empirical network proof.
   - We do not claim that the original 200 ms target was met in production.

4. **Future Instrumentation Needed**:
   - To decompose this latency scientifically, future benchmarks should instrument three discrete sub-phases:
     - `T_transport`: Separate network transport round-trip time (RTT) via standalone ping/pong probes.
     - `T_server`: Server-side ingress-to-broadcast processing delay inside Hocuspocus.
     - `T_client`: Local Monaco model mutation, tokenizer re-indexing, and DOM paint execution time.

---

### 15.5 Interview-Ready Project Explanation (60–90 Second Elevator Pitch)

Here is a natural, conversational response you can speak aloud in an interview:

> *"In PairPrep, I built the client-side collaborative code editor for technical placement interviews. Candidates and interviewers needed to write, debug, and review code together in real time without lag or merge conflicts.*
>
> *I chose Monaco Editor because it gives candidates an authentic VS Code experience with syntax highlighting for Python, C++, and JavaScript. Under the hood, I integrated Yjs CRDTs and Hocuspocus over WebSockets. When a user types, `y-monaco` translates editor changes into CRDT operations that commute mathematically, guaranteeing identical code on both screens without central locking.*
>
> *To verify performance, I built an automated benchmark using dual authenticated browser contexts connected to our live Azure East Asia production server over the public internet. Cursor and selection updates were exceptionally responsive, achieving a P95 latency of 23 ms and 80 ms respectively.*
>
> *For collaborative text synchronization, we recorded a P95 of 219 ms, which exceeds our original 200 ms target. Geographic network transit between India and Hong Kong is a plausible contributor, but network and application processing were not independently measured during the production benchmark. By comparison, the local development benchmark measured text synchronization P95 at 25.72 ms and cursor propagation P95 at 23.27 ms. These are local end-to-end measurements, not isolated application-processing measurements."*

---

### 15.6 Interview Questions and Answers (20 Key Questions)

#### 1. What is PairPrep and what problem does T08 solve?
PairPrep is a technical interview platform where candidates and interviewers conduct live coding sessions. Task T08 builds the real-time collaborative code editor, allowing two participants to edit the same codebase simultaneously with syntax highlighting, remote cursor tracking, connection status indicators, and conflict-free convergence.

#### 2. Why did you choose Monaco Editor?
Monaco is the battle-tested editor that powers Visual Studio Code. It provides native syntax highlighting, rich language tokenization, configurable keybindings, and robust APIs for custom themes and DOM decorations. It offers candidates an authentic coding environment superior to basic textareas or lighter editors.

#### 3. What is Yjs?
Yjs is a high-performance, open-source CRDT implementation designed for shared text, arrays, and key-value maps. It represents text as a sequence of character items with unique client IDs and monotonic clocks, allowing distributed edits to merge deterministically without a central coordinating authority.

#### 4. What is a CRDT?
A Conflict-Free Replicated Data Type (CRDT) is a distributed data structure that allows multiple replicas to be updated concurrently without central locking. All concurrent operations commute mathematically; as long as all replicas receive the same set of updates, they are guaranteed to reach Strong Eventual Consistency (SEC) regardless of message arrival order.

#### 5. Why did you use Hocuspocus?
Hocuspocus is a lightweight, headless WebSocket synchronization backend built specifically for Yjs. It handles connection pooling, room multiplexing, binary update broadcasting, session authentication, and hook points (`beforeHandleMessage`, `onStateless`) for custom authorization and document persistence.

#### 6. What is the role of WebSockets?
A WebSocket connection begins with an HTTP Upgrade handshake. Once established, it provides a persistent, full-duplex connection between the client browser and the Hocuspocus server. Subsequent document and awareness updates travel over the existing connection without a new HTTP request/response cycle for every update.

#### 7. How are text changes synchronized?
When a user types, `y-monaco` translates Monaco model content changes into a Yjs text transaction. Yjs packages the inserted or deleted items into a compact binary update. This binary packet travels over the WebSocket to Hocuspocus, which broadcasts it to the room. The remote client applies the binary update to its local Yjs document, which `y-monaco` reflects into Monaco's text model.

#### 8. How are remote cursors and selections synchronized?
Cursor and selection coordinates are managed through the Yjs Awareness protocol. When the local cursor moves, `useMonacoBinding` updates the local awareness state with the line number, column, user name, and color. This ephemeral state is broadcast over the WebSocket. Remote clients receive the awareness update and render Monaco decorations via CSS rules targeting `.yRemoteSelectionHead-${clientId}` and `.yRemoteSelection-${clientId}`.

#### 9. What is the difference between Awareness and Y.Doc?
A `Y.Doc` maintains collaborative document state in client and server memory using the CRDT causal graph. MongoDB persistence is handled separately by the backend persistence layer (asynchronously flushing document snapshots). `Awareness` maintains transient, ephemeral presence information (cursor and selection positions, participant display names and colors) in memory; it changes continuously, does not require conflict resolution, and remains ephemeral without being stored as document history.

#### 10. Why is text synchronization slower than cursor propagation?
Text synchronization goes through a full document CRDT pipeline: creating and encoding document updates as edits occur, verifying authorization on the server, merging updates into the remote CRDT graph, and executing Monaco model mutations with tokenizer re-indexing. (State vectors summarize which operations a replica has observed and are used during synchronization to exchange missing updates, rather than computed per keystroke). Cursor updates use lightweight awareness messages that bypass document models entirely and render directly as DOM CSS decorations.

#### 11. What do P50 and P95 mean?
P50 is the median: 50% of operations were faster, and 50% were slower. P95 is the 95th percentile tail latency: 95% of operations finished faster, and only the slowest 5% took longer. P95 is essential because it reveals network jitter and worst-case user experience that averages conceal.

#### 12. How did you benchmark production latency?
We connected a Playwright automation script over Chrome DevTools Protocol (CDP) to an authenticated browser session, created a practice room, and connected an isolated guest browser context. The test runner used a single monotonic clock (`performance.now()`) to time 200 sequential edits and cursor movements bidirectionally between the two sessions against our live Azure East Asia production server.

#### 13. Why did you use two isolated browser sessions?
Using two separate browser contexts (Host and Guest) ensures that each client maintains independent WebSocket connections, separate Monaco editor instances, and isolated JavaScript memory. This mirrors real-world collaboration between two remote users rather than testing an artificial single-client loopback.

#### 14. How do you know that remote updates actually arrived?
The benchmark uses Playwright's `waitForFunction` to observe the receiving browser context's DOM and Monaco editor state directly. For text, it polls until the unique character appears in the receiving Monaco model text. For cursors, it polls until the remote cursor DOM decoration element (`.yRemoteSelectionHead-${clientId}`) is attached and rendered with non-zero dimensions.

#### 15. What happens when a participant loses connectivity?
When connectivity drops, `useRoomSync` updates the UI indicator to `Offline`. The user can continue typing locally; edits are retained in memory in the local Yjs document. When connectivity is restored, the client reconnects its WebSocket, exchanges state vectors with Hocuspocus, and merges offline edits seamlessly.

#### 16. How do edits converge after reconnection?
Yjs uses state vectors (`Y.encodeStateVector`) to summarize observed operations. Upon reconnecting, the client and server exchange state vectors to identify exactly which operations each side missed. Missing items are transmitted and applied via the YATA algorithm, which resolves concurrent edits deterministically using causal origins and client ID tie-breaking.

#### 17. How is unauthorized editing prevented?
In `apps/server/src/sync/hocuspocus.ts`, we implement the `beforeHandleMessage` hook. If a client is authenticated as a `viewer` (`connection.readOnly === true`), the server intercepts incoming binary message frames and silently drops any mutation packets. Unauthorized mutations cannot alter server state even if an attacker modifies client-side JavaScript.

#### 18. What happens when a user refreshes while offline?
Because offline edits are held in memory within the active browser tab session, a hard browser refresh while disconnected will lose any unflushed offline keystrokes. Once the page reloads, it fetches the last persisted document state from the server. (Durable offline persistence via IndexedDB is documented as non-blocking technical debt).

#### 19. What is the difference between in-memory offline editing and durable offline editing?
In-memory offline editing holds uncommitted CRDT deltas in browser JavaScript memory during a temporary network disruption; edits survive connection drops but not browser restarts. Durable offline editing saves CRDT updates to client-side storage like IndexedDB (e.g., using `y-indexeddb`), allowing edits to survive browser tab closures and device reboots.

#### 20. What would you optimize next?
Next, I would implement sub-phase latency tracing (`T_transport`, `T_server`, `T_client`) using lightweight diagnostic timestamps, test performance against a geographically co-located client in East Asia, and evaluate multi-region edge deployment or regional WebSocket proxies (e.g., Cloudflare Workers or Azure Front Door) to bring the WebSocket connection closer to international candidates.

---

### 15.7 Honest Performance Assessment

| Requirement | Production result | Assessment |
|---|---|---|
| ED-3 cursor P95 below 200 ms | 23.56 ms | Pass |
| ED-3 selection P95 below 200 ms | 80.71 ms | Pass |
| ED-4 text P95 below 200 ms | 219.89 ms | Original threshold exceeded |

#### Acceptance Status Note:
The PRD requirement for `ED-4` states that remote text synchronization must complete in under 200 ms at the 95th percentile. In production across international WAN, we measured 219.89 ms. While cross-border network transit is a plausible contributor, engineering integrity requires that documentation does not unilaterally redefine or waive agreed targets. A revised WAN-aware latency SLA can only be adopted through an explicit stakeholder acceptance decision; until then, ED-4 is recorded as exceeding the original threshold.

---

### 15.8 Remaining Technical Debt (PER-1)

- **Durable Crash-Loss Protection**: Requirement `PER-1` (persistence and crash recovery within 2s) remains classified as **PARTIAL** technical debt.
- **Asynchronous Persistence Window**: The backend flushes Yjs document snapshots to MongoDB using a 250 ms debounce and a 2,000 ms maximum scheduling deadline. If the server process suffers an ungraceful crash (e.g., SIGKILL or power failure) before the scheduled write completes, in-flight edits within that window can be lost.
- **No Unconditional Guarantee**: We do not claim an unconditional zero-data-loss guarantee under arbitrary crash timings.

---

## 16. Comprehensive Interview Preparation Question Bank

This section provides 52 technical interview questions across 7 categories (A through G). It complements the 20 core questions and production performance breakdown in **Section 15 (T08 Technical Interview Preparation — Collaborative Editor & Production Performance)**, the architectural trade-offs in **Section 14**, and the foundational algorithms in **Section 13**. All original 12 core questions from previous drafts are preserved in full—either incorporated into specific questions below (e.g. Q16, Q20, Q22, Q29, Q43) or codified in dedicated architectural sections (Sections 2.4, 2.5, 2.6, 8, 12, 13.1–13.5).

### Category A: Connectivity and Network Lifecycle

#### Q1: What is the difference between `navigator.onLine` and actual internet connectivity?
> **Answer**:
> `navigator.onLine` is an operating system and network interface heuristic, not an end-to-end reachability probe. It returns `true` whenever the device is connected to a local area network (LAN), Wi-Fi router, or virtual bridge, even if the upstream WAN link is completely dead or behind a captive portal. Conversely, it returns `false` when the OS disables all network adapters (e.g. Airplane mode). In collaborative editing, `navigator.onLine === false` is a definitive guarantee that communication is impossible, but `navigator.onLine === true` is merely speculative—actual reachability can only be verified by an active, successful WebSocket or HTTP handshake with the synchronization server.

#### Q2: Why are browser `online` and `offline` events insufficient on their own?
> **Answer**:
> Browser `online` and `offline` events only fire when the underlying OS network interface toggles state. They do not fire when:
> 1. An intermediate proxy or load balancer resets the TCP connection.
> 2. The collaboration server process restarts or crashes.
> 3. DNS resolution fails or the route is blackholed.
> Therefore, an editor cannot rely solely on window events. It must maintain a two-layer detection system: window `online`/`offline` events for immediate local adapter transitions, combined with socket-level lifecycle callbacks (`onStatus`, `onClose`, heartbeat pings) to detect server and transport failures.

#### Q3: How should a collaborative editor handle network disconnection?
> **Answer**:
> When network disconnection occurs, the editor must:
> 1. Preserve the active document instance (`Y.Doc`) in memory without destroying or resetting it.
> 2. Allow the user to continue typing uninterrupted in the local editor.
> 3. Update the UI connection badge immediately to **Offline**, avoiding false error screens or blocking modals.
> 4. Explicitly disconnect the underlying WebSocket provider to halt connection retry loops and socket polling.
> 5. Suppress late asynchronous network callbacks (e.g. auth failures or late sync confirmations) from overriding the offline state.
> 6. Automatically initiate reconnection as soon as network connectivity is restored.

#### Q4: What is the difference between WebSocket connectivity and document synchronization?
> **Answer**:
> WebSocket connectivity represents the transport layer (Layer 7 protocol upgrade via HTTP 101 Switching Protocols), confirming that a TCP socket exists and session authentication succeeded. Document synchronization represents the application and CRDT state layer: it confirms that both peers have exchanged Yjs state vectors (`Y.encodeStateVector`), identified missing operational items, applied the diffs (`Y.applyUpdate`), and verified that both documents are mathematically identical. A socket can be connected while document synchronization is still actively transferring large diffs.

#### Q5: Why can a WebSocket report Connected before the document is Synced?
> **Answer**:
> In Hocuspocus, the `Connected` status is emitted immediately after the WebSocket handshake completes and the server's `onAuthenticate` hook resolves. However, document synchronization requires a subsequent two-step binary message exchange: Step 1 transmits the client's state vector (`SyncStep1`); the server computes the missing updates and replies with `SyncStep2`. Until the client applies `SyncStep2` and confirms vector equality, the document is in the `Syncing...` state, not `Synced`.

#### Q6: How should late asynchronous callbacks be handled?
> **Answer**:
> Network events operate asynchronously across process boundaries. If a user loses Wi-Fi while a connection attempt is in flight, a late `onStatus({ status: "connected" })`, `onSynced({ state: true })`, or `onAuthenticationFailed` callback may fire after the browser has already entered `offline` mode.
> In PairPrep, `useRoomSync.ts` maintains an internal `browserOffline` boolean flag and an `isCurrent` generation guard. Every callback inspects `if (!isCurrent || browserOffline) return;`. If `browserOffline` is true, late `Connected` callbacks force the socket to disconnect, late `Synced` callbacks are ignored, and late `AuthFailed` errors are suppressed so the UI remains cleanly **Offline**.

#### Q7: Why is an explicit reconnect strategy necessary?
> **Answer**:
> While libraries like Hocuspocus include internal exponential backoff timers, unmanaged timers can fire while the operating system network adapter is dead, creating wasted CPU cycles, unhandled promise rejections, and battery drain. When connectivity returns, waiting for a long exponential backoff timer (e.g. 30 seconds) degrades user experience. An explicit reconnect strategy listens to the browser `online` event and immediately invokes `wsProvider.connect()`, restoring real-time collaboration with zero unnecessary delay.

---

### Category B: Hocuspocus and WebSocket Architecture

#### Q8: What is Hocuspocus?
> **Answer**:
> Hocuspocus is an open-source, production-ready synchronization suite developed by TipTap. It acts as an authoritative WebSocket server and client provider for Yjs documents. It handles connection authentication, document-level routing, awareness multiplexing, hook-based lifecycle extensions (e.g. database persistence, read-only permission checks), and binary CRDT update propagation.

#### Q9: What is the role of HocuspocusProvider?
> **Answer**:
> `HocuspocusProvider` is the client-side document manager. It binds a specific `Y.Doc` to a room name, manages document synchronization state (`isSynced`), coordinates ephemeral awareness (cursors, selections, names), dispatches high-level lifecycle events (`status`, `synced`, `authFailed`), and serializes binary CRDT messages for transmission over a WebSocket.

#### Q10: What is the role of HocuspocusProviderWebsocket?
> **Answer**:
> `HocuspocusProviderWebsocket` is the transport-level connection manager in `@hocuspocus/provider`. It manages the physical `WebSocket` instance, URL resolution, reconnect backoff timers, ping/pong health heartbeats, and WebSocket event dispatching (`open`, `close`, `message`, `error`). A single `HocuspocusProviderWebsocket` can multiplex multiple `HocuspocusProvider` document instances over a single physical TCP connection.

#### Q11: What is the difference between a managed and externally supplied WebSocket?
> **Answer**:
> When `new HocuspocusProvider({ url, name, document })` is called without a `websocketProvider` parameter, the provider internally instantiates its own `HocuspocusProviderWebsocket` and sets internal flag `this.manageSocket = true`. It owns the socket and automatically manages attachment and destruction.
> When a custom `websocketProvider` is passed (e.g. for testing with custom headers or polyfills), `this.manageSocket` is `false`. The provider treats the socket as externally owned: it **does not** automatically attach listeners without an explicit `.attach()` call, and destroying the provider **does not** close the underlying socket.

#### Q12: Why might disconnecting a wrapper provider not close an externally managed socket?
> **Answer**:
> In `@hocuspocus/provider@4.7.1`, the `disconnect()` and `destroy()` methods inspect `if (this.manageSocket) { this.configuration.websocketProvider.destroy(); }`. If the socket was supplied externally (`manageSocket === false`), the provider assumes the socket may be shared by other documents. It merely unbinds its own message listeners and leaves the underlying `HocuspocusProviderWebsocket` connected and running. To actually disconnect the socket, the caller must invoke `wsProvider.disconnect()` directly on the underlying provider.

#### Q13: How do reconnect timers and connection lifecycle events work?
> **Answer**:
> When a WebSocket closes abruptly, `HocuspocusProviderWebsocket` starts an internal exponential backoff reconnect loop (e.g. 1s, 2s, 4s... capped at a maximum interval). During reconnection, it emits `status: "connecting"` (or `"reconnecting"`). Upon successful connection, it clears the timer, resets the backoff counter, and executes the authentication and sync handshake.

#### Q14: How should WebSocket reconnection be tested?
> **Answer**:
> WebSocket reconnection should be tested across three levels:
> 1. **Unit/Hook Level**: Mock the underlying provider methods, trigger browser `offline` and `online` events, and verify that `wsProvider.disconnect()` and `wsProvider.connect()` are called with correct status dispatching.
> 2. **Transport Integration Level**: Run two real providers against an active server, terminate the server socket or drop TCP packets, and assert that the client detects disconnection, engages backoff, and converges upon socket re-establishment.
> 3. **Real-Browser E2E Level**: In Playwright, invoke `await context.setOffline(true)`, verify the UI displays **Offline**, type local edits, invoke `await context.setOffline(false)`, and verify the badge returns to **Synced** and remote peers receive the edits.

---

### Category C: Yjs and Offline Editing

#### Q15: What is a Y.Doc?
> **Answer**:
> A `Y.Doc` is the primary in-memory container for all shared CRDT data structures in Yjs. It maintains the distributed transaction log, client clocks, garbage collection tables, and shared data types (`Y.Text`, `Y.Map`, `Y.Array`). It provides methods to create transactions, observe state mutations, encode state vectors, and apply binary updates.

#### Q16: How does Yjs CRDT synchronization work?
> **Answer**:
> Yjs uses a state-based sequence CRDT. Every inserted character is an immutable struct tagged with a unique `(client, clock)` identifier and causal relative positions (`origin` and `rightOrigin`). Clients synchronize by exchanging compact state vectors summarising observed clock ranges. Peers compare state vectors, identify missing item structs, serialize them into compact binary diffs, and merge them using the deterministic YATA algorithm without centralized coordination.

#### Q17: Why can multiple clients edit the same document concurrently?
> **Answer**:
> Because CRDT operations commute mathematically. In traditional databases or text buffers, operations like "insert at index 5" depend on absolute indexes, causing conflicts if another user inserted at index 2. In Yjs, operations attach to immutable character identities rather than transient line/column numbers. The YATA algorithm orders concurrent items using causal dependency graphs and deterministic client ID tie-breaking, ensuring all clients reach the exact same text buffer regardless of the order updates arrive.

#### Q18: What happens to local edits while disconnected?
> **Answer**:
> When disconnected, Monaco Editor continues writing to the local `Y.Doc` via `y-monaco`. Yjs assigns each new character a monotonically increasing clock under the local `clientID`. These structs are held in memory in the document's internal struct store. They are not transmitted over the network until a connection is restored.

#### Q19: Why should the same Y.Doc instance survive reconnect transitions?
> **Answer**:
> If an effect cleanup or reconnect handler instantiates `new Y.Doc()`, the existing in-memory document is garbage-collected, and all uncommitted local keystrokes typed while offline are destroyed. By preserving the exact same `Y.Doc` instance across offline and reconnect events, all local offline items are retained. When the connection re-opens, Yjs compares the preserved document's state vector against the server and transmits the offline edits cleanly.

#### Q20: How do Yjs updates converge after reconnection?
> **Answer**:
> On reconnection:
> 1. Client transmits its `StateVector`.
> 2. Server identifies remote edits made while the client was away and sends them to the client.
> 3. Client identifies local edits made while offline and sends them to the server.
> 4. Both peers call `Y.applyUpdate()`.
> 5. YATA evaluates both update streams. Because concurrent edits carry original causal origins, YATA weaves the concurrent edits together deterministically. Both screens display the exact same code with zero lost characters.

#### Q21: What is the difference between in-memory document preservation and durable offline persistence?
> **Answer**:
> - **In-Memory Preservation**: The `Y.Doc` lives in JavaScript heap memory inside the browser tab. It survives network disconnects, Wi-Fi blips, and server restarts as long as the tab remains open. If the user refreshes (`F5`) or closes the tab while offline, in-memory state is wiped.
> - **Durable Offline Persistence**: Involves serializing the `Y.Doc` transactions into persistent browser storage (e.g. IndexedDB via `y-indexeddb`). Edits survive page reloads and browser crashes while offline. PairPrep currently implements in-memory preservation; durable persistence occurs on the server side via MongoDB once updates reach `/sync`.

#### Q22: What are CRDT conflicts, and how does Yjs resolve concurrent updates?
> **Answer**:
> A conflict in sequence CRDTs occurs when two or more clients insert characters at the exact same location (sharing identical left and right origins) concurrently. Yjs resolves this via the YATA algorithm:
> 1. It navigates the causal origin graph between the left and right neighbors.
> 2. If two concurrent items have identical origins and neither causally precedes the other, YATA breaks the tie deterministically using the client ID (`clientA > clientB`). Because all peers execute this exact rule, convergence is mathematically guaranteed.

---

### Category D: Presence and Awareness

#### Q23: What is the difference between room membership and live presence?
> **Answer**:
> - **Room Membership**: The authoritative, durable record of enrolled participants stored in MongoDB (`room_members` collection). Capped at 6 participants. It persists across sessions, disconnects, and browser closes until explicitly deleted or the room ends.
> - **Live Presence**: The transient, real-time awareness state of connected users managed over WebSockets in memory. It tracks cursor positions, active selections, and live connection status. It is never written to disk and disappears upon disconnection.

#### Q24: What is Yjs Awareness?
> **Answer**:
> Yjs Awareness is an ephemeral key-value protocol layered on top of Hocuspocus/Yjs. Unlike `Y.Doc`, awareness is **not** a CRDT; it does not maintain immutable history. Instead, it stores the latest dictionary state for each active `clientID` (e.g. `{ user: { name, color }, cursor: { anchor, head } }`) with automatic timestamp heartbeats. Stale entries are evicted after 30 seconds of inactivity.

#### Q25: Why should presence not be treated as persistent membership?
> **Answer**:
> Treating presence as membership creates critical bugs:
> 1. If a participant temporarily drops Wi-Fi or refreshes the page, treating presence as membership would evict them from the room, allowing an external 7th user to steal their seat.
> 2. Ephemeral presence packets can be dropped or arrive out of order; using presence for access control creates security vulnerabilities.
> 3. Enforcing membership in MongoDB ensures stable permissions, capacity limits, and audit logs regardless of network flakiness.

#### Q26: How should multiple browser tabs for one user be handled?
> **Answer**:
> Each browser tab creates an independent WebSocket connection with a unique Yjs `clientID`. To prevent multiple tabs from inflating the online member count, the UI must group connections by the authenticated user ID (`member.id`). Multiple tabs for User A result in 1 online count. Presence is only marked offline when all active tabs belonging to User A have disconnected.

#### Q27: Why should online counts count unique members rather than connections?
> **Answer**:
> In PairPrep, rooms have a strict PRD limit of 6 participants (`ROOM-4`). If a candidate opens the room in two tabs (e.g. one for coding, one for viewing instructions), counting raw connections would report 2 participants, prematurely locking out legitimate candidates with a false "Room Full" error. Counting unique authenticated member IDs ensures capacity accurately reflects actual human participants.

#### Q28: What is the difference between Offline and Unavailable?
> **Answer**:
> In `RoomPage.tsx`:
> - **Offline**: Applied to the local user when their own browser drops network connectivity. The local user knows with certainty that they are disconnected. It is also applied to remote members when the local client is connected and the server authoritatively reports that the remote member has no active sockets.
> - **Unavailable**: Applied to remote participants when the **local user's browser is offline**. Because the local client has no server connection, it cannot observe remote presence. Calling remote members "Offline" would be speculative and false. Labeling them **Unavailable** correctly communicates that presence telemetry is temporarily unreachable.

#### Q29: What happens to cursor and selection information when a participant disconnects?
> **Answer**:
> When a participant disconnects, their WebSocket closes and awareness broadcasts stop. The server evicts the client's awareness entry and broadcasts an update. Remote peers receive the eviction, and `useMonacoBinding.ts` removes the remote cursor decoration, name tag, and selection highlight from Monaco's editor model and DOM, while pruning the dynamic CSS class.

#### Q30: Why should local browser connectivity not determine remote participant presence?
> **Answer**:
> Local network disconnection only proves that the local machine cannot reach the network; it provides zero evidence about remote peers. If Candidate A goes offline, Candidate B and the Interviewer may still be actively collaborating in the room. Inferring remote presence from local connectivity would cause misleading UI states, such as claiming the interviewer has left when they are still present.

---

### Category E: React Hooks and State Management

#### Q31: Why use an effect-scoped offline flag?
> **Answer**:
> React state updates are asynchronous and batched. If an event handler updates React state (`setStatus("offline")`), the state variable will not reflect the new value within the current synchronous execution tick. By maintaining a local mutable flag (`let browserOffline = ...`) inside the effect closure, event handlers and late asynchronous callbacks can synchronously inspect `if (browserOffline)` without waiting for a re-render.

#### Q32: How do React effect cleanup functions prevent stale listeners?
> **Answer**:
> When a component unmounts or effect dependencies change, React executes the returned cleanup function. By calling `window.removeEventListener("online", handleOnline)` and `window.removeEventListener("offline", handleOffline)`, the hook guarantees that destroyed component instances do not retain references to window events, preventing memory leaks and state updates on unmounted components.

#### Q33: What is a stale closure?
> **Answer**:
> A stale closure occurs when an asynchronous callback or event listener captures variables from a past render cycle. If state or props change, the callback continues executing with outdated values. In `useRoomSync`, stale closures are avoided by using mutable ref patterns or self-contained effect closures with `isCurrent` guards.

#### Q34: How can asynchronous callbacks cause state races?
> **Answer**:
> Consider an asynchronous WebSocket authentication callback: while the authentication request is processing over the network, the user clicks "Leave Room", causing the component to unmount. If the callback resolves later and invokes `setStatus("connected")`, it attempts to update an unmounted component, causing memory leaks and React warnings. The `isCurrent` generation guard ensures all callbacks abort if the component has unmounted.

#### Q35: Why use refs for tracking previous connection states?
> **Answer**:
> Refs provide mutable storage that persists across render cycles without triggering re-renders when updated. In `RoomPage.tsx`, `prevSyncStatusRef = useRef(sync.status)` tracks the prior connection status across renders. This allows the component to compare `prev !== "connected" && current === "connected"` to detect the exact rising edge of a reconnection.

#### Q36: How should reconnect transitions trigger side effects exactly once?
> **Answer**:
> By comparing the previous connection state stored in a ref with the new connection state inside an effect:
> ```typescript
> if (prevSyncStatusRef.current !== "connected" && sync.status === "connected") {
>   void refreshRoom().catch(() => {});
> }
> prevSyncStatusRef.current = sync.status;
> ```
> Even if `useRoomSync` emits multiple redundant `connected` pulses during steady operation, the condition evaluates to `false` on subsequent renders, firing the side effect strictly once per reconnect transition.

#### Q37: How do you avoid duplicate room refreshes?
> **Answer**:
> Duplicate room refreshes are avoided by:
> 1. Restricting refreshes strictly to reconnect rising edges via `prevSyncStatusRef`.
> 2. Debouncing participant sync polling in `useParticipantSync` (e.g. 500 ms debounce).
> 3. Ensuring that live Yjs awareness changes handle cursor movements directly over WebSockets without triggering REST HTTP requests.

---

### Category F: Reliability and Testing

#### Q38: How do you test offline behavior without relying on a real network outage?
> **Answer**:
> 1. **Unit Testing**: Simulate offline behavior by setting `Object.defineProperty(navigator, 'onLine', { value: false })` and dispatching `window.dispatchEvent(new Event('offline'))`.
> 2. **End-to-End Automation**: In Playwright, call `await context.setOffline(true)`. Chromium's DevTools Network emulation immediately intercepts and drops all outgoing TCP packets, triggering real browser `offline` events and closing active WebSockets.

#### Q39: How do you test late callback races?
> **Answer**:
> In unit tests, instantiate a mock `HocuspocusProvider`, dispatch `window.dispatchEvent(new Event('offline'))`, and then manually invoke the provider's `onStatus({ status: WebSocketStatus.Connected })` or `onSynced({ state: true })` callback. Assert that the hook rejects the callback, maintains `status === "offline"`, and calls `wsProvider.disconnect()`.

#### Q40: How do you verify Y.Doc identity preservation?
> **Answer**:
> In unit tests (`useRoomSync.test.ts`), capture the document reference before triggering network loss: `const initialDoc = result.current.doc;`. Trigger offline mode, type edits into `initialDoc.getText("code")`, trigger online mode, and assert that `result.current.doc === initialDoc` (strict reference equality). Verify that the typed edits remain present in the text buffer.

#### Q41: How do you test multi-tab presence?
> **Answer**:
> In Playwright, open two separate `Page` instances within the same authenticated `BrowserContext` pointing to the same room URL. Verify that both tabs show 1 online member. Close one tab and assert that the remaining tab still reflects the user as Online. Close the second tab and verify from a remote observer context that the user transitions to Offline.

#### Q42: What is the difference between unit tests and end-to-end tests?
> **Answer**:
> - **Unit Tests** (`vitest` / JSDOM): Test isolated React hooks and components with mocked WebSockets and synthetic events. Fast (milliseconds), deterministic, but do not execute real browser rendering engines, network sockets, or Web Workers.
> - **End-to-End Tests** (`playwright`): Launch real Chromium browser processes, load compiled bundles, execute Monaco Web Workers, open real TCP WebSockets, and measure physical screen rendering and cross-process IPC.

#### Q43: How do you distinguish WebSocket RTT from actual editor propagation latency?
> **Answer**:
> - **WebSocket RTT**: Measures network round-trip time between client, server, and back using minimal ping/pong packets (e.g. `latency_ping` -> `latency_pong`). It reflects socket transport latency (~3–5 ms locally).
> - **Editor Propagation Latency**: Measures the full user-perceived editing pipeline: typing a keystroke in Monaco -> `y-monaco` range offset calculation -> Yjs transaction creation -> binary encoding -> WebSocket transmission -> server reception & broadcast -> remote client reception -> binary decoding -> Yjs CRDT merge -> `y-monaco` delta mapping -> Monaco model update -> DOM layout & render. In PairPrep, this was measured at P95 = 25.72 ms.

#### Q44: What does P50 and P95 latency mean?
> **Answer**:
> - **P50 (50th Percentile / Median)**: The latency value below which 50% of all measured samples fall. It represents the typical, everyday user experience (16.79 ms in PairPrep).
> - **P95 (95th Percentile)**: The latency value below which 95% of all samples fall. It captures the tail latency experienced during network jitter or main-thread micro-tasks (25.72 ms in PairPrep). PRD requirement `ED-4` requires P95 to be strictly below 200 ms.

#### Q45: Why is a successful WebSocket 101 handshake not sufficient proof of collaboration correctness?
> **Answer**:
> An HTTP 101 handshake proves only that the server accepted the TCP upgrade request. It does not prove that:
> 1. Authentication succeeded (auth could fail in `onAuthenticate`).
> 2. The room exists and the user is an enrolled member.
> 3. Document CRDT updates are converging without character loss.
> 4. Read-only permissions are enforced against forced edits.
> 5. Awareness cursors are rendering properly in Monaco.
> True correctness requires verifying document sync convergence, permission drops, and DOM rendering.

---

### Category G: System Design and Trade-offs

#### Q46: How would you design offline support for a collaborative editor?
> **Answer**:
> A robust collaborative editor offline architecture requires:
> 1. **CRDT Foundation**: Use sequence CRDTs (like Yjs) so edits are commutative and commute without centralized ordering.
> 2. **Decoupled Editor Buffer**: Bind the editor to an in-memory CRDT model rather than directly to WebSocket message handlers.
> 3. **Connection State Machine**: Clear UI status indicators (Connecting, Synced, Offline, Error).
> 4. **Socket Lifecycle Management**: Halt socket polling while offline; reconnect immediately when online.
> 5. **Two-Tier Storage**: In-memory buffering for tab sessions; IndexedDB for multi-day durable offline editing.
> 6. **State Vector Handshake**: Exchange compact state vectors on reconnect to minimize payload size during sync.

#### Q47: How would you handle reconnect storms?
> **Answer**:
> When a network partition heals or a server restarts, thousands of clients may attempt to reconnect simultaneously:
> 1. **Full Jitter Exponential Backoff**: Clients add randomized jitter to their reconnect interval (`sleep = min(cap, base * 2^attempt) * random(0.5, 1.5)`), smoothing connection spikes.
> 2. **Token-Bucket Handshake Rate Limiting**: The server enforces IP-level and connection-level rate limiting during HTTP upgrade.
> 3. **Compact State Vectors**: Handshake payloads are tiny (~50 bytes), preventing network saturation.

#### Q48: How would you prevent duplicate presence entries?
> **Answer**:
> 1. Separate presence from document CRDT; store presence in an in-memory dictionary keyed by client ID.
> 2. Group client connections by authenticated user ID in the UI layer.
> 3. When a user connects with a new tab, update their presence entry and broadcast the unified user presence.
> 4. Require periodic heartbeats; evict stale presence entries after 30 seconds of silence.

#### Q49: How would you handle a participant with several active devices?
> **Answer**:
> 1. Each device operates its own `Y.Doc` and `clientID`, exchanging state vectors independently.
> 2. In the room participant list, aggregate presence under the user's primary account, displaying an indicator like "Online (2 devices)".
> 3. Enforce per-member connection limits (e.g. maximum 3 active sockets per user) in the server handshake to prevent socket exhaustion attacks.

#### Q50: How would you detect stale presence?
> **Answer**:
> Ephemeral presence cannot rely solely on TCP close frames, as abrupt client power cuts or OS crashes can leave sockets in a half-open state. Stale presence is detected via heartbeat lease times: clients rebroadcast awareness every 5–10 seconds. Peers maintain a timestamp for each remote client. If no packet arrives for `awareness.outdatedTime` (typically 30s), the client is marked stale and evicted.

#### Q51: What are the limitations of browser connectivity events?
> **Answer**:
> Browser `online` and `offline` events are reactive OS network interface triggers. They suffer from:
> 1. **False Positives**: `navigator.onLine` reports true on captive portals, dead routers, or local LANs without internet.
> 2. **Latency**: Events may take several seconds to fire after physical connection loss.
> 3. **No Service Health Awareness**: They provide zero insight into whether the specific backend application service is healthy.
> System design must supplement browser events with end-to-end WebSocket heartbeats and ping/pong health probes.

#### Q52: What additional mechanisms would be required for durable offline editing?
> **Answer**:
> To graduate from in-memory offline preservation to multi-day durable offline editing:
> 1. **IndexedDB Provider**: Integrate `y-indexeddb` to persist CRDT update chunks to browser disk on every local transaction.
> 2. **Service Worker**: Cache application HTML, CSS, JavaScript, and Monaco Web Workers so the web app can launch cold without an internet connection.
> 3. **Background Sync**: Utilize the Service Worker Background Sync API to trigger synchronization when connectivity returns even if the tab was closed.
> 4. **Storage Quota & Eviction Handling**: Handle browser storage pressure gracefully and provide clear sync conflict notifications for long-lived divergent branches.
