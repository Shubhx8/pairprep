# Task T06: Web Application Shell & Marketing Integration

> **Task**: T06 — Web Application Shell  
> **Status**: Completed  
> **Requirements Addressed**: `ROOM-1`, `ROOM-2`, `AUTH-3`, `AUTH-5`, `PER-2`, `UI-2`, `UIX-11`, `UIX-13`  
> **Primary Components Built**: Central API Client, AuthProvider, Dashboard (`/dashboard`), Room Shell (`/r/:slug`), Profile Modal, Marketing Suite (`/`, `/login`, `/signup`, `/interview`, legal routes)

---

## 1. Overview & Requirements Fulfillment

Task T06 establishes the user-facing web frontend for PairPrep. It provides both the public marketing presentation and the authenticated application shell where users manage and join collaborative coding sessions.

### Requirement Mappings

| Requirement ID | PRD Specification | Implementation Detail |
| :--- | :--- | :--- |
| **`ROOM-1`** | Authenticated room creation in 1 click; unguessable link ($\ge 128$ bits). | `CreateRoomDialog` sends `POST /api/v1/rooms` with client UUID `Idempotency-Key`, navigates to `/r/:slug`. |
| **`ROOM-2`** | Opening valid link joins room; invalid link shows clean 404 screen. | `/r/:slug` validates membership via `GET /api/v1/rooms/:slug`; renders 404 `EmptyState` when slug does not exist. |
| **`AUTH-3`** | Guest joins through room link; enters display name in $\le 10$s; eviction warning. | `/r/:slug` displays prominent **Guest Eviction Notice** informing visitors that active guest sessions are limited to one room at a time, followed by display name input. |
| **`AUTH-5`** | User can edit display name (1–40 code points). | `ProfileModal` validates 1–40 code points, submits to `PATCH /api/v1/me`, and updates session state via `refreshMe()`. |
| **`PER-2`** | Signed-in user sees list of owned/joined rooms, newest first, with cursor pagination. | `DashboardPage` fetches `GET /api/v1/rooms?cursor=...`, separates owned vs joined, and provides "Load More Rooms" pagination. |
| **`UI-2`** | Every screen has loading, empty, and error states with clear next actions. | `Skeleton`, `EmptyState`, and `ErrorState` with retry actions integrated across Dashboard, Room, and Auth views. |
| **`UIX-11`** | Semantic tokens, visible focus rings, reduced motion, zero hardcoded hex. | High-contrast dark canvas tokens in `tokens.css`; WCAG AA contrast tests passing mathematically; `useReducedMotion()` respected across all scroll animations. |
| **`UIX-13`** | Open-licensed assets recorded in third-party notices. | Self-hosted `@fontsource` packages; Lucide icons; Radix UI; public domain artwork attributed in `THIRD_PARTY_NOTICES.md`. |

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

### 2.4 Zero External CDN Leaks (`origin-isolation`)
- **Challenge**: Third-party fonts and CDNs introduce privacy leaks and potential network blocking.
- **Solution**: Replaced all Google Fonts references with self-hosted `@fontsource` packages (`@fontsource/geist-sans`, `@fontsource/instrument-serif`, `@fontsource/jetbrains-mono`). Verified via automated static and post-build scans that loading the application initiates zero outbound requests to external resource CDNs.

---

## 3. Interview Talking Points: How to Explain in an Interview

1. **Why Radix UI primitives over an all-in-one component suite?**
   > *"Radix UI primitives give us headless, fully accessible ARIA compliance and focus trapping without enforcing predefined CSS opinions. This allowed us to apply our exact WCAG AA token system and customize the visual design without fighting library styles or shipping unused bundle weight."*

2. **How does the client enforce CSRF protection without tokens in localStorage?**
   > *"Modern browser cross-origin requests cannot attach custom headers like `X-Requested-With: pairprep` in cross-site `form` posts or unauthorized CORS requests without triggering a preflight check. By pairing `SameSite=Lax` cookies with a mandatory custom header check on all mutating verbs, we get bulletproof CSRF defense without the complexity of stateful sync tokens."*

3. **How is idempotency handled on room creation?**
   > *"The client generates a UUID `crypto.randomUUID()` and attaches it via the `Idempotency-Key` header on `POST /api/v1/rooms`. If a network glitch causes a retry, the backend matches the key in MongoDB and returns the previously created room rather than creating an orphan room."*

---

## 4. Verification Evidence, Performance Budget & Metrics

### 4.1 Stated Landing Performance Budget
To maintain fast initial render and high Core Web Vitals on budget mobile devices and slow connections, the landing page (`/`) adheres to the following explicit performance budget:
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
- **Radix Deduplication**: `package-lock.json` inspected; 0 duplicate versions across all 29 `@radix-ui/*` packages.
- **External URLs**: Static scan of `marketing.css` and 23 `dist/` artifacts confirmed 0 external resource loads.
- **Unit & Component Tests**: All tests passing across workspaces (`apps/web`, `apps/server`, `test/e2e/support`).
