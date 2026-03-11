# Tasks: Hasura Auth Proxy

**Input**: Design documents from `/specs/008-hasura-proxy/`
**Prerequisites**: plan.md (required), spec.md (required for user stories), research.md, data-model.md, contracts/

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

---

## Phase 1: Setup & Tests

**Purpose**: Add direct dependency, set up test harness, create foundational utilities with TDD.

### Infrastructure

- [x] T001 Add `http-proxy-middleware` as a direct dependency in `services/cubejs/package.json` (currently only transitive via api-gateway — see research.md R12). Run `npm install http-proxy-middleware` in `services/cubejs/`.
- [x] T002 Create the test directory and harness `services/cubejs/test/` — this directory does not exist yet. Set up a minimal test runner (e.g., Node.js test runner or vitest). Confirm tests can be discovered and run.

### Tests

> **Write these tests FIRST, ensure they FAIL before implementation**

- [x] T003 [P] Write unit tests for JWT minting utility — test that `mintHasuraToken(userId)` returns a valid HS256 JWT with correct claims (namespace from `JWT_CLAIMS_NAMESPACE` env var, not hardcoded), correct issuer (`services:cubejs`), audience (`services:hasura`), and expiry matching `JWT_EXPIRES_IN` in `services/cubejs/test/mintHasuraToken.test.js`
- [x] T004 [P] Write unit tests for minted token cache — test `get(userId)` returns null on miss, returns cached token when `exp - now > 60s`, returns null when `exp - now <= 60s`, `invalidate(userId)` clears specific entry, `invalidateAll()` clears all entries, max 1000 entries eviction in `services/cubejs/test/mintedTokenCache.test.js`

### Implementation

- [x] T005 [P] Create JWT minting utility that generates HS256 Hasura JWTs from a userId, using `jose.SignJWT` with claims namespace from `JWT_CLAIMS_NAMESPACE` env var, issuer `services:cubejs`, audience `services:hasura`, and configurable expiry from `JWT_EXPIRES_IN` env var in `services/cubejs/src/utils/mintHasuraToken.js`
- [x] T006 [P] Create minted token cache — a per-userId Map cache (max 1000 entries) that stores `{ token, exp }` and returns cached token if `exp - now > 60s`, otherwise returns null. Include `invalidate(userId)` and `invalidateAll()` methods in `services/cubejs/src/utils/mintedTokenCache.js`

**Checkpoint**: T003/T004 tests pass with T005/T006 implementations. Utilities ready.

---

## Phase 2: User Story 1 — GraphQL Queries with WorkOS Token (Priority: P1) + User Story 2 — Legacy JWT Passthrough (Priority: P1) 🎯 MVP

**Goal**: WorkOS RS256 tokens can be used for GraphQL queries/mutations via the proxy. HS256 tokens pass through unchanged. Both paths return correct Hasura results. Unauthenticated requests are rejected. Untrusted headers are stripped.

**Independent Test**: Send a GraphQL query with a WorkOS RS256 token and verify the response contains valid data. Send the same query with an HS256 token and verify identical behavior. Send with no token and verify 401. Send with spoofed `x-hasura-user-id` header and verify it is stripped.

### Tests

> **Write these tests FIRST, ensure they FAIL before implementation**

- [x] T007 Write integration tests for the proxy endpoint in `services/cubejs/test/hasuraProxy.test.js`:
  - WorkOS RS256 token → successful GraphQL response
  - HS256 token → passthrough with unchanged response
  - Missing token → 401 JSON error
  - Malformed token (not 3-segment JWT) → 401 JSON error (not routed to HS256 verifier)
  - Expired token → 403 JSON error
  - Spoofed `x-hasura-user-id` header → stripped before forwarding
  - All error responses are `Content-Type: application/json` (not plain text)

### Implementation

- [x] T008 Create the Hasura proxy route handler in `services/cubejs/src/routes/hasuraProxy.js` (file lives in `routes/` for co-location with other route handlers, but is imported and mounted directly in `index.js` before body parsers — NOT via `routes/index.js`):
  - Export a factory function that receives config
  - Create an Express router with `POST /v1/graphql` and `GET /v1/graphql` routes
  - **Malformed token guard**: Before calling `detectTokenType()`, verify the token has 3 dot-separated segments. If not, return 401 JSON error immediately (see research.md R11). This prevents `detectTokenType()` from silently defaulting to "hasura" for garbage tokens.
  - Auth middleware: extract `Authorization` header → reject with 401 JSON if missing → malformed guard → call `detectTokenType()` from `workosAuth.js` → if RS256: call `verifyWorkOSToken()`, then `provisionUserFromWorkOS()`, then get/mint HS256 token via `mintedTokenCache` + `mintHasuraToken` → if HS256: pass through unchanged
  - **Header stripping**: In `http-proxy-middleware` `onProxyReq` callback, strip all `x-hasura-*` headers from the forwarded request (see research.md R9)
  - Proxy middleware: use `createProxyMiddleware()` targeting `HASURA_ENDPOINT`, rewriting the `Authorization` header for WorkOS tokens
  - **JSON error handling**: Wrap all auth logic in try-catch. Map error types to status codes and JSON bodies per contract. Do NOT let errors fall through to the global CubeJS error handler which returns plain text (see research.md R10)
  - Note: FR-006 (identity cache) and FR-007 (singleflight dedup) are satisfied by reusing `provisionUserFromWorkOS()` from `dataSourceHelpers.js` which manages `workosSubCache` and `inflightProvisions` internally
- [x] T009 Mount the proxy routes BEFORE the body parsers in `services/cubejs/index.js` — the proxy must receive the raw request body stream, not the parsed `req.body` from `express.json()`. Import `hasuraProxy` factory from `src/routes/hasuraProxy.js` and call `app.use(hasuraProxy({ ... }))` BEFORE the `express.json()` and `express.urlencoded()` middleware calls at lines 32-33 (see research.md R8). The proxy is mounted directly in `index.js`, NOT via `routes/index.js` (which is loaded after body parsers for the REST API). Exact middleware order:
  1. `app.use(hasuraProxy({ ... }))` — NEW, before body parsers
  2. `app.use(express.json({ limit: "50mb" }))` — existing line 32
  3. `app.use(express.urlencoded({ ... }))` — existing line 33
  4. `app.use(routes({ ... }))` — existing, REST API routes (receives parsed bodies)
- [x] T010 Wire minted token cache invalidation into the existing cache invalidation handler in `services/cubejs/src/routes/index.js` — import `mintedTokenCache` and when `type === "user"` call `mintedTokenCache.invalidate(userId)`, when `type === "all"` call `mintedTokenCache.invalidateAll()`
- [x] T011 Update Nginx config in `services/client/nginx/default.conf.template` — add `location = /v1/graphql` block before the existing `location ~ ^/v1` block, routing to `$upstream_cubejs` with WebSocket upgrade headers (`Upgrade`, `Connection`, `proxy_http_version 1.1`)

**Checkpoint**: T007 tests pass. GraphQL queries work with both WorkOS and HS256 tokens. Headers are stripped. Errors are JSON. MVP complete.

---

## Phase 3: User Story 3 — CubeJS REST API with Unified Auth (Priority: P2)

**Goal**: The proxy and CubeJS REST API share the same auth verification and provisioning code, with no duplication.

**Independent Test**: Verify that CubeJS REST API calls (`/api/v1/run-sql`, `/api/v1/test`) still work with both token types after the proxy is added. Verify the proxy and REST API resolve the same userId for the same WorkOS token.

### Implementation

- [x] T012 [US3] Verify and document that the proxy route handler (T008) imports directly from `workosAuth.js` and `dataSourceHelpers.js` — the same modules used by `checkAuth.js`. Add a code comment in `hasuraProxy.js` referencing the shared auth path and noting the provisioning behavior inherited (CubeJS `_eq` team lookup, see research.md R7). No code duplication should exist; if any was introduced in Phase 2, refactor to eliminate it in `services/cubejs/src/routes/hasuraProxy.js`
- [x] T013 [US3] Verify CubeJS REST API continues to work by running existing StepCI tests (`./cli.sh tests stepci`) and confirming no regressions from the new routes, middleware ordering changes, or Nginx changes

**Checkpoint**: Both GraphQL proxy and REST API use identical auth code paths. No duplication.

---

## Phase 4: User Story 4 — WebSocket Passthrough (Priority: P3)

**Goal**: WebSocket subscriptions work for all authenticated users after the Nginx routing change routes `/v1/graphql` through CubeJS. The proxy passes WebSocket upgrade requests through to Hasura with `x-hasura-*` header stripping for security consistency.

**Why this is required**: The Nginx change in T011 routes ALL `/v1/graphql` traffic (HTTP and WebSocket) to CubeJS. Without WebSocket proxying, subscriptions break.

**Why no token swapping needed**: All users (legacy and WorkOS) have HS256 tokens. WorkOS users receive theirs from `/auth/token` (Actions service). The frontend sends the HS256 `accessToken` via `connectionParams` for WebSocket. See research.md R5.

**Independent Test**: Establish a WebSocket subscription with an HS256 token (from either auth path) through the proxy and verify live data updates are received.

### Implementation

- [x] T014 [US4] Refactor `services/cubejs/index.js` to store the HTTP server handle — change `app.listen(port)` (line 110, currently discards return value) to `const server = app.listen(port)`. This is required to attach the `upgrade` event listener for WebSocket proxying.
- [x] T015 [US4] Add WebSocket proxy support to `services/cubejs/src/routes/hasuraProxy.js` — configure `http-proxy-middleware` with `ws: true` option. Export the proxy instance so the server can call `proxy.upgrade(req, socket, head)`.
- [x] T016 [US4] Wire the WebSocket upgrade handler in `services/cubejs/index.js` — listen for the `upgrade` event on the stored `server` handle, check if the request path is `/v1/graphql`, and if so:
  - Strip `x-hasura-*` headers from the upgrade request (security consistency with HTTP path)
  - Call `proxy.upgrade(req, socket, head)` to forward the upgrade to Hasura
  - All tokens pass through unchanged (HS256 passthrough; no WorkOS token swap)
  - For non-`/v1/graphql` paths, do not intercept (let default handling apply)
- [x] T017 [US4] Verify the Nginx config from T011 already includes WebSocket upgrade headers for the `/v1/graphql` location — confirm `proxy_http_version 1.1`, `Upgrade $http_upgrade`, and `Connection "Upgrade"` are present in `services/client/nginx/default.conf.template`

**Checkpoint**: Existing HS256 WebSocket subscriptions work through the proxy. `x-hasura-*` headers are stripped on upgrade. No regression from Nginx routing change.

---

## Phase 5: Polish & Cross-Cutting Concerns

**Purpose**: End-to-end validation, StepCI coverage, and regression testing.

- [x] T018 Create new StepCI workflow tests for the `/v1/graphql` proxy endpoint in `tests/` — test GraphQL query with WorkOS RS256 token returns valid data, GraphQL query with HS256 token returns valid data (passthrough), request with no token returns 401 JSON, request with expired token returns 403 JSON, request with spoofed `x-hasura-user-id` header → header is not seen by Hasura
- [ ] T019 Validate the full flow end-to-end (requires Docker services): start Docker services (`./cli.sh compose up`), test GraphQL query with WorkOS token through Nginx, test with HS256 token through Nginx, test unauthenticated request gets 401 JSON, verify CubeJS REST API still works
- [ ] T020 [P] Verify error responses match the contract (requires Docker services) in `specs/008-hasura-proxy/contracts/proxy-endpoints.md` — test expired token (403 JSON), malformed token (401 JSON, not routed to HS256), JWKS unavailable (503 JSON), and Hasura backend unavailable (502 JSON) scenarios. Confirm no errors return plain text.
- [ ] T021 [P] Run full StepCI integration tests (requires Docker services) (`./cli.sh tests stepci`) including new proxy tests (T018) to confirm no regressions in Actions RPC, Hasura mutations, or CubeJS REST API

---

## Rollback Procedure

If the proxy causes issues in production:

1. **Nginx**: Revert `services/client/nginx/default.conf.template` to remove the `location = /v1/graphql` block — traffic routes directly to Hasura again
2. **CubeJS**: The proxy routes can remain in code (unused) or be removed. They do not affect existing CubeJS REST API functionality since they mount on `/v1/graphql`, not `/api/v1/*`
3. **Middleware ordering**: If body parser ordering was changed in `index.js`, ensure existing REST API routes still receive parsed bodies (they should — proxy routes are mounted before parsers, REST routes after)
4. **No database changes** to roll back — feature is purely routing + in-memory

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 (Setup)**: No dependencies — T001-T002 first (infrastructure), then T003-T006 in parallel pairs
- **Phase 2 (US1+US2 MVP)**: Depends on Phase 1 — T007 (test) first, then T008 depends on T005+T006; T009-T011 depend on T008
- **Phase 3 (US3)**: Depends on Phase 2 — verification of shared code
- **Phase 4 (US4)**: Depends on Phase 2 — adds WebSocket passthrough for all users (required since Nginx change routes WS through CubeJS). All users use HS256 tokens for WS (WorkOS users get theirs from `/auth/token`).
- **Phase 5 (Polish)**: Depends on all previous phases

### User Story Dependencies

- **US1+US2 (P1)**: Combined because the proxy inherently handles both — Can start after Phase 1
- **US3 (P2)**: Can start after Phase 2 — Verification only, no new implementation expected
- **US4 (P3)**: Can start after Phase 2 — WebSocket passthrough for all users (required to prevent regression from Nginx change). All users use HS256 tokens for WS.

### Parallel Opportunities

- **Phase 1**: T003+T005 (mint tests+impl) parallel with T004+T006 (cache tests+impl) — different files
- **Phase 2**: T010 and T011 can run in parallel after T009 (different files).
- **Phase 3+4**: US3 and US4 can run in parallel after Phase 2
- **Phase 5**: T020 and T021 can run in parallel

---

## Parallel Example: Phase 1

```text
# After T001+T002 (infrastructure):
Pair A: T003 (mint test) → T005 (mint impl)
Pair B: T004 (cache test) → T006 (cache impl)
```

## Parallel Example: Phase 2 (after T009)

```text
# Launch cache wiring + Nginx update in parallel:
Task T010: "Wire cache invalidation in routes/index.js"
Task T011: "Update Nginx config"  # different file, parallel with T010
```

---

## Implementation Strategy

### MVP First (Phase 1 + Phase 2)

1. Complete Phase 1: Infrastructure (T001-T002), tests first (T003-T004), then implementations (T005-T006)
2. Complete Phase 2: Proxy test (T007), then route handler + mounting + Nginx (T008-T011)
3. **STOP and VALIDATE**: Test with both token types via curl. Verify JSON errors. Verify header stripping.
4. This delivers US1 + US2 — the core proxy functionality

### Incremental Delivery

1. Phase 1+2 → MVP (WorkOS + HS256 for GraphQL HTTP) → Validate
2. Phase 3 → Verify shared code (no new implementation expected) → Validate
3. Phase 4 → WebSocket passthrough for all users (prevent regression from Nginx routing change) → Validate
4. Phase 5 → StepCI coverage + end-to-end validation + regression check → Done

---

## Known Limitations

- **Multi-instance caches**: In-memory caches are per-CubeJS-instance. Test env runs `replicas: 3`. Invalidation is single-instance. Bounded by TTL (5min identity, 15min token). Pre-existing pattern for all CubeJS caches.
- **Multi-instance singleflight**: The `inflightProvisions` Map in `dataSourceHelpers.js` is per-instance. Concurrent first-time requests for the same WorkOS user hitting different replicas can create duplicate user rows because `insert_users_one` has no `on_conflict` clause. Pre-existing limitation. Mitigation: add a unique constraint on `auth_accounts(workos_user_id)` (separate task).
- **Identity cache invalidation**: No reverse userId→sub mapping. Identity cache relies on 5-minute TTL, not per-user invalidation. Minted token cache CAN be invalidated per-userId.
- **Actions invalidation gap**: `cubeCache.js` sends `type: "user"` not `type: "all"`, missing the WorkOS identity cache. Pre-existing.
- **Provisioning divergence**: CubeJS uses `_eq` (case-sensitive) team lookup; Actions uses `_ilike`. Proxy inherits CubeJS behavior. Pre-existing, documented in research.md R7.
- **Deactivated WorkOS accounts**: If a user's WorkOS account is deactivated and no `workos_user_id` link exists in `auth_accounts`, `fetchWorkOSUserProfile(sub)` returns 404 and provisioning fails. Users with an existing link resolve from cache/DB without calling WorkOS.
- **WebSocket uses HS256 for all users**: The browser `WebSocket` API cannot send custom HTTP headers on the upgrade request, but this is irrelevant — WorkOS users already receive HS256 tokens from `/auth/token`. The frontend uses WorkOS RS256 for HTTP GraphQL (proxy swaps) and HS256 for WebSocket (passthrough). No proxy-level WS token swapping needed.
- **Token issuer divergence**: Minted tokens use `iss: "services:cubejs"` while Actions tokens use `iss: "services:actions"`. Safe because Hasura does not validate issuer. If Hasura adds issuer validation, both services must be updated.

## Notes

- Total new code: ~300-400 lines across 4 new source files + 4 modifications + 3 test files
- `http-proxy-middleware` added as direct dependency (was only transitive)
- `services/cubejs/test/` is a new directory (no existing test harness)
- All auth code (`workosAuth.js`, `dataSourceHelpers.js`) is reused directly — no duplication
- US1 and US2 are combined into Phase 2 because the proxy inherently handles both token types in the same code path
- FR-006 (identity cache) and FR-007 (singleflight) are satisfied by reusing existing `provisionUserFromWorkOS()` — no new code needed
- JWT claims namespace is read from `JWT_CLAIMS_NAMESPACE` env var, not hardcoded
