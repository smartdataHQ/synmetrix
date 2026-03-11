# Quickstart: Query with WorkOS JWT

**Branch**: `007-workos-jwt-query` | **Date**: 2026-03-10

## Prerequisites

- Docker services running: `./cli.sh compose up`
- Client-v2 dev server: `cd ../client-v2 && yarn dev`
- A valid WorkOS JWT (get from browser network tab or `TEST_TOKEN` in `.env`)

## Deployment Prerequisites

These must be configured in the WorkOS dashboard before this feature works:

1. **JWT Template**: WorkOS must be configured with a JWT template that includes the `partition` claim. This claim provides the team/org identifier used for provisioning. Without it, team derivation falls back to email-domain logic.
   - In WorkOS Dashboard → Authentication → JWT Templates → add a custom claim: `partition` mapped to the organization slug
2. **Custom Domain (optional)**: If using a custom auth domain (e.g., `auth.yourdomain.com`), set `WORKOS_ISSUER` env var to the custom issuer URL. The JWKS endpoint and issuer validation will use this instead of the default `https://api.workos.com` prefix.

## Testing the Feature

### 1. Query CubeJS directly with WorkOS JWT

```bash
# Use the TEST_TOKEN from .env or grab from browser network tab
TOKEN=$(grep TEST_TOKEN .env | cut -d= -f2)

curl -s -X POST https://dbx.fraios.dev/api/v1/load \
  -H "Authorization: Bearer $TOKEN" \
  -H "x-hasura-datasource-id: <datasource-uuid>" \
  -H "x-hasura-branch-id: <branch-uuid>" \
  -H "Content-Type: application/json" \
  -d '{"query":{"dimensions":["semantic_events.type"],"measures":[],"limit":10}}' | python3 -m json.tool
```

### 2. Verify backward compatibility

```bash
# Mint a Hasura JWT (existing flow) and query — should still work
JWT=$(docker exec synmetrix-actions-1 node -e "
const jwt = require('jsonwebtoken');
const token = jwt.sign({
  hasura: {
    'x-hasura-user-id': '<user-uuid>',
    'x-hasura-allowed-roles': ['user'],
    'x-hasura-default-role': 'user'
  }
}, process.env.JWT_KEY, {algorithm: 'HS256', expiresIn: '1h'});
process.stdout.write(token);
")

curl -s -X POST http://localhost:4000/api/v1/load \
  -H "Authorization: Bearer $JWT" \
  -H "x-hasura-datasource-id: <datasource-uuid>" \
  -H "Content-Type: application/json" \
  -d '{"query":{"dimensions":["semantic_events.type"],"measures":[],"limit":10}}'
```

### 3. Verify JIT provisioning

1. Create a new user in WorkOS dashboard
2. Obtain their JWT (via AuthKit login flow or API)
3. Send a query to CubeJS using their token
4. Verify: user, account, team, and membership created in Postgres

```bash
# Check the user was provisioned
docker exec synmetrix-postgres psql -U synmetrix -d synmetrix -c \
  "SELECT u.id, u.display_name, a.email, a.workos_user_id
   FROM auth.accounts a JOIN public.users u ON a.user_id = u.id
   WHERE a.workos_user_id = 'user_<new-user-id>'"
```

### 4. Query via SQL API with WorkOS JWT

```bash
# Connect to SQL API using datasource ID as username, WorkOS JWT as password
TOKEN=$(grep TEST_TOKEN .env | cut -d= -f2)
PGPASSWORD=$TOKEN psql -h localhost -p 15432 -U "<datasource-uuid>" -c "SELECT 1"
```

## Environment Variables (new for CubeJS)

Add to `.env` and `docker-compose.dev.yml` for the cubejs service:

```
WORKOS_API_KEY=sk_test_...     # Already in .env for Actions
WORKOS_CLIENT_ID=client_01...  # Already in .env for Actions
WORKOS_ISSUER=                 # Optional: custom auth domain issuer URL (leave empty for default)
```

## New Dependency (CubeJS)

```bash
cd services/cubejs && npm install jose
```

## Files Changed

### CubeJS service (`services/cubejs/`)
- `package.json` — add `jose` dependency
- `src/utils/checkAuth.js` — dual-path verification (RS256 + HS256), JIT provisioning, identity cache
- `src/utils/checkSqlAuth.js` — accept WorkOS JWT as password
- `src/utils/dataSourceHelpers.js` — add identity mapping cache, add `findAccountByWorkosId()` and provisioning functions

### Actions service (`services/actions/`)
- `src/auth/token.js` — return `workosAccessToken` in response

### Client-v2 (`../client-v2/`)
- `src/stores/AuthTokensStore.ts` — store `workosAccessToken`
- `src/hooks/useAuth.ts` — pass through `workosAccessToken` from token response
- `src/components/RestAPI/index.tsx` — use WorkOS token for CubeJS requests
- `src/components/SmartGeneration/index.tsx` — use WorkOS token for CubeJS requests

### Docker/Config
- `docker-compose.dev.yml` — add `WORKOS_API_KEY` and `WORKOS_CLIENT_ID` to cubejs service
