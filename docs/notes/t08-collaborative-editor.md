# Task T08: Collaborative Code Editor (Phases 1, 2, 2.1, 2.2, 2.2.2, 2.2.3, 2.2.4, 2.2.5 & Phase 3)

> **Task**: T08 — Collaborative Code Editor
>
> **Status**: Phase 3 Implemented & Hardened (Under Independent Review; ED-3 and ED-4 strictly PARTIAL pending production broadband WAN telemetry)
>
> **PRD Requirements Addressed**: `ED-1`, `ED-2`, `ED-3`, `ED-4`, `ED-5`, `ED-6`, `ED-7`, `ROOM-4`, `CONC-1`, `CONC-2`, `AD-1`, `PER-1`
>
> **Primary Components Built**:
>
> - Dependency & Worker Architecture: Monaco Editor (`monaco-editor@0.52.2`), Yjs (`yjs@13.6.33`), `y-monaco@0.1.6`, Hocuspocus Provider (`@hocuspocus/provider@4.7.1`), Vite Web Worker bundler (`editor.worker.js`)
> - Client Synchronization Hook: `useRoomSync.ts` (`apps/web/src/hooks/useRoomSync.ts`)
> - Monaco Editor Integration: `CodeEditor.tsx` (`apps/web/src/components/CodeEditor.tsx`)
> - Monaco Yjs Binding & Remote Cursors: `useMonacoBinding.ts` (`apps/web/src/hooks/useMonacoBinding.ts`)
> - Status Indicator: `SyncStatusIndicator.tsx` (`apps/web/src/components/SyncStatusIndicator.tsx`)
> - Collaborative Editor Shell: `CollaborativeEditor.tsx` (`apps/web/src/components/CollaborativeEditor.tsx`)
> - Room Page Integration: `RoomPage.tsx` (`apps/web/src/pages/RoomPage.tsx`)
> - Utility & Validation Layer: `syncUrl.ts`, `roomId.ts` (`apps/web/src/lib/`)
> - Real-Stack E2E & Monaco Sync Test Suite: Real Two-Client Collaborative Monaco Test (`test/e2e/support/__tests__/monacoSync.test.ts`), Real Browser Monaco Collaboration Spec (`test/e2e/editor-collaboration.spec.ts`), Native Browser-to-Vite WebSocket Proxy Spec (`test/e2e/sync-proxy.spec.ts`), Real Two-Client Collaborative Smoke Test (`test/e2e/support/__tests__/syncSmoke.test.ts`), Session Cookie Injection Harness (`test/e2e/support/sessionHarness.ts`)

---

## 1. Overview & Requirements Fulfillment

Task T08 implements the client-side collaborative code editor for PairPrep. It connects the React frontend (`@pairprep/web`) to the Hocuspocus Yjs synchronization backend built in Task T07 at `/sync`.

### Requirement Mappings (PRD Compliance Matrix)

| Requirement ID | PRD Specification                                                                                                                                                                                | Implementation Detail in T08                                                                                                                                                                                                                                                                                                                                                                                                          | Status & Verification Qualification                                                                                                                                                                    |
| :------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`ED-1`**     | **Monaco editor with syntax highlighting**: Python, C++ and JavaScript highlight correctly; language selectable per room.                                                                        | `CodeEditor.tsx` built with `monaco-editor@0.52.2`, web worker lazy setup via `setupMonacoWorkers()`, custom `pairprep-dark` theme, ResizeObserver layout, and syntax highlighting for Python, C++, and JavaScript. Supported languages strictly validated with `isValidEditorLanguage` and synchronized across participants via `doc.getMap("roomConfig")`. Route-level lazy loading ensures Monaco is never loaded on `/dashboard`. | **DONE** — Verified in `CodeEditor.test.tsx`, `CollaborativeEditor.test.tsx`, and Playwright E2E `editor-collaboration.spec.ts`.                                                                       |
| **`ED-2`**     | **Conflict-free live editing**: Two users typing in the same line concurrently end with identical text on both screens, with neither user's characters lost, in 100 out of 100 automated trials. | `useMonacoBinding.ts` binds Monaco model to canonical `doc.getText("code")` via `y-monaco`. Tested with two real Hocuspocus providers connected over WebSockets to sync server in `ed2Convergence.test.ts` across 100 trials of concurrent same-line edits with deterministic pseudo-random interleaving.                                                                                                                             | **DONE** — Evidence: 100 automated trials, 100 converged, 0 divergent, 0 missing insertions in `ed2Convergence.test.ts`.                                                                               |
| **`ED-3`**     | **Live cursors and selections**: Each remote user's cursor and selection show in a distinct color with a name label, updating in under 200 ms at the 95th percentile.                            | `useMonacoBinding` propagates local selection and cursor to Yjs awareness with user name and safe color from `PARTICIPANT_PALETTE`. Injects scoped dynamic CSS with character sanitization (`escapeCssContent`) for remote cursors, selections, and name badges. Dedicated Playwright test `test/e2e/ed3-ed4-latency.spec.ts` measures 200 samples across dual browser contexts with a single test-process clock.                     | **PARTIAL** — Verified in unit/integration tests and local dual-browser Playwright suites. Kept PARTIAL until actual remote cursor latency measurements exist on the live target deployment.           |
| **`ED-4`**     | **Sync latency**: Remote edit visible in under 200 ms at the 95th percentile on a normal broadband connection (measured, see section 19).                                                        | Minimal, strictly validated stateless `latency_ping`/`pong` handler retained (256-byte cap, exactly three keys, nonce <= 128, token bucket rate limiting, unicast pong, read-only connections allowed). Dedicated Playwright test (`test/e2e/ed3-ed4-latency.spec.ts`) records 200 remote update samples using a single test-process clock.                                                                                           | **PARTIAL** — Minimal stateless ping/pong probe retained and verified in unit/integration suites. Kept PARTIAL until actual text propagation latency measurements exist on the live target deployment. |
| **`ED-5`**     | **Offline tolerance**: Disconnected edits stay in the local editor and merge on reconnect without data loss; a banner shows connection state.                                                    | Local edits continue in-memory while offline and merge deterministically upon reconnection via CRDT state vectors. Verified in Playwright E2E with browser context offline mode (`context.setOffline(true)`). Responsive status indicator reflects `Offline` and `Reconnecting` states.                                                                                                                                               | **DONE** — Operates in-memory for the duration of the active browser tab session; does not persist across page reloads without IndexedDB persistent storage.                                           |
| **`ED-6`**     | **Read-only for viewers**: Viewers cannot modify the document; attempts are rejected by the server, not just the UI.                                                                             | `RoomPage.tsx` and `CollaborativeEditor.tsx` enforce read-only UI for viewers and ended rooms (`editor.updateOptions({ readOnly: true })`), backed by server-side authorization in Hocuspocus `beforeHandleMessage` dropping update frames on `connection.readOnly` sockets. Verified in Playwright E2E by executing direct programmatic Yjs mutations over WebSocket and confirming server rejection and owner immunity.             | **DONE** — Verified at both UI and server protocol layers with genuine forced-edit WebSocket tests.                                                                                                    |
| **`ROOM-4`**   | **Participant limit**: A room holds at most 6 participants; the 7th sees a _Room full_ message.                                                                                                  | Strict capacity limits enforced at HTTP room admission, WebSocket connection authentication (`room_capacity_exceeded` / `room_member_limit_exceeded`), and web UI displaying friendly "Room is Full" empty state. Room ID validated with strict 24-character hexadecimal ObjectId regex.                                                                                                                                              | **DONE** — Verified in server capacity unit tests and frontend error mapping tests.                                                                                                                    |
| **`ROOM-5`**   | **Participant list**: Everyone sees who is present, with name, color and role, updating live.                                                                                                    | `RoomPage.tsx` sidebar participant list polls room state dynamically (every 4s), displaying participant names, distinct safe colors from `PARTICIPANT_PALETTE`, authoritative REST roles (`owner`, `editor`, `viewer`), `(You)` badge for local user, and dynamic membership/role changes without page reload.                                                                                                                        | **DONE** — Verified in Playwright real-browser multi-context test `editor-collaboration.spec.ts`.                                                                                                      |
| **`CONC-1`**   | Multi-client collaborative editing.                                                                                                                                                              | Verified across independent browser contexts and independent `HocuspocusProvider` instances with real session cookies.                                                                                                                                                                                                                                                                                                                | **DONE**                                                                                                                                                                                               |
| **`AD-1`**     | Same-origin WebSocket proxying.                                                                                                                                                                  | Vite dev server configured with `/sync` proxy (`ws: true`) forwarding native browser WebSocket connections to backend on port 3001.                                                                                                                                                                                                                                                                                                   | **DONE**                                                                                                                                                                                               |
| **`PER-1`**    | Document persistence & crash recovery within 2s.                                                                                                                                                 | Backend persistence via Task T07 queues updates with 250ms debounce and 2,000ms scheduling deadline. Verified recovery of persisted state from MongoDB after SIGKILL. Client hook operates in-memory and does not provide offline persistence across page reloads.                                                                                                                                                                    | **PARTIAL** — Verified state reconstruction after SIGKILL for tested edits confirmed in MongoDB; universal 2s durable commit SLA not established for arbitrary crash timings.                          |

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
|   |     ├── 3. Instantiates Y.Doc() (Default GC enabled)                                |   |
|   |     ├── 4. Manages HocuspocusProvider & custom HocuspocusProviderWebsocket          |   |
|   |     ├── 5. Explicit Attachment: activeProvider.attach() (for Hocuspocus v4)         |   |
|   |     └── 6. Subscribes to status, synced, authFailed, close, online/offline events   |   |
|   +------------------------------------------+------------------------------------------+   |
|                                              │                                              |
|                                              │ Native WebSocket ws://localhost:5174/sync    |
+──────────────────────────────────────────────┼──────────────────────────────────────────────+
                                               │ (Includes ambient browser cookie pairprep.sid)
                                               v
+─────────────────────────────────────────────────────────────────────────────────────────────+
| Vite Development Server (Port 5174)                                                         |
|   server.proxy: { '/sync': { target: 'http://localhost:3001', ws: true } }                  |
+──────────────────────────────────────────────┼──────────────────────────────────────────────+
                                               │ HTTP Upgrade to ws://127.0.0.1:3001/sync
                                               v
+─────────────────────────────────────────────────────────────────────────────────────────────+
| Node.js Backend Server (Port 3001)                                                          |
|   Hocuspocus Sync Server (T07 Backend)                                                      |
|   ├── Validates Cookie: pairprep.sid / pairprep.guest                                        |
|   ├── Verifies Room ID & User Membership in MongoDB                                         |
|   ├── Enforces Connection Rate Limiting & Room Capacity                                     |
|   └── CRDT Synchronization & Decoupled Asynchronous Persistence                            |
+─────────────────────────────────────────────────────────────────────────────────────────────+
```

### 2.1 Hocuspocus Provider Version & Lifecycle Architecture (`@hocuspocus/provider@4.7.1`)

During Phase 2.1, a deep architectural audit of `@hocuspocus/provider@4.7.1` established the exact contract for custom WebSocket providers:

1. **Ownership & `manageSocket` Flag**:
   - In `HocuspocusProvider.ts` (lines 289–297), when `websocketProvider` is omitted, the provider creates its own `HocuspocusProviderWebsocket` and sets internal flag `this.manageSocket = true`.
   - When a custom `websocketProvider` is provided (e.g. for testing with custom headers, cookies, or `WebSocketPolyfill`), `this.manageSocket` remains `false`.
2. **Explicit Attachment Required**:
   - Line 264 of `HocuspocusProvider.ts` only automatically invokes `this.attach()` if `this.manageSocket` is true.
   - Therefore, supplying a custom `websocketProvider` **requires calling `activeProvider.attach()` explicitly** to register event listeners on the WebSocket and insert the provider into the WebSocket provider map.
3. **Dual Destruction Responsibilities**:
   - Calling `activeProvider.destroy()` only destroys the WebSocket if `this.manageSocket === true` (lines 650–652).
   - When using a custom `websocketProvider`, `activeProvider.destroy()` detaches the provider, but the creator retains ownership of `customWsProvider` and **must explicitly invoke `customWsProvider.destroy()`**.
   - `useRoomSync` cleanly implements both destructions in its effect cleanup and error handlers.

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

- Importing server modules (`apps/server/src/middleware/session.ts`) into test files loaded `apps/server/src/config.ts`, which executed `loadEnvFileSafely()` and polluted the test runner with root `.env` values (such as a 64-character development session secret).
- When the E2E test harness signed session cookies with the dev secret, but Playwright's `webServer` ran the server with the test secret, cookie verification failed with `401 Unauthorized`.
- Furthermore, setting `NODE_ENV="test"` in `webServer.env` caused `apps/server/src/index.ts` to skip `bootstrapServer()` and exit prematurely.

**Solution implemented in Phase 2.1**:

1. Added guard `if (process.env["NODE_ENV"] !== "test" && !process.env["PAIRPREP_E2E"])` to `apps/server/src/config.ts`.
2. Playwright exports `process.env["PAIRPREP_E2E"] = "1"`, ensuring `.env` is never parsed during E2E runs.
3. Aligned `E2E_MONGODB_URI` and `E2E_SESSION_SECRET` uniformly across both the Playwright runner and the `webServer[0].env` child process.
4. Isolated `test/e2e/sync-proxy.spec.ts` from backend imports, sourcing `SESSION_COOKIE_NAME` exclusively from `./support/sessionHarness.js`.

---

## 3. Key Implementation Files

### 1. `apps/web/src/hooks/useRoomSync.ts`

Manages the complete Hocuspocus WebSocket connection and Yjs document lifecycle.

- Validates 24-character hexadecimal ObjectId.
- Dynamically derives WebSocket URL with protocol matching (`ws:` for `http:`, `wss:` for `https:`).
- Supports optional `WebSocketPolyfill` for Node/test environments with explicit `.attach()`.
- Exposes `status`, `isSynced`, `doc`, `provider`, and `error`.
- Handles browser offline/online transitions without dropping document state.

### 2. `apps/web/src/lib/syncUrl.ts`

Resolves the WebSocket URL for the document synchronization service.

- Translates `http://` / `https://` browser origins to `ws://` / `wss://`.
- Defaults to same-origin path `/sync`.
- Respects `overrideUrl` option or `VITE_SYNC_URL` environment variable if supplied.

### 3. `apps/web/src/lib/roomId.ts`

Validates room identifiers.

- Enforces strict regex `/^[0-9a-fA-F]{24}$/`.
- Rejects URL slugs, nulls, undefined, and non-hexadecimal strings prior to provider construction.

### 4. `test/e2e/sync-proxy.spec.ts`

Verifies the full browser-to-server WebSocket pipeline, unidirectional remote propagation, and fixture exception safety:

- Launches real Chromium browser context with session cookie injection.
- Navigates to `/dashboard` through Vite dev server (`http://localhost:5174`).
- Establishes native browser `HocuspocusProvider` to `ws://${window.location.host}/sync` through Vite's development proxy (`ws: true`).
- Proves full Hocuspocus protocol handshake: genuine event-derived ambient cookie authentication and initial Yjs sync.
- Inserts collaborative Y.Text edit in the browser document and asserts unidirectional propagation to an independently authenticated observer's separate Y.Doc across the real server.
- Verifies rejection of unauthenticated browser connections.
- Provides exception-safe `seedRoom()` fixture lifecycle: rolls back partially inserted records and closes database connections on setup failure.
- _Scope distinction_: This test verifies browser proxy upgrade, ambient cookie auth, and unidirectional browser-to-observer propagation. It does not claim bidirectional synchronization within the browser test itself.

### 5. `test/e2e/support/__tests__/syncSmoke.test.ts`

Real-stack integration tests against a live MongoDB and Hocuspocus server demonstrating bidirectional CRDT convergence and concurrency:

- Connects authenticated client via signed session cookie and updates `code` Y.Text.
- Tests two distinct authenticated clients (Alice and Bob) concurrently in the same room, proving bidirectional CRDT synchronization: Client A inserts prefix, Client B observes prefix and appends suffix, Client A observes suffix and reaches exact Y.Text content equality and encoded Yjs state-vector equality.
- Tests deterministic simultaneous same-position concurrent Y.Text insertion convergence where both clients insert distinct characters at the exact same index without waiting for intermediate network roundtrips, proving both insertions survive, final text converges identically, and Yjs encoded state vectors match exactly (`Y.encodeStateVector(docA)` == `Y.encodeStateVector(docB)`).
- Validates exception-safe concurrent resource cleanup: previously created providers and documents are cleanly destroyed even if setup fails midway through initialization.
- Verifies rejection of unauthenticated connections (`authenticationFailed`).
- Verifies rejection of room URL slugs instead of ObjectIds.
- _Scope distinction_: This test proves CRDT convergence at the character/string and state-vector level for concurrent edits. It does not claim semantic code logic conflict resolution or persistence across client reloads.

### 6. `test/e2e/support/__tests__/monacoSync.test.ts`

Real-stack Monaco Editor and Yjs synchronization tests against a live MongoDB and Hocuspocus server:

- Instantiates two independent Monaco Editor instances (`editorA` and `editorB`) and two independent `Y.Doc` / `HocuspocusProvider` connections in JSDOM.
- Binds Monaco models to canonical `doc.getText("code")` using `MonacoBinding` from `y-monaco`.
- Verifies real bidirectional editing: edits typed into Monaco Editor A propagate over real WebSockets to update Monaco Editor B, and vice versa.
- Verifies same-position concurrent editing: both Monaco editors apply edits at the same position simultaneously, propagate through the server, and deterministically converge to identical content.
- **100/100 Automated Concurrent Convergence Benchmark (ED-2 & ED-4)**: 100 consecutive trials with randomized distinct payloads (`[A${trial}_nonce]`, `[B${trial}_nonce]`), verifying identical final model text, exact character length (`startLen + lenA + lenB`), and zero lost characters.
- **100-Trial Remote Cursor & Selection Latency Benchmark (ED-3)**: 100 trials measuring cursor position/selection updates using sequence numbers and unique nonces, logging min, avg, P50, P95, and max latency (P95 < 5ms localhost RTT).
- Verifies remote awareness and selection propagation: selecting text in Editor A transmits cursor state, user name, and color to Editor B's awareness.
- Verifies graceful awareness cleanup: disconnecting Client B automatically removes Client B from Client A's awareness state.
- Cleans up all Monaco models, editors, bindings, providers, documents, sessions, and database fixtures idempotently. Skips gracefully outside CI if MongoDB is unreachable.

### 7. `test/e2e/editor-collaboration.spec.ts`

Full real-stack Chromium browser collaboration test suite executed with Playwright:

- Launches two real browser contexts (Host and Guest) against Vite (`http://localhost:5173`) and Express/Hocuspocus backend (`http://localhost:3001`).
- Verifies Monaco Editor mounts inside the React component tree with custom `pairprep-dark` theme and `JetBrains Mono` font.
- Tests dynamic language switching (`python` -> `javascript`) updating file indicators and syntax highlighting.
- Tests real-time typing propagation: Host types into Monaco editor and Guest observes edits in real time; Guest types and Host observes edits in real time.
- Verifies remote cursor presence: dynamic awareness stylesheet (`style[data-pairprep-awareness="true"]`) is generated and attached to the DOM with participant name and palette color.
- Tests offline resilience: Host browser context sets `offline: true`, status badge updates to "Offline", local edits remain in memory, and once set back to online, edits merge deterministically across both browsers.
- Tests read-only enforcement: ended room loads Monaco in `readOnly: true` mode, displays "Read-Only" badge and notification banner, disables language selector, and prevents keyboard input from altering document text.
- **Server-Side Forced-Edit Rejection (BLOCKER 1 & ED-6)**: Viewer context attempts a direct programmatic mutation of the shared Y.Doc over WebSocket (`window.__pairprep_sync.doc.getText("code").insert(...)`). Server drops the update frame via `beforeHandleMessage` on the read-only socket. Host editor never receives unauthorized edits, legitimate host edits succeed, and viewer reload discards speculative state.
- **Live Participant List Dynamic Updates (ROOM-5)**: Participant sidebar updates dynamically within 4s without page reload when a new user joins, showing participant name, safe palette color, authoritative REST role, and local `(You)` badge. Dynamic role elevation/demotion reflects live.
- **Monaco Lazy Loading & Web Worker Isolation (ED-1 & Blocker E)**: Verifies component-level dynamic code splitting (`RoomPage.tsx` using `React.lazy(() => import("../components/CollaborativeEditor.js"))`). Navigating to `/dashboard` triggers zero network requests for `monaco-editor`, `editor.worker.js`, or `y-monaco`. Entering a room dynamically loads the isolated editor chunks.
  - Main entry chunk (`index-*.js`): 288.52 kB raw (90.65 kB gzip)
  - Collaborative Editor chunk (`CollaborativeEditor-*.js`): 12.90 kB raw (5.21 kB gzip)
  - Monaco Editor library chunk (`monaco-editor-*.js`): 2,404.83 kB raw (627.80 kB gzip)
  - Monaco Web Worker (`editor.worker-*.js`): 232.35 kB raw
  - Dashboard Page chunk (`DashboardPage-*.js`): 18.54 kB raw (5.63 kB gzip)

---

## 3. Canonical Field Architecture & `getText()` Inventory

PairPrep establishes `"code"` as the canonical Yjs text field for editor content across all web and server components. Legacy documents created in earlier iterations with `"monaco"` are safely and idempotently migrated into `"code"`.

### Canonical Migration Rules

1. **Precedence**: `doc.getText("code")` is canonical. If `"code"` exists in `document.share` (even when intentionally empty `""`), it takes precedence over `"monaco"`. JavaScript truthiness (`"" || ...`) is strictly avoided to prevent resurrecting deleted code.
2. **Transparent Migration**: When `document.share.has("monaco")` is true but `document.share.has("code")` is false, `migrateLegacyDocFields()` transacts the legacy text into `"code"`.
3. **Snapshot Extraction**: `saveSnapshot()` uses `extractCanonicalDocText()`, writing the canonical document text directly into MongoDB `doc_snapshots.text`.

### Comprehensive `getText()` Inventory

| File Path                                                | Line(s)                                                                                       | Target Field           | Context / Purpose                                                                |
| :------------------------------------------------------- | :-------------------------------------------------------------------------------------------- | :--------------------- | :------------------------------------------------------------------------------- |
| `apps/server/src/sync/persistence.ts`                    | 941                                                                                           | `"code"`               | `extractCanonicalDocText`: returns canonical text if present in `document.share` |
| `apps/server/src/sync/persistence.ts`                    | 944                                                                                           | `"monaco"`             | `extractCanonicalDocText`: fallback to legacy field if `"code"` is absent        |
| `apps/server/src/sync/persistence.ts`                    | 961                                                                                           | `"monaco"`             | `migrateLegacyDocFields`: reads legacy text                                      |
| `apps/server/src/sync/persistence.ts`                    | 962                                                                                           | `"code"`               | `migrateLegacyDocFields`: populates canonical field                              |
| `apps/web/src/hooks/useMonacoBinding.ts`                 | 146                                                                                           | `"monaco"`             | Client-side migration: reads legacy text if `"code"` is absent before binding    |
| `apps/web/src/hooks/useMonacoBinding.ts`                 | 149                                                                                           | `"code"`               | Client-side migration: writes legacy text into canonical field                   |
| `apps/web/src/hooks/useMonacoBinding.ts`                 | 154                                                                                           | `fieldName` (`"code"`) | Primary Monaco editor binding to Y.Text                                          |
| `apps/web/src/hooks/__tests__/useMonacoBinding.test.ts`  | 50, 160, 161, 207, 208, 260                                                                   | `"code"`               | Unit tests for Monaco binding and selection mapping                              |
| `apps/web/src/hooks/__tests__/useMonacoBinding.test.ts`  | 240                                                                                           | `"monaco"`             | Unit test verifying legacy migration before mounting                             |
| `apps/server/src/__tests__/sync/legacyMigration.test.ts` | 20, 28, 62, 68, 74, 83, 87, 155                                                               | `"code"`               | Migration unit tests verifying canonical precedence                              |
| `apps/server/src/__tests__/sync/legacyMigration.test.ts` | 27, 39, 55, 67, 79, 138                                                                       | `"monaco"`             | Migration unit tests verifying legacy handling                                   |
| `apps/server/src/__tests__/sync/attribution.test.ts`     | 376, 435, 436                                                                                 | `"code"`               | Server sync attribution tests                                                    |
| `apps/server/src/__tests__/sync/livePermissions.test.ts` | 243, 263, 264, 295, 296, 410, 608, 626, 834                                                   | `"code"`               | Server role-enforced editing tests                                               |
| `test/e2e/support/__tests__/monacoSync.test.ts`          | 223, 274, 413, 414                                                                            | `"code"`               | Real two-client Monaco sync test                                                 |
| `test/e2e/support/__tests__/syncSmoke.test.ts`           | 251, 252, 453, 457, 482, 483, 487, 512, 513, 742, 746, 770, 771, 777, 778, 783, 814, 846, 847 | `"code"`               | Real-stack Hocuspocus sync smoke tests                                           |
| `test/e2e/sync-proxy.spec.ts`                            | 312, 334, 358                                                                                 | `"code"`               | Native browser WebSocket proxy E2E spec                                          |
| `test/e2e/editor-collaboration.spec.ts`                  | 439, 444                                                                                      | `"code"`               | Forced-edit server rejection E2E test                                            |

---

## 4. Verification & Quality Gates

All Phase 1, 2, 2.1, 2.2, 2.2.2, 2.2.3, 2.2.4, 2.2.5, and Phase 3 quality gates pass cleanly:

```bash
# Full Playwright Real Browser E2E Suite (9/9 tests passed)
npm run test:e2e

# Unit & Hook Lifecycle Tests (18/18 passed)
npx vitest run apps/web/src/hooks/__tests__/useRoomSync.test.ts

# Real Hocuspocus Integration Smoke Tests (7/7 passed)
npx vitest run test/e2e/support/__tests__/syncSmoke.test.ts

# Real Two-Client Monaco Editor & Yjs Sync Tests with 100-Trial Latency Benchmark (1/1 passed, 100/100 trials)
npx vitest run test/e2e/support/__tests__/monacoSync.test.ts

# Monaco Editor, Binding, Error Mapping & Collaborative Component Unit Tests (28/28 passed)
npx vitest run apps/web/src/components/__tests__/SyncStatusIndicator.test.tsx apps/web/src/components/__tests__/CodeEditor.test.tsx apps/web/src/hooks/__tests__/useMonacoBinding.test.ts apps/web/src/components/__tests__/CollaborativeEditor.test.tsx apps/web/src/lib/__tests__/syncErrors.test.ts

# Full Workspace Vitest Suite (65/65 test files passed, 532/532 tests passed)
npm run test

# Real-Browser Playwright Collaborative Editor Spec (5/5 passed, trace exported)
npx playwright test test/e2e/editor-collaboration.spec.ts

# Real-Browser Native WebSocket Proxy Spec (3/3 passed)
npx playwright test test/e2e/sync-proxy.spec.ts

# TypeScript Typecheck across all workspaces (0 errors)
npm run typecheck

# Monorepo ESLint (0 errors, 0 warnings)
npm run lint

# Production Build (shared, server, web)
npm run build
```

---

## 5. Non-Blocking Technical Debt

The following non-blocking technical debt items from Phase 2.2.5 and Phase 3 are tracked for future refactoring:

1. **Test-Fixture Rollback Boundary**: In `test/e2e/support/sessionHarness.ts`, partial fixture failure during multi-document seeding cleans up known entities via `try...finally`, but catastrophic process exits during failure-injection tests rely on subsequent test-suite teardown.
2. **Monaco Dynamic Import Code Splitting**: Implemented in Phase 3 via `React.lazy(() => import("../components/CollaborativeEditor.js"))` with Suspense fallback in `RoomPage.tsx`. The collaborative editor, Monaco bindings, and editor workers are split into on-demand chunks (`dist/assets/CollaborativeEditor-*.js`: ~12.9 kB raw / ~5.2 kB gzip, `dist/assets/RoomPage-*.js`: ~47.5 kB raw / ~12.9 kB gzip, and separate web worker chunks ~154 kB raw / ~46 kB gzip) loaded exclusively upon room navigation. Route-level code-splitting guarantees that `/dashboard` and non-editor pages never download or evaluate Monaco. Future optimization (T15) may optionally dynamic-import extended language servers if full LSP support is added.

---

## 6. How to Explain This in an Interview

### System Overview & Problem Statement

"In Task T08, I built the client-side collaborative code editor architecture for PairPrep using Monaco Editor, Yjs CRDTs, and the Hocuspocus client provider. The system connects the React web application to the Hocuspocus synchronization backend built in Task T07, providing conflict-free live collaborative editing, connection status monitoring, browser-proxy WebSocket routing, and strict React StrictMode lifecycle safety with systematic resource cleanup to prevent socket and timer leaks."

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

- **Problem**: In local development, the Vite frontend dev server runs on port 5174 while the Express/Hocuspocus backend runs on port 3001. Because origin includes scheme, host, and port, requests from `http://localhost:5174` to `ws://localhost:3001/sync` are cross-origin. While browsers do attach ambient cookies to certain cross-origin WebSocket requests if same-site, cross-origin WebSocket connections can encounter cookie-handling inconsistencies, require explicit cross-origin header allowance, and diverge from the production deployment model where Caddy serves web assets and proxies API/WebSocket traffic under a single unified origin (`AD-1`).
- **Solution**: We routed client WebSocket connections through Vite's same-origin development proxy (`/sync` with `ws: true`). The browser connects to `ws://${window.location.host}/sync`, treating the connection as strictly same-origin. This ensures first-party `HttpOnly` session cookies (`pairprep.sid`) are consistently transmitted during the HTTP upgrade handshake without cross-origin friction.
- **Trade-off**: Requires dev proxy configuration in Vite, but mirrors the single-origin reverse-proxy architecture (such as Caddy or AWS ALB) deployed in production.

#### 4. Playwright E2E Environment Isolation Without Mock Shortcuts

- **Problem**: In Playwright E2E tests, the test runner process transitively imported server code, triggering `config.ts` to load the development `.env` file with a 64-character secret. Meanwhile, the server process ran with the fallback 51-character test secret. The signature mismatch caused real browser requests to fail with `401 Unauthorized`.
- **Solution**: Rather than bypassing authentication or mocking session cookies, we isolated the environment: added a `!process.env["PAIRPREP_E2E"]` guard to `loadEnvFileSafely()`, exported `PAIRPREP_E2E="1"` in `playwright.config.ts`, unified `E2E_SESSION_SECRET` across both processes, and decoupled test helper imports from server internals.
- **Trade-off**: Maintained authentic real-stack security verification without compromising the purity of the production authentication logic.

---

### Common Interview Questions & Concise Answers

#### Q: _"How does the client know whether it's safe to start typing or rendering collaborative cursors?"_

> _"The `useRoomSync` hook exposes two reactive states: `status` ('connecting' | 'connected' | 'reconnecting' | 'offline' | 'disconnected' | 'error') and `isSynced: boolean`. `isSynced` is driven by Hocuspocus's `onSynced` event, which only fires `true` after the initial Yjs handshake exchanges state vectors and applies any remote document updates. This guarantees the editor never renders stale local state over fresh remote changes."_

#### Q: _"Why does `useRoomSync` validate the room ID with a regex before creating the provider?"_

> _"PairPrep rooms use 24-character hexadecimal MongoDB ObjectIds for document names, whereas the frontend URL routes often use human-readable slugs (e.g., `/rooms/practice-algorithms-101`). If a client attempted to connect using the slug, Hocuspocus would create an orphaned document in memory, and the backend authentication hook would reject it. Validating the ObjectId client-side fails fast, avoiding wasted network handshakes and giving the user immediate, actionable feedback."_

#### Q: _"How do you ensure Yjs doesn't leak memory during long collaborative editing sessions?"_

> _"By default, `Y.Doc` instances enable garbage collection (`gc: true`), which purges deleted item contents and only retains minimal tombstone structures to preserve CRDT causality. In `useRoomSync`, we instantiate `new Y.Doc()` with default GC enabled, and explicitly call `activeDoc.destroy()` during unmount cleanup, ensuring all internal transaction observers and item stores are freed."_

#### Q: _"What happens when a user's internet drops while editing?"_

> _"The browser fires a window `offline` event, which `useRoomSync` listens for, immediately updating `status` to `'offline'`. Because Yjs stores the document in local memory, the user can continue typing locally while the application session remains open in the browser tab (note: in-memory state is transient and not retained across page refreshes or tab closures unless paired with persistent client storage like IndexedDB). When network connectivity restores (`online` event), Hocuspocus attempts automatic reconnection, transitions `status` back to `'reconnecting'` and then `'connected'`, exchanges state vectors with the server, and merges all offline edits deterministically using Yjs CRDT convergence (resolving character-level concurrent operations deterministically, though semantic code logic conflicts may still require human inspection)."_
