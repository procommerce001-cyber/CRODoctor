# FIX LOG — Dashboard Connectivity Crisis

## Incident Summary

The dashboard consistently returned HTTP 404 or 401 errors on startup despite the backend being fully operational.

---

## Root Causes (in order of discovery)

### 1. Wrong port in `NEXT_PUBLIC_API_BASE_URL`
**File:** `web/.env.local`
**Was:** `NEXT_PUBLIC_API_BASE_URL=http://localhost:3001`
**Fixed to:** `NEXT_PUBLIC_API_BASE_URL=http://localhost:3000`

Port 3001 is the Next.js dev server.
Port 3000 is the Node.js/Express API (`api/src/server.js`).
Every dashboard fetch was hitting the frontend's own server, which had no matching routes → 404.

---

### 2. Wrong shop domain in `NEXT_PUBLIC_SHOP`
**File:** `web/.env.local`
**Was:** `NEXT_PUBLIC_SHOP=dev-store.myshopify.com`
**Fixed to:** `NEXT_PUBLIC_SHOP=jw5kjx-1z.myshopify.com`

`dev-store.myshopify.com` was a placeholder that did not exist in the database.
The API correctly returned 404 for an unknown shop domain.

---

### 3. Missing `Authorization` header on all API requests
**File:** `web/lib/api.ts`
**Was:** All `fetch()` calls had no headers at all.
**Fixed:** Added `apiHeaders()` helper that injects `Bearer <token>` from `NEXT_PUBLIC_DEV_BEARER_TOKEN`.

The backend requires a Bearer token on every request (`Authorization header with Bearer token required`).

---

### 4. Duplicate `API_BASE` constants with wrong fallback in two components
**Files:** `web/components/dashboard/ExecutionDetailsPanel.tsx`, `web/components/dashboard/RecentActivityList.tsx`
**Was:** Each component declared its own `const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:3001'`
**Fixed:** Both now import `API_BASE` from `web/lib/api.ts`. No local fallback.

These components also made raw `fetch()` calls for rollback without the Authorization header.
Fixed to use `apiHeaders()`.

---

### 5. Silent fallback in `lib/api.ts`
**File:** `web/lib/api.ts`
**Was:** `const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:3001'`
**Fixed:** Throws immediately at module load if `NEXT_PUBLIC_API_BASE_URL` is not set.

A missing env var was silently replaced with the wrong port.
Now it fails loudly with a clear message pointing to `.env.example`.

---

## Preventive Measures Added

| Tool | Location | Purpose |
|------|----------|---------|
| `check-env.mjs` | `web/scripts/` | Runs before every `npm run dev` via `predev` hook. Validates env vars and pings the API. |
| `verify-connection.mjs` | `web/scripts/` | On-demand end-to-end connectivity test. Run with `node web/scripts/verify-connection.mjs`. |
| `.env.example` | `web/` | Documents every required env var with correct defaults for new developers. |
| Hard throw in `lib/api.ts` | `web/lib/` | If `NEXT_PUBLIC_API_BASE_URL` is missing, the app refuses to start instead of silently failing. |

---

## Port Map (permanent reference)

| Port | Process | Start command |
|------|---------|---------------|
| 3000 | Node.js API (`api/src/server.js`) | `cd api && node src/server.js` |
| 3001 | Next.js dev server | `cd web && npm run dev` |

---

## How to Debug a Future 404

1. Run `node web/scripts/verify-connection.mjs` — it will tell you exactly what's wrong.
2. Check `web/.env.local` exists and has correct values (compare with `web/.env.example`).
3. Confirm the API is running: `lsof -i :3000` should show `node src/server.js`.
4. If Next.js was running before an env change: `rm -rf web/.next && npm run dev` to force a clean rebuild.
