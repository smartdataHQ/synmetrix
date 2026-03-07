import { workos, revokeAllUserSessions, revokeSessionsById } from "../utils/workos.js";
import { getSession, deleteSession } from "../utils/session.js";
import logger from "../utils/logger.js";

export default async function signoutHandler(req, res) {
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
      // Clear stale cookie
      res.clearCookie("session", { path: "/" });
      return res.json({ success: true, redirectTo: "/signin" });
    }

    const revokeAll = req.query?.revoke_all === "true";

    // Revoke WorkOS sessions
    if (revokeAll && session.user?.workosId) {
      try {
        await revokeAllUserSessions(session.user.workosId);
        logger.log(`Revoked all sessions for user: ${session.user.workosId}`);
      } catch (error) {
        logger.error("Failed to revoke all user sessions:", error);
      }
    } else if (session.workosSessionId) {
      try {
        await revokeSessionsById([{ id: session.workosSessionId }]);
      } catch (error) {
        logger.error("Failed to revoke session by ID:", error);
      }
    }

    // Call WorkOS logout endpoint
    if (session.workosSessionId) {
      try {
        const logoutUrl = workos.userManagement.getLogoutUrl({
          sessionId: session.workosSessionId,
        });
        await fetch(logoutUrl, { method: "GET", redirect: "manual" });
      } catch (error) {
        logger.error("Failed to logout from WorkOS:", error);
      }
    }

    // Delete Redis session
    await deleteSession(sessionId);

    // Clear session cookie
    res.clearCookie("session", { path: "/" });

    return res.json({ success: true, redirectTo: "/signin" });
  } catch (error) {
    logger.error("Error during signout:", error);
    return res.status(500).json({
      error: true,
      code: "server_error",
      message: "Signout failed",
    });
  }
}
