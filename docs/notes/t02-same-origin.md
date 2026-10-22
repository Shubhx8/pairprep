# Technical Note: T02 Same-Origin Hosting with Caddy

## 1. Overview & Architectural Decisions

Task T02 establishes a unified **same-origin hosting architecture (AD-1)** for PairPrep in accordance with PRD sections 10, 18, and `AGENTS.md`.

### Key Architectural Decisions:

1. **One-Origin Unification (`AD-1`)**:
   - Instead of hosting the React frontend on a separate static host or CDN and the backend on an API subdomain (which causes cross-origin cookie blocking, third-party cookie restrictions in Safari/Brave, and complicated CORS configurations), a single hostname serves the entire platform.
   - Caddy serves the static Vite SPA files (`/srv/web`) and proxies `/api/*`, `/healthz`, `/socket.io/*`, and `/sync*` internally to the Node.js API container on port 3000.

2. **Caddy Reverse Proxy & SPA Fallback (`infra/Caddyfile`)**:
   - Dynamically resolves the site hostname using `{$SITE_ADDRESS:http://localhost}` for seamless switching between local development and production.
   - Enables gzip compression (`encode gzip`).
   - Uses `try_files {path} /index.html` within a catch-all block so client-side routing works for all URLs without 404ing on refresh.
   - Enforces HSTS (`Strict-Transport-Security: max-age=31536000; includeSubDomains`) conditionally over HTTPS traffic only (`@https { protocol https }`).

3. **Internal Network Isolation & Resource Caps (`infra/docker-compose.yml`)**:
   - Only Caddy publishes ports 80 and 443 to the public internet.
   - The `api` container publishes **no** public ports and is only accessible via the internal Docker bridge network on port 3000 (`expose: ["3000"]`).
   - The Docker socket is never mounted to the API container.
   - The named volume `caddy_data` is strictly preserved to avoid re-requesting TLS certificates and hitting Let's Encrypt rate limits.
   - Memory is strictly budgeted for the 1 GB Azure VM: Node heap is capped with `--max-old-space-size=384` and Docker memory limits are capped at `512M`.

4. **Development One-Origin Emulation (`apps/web/vite.config.ts`)**:
   - The Vite development server on port 5173 proxies `/api`, `/healthz`, `/socket.io`, and `/sync` to `http://localhost:3000` with full WebSocket support (`ws: true`).
   - Frontend client code uses strictly relative fetch paths (e.g. `fetch('/healthz')`), eliminating hardcoded hostnames and ensuring identical behavior in local development and production.

5. **Placeholder Page (`apps/web/src/App.tsx`)**:
   - Displays "PairPrep" branding and queries `GET /healthz`.
   - Validates the response at runtime against `HealthResponseSchema` from `@pairprep/shared`, proving the end-to-end one-origin pipeline works before rooms and editing components are wired.

---

## 2. Trade-offs & Analysis

- **Single Origin via Reverse Proxy vs. Static CDN + API Subdomain**:
  - _Chosen_: Single origin via Caddy reverse proxy on the Azure VM.
  - _Reasoning_: Modern browsers (Safari ITP, Chrome Privacy Sandbox, Brave) restrict or completely partition third-party cookies. When auth cookies (`pairprep_session`) are issued on a separate subdomain or host, cross-site fetch requests require complex `credentials: "include"`, `SameSite=None; Secure`, and explicit CORS allowlists. With one origin, all session cookies are first-party (`SameSite=Lax`), CORS is completely bypassed in production, and network overhead is minimized.
- **Caddy vs. Nginx**:
  - _Chosen_: Caddy.
  - _Reasoning_: Caddy provides automatic HTTPS with Let's Encrypt / ZeroSSL, automated certificate renewal, native HTTP/2 & HTTP/3 support, and a concise declarative syntax with built-in gzip and WebSocket reverse proxying in ~20 lines of configuration.

---

## 3. How to Explain in an Interview

- "For PairPrep's deployment architecture, I implemented a same-origin hosting strategy using Caddy as our edge reverse proxy. Rather than hosting our React single-page app and Node backend on separate origins, Caddy terminates TLS and serves both from a single domain. Static frontend assets are served with client-side SPA fallbacks, while API endpoints and WebSockets (`/api/*`, `/healthz`, `/socket.io/*`, `/sync*`) are proxied internally to the backend container."
- "This decision eliminated all CORS overhead in production and resolved third-party cookie blocking issues across modern browsers, allowing our `HttpOnly` session cookies to operate strictly as first-party cookies with `SameSite=Lax`."
- "To guarantee resource stability on our 1 GB Azure VM, the API container publishes no public ports, caps the V8 heap at 384 MB, and restricts container memory to 512 MB. In local development, Vite proxies the same paths with WebSocket support so our frontend codebase never hardcodes backend URLs."
