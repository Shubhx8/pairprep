# AGENTS.md: rules for AI coding agents on this project

## What this project is
PairPrep (working name): a real-time collaborative interview and pair-programming platform.
Two or more people edit one shared code document live (Yjs CRDT), run code safely in
disposable Docker containers, and run mock interviews with hidden test cases, replay and a scorecard.
The builder is a solo student. The goal is a production-quality placement project with real users,
deployed at zero cost. The builder must be able to explain every design decision in an interview.

## Source of truth
- `docs/PRD.md` is the product requirements document. Requirement IDs (ED-2, INT-5, ATTR-1, LIVE-6, UIX-3 ...) are the unit of work.
- If `docs/PRD.md` is missing or still contains the placeholder text, STOP and tell the builder to export the real PRD. Never invent requirements.
- Build ONLY the requirement IDs named in the current task. Do not start the next phase early.
- If the PRD is unclear or two requirements conflict, STOP and ask. Never silently change the PRD.
- Phase 4 (video calling, AI hints) is out of scope unless explicitly requested.

## Tech stack (do not swap or add major libraries without asking first)
- Frontend: React + Vite + TypeScript, Tailwind CSS, Monaco Editor.
- Real-time: Yjs with the Monaco binding; Hocuspocus sync server; Socket.IO for room events (chat, timer, roles, run results).
- Backend: Node.js LTS + Express + TypeScript; Zod schemas shared in `packages/shared`.
- Auth: OAuth (Google, GitHub) via Passport, server-side sessions in httpOnly cookies.
- Database: MongoDB (Atlas free tier) with Mongoose. No Redis in version 1 (in-process queue and rate limits).
- Execution: own runner, one disposable Docker container per run. No Judge0 unless the builder decides after the spike.
- Tests: Vitest, Supertest, Playwright (two browser contexts), k6 for load tests.
- Tooling: npm workspaces monorepo, ESLint, Prettier, GitHub Actions.

## Repository layout
- `apps/web`: React app.  `apps/server`: API, sync server, room events, runner.
- `packages/shared`: Zod schemas and types shared by web and server.
- `infra`: Dockerfiles, docker-compose, Caddyfile, deploy scripts.  `docs`: PRD, decisions, notes.

## Non-negotiable security rules
1. Hidden test inputs and expected outputs NEVER reach a candidate's browser (INT-5). Judge only on the server.
2. The server checks role and permission on every REST route, every WebSocket message and every sync connection. Never trust a client-supplied role, user ID, client ID or timestamp.
3. Sandbox containers: no network, non-root user, all capabilities dropped, no-new-privileges, read-only root filesystem, memory 128 MB with no swap, 0.5 CPU, 64 processes max, 5 s wall time, 1 MB output cap, container removed after every run. Never mount the Docker socket into a sandbox container.
4. Validate every input with Zod. Reject unknown fields and oversized payloads.
5. Rate-limit per user and per IP (see SEC-1). Return HTTP 429 with a retry hint.
6. Never log source code or chat text. Never commit secrets, `.env` files or keys. Provide `.env.example` only.
7. Escape or sanitize all user-provided text and Markdown before rendering.

## Resource rules (the server has about 1 GB of RAM)
- One Node process for API, sync and room events. Cap the heap. At most 2 sandbox runs at once.
- Do not add background services (Redis, queues, workers) without asking.

## How to work
1. For each task: read the named requirement IDs in `docs/PRD.md`, then show a short plan BEFORE writing code.
2. Make small, reviewable changes. One logical change per commit, Conventional Commits style (feat:, fix:, test:, chore:, docs:).
3. Write tests with the feature, using the acceptance criteria in the PRD as the test cases.
4. Run lint, type check and tests before saying a task is done. Report the real output, including failures.
5. TypeScript strict mode. No `any` unless justified in a comment. No dead code, no TODOs left behind.
6. After each task, add a short note in `docs/notes/` (what changed, why, trade-offs, how to explain it in an interview).
7. Never claim something works without running it. Say clearly what you did not verify.

## Definition of done for a task
Acceptance criteria met and tested; lint, types and tests pass; no new secrets or warnings; notes written; the builder has reviewed the diff.

## Things not to do
- Do not rewrite unrelated files or reformat the whole repo.
- Do not delete tests to make them pass.
- Do not add analytics or third-party scripts.
- Do not copy logos, icons, text or code from LeetCode, VS Code or any other product (UIX-13). Use open-licensed assets only and record them in `THIRD_PARTY_NOTICES.md`.
