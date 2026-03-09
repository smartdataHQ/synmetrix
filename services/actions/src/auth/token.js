import * as jose from "jose";

import { workos } from "../utils/workos.js";
import { getSession, updateSession, extendSession } from "../utils/session.js";
import generateUserAccessToken from "../utils/jwt.js";
import logger from "../utils/logger.js";

function isTokenExpired(token) {
  try {
    const decoded = jose.decodeJwt(token);
    if (!decoded.exp) return true;
    const expiresAt = decoded.exp * 1000;
    return expiresAt - Date.now() < 60 * 1000;
  } catch {
    return true;
  }
}

export default async function tokenHandler(req, res) {
  res.set("Cache-Control", "no-store");

  try {
    const sessionId = req.cookies?.session;

    if (!sessionId) {
      return res.status(401).json({
        error: true,
        code: "unauthorized",
        message: "No valid session",
      });
    }

    const session = await getSession(sessionId);

    if (!session) {
      return res.status(401).json({
        error: true,
        code: "unauthorized",
        message: "No valid session",
      });
    }

    // Extend session TTL (sliding window) — fire and forget
    extendSession(sessionId).catch((err) =>
      logger.error("[Token] Failed to extend session TTL:", err)
    );

    // Check if WorkOS access token needs refresh
    if (
      session.workosAccessToken &&
      isTokenExpired(session.workosAccessToken)
    ) {
      try {
        const refreshResult =
          await workos.userManagement.authenticateWithRefreshToken({
            clientId: process.env.WORKOS_CLIENT_ID,
            refreshToken: session.refreshToken,
          });

        // Mint fresh Hasura JWT
        const freshJwt = await generateUserAccessToken(session.userId);

        // Update session with new tokens
        session.workosAccessToken = refreshResult.accessToken;
        session.refreshToken = refreshResult.refreshToken;
        session.accessToken = freshJwt;

        await updateSession(sessionId, session);

        return res.json({
          accessToken: freshJwt,
          userId: session.userId,
          teamId: session.teamId || null,
          role: "user",
        });
      } catch (refreshError) {
        logger.warn("[Token] WorkOS token refresh failed:", refreshError);
        // Fall through to return existing Hasura JWT
      }
    }

    // Mint a fresh Hasura JWT if the existing one is expired
    let accessToken = session.accessToken;
    if (!accessToken || isTokenExpired(accessToken)) {
      accessToken = await generateUserAccessToken(session.userId);
      if (accessToken) {
        session.accessToken = accessToken;
        updateSession(sessionId, session).catch((err) =>
          logger.error("[Token] Failed to update session:", err)
        );
      }
    }

    return res.json({
      accessToken,
      userId: session.userId,
      teamId: session.teamId || null,
      role: "user",
    });
  } catch (error) {
    logger.error("[Token] Error:", error);
    return res.status(500).json({
      error: true,
      code: "server_error",
      message: "Failed to get token",
    });
  }
}
