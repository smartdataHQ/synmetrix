const SESSION_COOKIE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function isHttpsRequest(req) {
  if (req.secure) return true;

  const forwardedProto = req.headers["x-forwarded-proto"];
  if (typeof forwardedProto === "string") {
    return forwardedProto.split(",")[0].trim() === "https";
  }

  return false;
}

export function getSessionCookieOptions(req) {
  const appUrl = process.env.APP_FRONTEND_URL || process.env.APP_URL || "";
  const secure =
    process.env.SESSION_COOKIE_SECURE === "true" ||
    isHttpsRequest(req) ||
    appUrl.startsWith("https://");

  return {
    httpOnly: true,
    secure,
    sameSite: "lax",
    maxAge: SESSION_COOKIE_MAX_AGE_MS,
    path: "/",
  };
}

export { SESSION_COOKIE_MAX_AGE_MS };
