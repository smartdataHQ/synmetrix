import express from "express";
import { createProxyMiddleware } from "http-proxy-middleware";

import { detectTokenType, verifyWorkOSToken } from "../utils/workosAuth.js";
import { provisionUserFromWorkOS } from "../utils/dataSourceHelpers.js";
import { mintHasuraToken } from "../utils/mintHasuraToken.js";
import { mintedTokenCache } from "../utils/mintedTokenCache.js";

// Shared auth path with checkAuth.js — no code duplication.
// provisionUserFromWorkOS() manages workosSubCache + inflightProvisions internally.
// Team lookup uses CubeJS _eq semantics (see research.md R7).

/**
 * Factory function to create the Hasura auth proxy middleware.
 * Must be mounted BEFORE body parsers in index.js (raw body passthrough).
 *
 * @param {{ hasuraEndpoint?: string }} config
 * @returns {express.Router}
 */
export default function createHasuraProxy(config = {}) {
  // HASURA_ENDPOINT may include a path (e.g., "http://hasura:8080/v1/graphql").
  // Extract just the origin since the proxy preserves the request path.
  const rawEndpoint =
    config.hasuraEndpoint || process.env.HASURA_ENDPOINT || "http://hasura:8080";
  const hasuraOrigin = new URL(rawEndpoint).origin;

  const router = express.Router();

  // --- Proxy middleware (http-proxy-middleware) ---
  const proxy = createProxyMiddleware({
    target: hasuraOrigin,
    changeOrigin: true,
    ws: true,
    // Don't let http-proxy-middleware handle errors with HTML
    selfHandleResponse: false,
    on: {
      proxyReq: (proxyReq) => {
        // Strip all x-hasura-* headers (security boundary — R9)
        const headerNames = proxyReq.getHeaderNames
          ? proxyReq.getHeaderNames()
          : Object.keys(proxyReq.getHeaders?.() || {});
        for (const name of headerNames) {
          if (/^x-hasura-/i.test(name)) {
            proxyReq.removeHeader(name);
          }
        }
      },
      error: (err, req, res) => {
        // Hasura unreachable → 502 JSON (R10)
        if (res && typeof res.writeHead === "function" && !res.headersSent) {
          res.writeHead(502, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "GraphQL service unavailable" }));
        }
      },
    },
  });

  // --- Auth middleware ---
  async function authMiddleware(req, res, next) {
    try {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return res
          .status(401)
          .json({ error: "Authorization header required" });
      }

      const token = authHeader.slice(7);

      // Malformed token guard (R11): verify 3 dot-separated segments
      if (token.split(".").length !== 3) {
        return res.status(401).json({ error: "Invalid token format" });
      }

      const tokenType = detectTokenType(token);

      if (tokenType === "workos") {
        // RS256 WorkOS token → verify, provision, mint HS256
        const payload = await verifyWorkOSToken(token);
        const userId = await provisionUserFromWorkOS(payload);

        // Check minted token cache
        let hasuraToken = mintedTokenCache.get(userId);
        if (!hasuraToken) {
          hasuraToken = await mintHasuraToken(userId);
          // Decode exp for cache storage
          const parts = hasuraToken.split(".");
          const decoded = JSON.parse(
            Buffer.from(parts[1], "base64url").toString()
          );
          mintedTokenCache.set(userId, hasuraToken, decoded.exp);
        }

        // Swap the Authorization header for Hasura
        req.headers.authorization = `Bearer ${hasuraToken}`;
      }
      // HS256 tokens pass through unchanged

      next();
    } catch (err) {
      // Map errors to JSON responses (R10)
      const status = err.status || 500;
      let message;

      if (status === 403) {
        if (
          err.message?.includes("expired") ||
          err.message?.includes("TokenExpiredError")
        ) {
          message = "Token expired";
        } else {
          message = "Token verification failed";
        }
      } else if (status === 503) {
        message = "Authentication service unavailable";
      } else {
        message = "Authentication failed";
      }

      return res.status(status).json({ error: message });
    }
  }

  // Mount auth + proxy on /v1/graphql only
  router.all("/v1/graphql", authMiddleware, proxy);

  // Expose proxy for WebSocket upgrade handler
  router.proxy = proxy;

  return router;
}
