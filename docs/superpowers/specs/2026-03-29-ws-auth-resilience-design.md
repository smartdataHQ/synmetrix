# WebSocket Auth Resilience Design

## Problem

When Hasura restarts on the dev cluster, the frontend app freezes on the loader and requires manual cookie clearing to recover. This happens because:

1. **WebSocket dies silently** — `graphql-ws` in `URQLClient.ts` has no retry config (`retryAttempts` defaults to 0). When the connection drops, subscriptions die permanently.
2. **No subscription error recovery** — if `SubCurrentUser` returns a GraphQL error (schema/permission issue), the `bootstrapping` flag in `useUserData.ts` never resolves and the app stays on the loader forever.

The cookie clearing is a red herring — it forces a full page reload which recreates the URQL client. A hard refresh should work but previously didn't because the Hasura metadata was missing `users` table permissions (fixed separately).

## Approach

**Approach B (Moderate):** WebSocket reconnection + subscription error boundary.

## Design

### 1. WebSocket Reconnection (`client-v2/src/URQLClient.ts`)

**1a. `connectionParams` reads from Zustand store directly**

Currently `connectionParams` captures `accessToken` from the React closure. On reconnection attempts, it sends the stale token. Fix: read from `AuthTokensStore.getState().accessToken` so each retry gets the latest token.

**1b. Add retry config to `graphql-ws`**

```
retryAttempts: Infinity
retryWait: exponential backoff — 1s, 2s, 4s, ... capped at 30s
shouldRetry: () => true
```

**1c. `on.closed` handler triggers token refresh**

When the WS connection closes abnormally (code !== 1000), call `fetchToken()` to refresh the JWT. This handles the case where subscriptions are the only active operations and `authExchange.willAuthError` never fires (it only intercepts new operations, not ongoing subscriptions).

- If refresh succeeds with a **new** token: `setAuthData()` updates the store, `accessToken` changes, `useMemo` re-runs, creating a new URQL + WS client with the fresh token.
- If refresh succeeds with the **same** token (Hasura restarted but JWT still valid): Zustand no-op (Object.is match), `useMemo` doesn't re-run, `graphql-ws` retry loop continues until Hasura is back.
- If refresh fails (session dead): `cleanTokens()` + redirect to signin.

Uses a singleflight guard to prevent multiple inflight `fetchToken()` calls from rapid close events.

**1d. Ref-based WS client cleanup**

Track the `wsClient` in a `useRef`. At the start of `useMemo`, call `wsClientRef.current?.dispose()` to kill the old client's retry timers before creating a new one. Also dispose on component unmount via `useEffect` cleanup.

This prevents zombie WebSocket connections that would accumulate if `useMemo` re-runs while the old client still has active retry timers.

### 2. Subscription Error Recovery (`client-v2/src/hooks/useUserData.ts`)

Add an effect that monitors both `currentUserData.error` and `subCurrentUserData.error`. If both the one-shot query AND the subscription fail (indicating a systemic issue like missing schema permissions), redirect to signin instead of staying stuck on the loader.

If only the subscription fails but the query succeeds, the app still works (just without live updates).

## Files Changed

| File | Change |
|------|--------|
| `client-v2/src/URQLClient.ts` | Add retry config, store-based connectionParams, on.closed handler, ref cleanup |
| `client-v2/src/hooks/useUserData.ts` | Add error detection effect for query + subscription failures |

## Scenarios

| Scenario | Behavior |
|----------|----------|
| Hasura restarts (JWT still valid) | WS drops -> graphql-ws retries with backoff -> reconnects when Hasura is back |
| JWT expires during active subscription | Hasura closes WS -> on.closed -> fetchToken() -> fresh token -> useMemo recreates client |
| Session dead (Redis lost) | on.closed -> fetchToken() -> null -> cleanTokens -> redirect to signin |
| Schema/permission error (users_by_pk missing) | Query + subscription both fail -> error effect redirects to signin |
| Normal close (code 1000) | on.closed handler skips refresh, no action needed |

## Not in Scope

- Periodic background token refresh (over-engineering given the on.closed handler covers it)
- Server-side `clearCookie` fix (session cookie options mismatch) — sessions survive restarts via KeyDB, not the root cause
- BigQuery pre-aggregation errors (separate issue, datasource being removed)
