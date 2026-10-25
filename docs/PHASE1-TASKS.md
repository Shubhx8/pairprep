# PairPrep: Phase 1 (MVP) Task Guide

How to build Phase 1 end to end, one task at a time, with Antigravity doing the typing and you doing the checking.

- Source of truth for WHAT to build: `docs/PRD.md` (sections 6.1 to 6.8, 58 requirements).
- This file tells you HOW to get there: what you do by hand, what the agent does, how to prove it works, and what to do when it doesn't.
- Phase 1 contains 17 tasks (T01 to T17) after a gate task (T00). Do them in order. Never start a task until the previous one is verified and merged.

Labels used in every task:

- **YOU DO**: steps only you can do (accounts, secrets, clicking in a portal, running a check).
- **AGENT PROMPT**: text to paste into Antigravity (always paste the Standard Wrapper from section 0.3 first).
- **REVIEW THE PLAN**: what to look for before you approve the agent's plan.
- **CHECK**: commands and clicks that prove the task works, with the expected result.
- **IF IT FAILS**: the usual causes of the usual errors.
- **DONE WHEN / COMMIT / SEND ME**: the exit criteria.

Nothing here is guaranteed error-free. What this process does guarantee is that nothing is called "done" until a test or a command output proves it.

---

## 0. Ground rules for the whole phase

### 0.1 Git workflow (for every task)

1. Make sure `main` is clean and up to date: `git checkout main`, `git pull`.
2. Create a branch for the task: `git checkout -b task/T04-auth` (use the task number and a short name).
3. Let the agent work on that branch. Review the diff yourself (`git diff main`, or the Source Control panel).
4. Run the standard commands (section 0.2). Everything must pass.
5. Commit with Conventional Commits (`feat:`, `fix:`, `test:`, `chore:`, `docs:`), push the branch, open a pull request on GitHub, wait for the green check, then merge.
6. After merging: `git checkout main`, `git pull`, and delete the branch.

If branch protection on `main` is on (T00), you cannot push to `main` directly. That is intentional.

### 0.2 Standard commands the project must provide

Ask the agent to make sure these exist in the root `package.json`. If Week 1 used other names, adapt this table once and keep it consistent.

| Command                | Meaning                                           | Must pass before merge |
| ---------------------- | ------------------------------------------------- | ---------------------- |
| `npm run dev`          | Starts web and server in development              | n/a                    |
| `npm run lint`         | ESLint + Prettier check                           | yes                    |
| `npm run typecheck`    | TypeScript strict check, all packages             | yes                    |
| `npm test`             | Unit and integration tests                        | yes                    |
| `npm run build`        | Production build of all packages                  | yes                    |
| `npm run test:e2e`     | Playwright end-to-end tests (from T06 on)         | yes, once it exists    |
| `npm run test:sandbox` | Sandbox escape suite (from T10 on)                | yes, once it exists    |
| `npm run test:fuzz`    | Concurrent-editing convergence test (from T12 on) | yes, once it exists    |

Type `npm run` (no name) to list what exists.

### 0.3 The Standard Wrapper (paste at the top of EVERY task prompt)

```
You are working on PairPrep. Follow AGENTS.md and docs/PRD.md.

Rules for this task:
1. Before writing code: restate the task in your own words; list the PRD requirement
   IDs and their acceptance criteria; list assumptions and open questions; propose a
   plan (files to create or change, every new dependency with a one-line reason, and a
   test plan). STOP and wait for my approval.
2. Dependencies: add only what the approved plan lists. Check each package's current
   official documentation instead of relying on memory for APIs or versions. Pin exact
   versions that were published at least 14 days ago. Run npm audit and report findings.
3. Work on branch <BRANCH>. Make small commits with Conventional Commit messages.
4. Write tests alongside the code. Every acceptance criterion needs at least one test.
5. Run npm run lint, typecheck, test and build, and paste the REAL output. If something
   fails, fix the cause. Never delete, skip or weaken a test to make it pass.
6. Do not change files outside the scope of this task. If the PRD or AGENTS.md seems wrong
   or conflicts with the task, stop and ask me.
7. Finish with: (a) summary of changes; (b) exact manual steps I can use to verify, with the
   expected result of each; (c) a table mapping requirement ID to test name or evidence;
   (d) what you did NOT verify; (e) known risks and follow-ups; (f) a note in
   docs/notes/<task>.md explaining what changed, why, the trade-offs, and how I would
   explain it in an interview.
```

Replace `<BRANCH>` with the branch name each time.

### 0.4 How to review a plan before approving it

Read the agent's plan and ask:

1. Does it list exactly the requirement IDs I gave it, with their acceptance criteria, and nothing else?
2. Does each criterion have a named test?
3. Is every new dependency justified, and is any one unnecessary?
4. Does it add any new running process, port or service? (Memory budget: see AGENTS.md.)
5. Does it put any security decision in the browser? (Roles, hidden data and limits belong on the server.)
6. Does it touch files outside the task? If yes, ask why.

If any answer is wrong, reply with the correction and ask for a revised plan. Approve only a plan you understand.

### 0.5 How to review a diff before committing

- No secrets, keys, `.env` files, or real passwords anywhere (search for `password`, `secret`, `token`).
- No `console.log` of request bodies, code, or chat text.
- Every new route or socket event checks authentication and role on the server.
- All input is validated with a schema; unknown fields are rejected.
- No `any` types without a comment, no commented-out code, no TODOs left behind.
- Tests exist for the new behavior, including a failure case.
- You can explain every file in your own words. If not, ask the agent: "Explain this file to me as if I were a first-year student, and tell me what would break if this line were removed."

### 0.6 Debugging protocol (when something fails)

Paste this to the agent along with the exact error text and what you did:

```
Something is failing. Do not change any code yet.
1. Reproduce the failure and show me the exact command and output.
2. List the three most likely causes, ranked, with the evidence for each.
3. Propose the smallest fix for the top cause and explain why it should work.
4. After my approval: apply it, add a regression test that fails without the fix, and show
   me the passing output.
```

If you are stuck after two rounds, send me the error text, the command you ran, and the relevant file. Never paste a `.env` file, a key, or a password.

### 0.7 What to send me after each task

1. The agent's final report (summary, evidence table, not-verified list).
2. The real output of `npm run lint`, `typecheck`, `test` and `build`.
3. The result of the CHECK steps for that task (screenshots are fine).
4. For security-sensitive tasks (T04, T05, T07, T09, T10): the changed files, as pasted code or as a zip of the repository with no `node_modules`, no `.env`, no key files. I can run the tests and read the code.

### 0.8 Architecture decisions that apply to Phase 1

These refine the PRD where the build showed a problem. They are recorded here and in the PRD decisions log.

- **AD-1: One origin.** Caddy on the VM serves the built web app AND proxies `/api`, `/healthz`, `/socket.io` and `/sync` to the API. There is no separate static host. Reason: a frontend on a different site than the API makes the login cookie a third-party cookie, which several browsers block, and it forces CORS rules. One origin avoids both and costs almost no memory.
- **AD-2: Runner in its own container.** The API container never gets the Docker socket. A tiny `runner` service (own container, memory-capped, internal network only, authenticated by a shared secret) is the only thing that talks to Docker. Reason: the Docker socket is root-equivalent, and the API is the most exposed code. This adds one small process; its memory use is measured in T10.
- **AD-3: Idempotency keys live in MongoDB** with a 24-hour expiry index, not in memory, so a restart does not forget them.
- **AD-4: API prefix is `/api/v1`.** Health is at `/healthz`. Server port 4000, Vite dev port 5173.
- **AD-5: Dependencies are pinned,** at least 14 days old, justified in the plan, and audited.
- **AD-6: No test-only backdoors.** End-to-end tests log in through the real guest-join path. No route that exists only for testing may exist in a production build.

### 0.9 AGENTS.md updates to make now (do this in T00)

Add these lines to `AGENTS.md` (or ask the agent to add them verbatim):

```
## Phase 1 architecture decisions
- One origin: Caddy serves the built web app and proxies /api, /healthz, /socket.io and /sync to the API. No CORS beyond localhost development.
- The API container never mounts the Docker socket. Only the small runner container does, on an internal network, authenticated by a shared secret.
- Resource rule update: API, sync and room events share ONE Node process; the runner is a second small process capped at about 96 MB.
- Idempotency keys are stored in MongoDB with a 24-hour expiry.
- Dependencies: exact versions, published at least 14 days ago, justified in the plan, npm audit clean of critical issues.
- No test-only routes or login backdoors may exist in production builds.
```

### 0.10 Honest time estimates

| Task                    | Hours (rough) | Task                           | Hours (rough) |
| ----------------------- | ------------- | ------------------------------ | ------------- |
| T00 Gate and prep       | 2 to 3        | T09 Room events and chat       | 4             |
| T01 Server foundations  | 3             | T10 Execution runner           | 8             |
| T02 Same-origin hosting | 3             | T11 Run and console UI         | 4             |
| T03 Database and models | 3             | T12 Concurrency tests          | 4             |
| T04 Authentication      | 5             | T13 Live indicators            | 5             |
| T05 Rooms and roles API | 5             | T14 Layout and editor features | 5             |
| T06 Web shell           | 6             | T15 Themes, fonts, size        | 5             |
| T07 Sync server         | 6             | T16 UI polish and performance  | 5             |
| T08 Editor page         | 6             | T17 Phase 1 gate               | 5             |

That is roughly 85 to 90 hours: about four weeks at 3 to 4 hours a day, which is longer than the PRD's six-week plan assumed for Phase 1. These are guesses. Track your real hours per task; after T04 we recalibrate the plan.

---

## T00. Gate and preparation (no features)

**Goal:** prove Week 1 really works, create the accounts Phase 1 needs, and prepare secrets safely.

**YOU DO**

1. Run the Week 1 verification checks and send me the output:
   - `git status`, `git log --oneline` (clean, small commits)
   - `git ls-files` (no `.env`, no `.pem`, no key files in the list)
   - `npm install`, then `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`
   - Open `https://pairprep-live.eastasia.cloudapp.azure.com/healthz` (should show JSON from your server over HTTPS)
   - GitHub repository, **Actions** tab: latest run has a green check
   - `docs/notes/sandbox-spike.md` exists and each attack ended safely
2. In the Azure portal: confirm `pairprep-vm` is **Running**; on the public IP, set **idle timeout to 30** and click Apply; delete the duplicate rules `Allow-HTTP-80` and `Allow-HTTPS-443`; check Cost analysis.
3. Add the AGENTS.md updates from section 0.9. Commit: `docs: record Phase 1 architecture decisions`.
4. GitHub: Settings, then Branches, then add a rule for `main`: require a pull request before merging and require status checks to pass. (Free for public repositories.)
5. **MongoDB Atlas** (free tier; confirm the current free-tier limits on the signup page):
   1. Create an account and a project named `pairprep`.
   2. Create a free **M0** cluster. Pick the region nearest to your VM or to India.
   3. **Database Access**: create a user `pairprep_app` with a long random password. Give it **Read and write to a specific database** only (database name `pairprep`), not Atlas admin.
   4. **Network Access**: add the VM's IP `52.175.53.13` (as `/32`) and, temporarily, your laptop's current IP (button "Add current IP address"). **Never add 0.0.0.0/0.**
   5. Click Connect, then Drivers, copy the connection string, put your username, password and the database name `pairprep_dev` in it, and save it as `MONGODB_URI` in your local `.env`. If the password has special characters (`@`, `:`, `/`, `#`), URL-encode them.
6. Generate a session secret and put it in your local `.env` as `SESSION_SECRET`:
   `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
7. Prepare the server folder for the production `.env` (run on the VM, prompt `azureuser@pairprep-vm`):
   `sudo mkdir -p /opt/pairprep && sudo chown azureuser:azureuser /opt/pairprep`
   Later you will create `/opt/pairprep/.env` there and run `chmod 600 /opt/pairprep/.env`.
8. Close any open `.pem` file in your editor. Back the key up somewhere private.

**CHECK**

- Every Week 1 check above passes. Anything that fails: fix it first, using the debugging protocol (0.6).
- `git ls-files` shows no secret files.
- You can sign in to Atlas and see the empty cluster and its Network Access list (two entries, not "allow all").

**IF IT FAILS**

- Atlas "Add current IP" missing: use Network Access, then Add IP Address, then paste the address.
- CI red on main: open the failing job, read the first red line, and give it to the agent with the debugging protocol.

**DONE WHEN:** all checks pass, Atlas and secrets are ready, AGENTS.md is updated, branch protection is on.
**SEND ME:** the check outputs and a screenshot of Atlas Network Access.

---

## T01. Server foundations

**Branch:** `task/T01-server-foundations`
**PRD IDs:** foundations for AUTH-4, UI-2, CONC-3; early parts of SEC-2, SEC-3, OBS-1, OBS-4.
**Depends on:** T00.

**Goal:** a server skeleton that every later task builds on: validated configuration, one error format, request IDs, safe logging, security headers, basic rate limiting, health check, graceful shutdown.

**YOU DO:** create the branch (0.1). Nothing else.

**AGENT PROMPT** (after the Standard Wrapper)

```
TASK T01: Server foundations in apps/server.
Build, with tests:
1. Config: load environment variables through a Zod schema in one module. Fail at startup
   with a clear message listing the missing or invalid variable NAMES (never values).
   Variables: NODE_ENV, PORT (default 4000), MONGODB_URI, SESSION_SECRET (min 32 chars),
   SITE_ORIGIN, GOOGLE_CLIENT_ID/SECRET, GITHUB_CLIENT_ID/SECRET (optional until T04),
   RUNNER_URL and RUNNER_SECRET (optional until T10), GIT_SHA (optional).
2. Errors: an AppError class and one JSON error shape for the whole API:
   { "error": { "code": "STABLE_CODE", "message": "...", "requestId": "..." } }.
   Central error middleware, a 404 handler, an async route wrapper. Zod validation errors
   map to code VALIDATION_ERROR with field names but no stack traces.
3. Request IDs: generate a UUID per request, return it in an X-Request-Id header, include
   it in every log line.
4. Logging: structured JSON with pino. Redact cookies and authorization headers. Never log
   request bodies. No source code or chat text may ever be logged.
5. Security headers with helmet. Start the Content-Security-Policy in report-only mode
   (the Monaco editor needs tuning in T14) and record that decision in docs/notes.
6. Limits: JSON body limit 100 KB; reject unknown content types; trust proxy setting
   controlled by config (on in production, off in development).
7. Rate limiting with express-rate-limit (memory store): 100 requests per minute per IP
   overall; return HTTP 429 with a Retry-After header and the standard error shape.
8. GET /healthz returns { status, uptimeSec, version } for now. A later task adds database
   status.
9. Graceful shutdown: on SIGTERM and SIGINT stop accepting connections, finish in-flight
   requests (10 s max), close resources, exit 0.
Tests (Vitest + Supertest): error shape on 404 and on validation failure; X-Request-Id
present and unique; config fails fast with names only; 429 after the limit with
Retry-After; healthz shape; graceful shutdown closes the server.
Do not add authentication, database access or any route other than /healthz.
```

**REVIEW THE PLAN:** only one new route (`/healthz`); config reads the environment in one place; no logging of bodies.

**CHECK**

1. `npm run lint`, `typecheck`, `test`, `build` all pass.
2. Start the server (`npm run dev`) and run, in PowerShell: `curl.exe -i http://localhost:4000/healthz`. Expect `200`, JSON, and an `x-request-id` header.
3. `curl.exe -i http://localhost:4000/nope`. Expect `404` and the JSON error shape with a `requestId`.
4. Rate limit test, in PowerShell:
   `1..120 | ForEach-Object { curl.exe -s -o NUL -w "%{http_code}" http://localhost:4000/healthz; "" } | Group-Object | Select-Object Name, Count`
   Expect mostly `200` and some `429` (the limit is 100 per minute).
5. Temporarily remove `SESSION_SECRET` from `.env` and start the server: it must refuse to start and name the variable, not print its value. Restore it afterwards.

**IF IT FAILS**

- `EADDRINUSE` (port in use): `netstat -ano | findstr :4000`, then `taskkill /PID <number> /F`.
- Tests hang: a server was not closed in an `afterAll`; ask the agent to close servers in tests.
- `curl` prints odd results in PowerShell: always write `curl.exe`, not `curl`.

**DONE WHEN:** all checks pass and the PR is merged. **COMMIT:** `feat(server): config, error shape, logging, limits, healthz`. **SEND ME:** the report and check outputs.

---

## T02. Same-origin hosting (Caddy serves the web app and proxies the API)

**Branch:** `task/T02-same-origin`
**PRD IDs:** infrastructure for AUTH-4, SEC-3; implements AD-1.
**Depends on:** T01.

**Goal:** one hostname serves everything. The browser loads the web app from Caddy; `/api`, `/healthz`, `/socket.io` and `/sync` go to the API container. Deployments copy the built web files to the VM.

**YOU DO**

1. Create the production environment file on the VM (prompt `azureuser@pairprep-vm`), then protect it:
   `nano /opt/pairprep/.env`, paste the production values (use a DIFFERENT `SESSION_SECRET` from your local one and a production `MONGODB_URI` pointing at database `pairprep`), save, then `chmod 600 /opt/pairprep/.env`. Never print this file in a screen you share.
2. Create the folder for web files: `mkdir -p /opt/pairprep/web`.
3. Make sure the existing Docker volume that holds the HTTPS certificate keeps its name (`caddy_data`). Changing the name makes Caddy request a new certificate and can hit rate limits.

**AGENT PROMPT**

```
TASK T02: One-origin hosting. Read docs/PRD.md sections 10, 18 and AGENTS.md "Phase 1
architecture decisions".
1. infra/Caddyfile: site address from an environment variable SITE_ADDRESS (default
   http://localhost for development). Proxy these paths to the API service on port 4000:
   /api/*, /healthz, /socket.io/*, /sync*. Everything else is served from the built web
   app directory (/srv/web) with a single-page-app fallback to index.html. Enable gzip.
   Add security headers that Caddy owns (HSTS in production only).
2. infra/docker-compose.yml: services caddy and api. Ports 80 and 443 published only on
   caddy; api only exposed on the internal network. Reuse the existing named volume
   caddy_data and add caddy_config. api uses env_file /opt/pairprep/.env on the server,
   a memory limit, and a capped Node heap (--max-old-space-size). Caddy mounts the web
   directory read-only.
3. Development: apps/web Vite dev server proxies /api, /healthz, /socket.io and /sync to
   http://localhost:4000 with WebSocket support, so the app behaves as one origin locally.
4. CI/CD: extend the deploy job to build apps/web, copy dist/ to /opt/pairprep/web on the
   VM, pull the new api image, run docker compose up -d, then check that
   https://<SITE_ADDRESS>/healthz and https://<SITE_ADDRESS>/ both return 200. On failure
   roll back to the previous image tag and fail the build.
5. Put a placeholder page in apps/web that says "PairPrep" and shows the JSON from
   /healthz, to prove the one-origin path works end to end.
Do not change application code beyond this.
```

**REVIEW THE PLAN:** the `api` service is NOT published to the internet; no Docker socket anywhere; the volume name `caddy_data` is unchanged.

**CHECK**

1. Locally: `docker compose -f infra/docker-compose.yml up --build`, open `http://localhost`: you see the placeholder page with health JSON.
2. After merge and deploy: open `https://pairprep-live.eastasia.cloudapp.azure.com/` (page) and `/healthz` (JSON), both over HTTPS with no browser warning.
3. On the VM: `docker ps` shows `caddy` and `api` running; `free -h` shows memory (note the number).
4. Press F12, Network tab, reload: all requests go to the same host. Cookies are not involved yet.
5. Try `http://pairprep-live.eastasia.cloudapp.azure.com` (http): it should redirect to https.

**IF IT FAILS**

- `502 Bad Gateway`: Caddy cannot reach the API. Check the service name and port in the Caddyfile against compose.
- Certificate errors after redeploy: the volume was recreated. Check `docker volume ls`; do not retry many times, because certificate issuers rate-limit.
- Site shows the old page: the web copy step ran before the build finished, or the browser cache; hard refresh with Ctrl+F5.
- Deploy job cannot SSH: check the key in GitHub Actions secrets (never print it).

**DONE WHEN:** the live URL serves both the page and `/healthz`, and a push to `main` redeploys both. **COMMIT:** `feat(infra): one-origin hosting with caddy`. **SEND ME:** screenshots of the live page and `docker ps`, plus `free -h`.

---

## T03. Database and models

**Branch:** `task/T03-database`
**PRD IDs:** foundations for ROOM-1 to 6, PER-1, PER-2, CH-2, CONC-3; PRD section 12.
**Depends on:** T02.

**Goal:** a reliable connection to MongoDB and models for the Phase 1 collections, with indexes and expiry rules, tested against a real database.

**YOU DO**

1. Make sure Docker Desktop is running (tests start a local MongoDB).
2. Keep two databases: `pairprep_dev` on Atlas for manual work, and a disposable local MongoDB container for tests, so tests never touch Atlas.

**AGENT PROMPT**

```
TASK T03: Database layer in apps/server. Read docs/PRD.md section 12 (data model).
1. Mongoose connection module: retry with backoff, serverSelectionTimeoutMS 5000, clean
   disconnect on shutdown. /healthz gains a "db" field ("ok" or "down"); never include
   connection strings or errors with credentials.
2. Models and indexes (section 12): users, guests, rooms, room_members, doc_updates,
   doc_snapshots, messages, client_map, events. Add one NEW collection idempotency_keys
   { key, userId or guestId, route, requestHash, response, createdAt } with a unique index
   on (key, actor, route) and a TTL index of 24 hours.
   - guests: TTL index so they expire after 7 days.
   - rooms.slug: unique; generated with crypto.randomBytes(16) encoded as base64url
     (at least 128 bits).
   - doc_updates: unique (roomId, seq); append-only (no update or delete methods in the
     repository except delete-by-room).
   - room_members: unique (roomId, memberId); enforce the 6-participant limit in code.
   Sessions are handled by the session store in T04, so do not model them here.
3. A repository layer: all queries live in apps/server/src/repos/*. Route code must not
   call Mongoose models directly.
4. Shared Zod schemas for the DTOs that will be returned to clients go in packages/shared.
5. Tests against a REAL MongoDB (docker container locally, a service container in the CI
   workflow): indexes exist, unique constraints reject duplicates, TTL indexes are
   defined, slug length and character set, slug uniqueness over 10,000 generations,
   doc_updates cannot be modified.
Add a docker compose file for a local test MongoDB and an npm script to start and stop it.
```

**REVIEW THE PLAN:** routes will use repositories, not models; tests use a local MongoDB, not Atlas; secrets never printed.

**CHECK**

1. `npm test` passes with the local MongoDB running.
2. Start the server with your Atlas `MONGODB_URI`. `curl.exe http://localhost:4000/healthz` shows `"db":"ok"`.
3. In Atlas, Browse Collections: the `pairprep_dev` database shows the collections after the first start (or after a seed script), and Indexes tabs list the unique and TTL indexes.
4. Temporarily stop your internet or use a wrong URI: `/healthz` shows `"db":"down"` and the server does not crash.

**IF IT FAILS**

- `MongoServerSelectionError`: your IP is not in Atlas Network Access, or campus Wi-Fi blocks the connection; try a phone hotspot.
- `bad auth`: wrong password or a password with special characters that must be URL-encoded.
- DNS errors on a `mongodb+srv://` string: ask the agent to try the standard (non-SRV) connection string from Atlas.
- Test hangs: the test database container is not running (`docker ps`).

**DONE WHEN:** tests pass, healthz reports the database state, and indexes exist in Atlas. **COMMIT:** `feat(server): mongodb connection, models, indexes`. **SEND ME:** report, `npm test` output, Atlas indexes screenshot (hide any connection string).

---

## T04. Authentication (Google, GitHub, sessions)

**Branch:** `task/T04-auth`
**PRD IDs:** AUTH-1, AUTH-2, AUTH-4, AUTH-5 (guest join, AUTH-3, is finished in T05).
**Depends on:** T03.

**Goal:** people can sign in with Google or GitHub, stay signed in securely for up to 7 idle days, see and edit their display name, and sign out.

**YOU DO (before the agent starts)**

Register the login apps. The callback addresses must match exactly, including `http` or `https`, the port, and no trailing slash.

1. **GitHub** (needs TWO apps, because GitHub allows one callback address per app):
   1. GitHub, Settings, Developer settings, OAuth Apps, New OAuth App.
   2. Development app: homepage `http://localhost:5173`, callback `http://localhost:5173/api/v1/auth/callback/github`.
   3. Production app: homepage `https://pairprep-live.eastasia.cloudapp.azure.com`, callback `https://pairprep-live.eastasia.cloudapp.azure.com/api/v1/auth/callback/github`.
   4. Generate a client secret for each; copy it immediately (it is shown once). Put the dev values in your local `.env` and the production values in `/opt/pairprep/.env` on the VM.
2. **Google:**
   1. console.cloud.google.com, create a project named `pairprep`. A payment method is not required for OAuth login.
   2. APIs and Services, OAuth consent screen: user type External; app name PairPrep; your email as support and developer contact; scopes `openid`, `email`, `profile` only.
   3. Credentials, Create credentials, OAuth client ID, type Web application. Authorized redirect URIs: `http://localhost:5173/api/v1/auth/callback/google` and `https://pairprep-live.eastasia.cloudapp.azure.com/api/v1/auth/callback/google`.
   4. Copy the client ID and secret into the two `.env` files as above.
   5. While the consent screen is in **Testing** mode, only people you add under Test users can sign in. Add yourself and a few friends now.

   **Caveat (I could not verify Google's current rules):** to let any user sign in, the consent screen must be published, and Google may require you to prove ownership of the domain used in redirect URIs. You do not own `cloudapp.azure.com`, so this may block public Google login. If it does, public users sign in with GitHub or as guests, and Google login stays for test users until you have your own domain. Check the consent screen's publishing status page for what Google says today.

**AGENT PROMPT**

```
TASK T04: Authentication in apps/server and a minimal login flow. Read docs/PRD.md
section 6.1 (AUTH-1, AUTH-2, AUTH-4, AUTH-5) and section 13.1 (auth endpoints).
1. OAuth 2.0 login for Google and GitHub using a maintained library. Compare Passport
   strategies with openid-client in your plan and recommend one. Use the OAuth "state"
   parameter and (for Google) PKCE if the library supports it.
2. Endpoints under /api/v1: GET /auth/google, GET /auth/github, GET /auth/callback/:provider,
   POST /auth/logout, GET /me, PATCH /me (display name only), DELETE /me is NOT part of
   this task. Cancelled or failed logins redirect to /login?error=<code> with no stack
   traces or provider details.
3. Users: upsert by (provider, providerId). Store displayName, avatarUrl and email as
   provided. Never expose email to other users in any response.
4. Sessions: express-session with a MongoDB store (connect-mongo). Cookie: httpOnly,
   secure in production, SameSite=Lax, 7 days idle expiry (rolling). Regenerate the session
   ID at login (prevents session fixation). Logout destroys the session on the server.
   The session secret comes from config.
5. CSRF: all state-changing requests (POST, PATCH, PUT, DELETE) require the custom header
   X-Requested-With: pairprep in addition to SameSite=Lax. Reject otherwise with code
   CSRF_REJECTED.
6. PATCH /me: display name 1 to 40 characters after trimming, strip control characters,
   reject empty.
7. Stricter rate limit on /auth/* (10 per minute per IP).
8. Provide docs/notes/auth.md describing the flow, and a docs/api-examples.http file for
   the VS Code REST Client extension.
Tests: callback upsert is idempotent (logging in twice creates one user); session cookie
flags; logout invalidates the old cookie (a replayed cookie gets 401); CSRF rejection;
PATCH /me validation; rate limit on /auth; the OAuth network calls are mocked in tests.
Do not implement rooms or guests.
```

**REVIEW THE PLAN:** state parameter present; session regeneration at login; no tokens stored in the browser; CSRF header required on writes; no email returned to other users.

**CHECK**

1. All four standard commands pass.
2. Run locally (`npm run dev`), open `http://localhost:5173/api/v1/auth/github`, sign in. You return to the app and `GET /me` (browser address `http://localhost:5173/api/v1/me`) shows your user JSON. Repeat with Google (you must be a Test user).
3. F12, Application, Cookies: the session cookie shows **HttpOnly** checked and **SameSite = Lax**. On the live site it also shows **Secure**.
4. Log out, then reload `/api/v1/me`: `401` with the standard error shape. In Atlas, the `sessions` collection no longer holds your session.
5. Copy the session cookie value before logging out, log out, and try the old value (REST Client or a copy of the request): it must return `401`.
6. Visit `/api/v1/auth/github` and press Cancel on GitHub's page: you land on `/login?error=...`, not on an error page with details.

**IF IT FAILS**

- `redirect_uri_mismatch` (Google) or "redirect_uri is not associated" (GitHub): the callback address differs by even one character (http vs https, port, trailing slash).
- "Access blocked: app has not completed verification" or "not a test user": add your account under Test users.
- Session cookie missing in production: `trust proxy` is off behind Caddy, so Express thinks the connection is not secure and refuses the secure cookie.
- Logged out right after login: cookie `Secure` is on while testing over plain `http://localhost`; make it conditional on production.
- `CSRF_REJECTED` in the browser: the web client must add the custom header; ask the agent to centralize it in the API client.

**DONE WHEN:** you can sign in, see `/me`, edit the name, sign out, and the old cookie fails. **COMMIT:** `feat(auth): oauth login, sessions, csrf`. **SEND ME:** the report, the changed server files (security task), and the cookie screenshot.

---

## T05. Rooms and roles API (with guests and idempotency)

**Branch:** `task/T05-rooms`
**PRD IDs:** ROOM-1, ROOM-2, ROOM-3, ROOM-4, ROOM-6, PER-2 (API), AUTH-3 (guest join), CONC-3.
**Depends on:** T04.

**Goal:** the complete server rules for rooms: who can create, join, see, change roles, end and delete, enforced on the server, with safe retries.

**YOU DO:** create the branch. Before approving the plan, list in your own words who may do each action (owner, editor, viewer, guest). Compare with the agent's table.

**AGENT PROMPT**

```
TASK T05: Rooms, roles, guests and idempotency in apps/server. Read docs/PRD.md sections
6.2 (ROOM-1..4, ROOM-6), 6.1 (AUTH-3), 6.6 (CONC-3), 13.1 and 12.
1. Phase 1 rooms are type "practice" only. Roles: owner, editor, viewer.
2. Endpoints under /api/v1: POST /rooms, GET /rooms (my rooms, newest first, paginated),
   GET /rooms/:slug (metadata and MY role; never anything hidden), POST /rooms/:slug/join,
   PATCH /rooms/:slug/members/:id (owner only: change role), DELETE
   /rooms/:slug/members/:id (owner only: remove), POST /rooms/:slug/end, DELETE /rooms/:slug.
3. Guests: POST /rooms/:slug/join with a display name creates a guest record and sets a
   signed httpOnly cookie (7 days). Guests join as editor by default and cannot create
   rooms. A tampered or expired guest cookie is rejected.
4. Limits: at most 6 participants per room (the 7th gets HTTP 409, code ROOM_FULL).
   Invalid or deleted slugs return 404. An ended room is read-only for everyone.
5. Authorization lives in ONE middleware (requireMember, requireRole) used by every route.
   Client-supplied roles or user IDs are never trusted. The owner cannot be demoted or
   removed.
6. Deleting a room removes its members, updates, snapshots, messages and events.
7. Archive job: rooms with no activity for 30 days become "archived". Use a simple
   in-process timer that runs daily and on startup. No new service.
8. Idempotency: an Idempotency-Key header (UUID) is accepted on POST /rooms, the role
   change, POST end and DELETE room. Same key and same payload within 24 hours returns the
   original response with no second record created. Same key with a different payload
   returns 422 (IDEMPOTENCY_KEY_REUSED). Keys are stored in the idempotency_keys
   collection from T03. Two simultaneous requests with one key must create ONE record.
9. Update docs/api-examples.http and docs/notes/rooms.md.
Tests: a table-driven authorization matrix (every role and guest against every endpoint,
including non-members); room full; slug randomness; double-submit of POST /rooms creates
one room; concurrent identical requests create one room; tampered guest cookie; ended room
rejects changes; cascade delete; archive job.
```

**REVIEW THE PLAN:** one authorization middleware; an explicit authorization matrix test; idempotency covers concurrent duplicates, not only sequential ones.

**CHECK**

1. All standard commands pass; the matrix test lists every role and endpoint.
2. With the REST Client extension and `docs/api-examples.http`: create a room (signed in), join it from a second browser as guest (no sign-in), try to change a role as the guest (must be 403), change it as owner (200).
3. Send the same `POST /rooms` twice with one `Idempotency-Key`: one room exists in the `rooms` collection. Send the same key with a different body: `422`.
4. Join with 7 different guests: the 7th gets `409 ROOM_FULL`.
5. Open a room link that does not exist: `404` with the standard shape.

**IF IT FAILS**

- Guest cookie not accepted: signature secret differs between processes, or the cookie is `Secure` over `http://localhost`.
- Duplicate key error on slug: a collision retry is missing (extremely rare with 128 bits; usually a bug in generation).
- Concurrent duplicate test flaky: the idempotency record must be created atomically with a unique index, not "check then insert".

**DONE WHEN:** the matrix passes and manual checks behave. **COMMIT:** `feat(rooms): rooms, roles, guests, idempotency`. **SEND ME:** report and the rooms, middleware and idempotency files.

---

## T06. Web app shell: login, dashboard, create and join room

**Branch:** `task/T06-web-shell`
**PRD IDs:** UI-2, PER-2 (UI), AUTH-5 (UI), ROOM-1, ROOM-2 (UI), start of UIX-11 (design tokens).
**Depends on:** T05.

**Goal:** a real app around the room: routes, sign-in, dashboard of my rooms, create-room dialog, guest join page, display-name editing, and proper loading, empty and error states everywhere.

**YOU DO:** create the branch. Sketch the dashboard and the guest join screen on paper in five minutes. It makes plan review much easier.

**AGENT PROMPT**

```
TASK T06: Web app shell in apps/web. Read docs/PRD.md sections 6.1, 6.2, 6.5 (UI-2, PER-2),
6.8 (UIX-11 tokens only), 21.1.
1. Routes: / (landing), /login, /dashboard, /r/:slug (room page placeholder for now),
   /not-found. The room placeholder shows the room name, my role, and the participant
   count, or a clear message for 404, full room, or ended room.
2. A single API client that: always sends X-Requested-With: pairprep, parses every
   response with the shared Zod schemas, maps the standard error shape to typed errors,
   and never stores tokens in localStorage.
3. Auth state from GET /me. Sign-in buttons for Google and GitHub, plus a plain note
   that guests can join with a link. Display-name editing (AUTH-5).
4. Dashboard: my rooms newest first (name, status, date), a New room dialog (language
   Python, C++ or JavaScript; type Practice only), copy-link button, empty state, loading
   skeleton, error state with a retry button.
5. Join page for a visitor with a link: shows the room, asks for a display name if not
   signed in, then joins (guest) or joins directly if signed in.
6. Design tokens in one CSS file (colors, spacing, radius, type scale) used by every
   component through Tailwind configuration. Shared components: Button, Input, Modal,
   Toast, Skeleton, EmptyState, ErrorState. Visible focus outlines, labelled inputs,
   keyboard-operable dialogs.
7. Every screen that loads data has loading, empty and error states (UI-2).
Tests: component tests for states (Vitest and Testing Library); Playwright tests that use
the REAL guest-join path (no test-only login routes in production code): create a room as
an owner session created by the test harness through a documented test setup that is not
shipped in production builds, join as a guest in a second browser context, see the room
placeholder.
```

**REVIEW THE PLAN:** no secrets or tokens in browser storage; the test harness does not add routes to production code.

**CHECK**

1. All standard commands pass, including `npm run test:e2e` once added.
2. Walk the app: sign out, landing, sign in, dashboard empty state, create room, copy link, open it in a private window, join as guest.
3. Stop the server while on the dashboard: you see an error state with Retry, not a blank page. Start it again and click Retry.
4. Keyboard only: Tab through the dashboard and dialogs; focus is always visible; Escape closes dialogs.
5. Chrome DevTools, Lighthouse, Accessibility only, on landing and dashboard: score 90 or more.
6. Resize the window to 1024 px wide: layout still works.

**IF IT FAILS**

- CORS errors in development: the Vite proxy is not set up (T02). The app must call relative paths like `/api/v1/me`.
- Cookies not sent: use relative URLs; do not point the client at `http://localhost:4000` directly.
- Blank page after build: the router base path or the Caddy fallback is wrong.
- Lighthouse complains about contrast or labels: ask the agent to fix each reported item and rerun.

**DONE WHEN:** you can complete create, share, guest-join end to end in the browser and the state screens exist. **COMMIT:** `feat(web): shell, auth ui, dashboard, join flow`. **SEND ME:** report, Lighthouse screenshot, and screenshots of dashboard states.

---

## T07. Sync server (Hocuspocus) with permissions and persistence

**Branch:** `task/T07-sync-server`
**PRD IDs:** ED-2 (server side), ED-6, PER-1, ED-4 (measurement hook); prepares ATTR-1.
**Depends on:** T05.

**Goal:** a WebSocket sync server inside the existing Node process that authenticates every connection, enforces read-only roles on the server, and saves document changes quickly and safely.

**YOU DO:** create the branch. Read PRD section 13.2 (the six sync steps) once; you will be asked to explain it in interviews.

**AGENT PROMPT**

```
TASK T07: Document sync server in apps/server. Read docs/PRD.md sections 6.3 (ED-2, ED-6),
6.5 (PER-1), 13.2, 12 (doc_updates, doc_snapshots, client_map).
1. Use Hocuspocus (Yjs server). Attach it to the SAME HTTP server and process at the path
   /sync (no extra port). Check the current official docs for the supported way to attach
   it to an existing server and propose the exact approach in your plan.
2. Authentication on every connection: read the session cookie or the guest cookie from the
   upgrade request, find the member and role in the database, and refuse non-members and
   deleted rooms. Refuse WebSocket upgrades whose Origin is not SITE_ORIGIN (or localhost
   in development). Viewers and ended or archived rooms get a READ-ONLY connection; the
   server must reject their edits (not only the browser).
3. Loading: build the document from the latest snapshot plus later updates, in order.
4. Saving: append each accepted update to doc_updates with the next per-room seq, the
   author (user or guest id) and a server timestamp, flushed within 2 seconds of the last
   change. Write a snapshot every 5 minutes of activity and when the last connection
   leaves. Unload the document from memory when the room is empty.
5. Limits: maximum update size 1 MB; per-connection message rate limit; at most 6
   connections per room (matches ROOM-4).
6. Record the Yjs client ID to user mapping in client_map when a connection is
   established, if Hocuspocus exposes the client ID reliably. If it does not, say so in
   your plan and propose the alternative; do not guess.
7. Expose a small internal function that returns server-side document stats for tests.
8. Write docs/notes/sync-server.md, including how a document is rebuilt after a crash.
Tests (Vitest with real Hocuspocus provider clients in Node and a real MongoDB):
two clients converge; an unauthenticated client is refused; a non-member is refused; a
viewer's edit is rejected and the server document is unchanged; wrong Origin refused;
persistence: type, wait 2.5 s, kill the process with SIGKILL, restart, document equals
what was typed; seq is strictly increasing with no gaps; sending the same update twice
leaves the document unchanged; an oversized update is rejected.
```

**REVIEW THE PLAN:** the sync server shares the one process; read-only is enforced server-side; the crash-recovery test uses SIGKILL, not a polite shutdown; the plan states what it does if client IDs are not available.

**CHECK**

1. All standard commands pass, including the crash test.
2. Manual kill test: run the server; use the test client or browser (after T08) to type; wait 3 seconds; in PowerShell `taskkill /F /IM node.exe` (this stops all Node processes, including other dev tools); restart; the text is still there. If you do not want to stop all Node processes, use the test the agent wrote.
3. In Atlas, `doc_updates` shows rows with increasing `seq` for your room, and `doc_snapshots` gets a row at session end.
4. Memory: `docker stats --no-stream` (or Task Manager) before and after opening 10 rooms: memory returns close to the baseline after rooms close.

**IF IT FAILS**

- WebSocket error 1006 or "unauthorized": cookies are not reaching the upgrade (use the one-origin setup), or `Origin` check is too strict in development.
- Updates lost after restart: the flush timer (2 seconds) was not awaited at shutdown; check SIGKILL test timing.
- Memory keeps growing: documents are never unloaded, or snapshots are loaded for every connection.
- Gaps in `seq`: two writers raced; use an atomic counter or unique index with retry.

**DONE WHEN:** the tests, including crash recovery, pass. **COMMIT:** `feat(sync): hocuspocus server with auth, roles, persistence`. **SEND ME:** report and the sync server files (security task).

---

## T08. Editor page: Monaco, live sync, cursors, offline

**Branch:** `task/T08-editor`
**PRD IDs:** ED-1, ED-2 (client), ED-3, ED-4 (measure), ED-5, ROOM-5.
**Depends on:** T06, T07.

**Goal:** the real room: a code editor that two or more people edit at once, with live cursors and names, a participant list, a connection banner, and offline tolerance.

**YOU DO:** create the branch. Have a second browser (or a private window) ready; you will test with two identities.

**AGENT PROMPT**

```
TASK T08: Editor page in apps/web at /r/:slug. Read docs/PRD.md sections 6.2 (ROOM-5),
6.3 (ED-1..ED-7), 13.2.
1. Monaco Editor, loaded lazily so the rest of the app does not wait for it. Configure its
   web workers correctly for the Vite build (check the current docs; do not copy old
   snippets blindly).
2. Yjs document plus the Hocuspocus provider connected to /sync with the room as the
   document name, and the Yjs Monaco binding with awareness.
3. Language selector for Python, C++ and JavaScript. The chosen language is shared: store
   it in a Y.Map inside the same Yjs document so everyone sees the change; syntax
   highlighting follows it.
4. Remote cursors and selections with a name label and a color. Colors come from a
   color-blind-safe palette assigned deterministically from the user ID. Awareness fields:
   { id, name, color } (more are added in T13).
5. Participant list from awareness: name, role, color, "you" marker, updates live (ROOM-5).
6. Connection state banner: connecting, connected, offline (edits continue locally and
   merge on reconnect), reconnecting. Locked states (viewer, ended room) show a clear
   reason and make the editor read-only.
7. Clean up bindings and providers on unmount. React StrictMode must not produce duplicate
   bindings or doubled characters.
8. A debug mode (?debug=latency) that measures server round-trip time of a probe message
   every 5 seconds and logs median and 95th percentile to the console. No effect in
   normal use. Do not add extra network traffic when the flag is off.
Tests (Playwright, two browser contexts): text typed in A appears in B; two users typing on
the same line end with identical text; a viewer cannot type, and the server also rejects
a forced edit; context.setOffline(true) in A, type, go online, both converge with no
lost characters; cursor labels show both names; reload restores the code.
```

**REVIEW THE PLAN:** lazy loading; cleanup on unmount; the shared language lives in the Yjs document, not in a separate request; the latency debug mode is off by default.

**CHECK**

1. All standard commands, including e2e, pass.
2. Two windows (one private): create a room, join as a guest, type in both at the same time, including on the same line. Both screens must show identical text.
3. In window A open DevTools, Network, set **Offline**, type a sentence, set back to **No throttling**. Within seconds both windows show the same text.
4. Change the owner's view of the guest to **viewer** (use the REST Client for now): the guest's editor becomes read-only with a visible reason.
5. Open `http://localhost:5173/r/<slug>?debug=latency` and read the numbers in the console after a minute. Note them. (Latency from your laptop to a server in East Asia will be higher than localhost; record both.)
6. Type 200 characters quickly: no doubled letters anywhere.

**IF IT FAILS**

- "Could not create web worker" or blank editor: Monaco worker setup for Vite is wrong; ask the agent to follow the current Monaco plus Vite documentation.
- Doubled or missing characters after reconnect: the binding was created twice (StrictMode) or the provider was recreated on every render.
- Cursor labels in the wrong place: stale positions after remote edits; use relative positions from the binding rather than raw numbers.
- Editor never connects in production: the WebSocket path is not proxied (T02) or the Origin check rejects the live host.

**DONE WHEN:** two people can edit one document live with cursors and offline recovery. **COMMIT:** `feat(web): monaco editor with yjs sync, presence, offline`. **SEND ME:** report, a short screen recording or screenshots of two windows, and the latency console numbers.

---

## T09. Room events: chat, presence, live role changes

**Branch:** `task/T09-room-events`
**PRD IDs:** CH-1, CH-2, CH-3, ROOM-3 (live role change within 1 second), ROOM-5 (presence).
**Depends on:** T08.

**Goal:** a second real-time channel (Socket.IO) for chat, join and leave notices, and instant role changes, authenticated like everything else.

**YOU DO:** create the branch. Decide the chat limits are right (1,000 characters, last 200 messages). They come from the PRD.

**AGENT PROMPT**

```
TASK T09: Room events with Socket.IO. Read docs/PRD.md sections 6.2 (ROOM-3), 6.5 (CH-1..3),
13.3.
1. Socket.IO on the SAME HTTP server and process at /socket.io. Authenticate every socket
   from the session or guest cookie; reject non-members. A socket may only join the
   socket room "room:<id>" for rooms it belongs to.
2. Events (Phase 1 subset): chat:send, chat:message, room:join, room:leave, role:changed,
   system messages. Payloads are validated with Zod schemas from packages/shared; unknown
   event names and malformed payloads are dropped.
3. Chat: text up to 1,000 characters (trimmed, no empty messages), stored in messages.
   Rate limit per socket: 20 messages per 10 seconds, excess gets an error event.
   Each message carries a client-generated UUID; a duplicate UUID is ignored (idempotent).
   On join the client receives the last 200 messages (CH-2).
4. System messages for join, leave and role changes are stored with kind "system" and
   appear in the same stream (CH-3).
5. Presence: users who have not been heard from for 30 seconds are removed from the
   participant list.
6. Role changes (the REST route from T05) publish role:changed to the room within 1
   second AND update the sync connection: a user demoted to viewer must lose write access
   on the sync server immediately, not only after reconnecting.
7. Frontend: chat panel with unread count when collapsed, system messages styled
   differently, input with character counter. User text is rendered as TEXT, never as
   HTML.
8. Write docs/notes/room-events.md.
Tests: non-member rejected; message length and rate limits; history of 200; duplicate
message UUID stored once; role:changed reaches clients in under 1 second and a demoted
user's edit is then rejected by the sync server; presence timeout; a chat message
containing <script> is shown as plain text in the browser test.
```

**REVIEW THE PLAN:** the role change updates the sync server connection, not only the screen; the chat renderer never uses `dangerouslySetInnerHTML`; one process.

**CHECK**

1. All standard commands pass.
2. Two windows in a room: chat both ways under half a second. Reload one window: the last messages return.
3. Type `<img src=x onerror=alert(1)>` in chat: it appears as plain text and no alert pops up.
4. Send 25 messages in 10 seconds (hold Enter): later ones are refused with a visible, polite message.
5. As owner, demote the guest to viewer (REST Client): within a second the guest's editor becomes read-only, with the banner reason from T08, without reloading.
6. Close the guest window: after about 30 seconds the participant list updates.

**IF IT FAILS**

- Messages arrive twice: the client registered the listener twice (StrictMode) or reconnect duplicated it.
- Demoted user can still type: only the UI changed; the sync connection role was not updated.
- Sockets connect locally but not live: `/socket.io` is missing from the Caddy proxy list.

**DONE WHEN:** chat, presence and live role changes work and are tested. **COMMIT:** `feat(events): socket.io chat, presence, live roles`. **SEND ME:** report and the events files (security task).

---

## T10. Code execution runner (the sandbox)

**Branch:** `task/T10-runner`
**PRD IDs:** EX-1 to EX-6, CONC-4 (queue); SEC-4 basics; PRD section 14.
**Depends on:** T09 and your Week 1 sandbox spike results.
**This is the riskiest task. Take your time and do not merge until every attack in the escape suite ends safely.**

**Goal:** run strangers' Python, C++ and JavaScript safely, with fixed limits, in throwaway containers, through a small separate runner service.

**YOU DO**

1. Re-read `docs/notes/sandbox-spike.md`: write down the cold start times and memory numbers you measured. Give them to the agent.
2. Make sure Docker Desktop is running locally. On the VM, pull the base images after the agent names them (for example `docker pull python:3.12-slim`).
3. Create a `RUNNER_SECRET` (random, 32 bytes hex, same command as the session secret) and add it to your local `.env` and to `/opt/pairprep/.env` on the VM.

**AGENT PROMPT**

```
TASK T10: Execution runner. Read docs/PRD.md sections 6.4 (EX-1..EX-6), 6.6 (CONC-4), 14
(all of it), AGENTS.md security rules, AD-2, and docs/notes/sandbox-spike.md.
Architecture (decision AD-2): a new workspace apps/runner, a minimal HTTP service in its
own container on an INTERNAL Docker network (not published). The API container never gets
the Docker socket. The runner is authenticated with the shared RUNNER_SECRET header
(constant-time comparison). The runner container: non-root where possible, read-only root
filesystem, all capabilities dropped, no-new-privileges, memory limit about 96 MB, only the
Docker socket mounted. Explain in the plan how the runner reaches Docker without root and
what the residual risk is.
1. In apps/server define an ExecutionProvider interface:
   run({ language, source, stdin }) returns { verdict, stdout, stderr, timeMs, memKb,
   exitCode, truncated }. The runner client implements it. Languages: python, cpp, javascript.
2. Runner flow per run (section 14.1): create a fresh container with the limits below; put
   the source in via the Docker API archive upload (never a host bind mount); for C++
   compile first (10 s, 192 MB) and map compiler output to a Compile Error verdict with
   line numbers; run with stdin; a watchdog kills the container at the wall-time limit;
   read the exit status and the out-of-memory flag; map to a verdict; force-remove the
   container in a finally block.
3. Limits for every run: 5 s wall time, 128 MB memory with swap equal to memory (no swap),
   0.5 CPU, 64 processes, output capped at 1 MB then flagged "truncated" (Output Limit),
   no network, non-root user, read-only root filesystem, small tmpfs working directory
   (writable, size-limited), all capabilities dropped, no-new-privileges, default seccomp,
   container labelled pairprep=sandbox.
4. Verdicts: Accepted (ran to completion; Phase 1 reports "Completed"), Compile Error,
   Runtime Error, Time Limit, Memory Limit, Output Limit, Internal Error. Internal Error
   never blames the user and can be retried.
5. Janitor: every minute remove containers labelled pairprep=sandbox that are older than
   30 seconds.
6. Queue in apps/server: at most 2 runs in parallel, at most 1 C++ compile at a time, at
   most 20 waiting, first come first served, 30-second queue timeout, at most 1 pending run
   per user, per-user run rate limit of 10 per minute (HTTP 429). Source and stdin each at
   most 64 KB.
7. Endpoints: POST /api/v1/rooms/:slug/run (editor roles and owner; not viewers; not ended
   rooms), GET /api/v1/runs/:id. Results also go to the room through Socket.IO events
   run:queued, run:started, run:finished (include who ran it). Keep run records one hour.
8. Images: Python, Node and a small C++ image (debian slim with g++ rather than the huge
   gcc image, unless you measure otherwise). Document each image's size. Pin by digest in
   the final version.
9. Escape and abuse suite in infra/sandbox/attacks/ run by npm run test:sandbox, one
   program per attack and language where applicable: infinite loop, memory bomb, fork bomb,
   huge output, network call to the internet and to the host, read of host files and of the
   Docker socket path, write of a large file, rapid repeated runs (rate limit), reading the
   previous run's files (must not exist), attempting to start containers from inside.
   Expected verdicts are written in the test.
9b. Write docs/notes/runner.md including measured memory of the runner and API during two
   parallel runs.
Tests: verdict mapping unit tests; queue unit tests with a fake provider (parallel limit,
order, timeout, per-user limit); integration tests against real Docker; the escape suite.
```

**REVIEW THE PLAN:** the API has no Docker socket; the runner is not reachable from outside; source is uploaded, not mounted; every limit from AGENTS.md appears; the plan says what the runner's residual risk is.

**CHECK**

1. All standard commands pass, and `npm run test:sandbox` prints a table where **every attack ends in its expected verdict**. If one does not, do not merge.
2. Manual: run Hello World in each language from the REST Client; run a program that reads stdin.
3. After 20 runs: `docker ps -a --filter label=pairprep=sandbox` shows **no leftover containers**.
4. On the VM while two runs are active: `free -h` and `docker stats --no-stream` (note runner and api memory). Compare with the PRD budget in section 17.1 and write the numbers in `docs/notes/runner.md`.
5. Submit an infinite loop three times at once from three accounts: queue positions appear, only two run together, all end as Time Limit.
6. From a window with the viewer role, try to run: refused with 403.

**IF IT FAILS**

- `permission denied` on `/var/run/docker.sock`: the runner user is not in the docker group; fix the group, do not run as root without noting why.
- C++ binary will not run: the working directory is mounted with `noexec`; the compile output directory must allow execution.
- Memory Limit on a trivial program: JavaScript and Python need more than a few MB; check the 128 MB limit and the image's startup memory.
- Cold start over 2 seconds: consider a small pool of pre-started containers (ask the agent for a design before building it).
- Out-of-memory kills on the VM: the runner or API exceeded the budget; lower the runner limit or the parallel run count and record the decision.
- Windows laptop paths or sockets differ: run the runner in its container locally as well, not as a bare Node process.

**DONE WHEN:** the escape suite is green, no containers leak, memory numbers are recorded. **COMMIT:** `feat(runner): sandboxed execution service and queue`. **SEND ME:** report, the runner and queue files, `npm run test:sandbox` output, and the VM memory numbers. I will review this one closely.

---

## T11. Run and console UI

**Branch:** `task/T11-run-ui`
**PRD IDs:** EX-1, EX-2, EX-3 (verdicts in the UI), EX-5, EX-7, UI-2.
**Depends on:** T10.

**Goal:** a console panel where anyone with edit rights can run code with custom input, and everyone in the room sees the result and who ran it.

**YOU DO:** create the branch.

**AGENT PROMPT**

```
TASK T11: Console panel in apps/web. Read docs/PRD.md sections 6.4, 14.4 and 21.2 (item 5).
1. Bottom console panel with tabs for Output (stdout), Errors (stderr and compile output)
   and Input (stdin text box). Run button and the shortcut Ctrl+Enter (Cmd+Enter on Mac).
   The language comes from the room.
2. States: idle, queued (show position), running, finished, failed. The Run button is
   disabled while this user's run is pending. Viewers and ended rooms see Run disabled
   with the reason.
3. Verdict badge with an icon AND a word AND a color (never color alone), plus the
   plain-language explanation and hint for each verdict from section 14.4, for example
   "Time Limit: your program ran longer than 5 seconds".
4. Results are shared: every participant sees the result with "run by <name>" and time
   taken, delivered by the Socket.IO run events. Late joiners see the latest result.
5. Truncated output is clearly marked. A Copy output button. Output panel is plain text
   (never HTML) with a monospace font and no surprise auto-scrolling when the user has
   scrolled up.
6. Errors: HTTP 429 shows a retry countdown; a runner failure shows "Run is unavailable
   right now. You can keep editing." Nothing else in the page breaks.
7. aria-live polite announcement when a run finishes.
Tests: component tests for every verdict; Playwright: both browsers see one run's output
labelled with who ran it; two users run at the same time and both see queue positions;
runner stopped means a friendly message; Ctrl+Enter runs.
```

**CHECK**

1. All standard commands pass.
2. Write each of these and run it in each language: Hello World, an echo of stdin, an infinite loop, a program printing a million lines, a division by zero, a C++ syntax error. Each shows the right verdict, a clear explanation, and (for C++) the line number.
3. Open a second window: it sees your result with your name.
4. Stop the runner container (`docker stop <runner>`), press Run: friendly message, editor still works. Start it again.
5. Screen reader or keyboard check: after a run, the result is announced; you can reach every control by keyboard.

**IF IT FAILS**

- Results appear only for the person who ran: the socket event is not being broadcast to the room.
- Output looks garbled: not UTF-8 or ANSI escape codes; strip them or render safely.
- Buttons stay disabled: the run record never reaches a final state when the runner times out; add a client timeout.

**DONE WHEN:** a full run, shared result, and all verdicts work for all three languages. **COMMIT:** `feat(web): console panel and shared run results`. **SEND ME:** report and screenshots of each verdict.

---

## T12. Concurrency and idempotency test suite

**Branch:** `task/T12-concurrency-tests`
**PRD IDs:** CONC-1, CONC-2, CONC-3, CONC-4; ED-2 acceptance criteria.
**Depends on:** T11.

**Goal:** prove, with automated evidence and not hope, that many writers converge, duplicates are harmless, retries are safe, and runs queue fairly.

**YOU DO:** create the branch. This task is mostly tests, so your main job is to make sure the tests really can fail (see CHECK 3).

**AGENT PROMPT**

```
TASK T12: Concurrency and idempotency tests. Read docs/PRD.md sections 6.6 (CONC-1..4),
6.3 (ED-2), 19.
1. Convergence fuzz harness (npm run test:fuzz): 6 simulated clients connect to a real
   test server; for 60 seconds each performs random inserts and deletes at random
   positions (including multi-line paste-like inserts), with random pauses and random
   disconnect and reconnect. At the end, wait for sync and assert every client and the
   persisted document have identical text. Use a seeded random generator and print the
   seed on failure so it can be replayed. The trial count is a parameter: 3 trials in the
   pull request workflow; 100 trials in a scheduled nightly GitHub workflow (cron) that
   reports a summary.
2. Duplicate delivery: replay every update twice (and out of order) to a fresh document;
   the result must equal single, in-order delivery.
3. REST idempotency across every endpoint that accepts an Idempotency-Key: sequential
   duplicates, concurrent duplicates (20 parallel identical requests), same key with a
   different payload.
4. Fair runs: 10 simultaneous run requests from 5 users; assert at most 2 run in parallel,
   first come first served, one pending run per user, and that each result reaches the
   user who asked.
5. Mutation check: show me, once, that each test fails if the behavior is broken (for
   example temporarily skip applying one update, or remove the unique index). Revert the
   break afterward and keep a note in docs/notes/concurrency-tests.md.
Do not change production behavior except to fix real bugs these tests find; report each bug
found.
```

**CHECK**

1. All standard commands pass, including `npm run test:fuzz`.
2. Run `npm run test:fuzz` with 100 trials once locally (this may take a while). Expected summary: `0 divergences in 100 of 100 trials`.
3. Ask the agent to show a deliberately broken version failing each test (the mutation check). A test that cannot fail proves nothing.
4. The scheduled nightly workflow exists and appears under the Actions tab (it runs only on the default branch after merge).

**IF IT FAILS**

- Divergence found: that is a real bug (or a test bug). Keep the seed; reproduce with that seed; give the seed and the failing output to the agent via the debugging protocol (0.6).
- Flaky timing: replace sleeps with "wait until synced" conditions.
- Fuzz test too slow in CI: lower trials for pull requests, keep 100 for nightly.

**DONE WHEN:** zero divergences over 100 trials, duplicates harmless, retries safe, queue fair, and each test proven able to fail. **COMMIT:** `test: concurrency, idempotency and fairness suites`. **SEND ME:** report and the fuzz summary output.

---

## T13. Live change indicators

**Branch:** `task/T13-live-indicators`
**PRD IDs:** LIVE-1 to LIVE-8 (PRD section 6.7).
**Depends on:** T08 (T12 recommended first, so the indicators are built on a proven sync).

**Goal:** when someone else types, you can see that the code is changing and who is changing it, without your own typing ever being disturbed.

**YOU DO:** create the branch. Prepare two windows side by side; you will judge this one with your eyes.

**AGENT PROMPT**

```
TASK T13: Live change indicators in apps/web. Read docs/PRD.md section 6.7 (LIVE-1..8) and
section 13.2 (awareness).
1. Awareness gains a lastEditAt timestamp, updated (throttled to once per 200 ms) when the
   local user edits.
2. LIVE-1 remote edit highlight: text inserted or changed by someone else is highlighted
   in that person's color for 2 seconds and fades; your own edits are never highlighted.
   Use Monaco decorations driven by the Yjs change events whose origin is remote. Map the
   author from the Yjs client ID through awareness; if the author has already left,
   use a neutral color and the label "Someone".
3. LIVE-2 cursor name flag: visible while the person is active and for 3 seconds after,
   then shrinks to a small colored bar.
4. LIVE-3 typing indicator in the participant list and the chat footer: "Meera is typing"
   or "Meera and Rohan are typing", appearing within 300 ms and clearing 2 seconds after
   the last keystroke.
5. LIVE-4 gutter marker: a thin bar in the author's color with their initial beside lines
   being edited by others, cleared after 3 seconds without edits.
6. LIVE-5 off-screen cue: when someone edits outside the visible area, an indicator at the
   top or bottom edge shows who and which line with an arrow; clicking scrolls there. The
   view is never moved automatically.
7. LIVE-6 never disturb the typist: remote edits above or below the cursor must not move
   your cursor, selection or scroll position.
8. LIVE-7 calm and accessible: honor prefers-reduced-motion (static marker for 2 seconds
   instead of a fade) and add a settings toggle for remote highlights; colors from the
   color-blind-safe palette and always with initials; aria-live polite announcements at
   most once every 5 seconds, for example "Meera edited lines 10 to 12".
9. LIVE-8 bulk changes: a remote change of more than 20 lines shows a single notice
   "Meera pasted 35 lines" with a Jump button instead of flashing the range.
Tests (Playwright, two contexts): highlight appears within 200 ms in the author's color and
disappears within 3 seconds; typing indicator timing; local caret stays on the same text
while a second client inserts 10 lines above it (assert the caret's text position before
and after); reduced-motion emulation; bulk paste notice; no highlight on your own edits.
```

**CHECK**

1. All standard commands pass.
2. Two windows side by side: type in one; in the other the text glows in the author's color for about 2 seconds, the name flag appears, and the typing line reads "<name> is typing".
3. In window B, place your cursor in the middle of line 20 and keep typing; in window A insert ten lines at the top. Your cursor in B must stay on the same text and the screen must not jump.
4. Scroll window B far down; edit near the top in A: an edge cue appears; clicking it scrolls; nothing scrolled by itself.
5. In DevTools (three dots, More tools, Rendering), set **Emulate CSS prefers-reduced-motion: reduce**: no fading animation, a static marker instead.
6. Paste 40 lines in A: B shows one notice, not 40 flashes.

**IF IT FAILS**

- Highlight in the wrong place after more edits: decorations must follow Monaco ranges (use tracked decorations), not stored line numbers.
- Your cursor jumps: the binding is being re-created, or a full document replace is happening instead of a diff.
- Typing indicator stays on: `lastEditAt` is never cleared; compare with the current time on a timer.
- Everything flickers with 6 users: batch decoration updates per animation frame.

**DONE WHEN:** you can see who is writing live and your own typing is never disturbed. **COMMIT:** `feat(web): live change indicators`. **SEND ME:** report and a short screen recording of two windows.

---

## T14. Layout, editor features, export and responsive behavior

**Branch:** `task/T14-layout`
**PRD IDs:** UIX-1, UIX-2, PER-3, UI-1, ED-7 (superseded by UIX settings in T15).
**Depends on:** T11.

**Goal:** a room that feels like a real tool: resizable panes (LeetCode-style), VS Code-style editor features, a status bar, file export, and a layout that works on narrower screens.

**YOU DO:** create the branch. Open LeetCode and VS Code in two tabs beside the app for reference. Take ideas only; copy no logos, icons, text or code (UIX-13).

**AGENT PROMPT**

```
TASK T14: Room layout and editor features in apps/web. Read docs/PRD.md sections 6.8
(UIX-1, UIX-2), 6.5 (PER-3, UI-1), 21.2.
1. Resizable panes with drag handles using a maintained library (propose it in the plan):
   problem panel (a collapsed placeholder labelled "Problem panel, coming in Phase 2"),
   editor, console, and a right panel with participants and chat. Each pane can be
   collapsed and restored; minimum sizes prevent accidental disappearance; "Reset layout"
   command.
2. A per-user settings store: GET and PUT /api/v1/me/settings in the server (Zod schema,
   versioned, 16 KB limit) for signed-in users; localStorage for guests. Layout is saved
   there. (T15 adds appearance settings to the same store.)
3. Monaco options: line numbers, minimap (toggle), bracket pair colorization, indent
   guides, current-line highlight, code folding, find and replace, multi-cursor with
   Alt+click, standard VS Code shortcuts, tab size 2/4/8, spaces or tabs, word wrap.
4. Status bar: line and column, language, connection state, number of people present.
5. Export: a Download button saves the current code as a file with the right extension
   (.py, .cpp, .js) using the room name.
6. Responsive: full features from 1024 px; below that the panels become tabs with the
   editor as the main view; the page is usable read-only at 360 px.
7. Write docs/notes/layout.md with a checklist of the 15 shortcuts below.
Tests: Playwright for resize, collapse, persistence after reload, export filename and
content; component tests for the status bar; layout persists per user and independently
in two browsers.
```

**CHECK**

1. All standard commands pass.
2. Manual shortcut test (click in the editor first). Each must work: Ctrl+F (find), Ctrl+H (replace), Ctrl+Z / Ctrl+Y (undo, redo), Ctrl+D (select next occurrence), Alt+click (extra cursor), Ctrl+/ (comment), Alt+Up / Alt+Down (move line), Shift+Alt+Down (copy line), Ctrl+Shift+K (delete line), Ctrl+] and Ctrl+[ (indent, outdent), Ctrl+G (go to line), Ctrl+Shift+[ (fold), Ctrl+Space (suggestions), Ctrl+A (select all), F1 (Monaco's own command list).
3. Drag every divider; collapse and restore each pane; reload: the layout is the same. Open a second browser: its layout is independent.
4. Press Download: the file has the right extension and contents.
5. DevTools device toolbar at 360 px and at 800 px: panels become tabs and the editor is usable.

**IF IT FAILS**

- Monaco does not resize with its pane: set `automaticLayout` or call `layout()` when the pane size changes.
- A browser shortcut wins over Monaco (for example Ctrl+D bookmarks the page): the editor must have focus; if it still fails, note it in the checklist rather than fighting the browser.
- Layout "jumps" on load: render the saved layout before first paint, or show a skeleton.

**DONE WHEN:** all 15 shortcuts work, layout persists per person, export and responsive modes work. **COMMIT:** `feat(web): resizable layout, editor features, export`. **SEND ME:** report and a screenshot of the room.

---

## T15. Themes, fonts, text size and the settings drawer

**Branch:** `task/T15-appearance`
**PRD IDs:** UIX-3, UIX-4, UIX-5, UIX-6, UIX-7, UIX-13.
**Depends on:** T14.

**Goal:** at least 8 themes, 6 fonts, text sizes from 10 to 32 px, all personal to each user and saved, with open licenses recorded.

**YOU DO:** create the branch. Decide your default theme and font (suggestion: Dark and JetBrains Mono). Check each font's license text yourself when the agent adds it.

**AGENT PROMPT**

```
TASK T15: Appearance settings in apps/web. Read docs/PRD.md section 6.8 (UIX-3..UIX-7,
UIX-13) and 21.4.
1. Themes (each styles BOTH the app interface and the Monaco editor): Light, Dark,
   High-contrast dark, High-contrast light, Solarized Light, Solarized Dark, Dracula,
   Nord. Define app themes as CSS variables; define Monaco themes from the same palettes
   with monaco.editor.defineTheme (register them before the editor is created). A "Match
   system" option follows prefers-color-scheme. Switching applies in under 100 ms with no
   reload and no flash of the wrong theme on page load (apply the saved theme before the
   app renders; keep Content-Security-Policy in mind).
2. Fonts: JetBrains Mono, Fira Code, Source Code Pro, Cascadia Code, Roboto Mono, IBM Plex
   Mono, plus the system monospace default. Self-host the font files (for example through
   @fontsource packages; if one is unavailable, add the official font files). Load ONLY
   the selected font, lazily, with font-display swap and a fallback stack so text is
   never invisible. A ligatures toggle.
3. Text size: editor font size 10 to 32 px (default 14) with a slider and Ctrl+Plus,
   Ctrl+Minus and Ctrl+0 (reset) when the editor is focused; line spacing compact, normal,
   relaxed; interface scale 80% to 150%. After a font or size change call Monaco's font
   remeasure so cursors and selections, including remote cursor flags, stay aligned.
4. Settings drawer (gear icon) with Theme, Font, Size and Editor sections, a live preview
   snippet, and "Reset to defaults". Use the settings store from T14 (server for signed-in
   users, localStorage for guests).
5. Settings are personal: they must never be stored in the Yjs document, awareness, or any
   shared channel. Two browsers with different settings must not affect each other.
6. THIRD_PARTY_NOTICES.md: add every theme palette, font and icon source with name, link
   and license. Only open licenses. If a license is unclear, do not use the asset.
Tests: Playwright: every theme applies to app and editor; every font loads (check
document.fonts) and only the chosen font file is requested; size changes keep the caret and
a remote cursor aligned; two contexts with different settings stay independent; settings
persist after reload and (signed in) on a second device context; Ctrl+Plus and Ctrl+Minus
change the size.
```

**CHECK**

1. All standard commands pass.
2. Cycle through all 8 themes: app and editor change together; the switch feels instant.
3. Cycle through all fonts. DevTools, Network, filter "font": only the font you chose is downloaded.
4. Set size 32, then 10, then reset with Ctrl+0: remote cursor labels and selections still sit on the right characters.
5. Open a second browser with a different theme, font and size: they never affect each other.
6. Reload: your choices are still there; the page does not flash the wrong theme.
7. Open `THIRD_PARTY_NOTICES.md`: every font and theme has a name, source and license.

**IF IT FAILS**

- Cursor is off by a few pixels after a font change: the editor must re-measure fonts after the font finishes loading.
- Monaco keeps the old theme: the theme must be defined before the editor is created, then applied with `setTheme`.
- Flash of light theme on reload: the saved theme is applied too late; apply it from a tiny script or inline style before React starts (CSP may need a hash or nonce).
- A font will not load: file path or MIME type on the server; check the Network tab response.

**DONE WHEN:** all themes, fonts and sizes work, are personal and persistent, and licenses are recorded. **COMMIT:** `feat(web): themes, fonts, text size, settings drawer`. **SEND ME:** report and screenshots of two themes.

---

## T16. UI polish and performance

**Branch:** `task/T16-polish`
**PRD IDs:** UIX-8, UIX-10, UIX-11, UIX-12. (UIX-9, autocomplete control for candidates, waits for interview rooms in Phase 2.)
**Depends on:** T15.

**Goal:** the product feels fast and finished: command palette, optional Vim mode, a consistent design system, smooth loading, and measured performance.

**YOU DO:** create the branch. Write down the three things that annoy you most when you use the app; give them to the agent as extra polish items.

**AGENT PROMPT**

```
TASK T16: Polish and performance. Read docs/PRD.md section 6.8 (UIX-8, UIX-10, UIX-11,
UIX-12).
1. Command palette (Ctrl+Shift+P): fuzzy search over commands: change theme, change font,
   increase and decrease text size, toggle minimap, run code, toggle panels, reset layout.
   Keyboard only operation, focus trap, Escape closes.
2. Optional Vim mode in the settings drawer using a maintained Monaco Vim package (check its
   maintenance and license first; propose alternatives if it is unmaintained). Load it only
   when enabled. Show the mode in the status bar.
3. Design system: document tokens and components in docs/design-system.md with a short
   living page or markdown list; consistent spacing, type scale and icons (one open-licensed
   icon set); skeleton loaders; 150 to 200 ms transitions that honor reduced motion.
4. Performance: confirm Monaco and language support load only when a room opens; produce a
   bundle report and set a size budget for the app code outside the editor, written in
   docs/notes/performance.md; measure room interactive time on broadband (target under 3
   seconds), cumulative layout shift under 0.1, and local keystroke-to-screen latency
   under 50 ms with 6 simulated participants. Report numbers; do not claim them without
   measurement.
5. Accessibility pass: Lighthouse accessibility at least 90 on landing, dashboard and room;
   a full keyboard-only walk of the main journey.
Tests: palette open, search, run command; Vim toggle; reduced motion; Lighthouse in CI or a
documented manual script; budget check script.
```

**CHECK**

1. All standard commands pass.
2. Ctrl+Shift+P: type "theme" and switch theme using only the keyboard.
3. Turn Vim mode on: typing `i`, `Esc`, `dd` behave like Vim; turn it off again.
4. Chrome DevTools, Lighthouse (Performance and Accessibility) on the room page: record the numbers.
5. Reload the room on throttled "Fast 4G" in DevTools: the layout does not jump; skeletons appear first.
6. Walk the full journey with only the keyboard: create room, join, edit, run, chat.

**IF IT FAILS**

- Large bundle: Monaco imported eagerly; load it on room entry only.
- Vim package breaks Monaco upgrades: lazy-load it and keep it optional; drop it if unmaintained.
- Performance numbers worse than the targets: record the real numbers and open an issue; do not hide them.

**DONE WHEN:** the targets are met or the real numbers are recorded with a plan. **COMMIT:** `feat(web): command palette, vim mode, design system, performance`. **SEND ME:** report and the Lighthouse numbers.

---

## T17. Phase 1 gate: end to end on the live server

**Branch:** `task/T17-phase1-gate`
**PRD IDs:** the Phase 1 gate in PRD section 4 (two people finish a full session on the deployed URL).
**Depends on:** T01 to T16.

**Goal:** prove the whole of Phase 1 works on the real server, record baseline numbers, trace every requirement to evidence, and invite the first testers.

**YOU DO**

1. Create a monitor in UptimeRobot (free): HTTPS check of `https://pairprep-live.eastasia.cloudapp.azure.com/healthz` every 5 minutes with an email alert after two failures. Check its current free limits on signup.
2. Make sure the weekly cost check is done and the budget alerts are set.
3. Prepare a short feedback form (any free form tool) for the testers: what worked, what broke, what felt slow.

**AGENT PROMPT**

```
TASK T17: Phase 1 gate. Read docs/PRD.md sections 4, 6 (all), 19 and 20.
1. Traceability: create docs/notes/phase1-traceability.md, a table of every Phase 1
   requirement ID (AUTH, ROOM, ED, EX, CH, PER, UI, CONC, LIVE, UIX except UIX-9) with
   the test name or manual evidence that proves it and its current status. Mark anything
   without evidence as NOT PROVEN. Do not mark an item done without evidence.
2. End-to-end test of the full Phase 1 journey with two browser contexts: owner creates a
   room, guest joins by link, both edit at once, cursors and live indicators appear, chat,
   run code, owner demotes the guest to viewer, guest loses write access, network drop and
   recovery, owner ends the room (read-only), room restores after reload.
3. Smoke load test with k6 (WebSocket): 10 rooms with 2 connections each typing for 5
   minutes against the DEPLOYED server, from a script I run from my laptop. Record median
   and 95th percentile sync latency, error rate, and VM memory and CPU during the run
   (docker stats and free -h on the VM). This is a smoke test, not the full Phase 3 load
   test; label results accordingly.
4. Security checks: run the sandbox escape suite against the deployed runner; npm audit;
   a secret scan (gitleaks or similar) in CI; check the production security headers with an
   online header scanner; confirm no test-only routes exist in the production build.
5. Write docs/notes/phase1-baseline.md with: the numbers above, the VM memory at idle and
   under load, known issues, and decisions to revisit.
6. Tag release v0.1.0 and write short release notes.
```

**CHECK**

1. All standard commands pass; the end-to-end test passes locally and against a deployed build.
2. Open the traceability table: **every row has evidence**. Any `NOT PROVEN` row is a task for the agent, not something to ignore.
3. On the live site with a friend: you (signed in) and your friend (guest, on their own phone data or Wi-Fi) edit one file for 10 minutes, chat, run code, then end the session. Nothing lost, nothing broken.
4. VM: `docker ps` all services up, `free -h` stable after the load test, no leftover sandbox containers.
5. UptimeRobot shows the monitor up.
6. Cost analysis: nothing unexpected.

**IF IT FAILS**

- Latency worse than 200 ms at the 95th percentile: remember the server is in East Asia; measure from your location and record it honestly. If it is the main problem, the options are a closer region (if a free size becomes available there) or accepting a higher number for now; we decide together with the real numbers.
- Memory above 85% during the load test: apply the PRD section 17.2 fallbacks (lower parallel runs, lower room cap, trim the heap) and record the change.
- A `NOT PROVEN` row: write the missing test or manual check; never delete the row.

**DONE WHEN:** the traceability table has evidence for every row, the live two-person session passes, the baseline numbers are recorded, and `v0.1.0` is tagged. Then invite 5 to 10 testers.
**COMMIT:** `chore: phase 1 gate, traceability, baseline`. **SEND ME:** traceability table, baseline notes, load-test output, and a zip of the repository for a code review pass.

---

## Appendix A. Which task builds which requirement

| Requirement IDs                | Task                                                   |
| ------------------------------ | ------------------------------------------------------ |
| AUTH-1, AUTH-2, AUTH-4, AUTH-5 | T04 (UI for AUTH-5 in T06)                             |
| AUTH-3                         | T05 (UI in T06)                                        |
| ROOM-1, ROOM-2, ROOM-4, ROOM-6 | T05 (UI in T06)                                        |
| ROOM-3                         | T05 and T09                                            |
| ROOM-5                         | T08 and T09                                            |
| ED-1, ED-3, ED-5               | T08                                                    |
| ED-2                           | T07, T08, T12                                          |
| ED-4                           | T08 (hook), T17 (smoke numbers); full proof in Phase 3 |
| ED-6                           | T07                                                    |
| ED-7                           | Superseded by UIX-3 to UIX-7 (T15)                     |
| EX-1 to EX-6                   | T10 (UI in T11)                                        |
| EX-7                           | T11                                                    |
| CH-1 to CH-3                   | T09                                                    |
| PER-1                          | T07                                                    |
| PER-2                          | T05 and T06                                            |
| PER-3                          | T14                                                    |
| UI-1                           | T14                                                    |
| UI-2                           | T06 and every UI task                                  |
| CONC-1, CONC-2                 | T07 and T12                                            |
| CONC-3                         | T05 and T12                                            |
| CONC-4                         | T10 and T12                                            |
| LIVE-1 to LIVE-8               | T13                                                    |
| UIX-1, UIX-2                   | T14                                                    |
| UIX-3 to UIX-7, UIX-13         | T15                                                    |
| UIX-8, UIX-10, UIX-11, UIX-12  | T16                                                    |
| UIX-9                          | Deferred to Phase 2 (needs interview rooms)            |

## Appendix B. Accounts and secrets checklist

| Item                                                  | Where it lives                                              | Never                                                 |
| ----------------------------------------------------- | ----------------------------------------------------------- | ----------------------------------------------------- |
| `MONGODB_URI`                                         | local `.env`, `/opt/pairprep/.env`                          | in Git, in screenshots, in chat                       |
| `SESSION_SECRET` (different per environment)          | local `.env`, VM `.env`                                     | reused between dev and production                     |
| Google and GitHub client secrets (dev and production) | local `.env`, VM `.env`                                     | in Git or in the browser bundle                       |
| `RUNNER_SECRET`                                       | local `.env`, VM `.env`                                     | shared with the browser                               |
| SSH private key (`.pem`)                              | a private folder outside the project, plus a private backup | open in an AI-enabled editor, in Git, pasted anywhere |
| GitHub Actions secrets (deploy key, host)             | GitHub, Settings, Secrets                                   | printed in workflow logs                              |

If you ever paste a secret somewhere by mistake: stop, tell me, and rotate it (generate a new one and replace it everywhere). Do not just delete the message.

## Appendix C. Windows and tooling notes

- In PowerShell always type `curl.exe`, not `curl`.
- Docker Desktop must be running for anything that uses Docker locally.
- Check the prompt before running a command: `PS C:\...>` is your laptop, `azureuser@pairprep-vm:~$` is the server. `sudo` and `apt` only work on the server.
- Line-ending warnings about CRLF are harmless.
- Long paths and spaces in folder names (`C:\Users\Shubham Sanap\...`) can break some scripts; if a tool fails on a path, quote it, or move the project to a short path such as `C:\dev\pairprep`.
- Stopping all Node processes with `taskkill /F /IM node.exe` also stops other tools you may be running (including some editors' helpers). Prefer stopping by port or by the PID the dev server prints.

## Appendix D. When to stop and ask me

- A security-sensitive task finishes (T04, T05, T07, T09, T10): send me the files.
- Any test fails twice after the debugging protocol.
- The agent proposes adding a service, opening a port, mounting the Docker socket, or loosening a limit.
- A measured number is worse than the PRD target.
- You are unsure whether something counts as "done".

End of Phase 1 task guide.
