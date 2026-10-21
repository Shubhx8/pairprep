# Task 2: Quality Tooling and CI Skeleton

## What Changed

- Configured **Prettier** (`.prettierrc`, `.prettierignore`) for unified code formatting across all workspaces.
- Configured **ESLint 9 Flat Config** (`eslint.config.mjs`) with TypeScript-ESLint, strictly enforcing no-unused-vars and no-explicit-any.
- Configured **Vitest** (`vitest.config.ts`) and Supertest with automated test discovery across all workspaces.
- Implemented 3 comprehensive test suites:
  - `packages/shared/src/__tests__/schemas.test.ts`: Verifies `PingResponseSchema`, role enum permissions, and language whitelist rejections.
  - `apps/server/src/__tests__/ping.test.ts`: Integration test testing Express HTTP routes (`GET /`, `GET /api/ping`, and 404 handler) against Zod runtime contracts.
  - `apps/web/src/__tests__/app.test.ts`: Frontend contract and schema parsing tests.
- Configured **GitHub Actions Workflow** (`.github/workflows/ci.yml`) triggering on pushes and pull requests to `master`, enforcing format check, lint, typecheck, tests, and build.

## Why

- **Vitest vs. Jest:** Vitest reuses the Vite pipeline, requires zero transpilation/babel plugins, and runs tests concurrently in worker threads with native ESM support.
- **ESLint Flat Config:** The modern standard in ESLint 9 provides faster AST parsing and explicit project scoping without legacy `.eslintrc` configuration drift.
- **Fail-Fast CI Pipeline:** Running automated formatting, linting, typechecking, and tests in GitHub Actions guarantees that regressions are blocked before touching the main branch or production.

## Trade-offs

- Modern NodeNext module resolution requires explicit `.js` extensions for relative imports in TypeScript test files.
- Separating unit tests from full integration tests allows quick developer feedback without waiting for external Docker or MongoDB infrastructure.

## How to Explain in an Interview

> _"We implemented a comprehensive quality pipeline using Prettier, ESLint, and Vitest connected to GitHub Actions CI. By adopting Vitest, we achieved sub-second test execution across the entire monorepo with native ESM and TypeScript support. Our CI pipeline enforces a strict fail-fast policy on every pull request: verifying formatting, linting, static typechecking, unit tests, and production builds before any code can be merged."_
