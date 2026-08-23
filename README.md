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
2. Leave **Root Directory** as the repo root (default) — `railway.json` at the repo root handles the npm-workspaces build (`npm ci && npm run build --workspace backend`) and start (`npm run start --workspace backend`) commands, since a workspaces monorepo needs `npm ci` run from the root, not from `backend/`.
3. In the service's **Variables** tab, add everything from `backend/.env.example` with real values: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `PLAID_CLIENT_ID`, `PLAID_SECRET`, `PLAID_ENV`, `PLAID_PRODUCTS`, `PLAID_COUNTRY_CODES`. Leave `PORT` unset — Railway injects its own and `env.ts` already reads `process.env.PORT`.
4. `FRONTEND_URL` needs the Vercel URL from the next section, so it's normal to deploy the backend once first with a placeholder, then come back and set it for real once Vercel gives you a URL (Railway redeploys automatically when you change a variable).
5. Once deployed, Railway gives you a public URL (or attach a custom domain) — that's your `VITE_API_BASE_URL` for the frontend.

### Frontend (Vercel)

1. New Project → import this repo.
2. Set **Root Directory** to `frontend` — Vercel auto-detects the Vite framework preset from there (build command `vite build`, output `dist`) and only needs `frontend/package.json`'s own dependencies, so it doesn't need the workspaces root.
3. In **Environment Variables**, add `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` (same values as the backend's Supabase project — the anon key, not the service-role key), and `VITE_API_BASE_URL` set to the Railway backend URL from above.
4. Deploy. Vercel gives you a production URL — go back to Railway and set `FRONTEND_URL` to that exact URL (CORS in `backend/src/index.ts` only allows one configured origin).

### After both are live

- Confirm CORS: opening the Vercel URL and linking a Plaid account should work with no CORS errors in the browser console. If you see one, double check `FRONTEND_URL` on Railway matches the Vercel URL exactly (including `https://`, no trailing slash).
- Switch `PLAID_ENV`/`PLAID_PRODUCTS`/`PLAID_SECRET` to Plaid's Development or Production credentials when you're ready to move off Sandbox — Sandbox items and Sandbox-only routes (`/api/plaid/items/:itemId/sandbox-reset-login`) won't work against real institutions, but that route already 404s outside `PLAID_ENV=sandbox`, so it's safe to leave deployed.

## Flow

1. User signs in via Supabase Auth in the frontend.
2. Frontend calls `POST /api/plaid/link-token` (with the user's Supabase JWT) to get a Plaid `link_token`.
3. Frontend opens Plaid Link with that token; on success Plaid returns a `public_token`.
4. Frontend calls `POST /api/plaid/exchange-public-token` with the `public_token`. The backend exchanges it for an access token, fetches accounts from Plaid, and stores everything in Supabase (`plaid_items`, `accounts`) — the access token never leaves the backend.
5. Frontend calls `GET /api/plaid/items` to display the user's linked institutions/accounts.
