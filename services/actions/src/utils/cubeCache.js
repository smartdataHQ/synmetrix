const CUBEJS_URL = process.env.CUBEJS_URL || "http://cubejs:4000";

/**
 * Invalidate CubeJS caches after admin mutations.
 * Fire-and-forget — never blocks the caller.
 */
export function invalidateUserCache(userId) {
  fetch(`${CUBEJS_URL}/api/v1/internal/invalidate-cache`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "user", userId }),
  }).catch(() => {});
}

export function invalidateAllUserCaches() {
  fetch(`${CUBEJS_URL}/api/v1/internal/invalidate-cache`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "user" }),
  }).catch(() => {});
}

export function invalidateRulesCache() {
  fetch(`${CUBEJS_URL}/api/v1/internal/invalidate-cache`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "rules" }),
  }).catch(() => {});
}
