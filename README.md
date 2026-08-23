# My Finances

Express backend + React PWA frontend with Plaid Link integration and Supabase Auth/storage.

Architecture: the frontend never sees Plaid secrets, Plaid access tokens, or the Supabase service-role key. It only talks to the Express API using the signed-in user's Supabase JWT; Express is the only thing that talks to Plaid and to Supabase with the service-role key.

## Setup

### Backend

```bash
cd backend
cp .env.example .env   # fill in Supabase + Plaid credentials
npm install
npm run dev
```

### Frontend

```bash
cd frontend
cp .env.example .env   # fill in Supabase URL/anon key + backend API URL
npm install
npm run dev
```

## Deployment

Backend on [Railway](https://railway.app), frontend on [Vercel](https://vercel.com), both deploying from this repo.

### Backend (Railway)

1. New Project → Deploy from GitHub repo → select this repo.
2. Leave **Root Directory** as the repo root (default) — `railway.json` at the repo root handles the npm-workspaces build (`npm install && npm run build --workspace backend`) and start (`npm run start --workspace backend`) commands, since a workspaces monorepo needs the install run from the root, not from `backend/`. (Note: this uses `npm install`, not `npm ci` — Railway's Nixpacks caches `node_modules/.cache` as a persistent mount, and `npm ci`'s clean-slate wipe of `node_modules` collides with that mount and fails with `EBUSY`.)
3. In the service's **Variables** tab, add everything from `backend/.env.example` with real values: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `PLAID_CLIENT_ID`, `PLAID_SECRET`, `PLAID_ENV`, `PLAID_PRODUCTS`, `PLAID_COUNTRY_CODES`. Leave `PORT` unset — Railway injects its own and `env.ts` already reads `process.env.PORT`.
4. `FRONTEND_URL` needs the Vercel URL from the next section, so it's normal to deploy the backend once first with a placeholder, then come back and set it for real once Vercel gives you a URL (Railway redeploys automatically when you change a variable).
5. Once deployed, Railway gives you a public URL (or attach a custom domain) — that's your `VITE_API_BASE_URL` for the frontend.
6. **Settings → Networking → Public Networking**: confirm the domain's target port matches whatever the app actually logs on boot (`Backend listening on 0.0.0.0:<port>` in Deploy Logs) — this is Railway's dynamically-injected `PORT`, not a fixed value. If the domain was generated before the app was pointed at `process.env.PORT`, or the port field was hand-edited at some point, it can drift out of sync with the container's actual listening port. When that happens, Railway's own deploy healthcheck still passes (it isn't subject to the same domain routing), so the deployment shows "Active"/successful — but the public domain 502s on every request with "Application failed to respond." The browser reports that as a CORS error (no CORS headers on a response that never reached the app), which is a red herring — check this port match before touching CORS config.

### Frontend (Vercel)

1. New Project → import this repo.
2. Set **Root Directory** to `frontend` — Vercel auto-detects the Vite framework preset from there (build command `vite build`, output `dist`) and only needs `frontend/package.json`'s own dependencies, so it doesn't need the workspaces root.
3. In **Environment Variables**, add `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` (same values as the backend's Supabase project — the anon key, not the service-role key), and `VITE_API_BASE_URL` set to the Railway backend URL from above.
4. Deploy. Vercel gives you a production URL — go back to Railway and set `FRONTEND_URL` to that exact URL (CORS in `backend/src/index.ts` only allows one configured origin).

### Environment variable reference

Only the variables below are actually read by the code — everything else is dead weight, safe to delete from the platform's Variables tab (harmless either way, since unused env vars are simply ignored, but worth cleaning up so a future debugging session doesn't waste time on a var that looks relevant but isn't wired to anything).

**Railway (backend)** — read in `backend/src/config/env.ts`:

| Variable | Used for |
|---|---|
| `PORT` | Injected by Railway itself — don't set manually |
| `FRONTEND_URL` | The **only** var driving CORS (`backend/src/index.ts`) — must exactly match the Vercel URL |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Server-side Supabase client |
| `PLAID_CLIENT_ID`, `PLAID_SECRET`, `PLAID_ENV`, `PLAID_PRODUCTS`, `PLAID_COUNTRY_CODES` | Plaid client config |
| `BACKEND_PUBLIC_URL` (optional) | This backend's own public URL, used to register `/api/webhooks/plaid` with Plaid on link. See **Webhooks** below. |

`CORS_ORIGIN` and `CLIENT_URL` (added during troubleshooting, presumably guessing at alternate names CORS config might read) aren't referenced anywhere in the code — `FRONTEND_URL` is the single source of truth for the allowed origin. Safe to delete both.

**Vercel (frontend)** — read in `frontend/src/vite-env.d.ts` / `frontend/src/lib/*`:

| Variable | Used for |
|---|---|
| `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` | Frontend Supabase Auth client |
| `VITE_API_BASE_URL` | Base URL for every backend API call (`frontend/src/lib/api.ts`) |

`VITE_API_URL` is an unused duplicate of `VITE_API_BASE_URL` — the code only reads the latter. Safe to delete.

### After both are live

- Confirm CORS: opening the Vercel URL and linking a Plaid account should work with no CORS errors in the browser console. If you see one, double check `FRONTEND_URL` on Railway matches the Vercel URL exactly (including `https://`, no trailing slash).
- Switch `PLAID_ENV`/`PLAID_PRODUCTS`/`PLAID_SECRET` to Plaid's Development or Production credentials when you're ready to move off Sandbox — Sandbox items and Sandbox-only routes (`/api/plaid/items/:itemId/sandbox-reset-login`) won't work against real institutions, but that route already 404s outside `PLAID_ENV=sandbox`, so it's safe to leave deployed.

## Flow

1. User signs in via Supabase Auth in the frontend.
2. Frontend calls `POST /api/plaid/link-token` (with the user's Supabase JWT) to get a Plaid `link_token`.
3. Frontend opens Plaid Link with that token; on success Plaid returns a `public_token`.
4. Frontend calls `POST /api/plaid/exchange-public-token` with the `public_token`. The backend exchanges it for an access token, fetches accounts from Plaid, and stores everything in Supabase (`plaid_items`, `accounts`) — the access token never leaves the backend.
5. Frontend calls `GET /api/plaid/items` to display the user's linked institutions/accounts.

## Webhooks

Plaid pushes updates to `POST /api/webhooks/plaid` instead of the app relying solely on the user manually clicking "Sync transactions"/"Refresh balances". This endpoint is intentionally **not** behind `requireAuth` — Plaid calls it directly as a server, not as a signed-in user — so authenticity is verified a different way: every delivery carries a `Plaid-Verification` header (a JWT signed with a key Plaid rotates periodically), which `backend/src/services/webhookVerification.ts` checks against Plaid's `/webhook_verification_key/get` endpoint (caching keys for 24h) and against a hash of the exact raw request body, rejecting anything that doesn't match or is older than 5 minutes. `backend/src/index.ts` captures the raw body via `express.json()`'s `verify` callback specifically so this check has the exact original bytes to hash, since the parsed `req.body` isn't guaranteed to re-serialize identically.

Two webhook types are handled (`backend/src/controllers/webhookController.ts`):
- `TRANSACTIONS` / `SYNC_UPDATES_AVAILABLE` — runs the same sync logic as the manual "Sync transactions" button (`backend/src/services/syncService.ts`, shared by both paths so they can't drift out of sync with each other).
- `ITEM` / `ERROR` with `ITEM_LOGIN_REQUIRED` — flips the item to `login_required` immediately, so the reconnect banner appears without the user having to trigger a manual refresh first.

**Enabling this**: set `BACKEND_PUBLIC_URL` on Railway to the backend's own public URL once you have it (same chicken-and-egg as `FRONTEND_URL` — deploy once first, then set it). `plaidService.createLinkToken`/`createReauthLinkToken` only pass a `webhook` URL to Plaid when this is set, so items linked before it's configured won't have a webhook registered — clicking **Refresh balances** afterward backfills it onto existing items (`plaidService.updateItemWebhook`, called best-effort inside `refreshAccounts`). Left unset in local dev, since Plaid can't deliver webhooks to `localhost`.

**Testing in Sandbox**: `POST /api/plaid/items/:itemId/sandbox-fire-webhook` (same auth/ownership/404-outside-sandbox pattern as the existing `sandbox-reset-login` route) asks Plaid to actually deliver the `SYNC_UPDATES_AVAILABLE` webhook for that item, so you can exercise the real receiver — signature verification included — rather than only trusting it in theory.
