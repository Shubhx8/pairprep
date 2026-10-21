# Phase 1: Real-Time Collaborative Workspace & Rooms

Implementation plan for Phase 1 (Week 2 of PRD).
After each task: run quality checks (lint, format, typecheck, test, build), review the diff, and commit with Conventional Commits.

---

## Task 1: Room Lifecycle, Unguessable Slugs, Roles & Guest Identity

- **PRD Requirements**: `ROOM-1`, `ROOM-2`, `ROOM-3`, `ROOM-4`, `ROOM-5`, `AUTH-3`, `AUTH-4`, `SEC-2`, `CONC-3`.
- **Scope**:
  - Add Room, Member, Role, and Guest Zod schemas to `@pairprep/shared`.
  - Cryptographically secure 128-bit unguessable slug generation (at least 16 bytes entropy).
  - In-memory / repository-pattern Room store with participant tracking (max 6 participants per room).
  - HTTP endpoints in `apps/server`:
    - `POST /api/v1/rooms` (Create room with language, type, title, 128-bit slug, idempotency key support).
    - `GET /api/v1/rooms/:slug` (Get room metadata, active participants, and current user role).
    - `POST /api/v1/rooms/:slug/join` (Guest join with display name, assigns distinct color & session cookie).
    - `PATCH /api/v1/rooms/:slug/members/:id` (Role update: owner can change member role).
    - `DELETE /api/v1/rooms/:slug/members/:id` (Remove member).
  - Unit & integration tests in `apps/server/src/__tests__/rooms.test.ts` verifying all role constraints and participant limit (6 max, 7th rejected).
- **Done when**:
  - All endpoints pass input validation via Zod.
  - 100% of room lifecycle test cases pass in Vitest.
  - Endpoints return structured JSON logs with `requestId`.

---

## Task 2: Yjs CRDT WebSocket Server & Room-Based Document Isolation

- **PRD Requirements**: `ED-2`, `ED-6`, `CONC-1`, `CONC-2`, `ATTR-1`.
- **Scope**:
  - Embed Yjs WebSocket sync server into the Node HTTP server.
  - Room-level isolation: each room slug maps to an isolated `Y.Doc`.
  - Server-side role enforcement: `viewer` connections cannot push updates to the shared `Y.Doc`.
  - Server-side `client_map` tracking: records which Yjs client ID belongs to which user/guest identity.
  - Automated concurrency and duplicate-delivery tests in Vitest.
- **Done when**:
  - Two simulated WebSocket clients can synchronize document edits concurrently without conflict.
  - Read-only viewer updates are rejected by the server.

---

## Task 3: Monaco Editor with Collaborative Editing & Live Cursors

- **PRD Requirements**: `ED-1`, `ED-3`, `ED-4`, `ED-5`, `LIVE-1`, `LIVE-2`, `LIVE-3`, `LIVE-4`.
- **Scope**:
  - Integrate Monaco Editor into `apps/web`.
  - Bind Monaco model to Yjs `Y.Text` using `y-monaco`.
  - Real-time cursor awareness: remote cursor flags, names, and distinct color badges.
  - Typing indicators and transient remote edit highlights.
  - Connection status banner (connected, offline/reconnecting).
- **Done when**:
  - Two browser windows editing the same room display live updates and remote cursors in real time (< 200 ms).

---

## Task 4: Responsive Workspace Layout, Resizable Panes & Personal Settings

- **PRD Requirements**: `UIX-1`, `UIX-2`, `UIX-3`, `UIX-4`, `UIX-5`, `UIX-6`, `UIX-7`, `UIX-13`.
- **Scope**:
  - Resizable 3-pane layout (problem panel, Monaco editor, console/chat).
  - Themes (Light, Dark, High-contrast, Dracula, Nord, Solarized).
  - Monospace font selection, text size slider, and personal settings drawer.
  - Settings persistence in `localStorage` per user/guest.
- **Done when**:
  - Panes can be smoothly resized with minimum bounds and collapse toggles.
  - Changing personal settings does not affect another participant's screen.

---

## Task 5: Document Persistence & Production Deployment Verification

- **PRD Requirements**: `PER-1`, `OPS-2`, `QA-4`, `QA-5`.
- **Scope**:
  - Periodic document snapshotting and graceful termination flush on SIGTERM/SIGINT.
  - End-to-end multi-client test verification in CI.
  - Automated deployment to Azure VM via GitHub Actions pipeline.
- **Done when**:
  - Server restart preserves document state with zero data loss.
  - Live deployment verified on Azure VM.
