# Quickstart: WorkOS Authentication

## Prerequisites

- Docker and Docker Compose
- Node.js 18+
- Bun (for client-v2)
- Access to the shared WorkOS account (secrets in `.env`)

## Setup

### 1. Environment Variables

Copy example env files and add WorkOS secrets:

```bash
# In synmetrix/
cp .env.example .env
cp .dev.env.example .dev.env
```

Add to `.env`:
```
WORKOS_API_KEY=sk_test_...          # From cxs2/.env
WORKOS_CLIENT_ID=client_01K0...     # From cxs2/.env
WORKOS_REDIRECT_URI=http://localhost:3000/auth/callback
JWT_EXPIRES_IN=15                   # 15 minutes (NOT 10800!)
```

Add to `.dev.env`:
```
REDIS_URL=redis://redis:6379
```

Note: `WORKOS_COOKIE_PASSWORD` from cxs2 is NOT needed. Synmetrix uses plain session ID cookies with server-side Redis storage.

### 2. Apply Hasura Migration

The migration adds `workos_user_id` to `auth.accounts` and a uniqueness constraint on `public.teams.name`:

```bash
./cli.sh hasura cli "migrate apply"
```

### 3. Start Backend Services

```bash
./cli.sh compose up
```

This starts: Hasura, Actions (with auth routes on port 3000), CubeJS, Redis, PostgreSQL.

### 4. Start Frontend

```bash
cd ../client-v2
bun install
yarn dev
```

Frontend runs on `http://localhost:8000` with Vite proxying `/auth/*` to `http://localhost:3000`.

### 5. Test the Flow

1. Open `http://localhost:8000`
2. You should be redirected to the sign-in page
3. Click "Continue with Google" (or another provider)
4. Authenticate at WorkOS
5. You should be redirected back to the application with an active session

## Verification Checklist

- [ ] Sign in redirects to WorkOS and back
- [ ] After sign-in, GraphQL queries succeed (check browser network tab for `/v1/graphql`)
- [ ] Page refresh preserves session (no re-auth needed)
- [ ] Sign out clears session and redirects to sign-in page
- [ ] New user sign-in creates user record in PostgreSQL (`public.users`) with `workos_user_id` in `auth.accounts`
- [ ] New user is assigned to team matching their email domain
- [ ] Consumer email user (gmail.com etc.) gets a personal workspace, NOT the shared "gmail.com" team
- [ ] JWT TTL is ~15 minutes (decode the token and check `exp - iat`)

## Troubleshooting

**"Redirect URI mismatch" from WorkOS**: Ensure `WORKOS_REDIRECT_URI` is exactly `http://localhost:3000/auth/callback` and matches the URI registered in WorkOS dashboard.

**401 on GraphQL requests after sign-in**: Check that `JWT_KEY` in `.env` matches `HASURA_GRAPHQL_JWT_SECRET` key value. Also check that `JWT_EXPIRES_IN` is set to `15` (not `10800`).

**Redis connection errors**: Ensure Redis service is running (`docker ps | grep redis`). Check `REDIS_URL` env var.

**Session cookie not being sent**: In dev, ensure the frontend (port 8000) proxies `/auth/*` to port 3000. Cookies set by the Actions service will have the correct domain since requests go through the proxy.

**7.5-day JWT tokens**: If tokens have very long expiry, check that `JWT_EXPIRES_IN=15` in your `.env` file. The old default of `10800` was interpreted as 10800 minutes (7.5 days) by jose's `.setExpirationTime()`.
