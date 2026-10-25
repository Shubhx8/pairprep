# PairPrep

> Real-time collaborative interview and pair-programming platform with live Yjs CRDT synchronization, Monaco Editor, isolated Docker sandbox code execution, and mock interview scorecard judging.

---

## Architecture & Monorepo Layout

PairPrep is built as an **npm workspaces** monorepo using **strict TypeScript**:

- **`apps/web`**: React SPA powered by Vite, Tailwind CSS, Monaco Editor, and Yjs awareness.
- **`apps/server`**: Express API, Hocuspocus CRDT sync server, Socket.IO room events, and Docker sandbox runner.
- **`packages/shared`**: Shared Zod schemas, TypeScript interfaces, and validation contracts used by both web and server.
- **`infra`**: Production Docker configurations, sandbox runner scripts, and Caddy reverse proxy setup.

---

## Tech Stack

| Layer                 | Technology                                                                           |
| :-------------------- | :----------------------------------------------------------------------------------- |
| **Frontend**          | React, Vite, TypeScript, Tailwind CSS, Monaco Editor                                 |
| **Real-Time Sync**    | Yjs (CRDT), Hocuspocus WebSocket server, Socket.IO                                   |
| **Backend API**       | Node.js LTS, Express, TypeScript                                                     |
| **Validation**        | Zod (Shared between client & server)                                                 |
| **Database**          | MongoDB Atlas with Mongoose                                                          |
| **Execution Sandbox** | Disposable Docker containers with strict memory (128 MB), CPU, and network isolation |
| **Proxy & TLS**       | Caddy (automated Let's Encrypt certificates)                                         |

---

## Getting Started

### Prerequisites

- Node.js >= 20.0.0
- npm >= 10.0.0
- Docker (for local code execution runner)

### Installation

```bash
# Clone the repository
git clone https://github.com/Shubhx8/pairprep.git
cd pairprep

# Install all workspace dependencies
npm install

# Copy environment variables
cp .env.example .env
```

### Development

```bash
# Run both backend and frontend concurrently
npm run dev

# Or run individually:
npm run dev:server   # Starts Express backend on http://localhost:3000
npm run dev:web      # Starts Vite frontend on http://localhost:5173
```

### Type Checking & Production Build

```bash
# Strict TypeScript check across all packages
npm run typecheck

# Build all workspaces for production
npm run build
```

---

## Security & Isolation

- **Zero-Network Sandboxes**: Code runs in ephemeral, non-root Docker containers with all Linux capabilities dropped, memory capped at 128 MB, CPU quota capped, and no network access.
- **Server-Side Judging**: Hidden interview test cases and inputs are evaluated exclusively on the server and never sent to candidate browsers.
- **Contract Enforcement**: Every REST and WebSocket payload is parsed and verified via shared Zod schemas.

---

## License

MIT
