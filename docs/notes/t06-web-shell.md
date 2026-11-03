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
- **Solution**: Replaced all Google Fonts references with self-hosted `@fontsource` packages (`@fontsource/geist-sans`, `@fontsource/instrument-serif`, `@fontsource/jetbrains-mono`). Verified via unit test `origin-isolation.test.tsx` that loading the application initiates zero outbound requests to external domains.

---

## 3. Interview Talking Points: How to Explain in an Interview

1. **Why Radix UI primitives over an all-in-one component suite?**
   > *"Radix UI primitives give us headless, fully accessible ARIA compliance and focus trapping without enforcing predefined CSS opinions. This allowed us to apply our exact WCAG AA token system and customize the visual design without fighting library styles or shipping unused bundle weight."*

2. **How does the client enforce CSRF protection without tokens in localStorage?**
   > *"Modern browser cross-origin requests cannot attach custom headers like `X-Requested-With: pairprep` in cross-site `form` posts or unauthorized CORS requests without triggering a preflight check. By pairing `SameSite=Lax` cookies with a mandatory custom header check on all mutating verbs, we get bulletproof CSRF defense without the complexity of stateful sync tokens."*

3. **How is idempotency handled on room creation?**
   > *"The client generates a UUID `crypto.randomUUID()` and attaches it via the `Idempotency-Key` header on `POST /api/v1/rooms`. If a network glitch causes a retry, the backend matches the key in MongoDB and returns the previously created room rather than creating an orphan room."*

---

## 4. Verification Evidence & Metrics

- **Lint**: `eslint .` passed with 0 errors and 0 warnings.
- **Prettier**: `prettier --check .` passed with 100% formatted files.
- **TypeScript**: `tsc --noEmit` passed with 0 errors across `@pairprep/shared`, `@pairprep/server`, and `@pairprep/web`.
- **Unit & Component Tests**: 14 test files and 68 unit/component tests passing in `apps/web` and `test/e2e/support`.
- **Bundle Gzip Metrics**:
  - Main chunk (`index-*.js`): 289.56 kB (gzip: 91.08 kB)
  - Landing chunk (`landing-*.js`): 176.63 kB (gzip: 54.29 kB) — reduced from 214.10 kB raw / 64.04 kB gzip (-9.75 kB gzip, ~15% reduction)
  - Index CSS (`index-*.css`): 50.68 kB (gzip: 9.53 kB)
- **Lighthouse Accessibility Audit**:
  - `/` (Landing Page): **96 / 100**
  - `/login` (Sign-in Page): **100 / 100**
  - `/dashboard` (Authenticated Dashboard): **90 / 100** (anonymous redirect: 100 / 100)
- **Production Build**: Production Vite bundle built successfully with zero errors.

