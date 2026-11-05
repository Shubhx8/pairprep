# Task T06: Web Application Shell & Marketing Integration

> **Task**: T06 — Web Application Shell  
> **Status**: Completed  
> **Requirements Addressed**: `ROOM-1`, `ROOM-2`, `ROOM-4`, `AUTH-3`, `AUTH-5`, `PER-2`, `UI-2`, `UIX-11`, `UIX-13`, `SEC-1`, `SEC-2`, `SEC-3`, `OBS-4`  
> **Primary Components Built**: Central API Client (`apiClient.ts`), AuthProvider (`authContext.tsx`), Dashboard (`/dashboard`), Room Shell (`/r/:slug`), Profile Modal, Marketing Suite (`/`, `/login`, `/interview`, `/contact`, `/privacy`, `/terms`)

---

## 1. Overview & Requirements Fulfillment

Task T06 establishes the user-facing web frontend for PairPrep. It provides both the public marketing presentation and the authenticated application shell where users manage and join collaborative coding sessions.

### Requirement Mappings

| Requirement ID | PRD Specification | Implementation Detail | Status |
| :--- | :--- | :--- | :--- |
| **`ROOM-1`** | Authenticated room creation in 1 click; unguessable link ($\ge 128$ bits). | `CreateRoomDialog` sends `POST /api/v1/rooms` with client UUID `Idempotency-Key`, navigates to `/r/:slug`. | **Verified** |
| **`ROOM-2`** | Opening valid link joins room; invalid link shows clean 404 screen. | `/r/:slug` validates membership via `GET /api/v1/rooms/:slug`; renders 404 `EmptyState` when slug does not exist. | **Verified** |
| **`ROOM-4`** | Room holds at most 6 participants; 7th participant sees *Room full* message. | `/r/:slug` checks `memberCount >= 6` and handles 409 `ROOM_FULL`; renders dedicated *Room is Full* `EmptyState`. | **Verified** |
| **`AUTH-3`** | Guest joins through room link; enters display name in $\le 10$s; eviction warning. | `/r/:slug` displays prominent **Guest Eviction Notice** informing visitors that active guest sessions are limited to one room at a time, followed by display name input. | **Verified** |
| **`AUTH-5`** | User can edit display name (1–40 code points). | `ProfileModal` validates 1–40 code points, submits to `PATCH /api/v1/me`, and updates session state via `refreshMe()`. | **Verified** |
| **`PER-2`** | Signed-in user sees list of owned/joined rooms, newest first, with cursor pagination. | `DashboardPage` fetches `GET /api/v1/rooms?cursor=...`, separates owned vs joined, and provides "Load More Rooms" pagination. | **Verified** |
| **`UI-2`** | Every screen has loading, empty, and error states with clear next actions. | `Skeleton`, `EmptyState`, and `ErrorState` with retry actions integrated across Dashboard, Room, and Auth views. | **Verified** |
| **`UIX-11`** | Semantic tokens, visible focus rings, reduced motion, zero hardcoded hex. | High-contrast dark canvas tokens in `tokens.css`; WCAG AA contrast tests passing mathematically; `useReducedMotion()` respected across all scroll animations. | **Verified** |
| **`UIX-13`** | Open-licensed assets recorded in third-party notices. | Self-hosted `@fontsource` packages; Lucide icons; Radix UI; public domain artwork attributed in `THIRD_PARTY_NOTICES.md` and `docs/landing-assets.md`. | **Verified** |
| **`SEC-1`** | CSRF protection & strict origin validation. | Client `apiClient.ts` injects `X-Requested-With: pairprep` on mutating verbs; server rejects missing header with 403 `CSRF_REJECTED`. | **Verified** |
| **`SEC-2`** | Open-redirect protection & error sanitization. | `returnTo` sanitized to relative paths (`/` or `/dashboard`); OAuth errors mapped to strict allowlist with user-friendly messages. | **Verified** |
| **`SEC-3`** | Privacy & search indexing defenses. | `infra/Caddyfile` and `index.html` enforce `X-Robots-Tag: noindex, nofollow` and `Referrer-Policy: no-referrer` on `/r/*` and `/dashboard`. | **Verified** |
| **`OBS-4`** | Request ID correlation and observability. | `apiClient.ts` extracts `X-Request-Id` from error responses and displays it in UI error boundaries for tracing. | **Verified** |

---

## 2. Key Architectural Decisions & Trade-Offs

### 2.1 Dual Theme Architecture (Marketing vs. App Shell)
- **Challenge**: The marketing landing page uses a warm stone/sand palette (`oklch(0.986 0.004 95)`) with rich glassmorphism matching the design system, whereas the code editor and authenticated web shell demand a dark canvas (`#090D16`) to maximize syntax contrast.
- **Solution**: Scoped all marketing variables strictly under `.marketing` in `apps/web/src/marketing/marketing.css`. Kept `apps/web/src/styles/tokens.css` as the pure design token source of truth for the application shell.

### 2.2 Central API Client & Defense-in-Depth CSRF
- **Challenge**: State-changing requests (`POST`, `PATCH`, `DELETE`) require the custom header `X-Requested-With: pairprep` to satisfy server-side CSRF perimeter checks, and 429 responses must parse `Retry-After` into an active countdown.
- **Solution**: Created `apps/web/src/lib/apiClient.ts` wrapping `window.fetch`. It automatically attaches `X-Requested-With: pairprep` on state-changing methods, passes `credentials: "include"`, extracts `x-request-id` and `retry-after`, and parses server errors into strongly-typed `ApiClientError` instances.

### 2.3 Guest Eviction Lifecycle Transparency (`AUTH-3`)
- **Challenge**: Guests are limited to one active room at a time in version 1 to protect server memory and prevent session abuse. Joining a new room re-keys their guest cookie and disconnects their previous room.
- **Solution**: Before submitting the guest join form on `/r/:slug`, an explicit note banner is rendered:
  > *"Guest Eviction Notice: Active guest participation is limited to one room at a time; joining this room will disconnect and replace your guest session in any previous room."*

### 2.4 Room Capacity Limit & 7th Participant UX (`ROOM-4`)
- **Challenge**: Rooms hold at most 6 participants. When a 7th user navigates to `/r/:slug` or attempts to join, they must receive a clear message indicating capacity is reached rather than an ambiguous failure.
- **Solution**: Evaluates `room.memberCount >= 6` and catches server 409 `ROOM_FULL` errors, rendering a dedicated `EmptyState` with the title *"Room is Full"*, description *"This practice room has reached its maximum capacity of 6 participants."*, and a direct link back to `/dashboard`.

### 2.5 Zero External CDN Leaks (`origin-isolation`)
- **Challenge**: Third-party fonts and CDNs introduce privacy leaks and potential network blocking.
- **Solution**: Replaced all Google Fonts references with self-hosted Latin-only `@fontsource` packages (`@fontsource/geist-sans`, `@fontsource/instrument-serif`, `@fontsource/jetbrains-mono`). Verified via automated static and post-build scans (`scripts/scan-external-urls.mjs`) that loading the application initiates zero outbound requests to external resource CDNs.

### 2.6 Static Preload Optimization & Speculative Pre-parser Discovery
- **Challenge**: Injecting the hero image `<link rel="preload">` via JavaScript in `<head>` delayed discovery until JS execution, adding ~200–400ms to Largest Contentful Paint (LCP).
- **Solution**: Placed the preload tag statically in `index.html` with matching `imagesrcset` and `imagesizes`. The browser's C++ preload scanner immediately discovers and parallel-downloads the hero image during initial HTML tokenization.

---

## 3. Marketing Suite & Policy Compliance

### 3.1 Route Architecture (`routes.ts`)
- `routes.start`: Points directly to `/dashboard`.
- `routes.signIn` and `routes.signUp`: Point to `/login`. `/signup` is permanently redirected to `/login` to prevent broken sign-up funnels.
- `/rooms/new`: Removed in favor of authenticated dashboard modal flow.

### 3.2 Pure OAuth Login Form
- `/login` contains no dead email/password input fields.
- Full-page links initiate OAuth directly against `/api/v1/auth/google` and `/api/v1/auth/github` with sanitized `returnTo` parameters.
- If a provider strategy is unregistered at runtime, Express safely redirects to `/login?error=provider_unavailable`, displaying a friendly toast/banner.

### 3.3 Accurate Privacy & Terms Disclosures
- **Room Lifecycle**: Rooms (not user accounts) are archived after 30 days of inactivity.
- **Content Storage**: Room code and chat are retained in MongoDB until room deletion; code and chat are never written to server logs.
- **Account Deletion**: Users request deletion by contacting support via `/contact` (no non-functional self-service deletion button).
- **Cookies**: Discloses `pairprep.sid` (7-day authenticated session) and `pairprep.guest` (1-day room participant cookie).
- **OAuth Data**: Discloses storage of display name, verified email (if provided), and avatar URL.

---

## 4. Verification Evidence, Performance Budget & Metrics

### 4.1 Stated Landing Performance Budget
To maintain fast initial render and high Core Web Vitals on mobile devices and slow connections, the landing page (`/`) adheres to the following explicit performance budget:
- **First-load JavaScript**: $\le 160$ kB gzip (entry chunk + landing route chunk).
- **First-load Stylesheets**: $\le 20$ kB gzip (global styling + latin typography).
- **Landing route chunk**: $\le 50$ kB gzip.
- **Mobile Lighthouse**: Score $\ge 75$ on Performance, and $100$ on Accessibility, Best Practices, and SEO.

### 4.2 Measured Bundle Gzip Metrics (Post-Optimization)
- **Main entry chunk (`index-*.js`)**: 289.39 kB (gzip: 91.01 kB)
- **Landing page chunk (`landing-*.js`)**: 145.03 kB (gzip: 45.44 kB) — reduced from 176.63 kB (54.29 kB gzip) through `<LazyMotion>` + `domAnimation` + `<m.*>` components.
- **Fontsheet CSS (`sheet-*.css`)**: 16.44 kB (gzip: 3.71 kB) — reduced from 39.54 kB (17.80 kB gzip) by importing Latin-only `@fontsource` subsets.
- **Index CSS (`index-*.css`)**: 51.33 kB (gzip: 9.59 kB)
- **Total first-load JS + CSS for `"/"`**: 502.19 kB raw (gzip: **149.75 kB**), fully within the $\le 180$ kB combined budget.

### 4.3 Mobile Lighthouse Audit (Compressed Built Site — 5 Runs on Idle Machine)
Audit executed against the production build served with gzip compression on `127.0.0.1:4173`:
- **Run 1**: Performance **79** | FCP: 0.8 s | LCP: 4.6 s | TBT: 240 ms | CLS: 0.024
- **Run 2**: Performance **78** | FCP: 0.8 s | LCP: 4.8 s | TBT: 230 ms | CLS: 0.024
- **Run 3**: Performance **69** | FCP: 0.8 s | LCP: 4.8 s | TBT: 490 ms | CLS: 0.024
- **Run 4**: Performance **77** | FCP: 0.8 s | LCP: 4.8 s | TBT: 260 ms | CLS: 0.024
- **Run 5**: Performance **77** | FCP: 0.8 s | LCP: 4.8 s | TBT: 240 ms | CLS: 0.024
- **Median Performance**: **77 / 100**
- **LCP Element**: `div.marketing > main#main-content > section#top > img.hero-terrain`

#### Analysis of the Score Fluctuation (Drop from 78 to 56 and Recovery to 77–79)
1. **JavaScript Preload Injection vs. Static HTML Discovery**:
   When the hero preload `<link rel="preload">` was dynamically injected via client-side JavaScript in `<head>`, the browser's speculative pre-parser (preload scanner) could not discover the hero image during initial HTML tokenization. Image download was deferred until after the script block was parsed and executed, adding critical latency to LCP. Restoring the static `<link rel="preload">` directly in `index.html` with `imagesrcset` allowed immediate parallel fetching.
2. **CPU Contention & Total Blocking Time (TBT)**:
   In Lighthouse mobile simulation (4x CPU slowdown), TBT accounts for 30% of the performance score. During earlier benchmark runs, concurrent background tasks (test runner execution and Docker connection retries) placed heavy load on the host CPU. This increased TBT from ~230 ms to ~550 ms, single-handedly dropping the composite score from ~78 to 56. On an idle machine with static preload, TBT stabilizes at ~240 ms and performance returns to **77–79**.

### 4.4 Verification Summary
- **Lint**: `eslint .` passed with 0 errors and 0 warnings.
- **Prettier**: `prettier --check .` passed with 100% formatted files.
- **TypeScript**: `tsc --noEmit` passed with 0 errors across `@pairprep/shared`, `@pairprep/server`, and `@pairprep/web`.
- **Radix Deduplication**: `package-lock.json` inspected; 0 duplicate versions across all 29 `@radix-ui/*` packages (`@radix-ui/react-accordion` pinned to 1.3.1, `@radix-ui/react-slot` pinned to 1.5.0).
- **Framer Motion**: Pinned to exact version `12.43.0` which natively supports React 18 and satisfies peer dependencies.
- **External URLs**: Static scan of `marketing.css` and 23 `dist/` artifacts confirmed 0 external resource loads.
- **Unit & Integration Tests**: 38 test files, 271 tests passing (0 failures).
- **E2E Tests**: Playwright tests passing across both mocked multi-context workflows and real-stack MongoDB execution.

---

## 5. Walkthrough Verification Checklist

| Step | Verification Item | Expected Behavior | Codebase / Runtime Verification | Status |
| :--- | :--- | :--- | :--- | :--- |
| **1** | Sign in with GitHub | Lands on `/dashboard`, not the landing page | `RootRoute` and `handleOAuthCallback` redirect authenticated users to `/dashboard`. | **Verified** |
| **2** | Create a practice room | Lands on `/r/<slug>` | `CreateRoomDialog` executes `POST /rooms` and navigates to `/r/${room.slug}`. | **Verified** |
| **3** | Open link in private window | Guest notice shows, name form works, participant count updates | `RoomPage.tsx` renders Guest Eviction Notice, accepts display name, and increments participant count. | **Verified** |
| **4** | Made-up slug / 7th participant | 404 page for bad slug; "Room is Full" screen for 7th participant | `RoomPage.tsx` displays 404 on `ROOM_NOT_FOUND` and dedicated capacity screen on `ROOM_FULL` or `memberCount >= 6`. | **Verified** |
| **5** | Profile modal | Changes display name | `ProfileModal.tsx` submits `PATCH /api/v1/me` and updates context across the UI. | **Verified** |
| **6** | Signed-out `/dashboard` | Redirects to `/login` | `ProtectedRoute` in `App.tsx` intercepts unauthenticated visitors and redirects to `/login`. | **Verified** |

---

## 6. Interview Talking Points

1. **Why Radix UI primitives over an all-in-one component suite?**
   > *"Radix UI primitives give us headless, fully accessible ARIA compliance and focus trapping without enforcing predefined CSS opinions. This allowed us to apply our exact WCAG AA token system and customize the visual design without fighting library styles or shipping unused bundle weight."*

2. **How does the client enforce CSRF protection without tokens in localStorage?**
   > *"Modern browser cross-origin requests cannot attach custom headers like `X-Requested-With: pairprep` in cross-site `form` posts or unauthorized CORS requests without triggering a preflight check. By pairing `SameSite=Lax` cookies with a mandatory custom header check on all mutating verbs, we get bulletproof CSRF defense without the complexity of stateful sync tokens."*

3. **How is idempotency handled on room creation?**
   > *"The client generates a UUID `crypto.randomUUID()` and attaches it via the `Idempotency-Key` header on `POST /api/v1/rooms`. If a network glitch causes a retry, the backend matches the key in MongoDB and returns the previously created room rather than creating an orphan room."*

4. **Why separate marketing tokens from application tokens?**
   > *"Marketing sites and web IDEs have fundamentally different visual affordances. Scoping marketing styles under `.marketing` preserves the warm, editorial brand aesthetic while keeping our core token architecture (`tokens.css`) strictly focused on high-contrast syntax highlighting, dark mode elevation, and low visual fatigue for interviewees."*
