# Week 1 Sprint: Engineering Foundation

Implementation plan for Week 1 foundation milestones.
After each task: run linting, type checks, review the diff, and commit with Conventional Commits.

---

## Task 1: Monorepo scaffold

Read `docs/PRD.md` sections 10, 11 and 18. Create an npm-workspaces monorepo with `apps/web` (Vite, React, TypeScript, Tailwind),
`apps/server` (Node, Express, TypeScript) and `packages/shared` (TypeScript, Zod). Strict TypeScript everywhere.
Add one shared Zod schema and import it from both apps to prove the wiring works.
Done when: `npm install` works at the root, both apps start in dev mode, and the web page shows a value fetched from the server.

## Task 2: Quality tooling and CI skeleton

Read PRD sections 8 (QA-1, QA-4) and 19. Add ESLint, Prettier and Vitest with one real test per app. Add a GitHub Actions workflow
that runs lint, type check, tests and build on every pull request.
Done when: all commands pass locally and the workflow file is valid.

## Task 3: Health endpoint and container

Read PRD sections 8 (OBS-1, OBS-4) and 18. Add `GET /healthz` to the server (return status and uptime only for now), structured JSON logging
with request IDs (no source code or chat in logs), and a production Dockerfile for the server with a capped Node heap.
Add `infra/docker-compose.yml` with the server and a Caddy proxy.
Done when: `docker compose up` serves `/healthz` through Caddy on localhost.

## Task 4: Sandbox spike (design experiment, not final code)

Read PRD section 14. Write a standalone script in `infra/spike/` that runs hello-world and a stdin-echo program for Python, C++ (gcc) and Node
inside disposable Docker containers using the exact sandbox limits. Print for each language: cold start time, total run time, peak memory
and verdict. Also run these attacks and show each ends safely: infinite loop, memory bomb, fork bomb, huge output, network call.
Done when: a results table is saved in `docs/notes/sandbox-spike.md` and every attack ends in the expected verdict.

## Task 5: Deploy pipeline (after the Azure VM exists)

Read PRD sections 17 and 18. Write the GitHub Actions deploy job: build the server image, push it to GitHub Container Registry, SSH to the VM
with a restricted key, pull and restart the stack, run a health check and roll back on failure.
Done when: a push to main deploys a working `/healthz` to the public URL.

---

## Infrastructure Prerequisites

- Create the Azure VM, configure swap space, and install Docker (PRD 18.5).
- Monitor Azure Cost Analysis.
- Configure MongoDB Atlas cluster.
- Register Google and GitHub OAuth applications for local and production URIs.
- Configure GitHub repository secrets for automated CI/CD deployment.
