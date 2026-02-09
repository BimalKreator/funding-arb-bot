# Funding Arb Bot

Production-ready monorepo for a crypto trading bot. No trading logic yet — backend API, frontend dashboard, shared types, and WebSocket placeholders only.

## Structure

- **`packages/shared`** — Shared TypeScript types (API, WebSocket) used by backend and frontend
- **`apps/backend`** — Node.js + TypeScript + Express API
- **`apps/frontend`** — React + Vite + Tailwind CSS (dark theme, mobile responsive)

## Prerequisites

- Node.js **18+**
- npm **9+** (for workspaces)

## Run instructions

### 1. Install dependencies (from repo root)

```bash
npm install
```

### 2. Build shared package first (required by backend and frontend)

```bash
npm run build:shared
```

### 3. Development

**Option A — run backend and frontend in separate terminals**

```bash
# Terminal 1: backend
npm run dev:backend

# Terminal 2: frontend
npm run dev:frontend
```

Then open [http://localhost:5173](http://localhost:5173). The frontend proxies `/api` and `/ws` to the backend.

**Option B — run all workspaces (backend + frontend) from root**

```bash
npm run dev
```

### 4. Production build and run

```bash
# Build everything
npm run build:shared
npm run build:backend
npm run build:frontend

# Run backend (serves API; frontend is static files)
npm run start:backend
```

Serve the frontend static files from `apps/frontend/dist` with any static server (e.g. nginx, or `npm run start:frontend` for `vite preview` on port 4173).

### 5. Environment

Copy `.env.example` to `.env` in the repo root (or in `apps/backend`) and adjust:

```bash
cp .env.example .env
```

## PM2

Use the provided `ecosystem.config.js` with PM2 for process management in production. From repo root:

```bash
# Build first, then:
pm2 start ecosystem.config.js
```

Edit `ecosystem.config.js` to match your deployment (paths, env, instances).

## Scripts reference

| Script | Description |
|--------|-------------|
| `npm run build` | Build all workspaces |
| `npm run build:shared` | Build shared types only |
| `npm run build:backend` | Build backend only |
| `npm run build:frontend` | Build frontend only |
| `npm run dev` | Run backend + frontend in dev mode |
| `npm run dev:backend` | Run backend with tsx watch |
| `npm run dev:frontend` | Run Vite dev server |
| `npm run start:backend` | Run built backend (node dist) |
| `npm run start:frontend` | Preview built frontend (vite preview) |
| `npm run lint` | Type-check all workspaces |
| `npm run clean` | Remove node_modules and dist |

## WebSocket

WebSocket support is planned. The frontend is set up to proxy `/ws` to the backend; add your WebSocket server in `apps/backend` when ready.
