# WebSocket Auth Resilience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the frontend resilient to backend restarts by adding WebSocket reconnection and subscription error recovery.

**Architecture:** Add `retryAttempts` with exponential backoff to `graphql-ws`, read token from Zustand store directly in `connectionParams`, manage WS client lifecycle with a ref to prevent zombies, and add error detection in `useUserData` to redirect on systemic failures.

**Tech Stack:** React 18, graphql-ws ^5.14.0, URQL, Zustand

---

### Task 1: Add WebSocket reconnection with retry to URQLClient

**Files:**
- Modify: `client-v2/src/URQLClient.ts`

- [ ] **Step 1: Add Client type import from graphql-ws**

In `client-v2/src/URQLClient.ts`, update the type import on line 10:

```typescript
import type { Client as WsClient, SubscribePayload } from "graphql-ws";
```

- [ ] **Step 2: Add singleflight guard and ref before the hook**

After the `isAuthError` function (after line 73), add:

```typescript
let inflightWsRefresh: Promise<void> | null = null;
```

- [ ] **Step 3: Add wsClientRef inside the hook**

Inside the default export function (after line 77), add:

```typescript
  const wsClientRef = useRef<WsClient | null>(null);
```

- [ ] **Step 4: Replace wsClient creation with retry-enabled version**

Replace lines 79-88 (the `useMemo` opening and `wsClient` creation) with:

```typescript
  const client = useMemo(() => {
    // Dispose previous WS client to kill its retry timers
    wsClientRef.current?.dispose();

    const wsClient = createWsClient({
      url: getWsUrl(HASURA_WS_ENDPOINT),
      connectionParams: () => ({
        headers: {
          Authorization: `Bearer ${AuthTokensStore.getState().accessToken}`,
          "content-type": "application/json",
        },
      }),
      retryAttempts: Infinity,
      retryWait: (retries) =>
        new Promise((resolve) =>
          setTimeout(resolve, Math.min(1000 * 2 ** retries, 30000))
        ),
      shouldRetry: () => true,
      on: {
        closed: (event) => {
          if (
            event &&
            typeof event === "object" &&
            "code" in event &&
            (event as CloseEvent).code === 1000
          )
            return;

          if (!inflightWsRefresh) {
            inflightWsRefresh = fetchToken()
              .then((result) => {
                if (result) {
                  setAuthData({
                    accessToken: result.accessToken,
                    workosAccessToken: result.workosAccessToken,
                  });
                } else {
                  cleanTokens();
                  window.location.href = SIGNIN;
                }
              })
              .catch(() => {
                // Token fetch failed (network error) — retry will handle it
              })
              .finally(() => {
                inflightWsRefresh = null;
              });
          }
        },
      },
    });
    wsClientRef.current = wsClient;
```

The rest of the `useMemo` (exchanges array, `return createClient(...)`, closing `}`) stays unchanged.

- [ ] **Step 5: Add cleanup effect after the useMemo**

After the `useMemo` closing (after line 162), before `return client;`, add:

```typescript
  // Dispose WS client on unmount
  useEffect(() => {
    return () => {
      wsClientRef.current?.dispose();
    };
  }, []);
```

- [ ] **Step 6: Verify the full file compiles**

Run: `cd /Users/stefanbaxter/Development/client-v2 && npx tsc --noEmit src/URQLClient.ts 2>&1 || yarn dev 2>&1 | head -20`

Expected: No TypeScript errors. Dev server starts without compilation errors.

- [ ] **Step 7: Commit**

```bash
cd /Users/stefanbaxter/Development/client-v2
git add src/URQLClient.ts
git commit -m "feat: add WebSocket reconnection with exponential backoff

graphql-ws now retries infinitely with 1s-30s exponential backoff.
connectionParams reads latest token from Zustand store on each retry.
on.closed handler triggers token refresh for auth-related disconnects.
Ref-based WS client cleanup prevents zombie connections."
```

---

### Task 2: Add subscription error recovery to useUserData

**Files:**
- Modify: `client-v2/src/hooks/useUserData.ts`

- [ ] **Step 1: Add cleanTokens to AuthTokensStore destructuring**

In `client-v2/src/hooks/useUserData.ts`, update line 222 from:

```typescript
  const { JWTpayload, accessToken, setAuthData } = AuthTokensStore();
```

to:

```typescript
  const { JWTpayload, accessToken, setAuthData, cleanTokens } = AuthTokensStore();
```

- [ ] **Step 2: Add error recovery effect**

After the subscription re-fetch effect (after line 326), add:

```typescript
  // Redirect to signin if both user query and subscription fail
  // (indicates systemic issue like missing schema permissions)
  useEffect(() => {
    if (!tokenFetchDone || !accessToken) return;

    const queryErr = currentUserData.error;
    const subErr = subCurrentUserData?.error;

    if (queryErr && subErr) {
      console.error(
        "[useUserData] User query and subscription both failed:",
        queryErr.message
      );
      cleanTokens();
      window.location.href = SIGNIN;
    }
  }, [
    currentUserData.error,
    subCurrentUserData?.error,
    tokenFetchDone,
    accessToken,
    cleanTokens,
  ]);
```

- [ ] **Step 3: Verify the full file compiles**

Run: `cd /Users/stefanbaxter/Development/client-v2 && npx tsc --noEmit src/hooks/useUserData.ts 2>&1 || yarn dev 2>&1 | head -20`

Expected: No TypeScript errors.

- [ ] **Step 4: Commit**

```bash
cd /Users/stefanbaxter/Development/client-v2
git add src/hooks/useUserData.ts
git commit -m "feat: redirect to signin when user query and subscription both fail

Prevents the app from staying stuck on the loader when systemic
errors occur (e.g., missing Hasura permissions after metadata loss)."
```

---

### Task 3: Manual verification

- [ ] **Step 1: Verify app loads normally**

Open http://localhost:8001 in the browser. Sign in. Confirm:
- App loads past the loader
- User data and team data appear
- No console errors related to WebSocket or auth

- [ ] **Step 2: Simulate Hasura restart**

In a terminal, restart Hasura:
```bash
cd /Users/stefanbaxter/Development/synmetrix
docker compose -f docker-compose.dev.yml restart hasura
```

Watch the browser console. Expected:
- WebSocket connection drops (console may show close event)
- graphql-ws retries with backoff (visible in Network tab as new WS connections)
- After Hasura is healthy (~10-15s), WS reconnects
- Subscriptions resume — no page reload needed
- App does NOT freeze on loader

- [ ] **Step 3: Simulate JWT expiry during WS connection**

This is harder to test directly. Verify by checking that the `on.closed` handler fires and `fetchToken` is called:

1. Open browser DevTools → Network → WS tab
2. Restart Hasura: `docker compose -f docker-compose.dev.yml restart hasura`
3. Watch for reconnection attempts in the WS tab
4. Confirm the app recovers without manual intervention

- [ ] **Step 4: Commit verification notes**

No code changes — just confirm tests pass.
