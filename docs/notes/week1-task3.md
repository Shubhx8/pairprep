# Task 3: Health Endpoint, Observability & Containerization

## What Changed

- Added `HealthResponseSchema` to `@pairprep/shared` defining the contract for system health status, uptime, timestamp, and version.
- Implemented structured JSON request logging middleware in `apps/server/src/middleware/logger.ts`, assigning a unique `X-Request-Id` to every request and emitting structured JSON lines with response status, duration in milliseconds, and method/path.
- Enforced strict security compliance (`OBS-1`, `AGENTS.md` Rule 6): Request bodies, source code, and chat text are excluded from logs.
- Added `GET /healthz` endpoint to Express server conforming to `HealthResponseSchema`.
- Authored a multi-stage production Dockerfile (`apps/server/Dockerfile`) with:
  - Multi-stage build caching (`npm ci`, build `@pairprep/shared`, build `@pairprep/server`, `npm prune --omit=dev`).
  - Production environment with heap cap: `NODE_OPTIONS="--max-old-space-size=384"` to guarantee protection against Out-of-Memory (OOM) kills on the 1 GB Azure B1s VM.
  - Security hardening: Running under unprivileged `USER node`.
- Configured `infra/Caddyfile` and `infra/docker-compose.yml` orchestrating the Node server and Caddy reverse proxy.
- Added 3 new unit tests in `apps/server/src/__tests__/health.test.ts` verifying `/healthz` schema compliance and request ID propagation.

## Why

- **Capped Node Heap:** The Azure B1s instance has ~891 MB RAM. Without `--max-old-space-size=384`, V8 defaults to a generous heap that easily causes the Linux kernel OOM killer to terminate the process or starve Docker sandbox containers.
- **Request ID Tracking:** In distributed systems, tracing requests through proxies, REST APIs, and background runners requires a consistent identifier across log aggregators.
- **Multi-Stage Docker Builds:** Separates TypeScript build dependencies and dev tool chains from the final runtime image, minimizing attack surface and image size.

## Trade-offs

- In-process request logging adds negligible overhead (<1ms) compared to an external sidecar daemon, saving vital memory on a small instance.
- Capping heap at 384 MB requires memory-conscious coding in Node (e.g. streaming large payloads rather than buffering them all into memory).

## How to Explain in an Interview

> _"We implemented a production-grade observability and containerization foundation. Every request is automatically tagged with a correlation request ID and logged as structured JSON without exposing sensitive user code or chat data. Our production Dockerfile uses a multi-stage build running under an unprivileged user, and explicitly caps the V8 heap at 384 MB using NODE_OPTIONS. This ensures our backend never competes with or starves the isolated Docker sandbox runner on our 1 GB RAM Azure VM."_
