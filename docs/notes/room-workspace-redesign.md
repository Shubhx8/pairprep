# PairPrep — Room Workspace UI/UX Redesign Note

## 1. Context & Motivation

The original room layout docked a static participants bar on the left and a collapsible chat on the right, which constrained developer focus and lacked flexibility for multi-role live technical interviews.

Inspired by modern developer IDE workspaces (such as the reference three-column collaborative workbench), this redesign rebuilds the `RoomPage` into an ergonomic, symmetrical three-column coding environment with independent upper toolbar toggles, draggable splitters, independent panel scrollbars, and robust responsive drawer fallbacks.

---

## 2. Architectural Design & Key Changes

### A. Symmetrical 3-Column IDE Layout
1. **Left Column — Members Panel (`MembersPanel.tsx`)**:
   - Displays real-time participants count (`onlineCount` / `totalMembersCount`).
   - Role badges (`Owner`, `Editor`, `Viewer`) with WCAG AA compliant colors.
   - Independent vertical scrolling with `.custom-scroll` and `overscroll-behavior: contain`.
   - Host quick invite link with copy feedback.
2. **Center Column — Collaborative Monaco Editor & Terminal**:
   - Undisputed visual anchor of the workspace.
   - Monaco automatically responds to layout dimension changes via container `ResizeObserver` invoking `editor.layout()`.
   - Dedicated terminal & execution output console.
3. **Right Column — Live Room Chat (`ChatPanel.tsx`)**:
   - Scrollable message history with auto-scroll lock.
   - Pinned composer with 1000-character counter.
   - XSS sanitization and unread message indicators.

### B. Independent Upper Toolbar Toggle Controls
- Pinned in the workspace header within a segmented layout controls group:
  - `[ 👥 Members {count} ]` (`data-testid="members-toggle-button"`, `aria-controls="members-panel"`).
  - `[ 💬 Chat {unread} ]` (`data-testid="chat-trigger-button"`, `aria-controls="chat-panel"`).
- Supports all 4 workspace modes:
  1. Both panels open (Full 3-column workspace).
  2. Members only (Focus on attendees + code).
  3. Chat only (Code + conversation).
  4. Both closed (Distraction-free maximum code editor view).

### C. Drag-to-Resize (`ResizeHandle.tsx`)
- Accessible vertical splitter (`role="separator"`, `aria-orientation="vertical"`).
- Uses Pointer Events API (`setPointerCapture`) for smooth dragging regardless of cursor drift over iframe/Monaco canvas.
- Min/max bounding:
  - Members: min 220px, max 400px, default 280px.
  - Chat: min 260px, max 480px, default 320px.
- Keyboard accessible: `ArrowLeft`/`ArrowRight` (±10px), `Home`/`End` (min/max), `Enter`/double-click to reset.

### D. Mobile Adaptability (< 1024px)
- On desktop (>= 1024px), panels dock as columns in the flex row.
- On mobile (< 1024px), panels gracefully become accessible overlay drawers with a dimmed backdrop (`bg-overlay/60 backdrop-blur-xs`).
- On initial page load on mobile, side panels start closed to preserve immediate code visibility.
- Focus trapping and Escape key closing ensure strict accessibility compliance.

---

## 3. Trade-offs & Decisions

| Decision | Trade-off | Rationale |
|---|---|---|
| Single DOM node for desktop & mobile | Slightly more complex Tailwind class switching (`fixed ... lg:static`) | Avoids duplicate component trees, double socket event listeners, and duplicate test queries in Testing Library. |
| In-browser Pointer Capture | Pointer capture requires pointerId management | Avoids missed `mouseup` events when user drags quickly across the Monaco editor or iframe. |
| Tokenized scrollbars in `tokens.css` | Extra CSS custom property definitions | Adheres strictly to UIX-11 token guard; prevents hardcoded RGB/HEX values in CSS files. |

---

## 4. How to Explain in an Interview

- **Monaco Auto-Layout Architecture**: When building a dynamic multi-column workbench, the primary pitfall is Monaco Canvas distortion or lack of reflow when panels collapse or expand. We solved this by pairing CSS flexbox (`flex-1 min-w-0`) with a `ResizeObserver` on the editor wrapper, decoupling layout state from Monaco's internal pixel grid.
- **Accessible Draggable Splitters**: Rather than relying on heavyweight external drag libraries, we built an accessible `ResizeHandle` conforming to W3C ARIA Splitter design patterns (`role="separator"`, `aria-valuenow`, keyboard navigation, pointer capture).
- **Single Source of Truth for Real-time Contracts**: The visual redesign was achieved with zero mutations to the underlying real-time contracts (Yjs awareness, Socket.IO outbox events, chat rate limiter, and plain-text XSS guards).

