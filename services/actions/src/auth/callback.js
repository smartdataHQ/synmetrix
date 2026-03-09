import * as jose from "jose";

import { workos } from "../utils/workos.js";
import { createSession } from "../utils/session.js";
import { provisionUser } from "./provision.js";
import generateUserAccessToken from "../utils/jwt.js";
import logger from "../utils/logger.js";

export default async function callbackHandler(req, res) {
  try {
    const { code, state } = req.query;

    if (!code) {
      logger.error("[Auth Callback] No authorization code received");
      return res.redirect("/signin?error=callback_failed");
    }

    // Exchange code for user + tokens
    const authResult = await workos.userManagement.authenticateWithCode({
      clientId: process.env.WORKOS_CLIENT_ID,
      code,
    });

    const { user, accessToken, refreshToken, organizationId } = authResult;

    // Decode WorkOS access token to extract org claims
    let jwtClaims = {};
    try {
      jwtClaims = jose.decodeJwt(accessToken);
      logger.log("[Auth Callback] WorkOS JWT claims:", JSON.stringify(jwtClaims, null, 2));
    } catch (e) {
      logger.warn("[Auth Callback] Failed to decode WorkOS JWT:", e?.message);
    }

    // Log full auth result for debugging team assignments
    logger.log("[Auth Callback] WorkOS auth result:", JSON.stringify({
      userId: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      organizationId,
      jwtOrgId: jwtClaims.org_id,
      jwtOrgName: jwtClaims.org_name,
      authResultKeys: Object.keys(authResult),
    }, null, 2));

    // Extract partition from JWT claims (custom claim set in WorkOS)
    // Falls back to org_id, then top-level organizationId
    const partition = jwtClaims.partition || jwtClaims.org_id || organizationId || null;
    const orgId = jwtClaims.org_id || organizationId || null;
    logger.log(`[Auth Callback] Extracted partition: ${partition}, orgId: ${orgId}`);

    // JIT provision user in PostgreSQL
    const { userId, teamId } = await provisionUser(user, { partition, orgId });
    logger.log(`[Auth Callback] Provisioned: userId=${userId}, teamId=${teamId}, partition=${partition}, orgId=${orgId}`);

    // Mint Hasura-compatible JWT
    const hasuraJwt = await generateUserAccessToken(userId);
    if (!hasuraJwt) {
      logger.error("[Auth Callback] Failed to mint Hasura JWT");
      return res.redirect("/signin?error=callback_failed");
    }

    // Extract session ID from WorkOS access token
    let sessionId;
    try {
      const decoded = jose.decodeJwt(accessToken);
      sessionId = decoded.sid || user.id;
    } catch {
      sessionId = user.id;
      logger.warn(
        "[Auth Callback] Failed to decode access token, using user ID as session ID"
      );
    }

    // Create Redis session
    const sessionData = {
      sessionId,
      workosSessionId: sessionId,
      userId,
      teamId,
      accessToken: hasuraJwt,
      refreshToken,
      workosAccessToken: accessToken,
      user: {
        id: userId,
        workosId: user.id,
        email: user.email,
        displayName:
          [user.firstName, user.lastName].filter(Boolean).join(" ") || null,
      },
      createdAt: new Date().toISOString(),
    };

    await createSession(sessionId, sessionData);

    // Determine redirect target — redirect to the frontend app
    const appUrl = process.env.APP_FRONTEND_URL || process.env.APP_URL || "http://localhost:8000";

    // Set session cookie
    const isSecure = appUrl.startsWith("https://") || process.env.NODE_ENV === "production";
    res.cookie("session", sessionId, {
      httpOnly: true,
      secure: isSecure,
      sameSite: "lax",
      maxAge: 86400000, // 24 hours in ms
      path: "/",
    });
    let redirectTo = `${appUrl}/explore`;
    if (state) {
      try {
        const stateData = JSON.parse(state);
        if (stateData.returnTo) {
          redirectTo = stateData.returnTo.startsWith("/")
            ? `${appUrl}${stateData.returnTo}`
            : stateData.returnTo;
        }
      } catch {
        // ignore non-JSON state
      }
    }

    logger.log(
      `[Auth Callback] Session created for user ${userId}, redirecting to ${redirectTo}`
    );
    return res.redirect(redirectTo);
  } catch (error) {
    console.error("[Auth Callback] Error:", error?.message || error, error?.stack);
    return res.redirect("/signin?error=callback_failed");
  }
}
