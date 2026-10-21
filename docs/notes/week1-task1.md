# Task 1: Monorepo Scaffold

## What Changed
- Initialized an **npm workspaces monorepo** with root `package.json` managing `apps/*` and `packages/*`.
- Configured root `tsconfig.base.json` with strict TypeScript checks (`strict: true`, `noImplicitAny: true`, `noUncheckedIndexedAccess: true`).
- Created `packages/shared` (`@pairprep/shared`) containing shared Zod schemas (`PingResponseSchema`, `UserRoleSchema`, `SupportedLanguageSchema`) and exported TypeScript types.
- Converted `apps/server` (`@pairprep/server`) to TypeScript (`src/index.ts`) with Express, CORS, and `/api/ping` runtime schema enforcement.
- Initialized `apps/web` (`@pairprep/web`) with Vite, React, TypeScript, Tailwind CSS, and dev proxying for `/api`.
- Verified compilation (`npm run build`), strict typechecking (`npm run typecheck`), and end-to-end dev runtime communication (`http://localhost:5173/api/ping`).

## Why
- **Native npm Workspaces vs. Turborepo/Nx:** On a 1 GB RAM Azure B1s VM, avoiding extra daemon overhead and build tools preserves memory for the Docker sandbox runner and Node runtime.
- **Shared Zod Contracts:** TypeScript types exist only at compile time. Using Zod in `packages/shared` enables both compile-time inference (`z.infer<T>`) for frontend/backend developers and runtime assertion (`schema.parse()`) to protect against malformed payloads.
- **Vite SPA vs. Next.js:** A static Vite SPA can be served via CDN or Caddy at zero server CPU cost, reserving all VM resources for code execution and Yjs synchronization.

## Trade-offs
- Monorepos with npm workspaces require careful handling of ESM/CJS exports across packages (`type: module` and package exports maps).
- In-memory dev execution (`tsx watch` and `vite`) requires two local ports (3000 and 5173), which is unified in dev via Vite proxy and in production via Caddy reverse proxy.

## How to Explain in an Interview
> *"We architected PairPrep as an npm workspaces monorepo to maintain a single source of truth between the client and server without polyrepo synchronization drift. We used Zod in a shared package to provide end-to-end type safety: types are inferred at compile time for developers, and schemas are executed at runtime to validate API payloads. To maximize the efficiency of our 1 GB RAM server, the frontend is built as an optimized static SPA via Vite, offloading rendering from the backend."*
