# Task Note: T04 - Authentication and User Management

## What Changed

1. **Passport.js OAuth 2.0 Integration (`apps/server/src/auth/passport.ts`)**:
   - Pinned exact production versions: `passport@0.7.0`, `passport-google-oauth20@2.0.0`, `passport-github2@0.1.12`, `@types/passport@1.0.17`, `@types/passport-google-oauth20@2.0.17`, `@types/passport-github2@1.2.9`.
   - Completely avoided `openid-client` in strict compliance with project architectural constraints.
   - Dynamic callback URLs computed from `config.SITE_ORIGIN` (`${config.SITE_ORIGIN}/api/v1/auth/callback/google` and `${config.SITE_ORIGIN}/api/v1/auth/callback/github`).
   - GitHub and Google verified email extraction: extracts only verified emails; if unverified or absent, email is set to `null` (no invented fallback noreply addresses).
   - Strict HTTPS-only filtering on OAuth avatars (`safeAvatarUrl` must begin with `https://`).
   - Access and refresh tokens are immediately discarded in the verify callback with zero persistence.
   - Strategy registration only runs if credentials are provided, preventing startup crashes in headless dev environments.

2. **MongoDB Session Store (`apps/server/src/middleware/session.ts`)**:
   - Integrated `express-session@1.19.0` and `connect-mongo@5.1.0`.
   - Single connection reuse: `clientPromise: mongoose.connection.asPromise().then((m) => m.getClient())`, ensuring the session store waits for the active T03 Mongoose connection without creating redundant database sockets. Includes timeout and `.catch()` rejection handling.
   - Session middleware catches MongoDB session store failures and emits HTTP 503 `DATABASE_UNAVAILABLE` with a standard unified error shape and request ID, without crashing the Node.js server.
   - Session cookie configured with:
     - Name: `pairprep.sid`
     - Rolling 7-day expiration (`maxAge: 7 * 24 * 60 * 60 * 1000`)
     - `httpOnly: true` (prevents JavaScript access and XSS theft)
     - `secure: config.NODE_ENV === "production"`
     - `sameSite: "lax"` (mitigates CSRF on cross-site navigations while supporting top-level redirects)
   - Secret validated strictly from `config.SESSION_SECRET` with zero fallback defaults.

3. **Strict Middleware Ordering (`apps/server/src/index.ts`)**:
   - Pipeline order strictly verified:
     `requestLogger` -> `/healthz` (stateless, zero sessions/cookies) -> `authRateLimiter` (mounted on `/api/v1/auth/*` before session creation to prevent DB session allocation spam) -> `sessionMiddleware` (scoped to `/api`) -> `passport.initialize()` -> `passport.session()` -> `csrfProtection` (mounted once on `/api`) -> `authRouter` -> `meRouter` -> `roomsRouter`.
   - CORS allowlist strictly permits `config.SITE_ORIGIN`, `config.CLIENT_ORIGIN`, `localhost:5173`, `localhost:3000`, `127.0.0.1:5173`, `127.0.0.1:3000`, and rejects untrusted cross-origin requests.

4. **Session Fixation Prevention & State Security (`apps/server/src/routes/auth.ts`)**:
   - State parameter and PKCE (code_verifier and S256 code_challenge) are automatically generated and validated by `passport-oauth2`'s session-based store (`state: true`, `pkce: true` on Google; `state: true` on GitHub).
   - Callback validates state parameter and deletes state immediately to prevent replay attacks.
   - Upon successful OAuth verification, `req.session.regenerate()` is invoked before attaching `userId` to issue a completely fresh session ID (PRD 6.1 AUTH-4).
   - `returnTo` redirect parameter is sanitized to ensure it is a relative path starting with `/` and not `//` (preventing open redirect vulnerabilities).
   - `Cache-Control: no-store` header explicitly enforced on all auth routes and user profile routes to prevent caching of sensitive state or profile data by proxies.
   - `POST /api/v1/auth/logout`: Calls `req.logout()` followed by `req.session.destroy()` to delete the session document in MongoDB and clears the `pairprep.sid` cookie. Replaying the destroyed session cookie returns 401.

5. **Atomic User Upsert & Identity Preservation (`apps/server/src/repos/userRepo.ts`)**:
   - `upsertUser` performs an atomic `findOneAndUpdate` with:
     - `$setOnInsert`: `displayName`, `avatarUrl`, `role`, `createdAt`, `disabled`.
     - `$set`: `email`, `lastLoginAt`.
   - Subsequent OAuth logins never overwrite user edits made via `PATCH /me`.
   - Catches MongoDB `E11000` duplicate key race conditions during concurrent logins and gracefully retrieves the existing record.

6. **Runtime Public DTO Email Stripping (`packages/shared/src/index.ts`)**:
   - Added runtime converter `toUserPublicDto(user)` that constructs an explicit public object containing only `id`, `displayName`, `avatarUrl`, `role`, and `createdAt`.
   - Backed by strict unit tests verifying `email in publicDto === false` and `(publicDto as any).email === undefined`.
   - `UpdateProfileDtoSchema` configured with `.strict()` to reject unrecognized extraneous fields.
   - `sanitizeDisplayName` strips control characters (`\p{Cc}`) and formatting characters (`\p{Cf}`), trims whitespace, normalizes Unicode to `NFC`, and validates code-point lengths (1–40 characters).

7. **CSRF Defense-in-Depth (`apps/server/src/middleware/csrf.ts`)**:
   - Enforces `X-Requested-With: pairprep` header on state-changing requests (`POST`, `PATCH`, `PUT`, `DELETE`).
   - Rejects with 403 `CSRF_REJECTED` at perimeter.
   - Tested independently of authentication guards to prove rejection happens even without a valid session.

---

## Architectural Decisions & Interview Trade-offs

### 1. Dedicated Driver Compatibility with Passport.js & Single Mongoose Connection

- **Decision**: Pinned `passport@0.7.0` alongside `passport-google-oauth20@2.0.0` and `passport-github2@0.1.12`, wiring the session store through `mongoose.connection.asPromise().then((m) => m.getClient())`.
- **Trade-off**: While Passport strategy packages have not received recent API changes, Passport is the battle-tested Node.js authentication standard. By binding `connect-mongo` directly to Mongoose's underlying MongoClient promise, the application avoids opening secondary connection pools, keeps socket counts predictable, and shares connection health monitoring with the T03 infrastructure.

### 2. State-Changing Defense-in-Depth vs Traditional CSRF Tokens

- **Decision**: Implemented custom header verification (`X-Requested-With: pairprep`) for state-changing requests, combined with `SameSite=Lax` cookies.
- **Trade-off**: Traditional synchronize-token pattern requires issuing and managing unique CSRF tokens across sessions and forms. Because modern browsers do not allow cross-origin requests to set arbitrary custom headers without preflight approval (CORS), the custom header approach offers equivalent protection against cross-site request forgery without session state bloat.

### 3. $setOnInsert vs Blanket Upsert

- **Decision**: Separated user fields into `$setOnInsert` (display name, avatar) and `$set` (email, last login time).
- **Trade-off**: A naive `upsert` overwrites the user's display name and avatar with whatever the OAuth provider returns on every login. Using `$setOnInsert` ensures user customization from `PATCH /me` is permanently preserved while still recording accurate `lastLoginAt` timestamps and email updates.

### 4. Auth Rate Limiting (30 requests/minute per IP) for Shared Campus IPs

- **Decision**: Configured `AUTH_RATE_LIMIT_MAX` to default to 30 requests per minute per IP on `/api/v1/auth/*` routes.
- **Trade-off**: In university dorms, shared campus Wi-Fi, and computer labs, hundreds of students frequently route outbound internet traffic through a single shared campus NAT gateway / public egress IP. A rigid limit (such as 10 requests/minute) causes frequent false-positive HTTP 429 lockouts for innocent students attempting to log in during peak study and mock interview hours. Setting the threshold to ~30 requests per minute per IP provides sufficient headroom for concurrent student logins from shared institutional egress IPs while still effectively mitigating automated credential stuffing, token endpoint abuse, and state-generation resource exhaustion attacks.

---

## Infrastructure & Deployment Notes

### Outbound NAT Requirement

The Azure VM and application container require outbound internet access on port 443 (HTTPS). During OAuth authorization code exchange, `passport-oauth2` connects directly to Google (`https://oauth2.googleapis.com/token`) and GitHub (`https://github.com/login/oauth/access_token`), as well as provider user profile endpoints (`https://openidconnect.googleapis.com/v1/userinfo`, `https://api.github.com/user`). If outbound NAT / firewall rules block port 443, OAuth token exchange will hang and timeout.

### VM Production Environment Variables List (T04)

```env
NODE_ENV=production
PORT=3000
MONGODB_URI=mongodb+srv://<user>:<password>@<cluster>.mongodb.net/pairprep_prod?retryWrites=true&w=majority
SESSION_SECRET=<random-32-char-minimum-hex-secret>
SITE_ORIGIN=https://pairprep-live.eastasia.cloudapp.azure.com
CLIENT_ORIGIN=https://pairprep-live.eastasia.cloudapp.azure.com
GOOGLE_CLIENT_ID=<google-client-id>
GOOGLE_CLIENT_SECRET=<google-client-secret>
GOOGLE_CALLBACK_URL=https://pairprep-live.eastasia.cloudapp.azure.com/api/v1/auth/callback/google
GITHUB_CLIENT_ID=<github-client-id>
GITHUB_CLIENT_SECRET=<github-client-secret>
GITHUB_CALLBACK_URL=https://pairprep-live.eastasia.cloudapp.azure.com/api/v1/auth/callback/github
AUTH_RATE_LIMIT_MAX=30
RATE_LIMIT_MAX=100
```

### Security & Dependency Vulnerability Assessment (`npm audit --omit=dev`)

1. **`body-parser` (GHSA-27r3-jxmh-p828)**:
   - _Status_: Remediated via `overrides` entry in root `package.json` pinned to `^1.20.9`. Verified via `npm ls body-parser` confirming `body-parser@1.20.9`.
2. **`zod` (GHSA-mrhx-c7xc-m3w5 - Memory exhaustion in oversized constrained collections)**:
   - _Status_: Assessed as non-applicable to current PairPrep attack surface.
   - _Assessment Evidence_:
     - Ingestion perimeter encloses all incoming JSON payloads with a 1 MB ceiling via `express.json({ limit: "1mb" })` in `index.ts`.
     - Schemas validate strict scalar bounds (e.g., `UpdateProfileDtoSchema` enforces `displayName` code points between 1 and 40, rejecting unrecognized keys under `.strict()`; `CreateRoomDtoSchema` restricts title to 100 characters).
     - No schema in the codebase accepts unbounded or nested user-supplied collections (`z.array()`, `z.set()`, `z.record()`).
     - Upgrading to `zod@4.x` is a major breaking change requiring full rewrite across shared schemas, whereas existing scalar schemas are completely immune to collection exhaustion attacks.

---

## Verification Commands

### Linux / macOS (Bash)

```bash
# 1. Verify healthcheck is stateless (no session cookie)
curl -i http://localhost:3000/healthz

# 2. Verify CSRF rejection on logout without header
curl -i -X POST http://localhost:3000/api/v1/auth/logout

# 3. Verify CSRF acceptance on logout with header
curl -i -X POST http://localhost:3000/api/v1/auth/logout \
  -H "X-Requested-With: pairprep"

# 4. Run full test suite & CI verification
npm test
npm run ci
```

### Windows (PowerShell)

```powershell
# 1. Verify healthcheck is stateless
Invoke-RestMethod -Uri "http://localhost:3000/healthz" -Method Get

# 2. Verify CSRF rejection on logout without header (returns 403)
try {
  Invoke-WebRequest -Uri "http://localhost:3000/api/v1/auth/logout" -Method Post
} catch {
  $_.Exception.Response.StatusCode
}

# 3. Verify CSRF acceptance with header
Invoke-WebRequest -Uri "http://localhost:3000/api/v1/auth/logout" -Method Post -Headers @{ "X-Requested-With" = "pairprep" }

# 4. Run CI verification
npm run ci
```
