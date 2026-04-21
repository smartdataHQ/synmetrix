import jwt from "jsonwebtoken";

import {
  detectTokenType,
  verifyWorkOSToken,
  verifyFraiOSToken,
} from "./workosAuth.js";
import {
  provisionUserFromWorkOS,
  provisionUserFromFraiOS,
} from "./dataSourceHelpers.js";

const { JWT_KEY, JWT_ALGORITHM } = process.env;

/**
 * Shared direct-verify entry point for branch-scoped Model-Management routes.
 *
 * Endpoints whose request contract does NOT carry `x-hasura-datasource-id`
 * cannot mount behind the existing `checkAuthMiddleware` (which 400s when
 * the header is absent — see utils/checkAuth.js). Instead those handlers
 * call this helper, which mirrors the inline auth path already used by
 * `routes/metaAll.js` and the `hasuraProxy` authMiddleware.
 *
 * Returns `{token, payload, tokenType, userId}` on success, and
 * `{error: {status, code, message}}` on any auth failure — never throws.
 *
 * @param {import('express').Request} req
 * @returns {Promise<{token:string, payload:object, tokenType:string, userId:string} | {error:{status:number, code:string, message:string}}>}
 */
export async function verifyAndProvision(req) {
  const authHeader = req.headers?.authorization;
  if (!authHeader) {
    return {
      error: {
        status: 403,
        code: "auth_missing",
        message: "Authorization header required",
      },
    };
  }

  const token = authHeader.startsWith("Bearer ")
    ? authHeader.slice(7)
    : authHeader;

  if (!token || token.split(".").length !== 3) {
    return {
      error: {
        status: 403,
        code: "auth_invalid",
        message: "Bearer token required",
      },
    };
  }

  let tokenType;
  try {
    tokenType = detectTokenType(token);
  } catch {
    return {
      error: {
        status: 403,
        code: "auth_invalid",
        message: "Token could not be decoded",
      },
    };
  }

  try {
    if (tokenType === "workos") {
      const payload = await verifyWorkOSToken(token);
      const userId = await provisionUserFromWorkOS(payload);
      return { token, payload, tokenType, userId };
    }
    if (tokenType === "fraios") {
      const payload = await verifyFraiOSToken(token);
      const userId = await provisionUserFromFraiOS(payload);
      return { token, payload, tokenType, userId };
    }
    // Hasura HS256 — accepted for parity with checkAuth.js so the Model
    // Management routes honour the same tokens already used by catalog +
    // discovery endpoints (FR-015). No provisioning needed; the token is
    // already scoped to an existing user.
    const payload = jwt.verify(token, JWT_KEY, {
      algorithms: [JWT_ALGORITHM || "HS256"],
    });
    const userId =
      payload?.hasura?.["x-hasura-user-id"] || payload?.sub;
    if (!userId) {
      return {
        error: {
          status: 403,
          code: "auth_invalid",
          message: "Token missing x-hasura-user-id",
        },
      };
    }
    return { token, payload, tokenType: "hasura", userId };
  } catch (err) {
    const status = err?.status || 403;
    return {
      error: {
        status,
        code: status === 503 ? "auth_unavailable" : "auth_invalid",
        message:
          status === 503
            ? "Authentication service unavailable"
            : err?.message || "Token verification failed",
      },
    };
  }
}
