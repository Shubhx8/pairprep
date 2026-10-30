# Technical Note: T01 Server Foundations

## 1. Overview & Architectural Decisions

Task T01 establishes the foundational HTTP server architecture for PairPrep in `apps/server`, implementing core requirements from PRD sections 6.1 (AUTH-4), 6.6 (CONC-3), 8.1 (SEC-1, SEC-2, SEC-3), 8.4 (OBS-1, OBS-4), and 13.1 (/healthz).

### Key Architectural Decisions:

1. **Zod Environment Configuration (`apps/server/src/config.ts`)**:
   - Environment variables are validated at boot against a strict Zod schema.
   - **Fail-Fast Security**: If variables are missing or malformed, startup immediately aborts listing only the _names_ of the failed variables (e.g. `SESSION_SECRET`, `MONGODB_URI`). Values are never logged or exposed in stack traces.
   - **Default PORT**: Configured to `3000` to match existing repo tooling, PM2 configurations, and reverse proxy settings.

2. **Unified Error Shape (`apps/server/src/middleware/errorHandler.ts`)**:
   - Every API error strictly conforms to:
     ```json
     {
       "error": {
         "code": "STABLE_CODE",
         "message": "Human readable message",
         "requestId": "uuid-v4",
         "fields": { "title": "Title is required" }
       }
     }
     ```
   - Zod validation errors map to code `VALIDATION_ERROR`.
   - Unknown exceptions map to 500 `INTERNAL_ERROR`. Stack traces are strictly stripped from client responses.

3. **Structured Logging with Pino (`apps/server/src/middleware/logger.ts`)**:
   - Low-overhead structured JSON output using `pino@10.4.0`.
   - Every log line tags the unique `requestId` (`X-Request-Id`).
   - Redacts sensitive headers (`cookie`, `authorization`).
   - **Strict Privacy Rule (PRD OBS-1)**: Request bodies, user source code, and chat messages are never recorded in logs.

4. **Security Headers & CSP Decision (PRD SEC-3)**:
   - Configured via `helmet@8.3.0`.
   - **Decision: Content-Security-Policy (CSP) in Report-Only Mode**:
     - _Rationale_: The Monaco editor used for real-time collaborative editing relies on web workers (`Blob` URLs) and dynamic font/script evaluation. Enforcing a strict CSP prematurely in Phase 1 would break client editor initialization. CSP is launched in `Content-Security-Policy-Report-Only` mode and will be tuned to enforcement mode in Task T14 when Monaco worker integration is finalized.

5. **Limits and Rate Limiting (PRD SEC-1, SEC-2)**:
   - JSON request body size limit set to `100 KB` (`express.json({ limit: "100kb" })`).
   - Requests with unknown content types on body-bearing methods are rejected (`415 Unsupported Media Type`).
   - Global in-memory IP rate limiter set to 100 requests per minute per IP via `express-rate-limit@8.7.1`, returning HTTP 429 with `Retry-After` header and the standardized error shape.

6. **Health Endpoint (PRD 8.4, 13.1)**:
   - `GET /healthz` returns `{ "status": "ok", "uptimeSec": 12.34, "version": "0.1.0" }`.
   - Uses `uptimeSec` as specified in the PRD.

7. **Graceful Shutdown (PRD OPS-2)**:
   - Intercepts `SIGTERM` and `SIGINT` to stop accepting new requests, drains in-flight requests (capped at 10 seconds), and exits cleanly with code 0.

---

## 2. Trade-offs & Analysis

- **In-Memory Rate Limiting vs Redis**:
  - _Chosen_: In-memory store (`express-rate-limit`).
  - _Reasoning_: PairPrep runs on a single 1 GB Azure VM process during Phase 1. An in-memory rate limiter requires zero external services or network hops, saving memory and keeping operational complexity minimal. In Phase 3, this can be swapped for Redis if horizontal scaling is required.
- **Pino vs Winston**:
  - _Chosen_: Pino.
  - _Reasoning_: Pino is significantly faster (up to 5x lower latency) and avoids allocating unnecessary objects on the V8 heap, critical for maintaining 200 ms latency bounds during real-time editing.

---

## 3. How to Explain in an Interview

- "When designing the server foundations for PairPrep, security, predictability, and observability were prioritized from day one. I implemented a fail-fast configuration module using Zod that guarantees the server cannot boot without its required cryptographic secrets and database URIs, while ensuring error messages only state the variable names to prevent credential leakage in CI/CD logs."
- "For API predictability, I centralized error handling and 404s into a single RFC-compliant JSON shape with stable machine-readable codes and trace IDs (`X-Request-Id`). This simplifies frontend error consumption."
- "For observability, I replaced ad-hoc logging with structured Pino JSON logs and strictly enforced a privacy boundary: cookies and authorization tokens are redacted, and request bodies are never logged to prevent code submissions or chat from leaking into log aggregators."
