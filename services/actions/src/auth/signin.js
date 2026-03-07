import { workos } from "../utils/workos.js";

const OAUTH_PROVIDERS = {
  google: "GoogleOAuth",
  github: "GitHubOAuth",
  linkedin: "LinkedInOAuth",
  googleoauth: "GoogleOAuth",
  githuboauth: "GitHubOAuth",
  linkedinoauth: "LinkedInOAuth",
};

function validateReturnTo(returnTo) {
  if (!returnTo) return null;
  try {
    const url = new URL(returnTo, "http://localhost");
    const allowedHosts = (process.env.ALLOWED_RETURN_TO_HOSTS || "localhost")
      .split(",")
      .map((h) => h.trim());
    if (allowedHosts.includes(url.hostname)) {
      return url.pathname + url.search + url.hash;
    }
  } catch {
    // If returnTo is a relative path, allow it
    if (returnTo.startsWith("/")) return returnTo;
  }
  return null;
}

export default async function signinHandler(req, res) {
  try {
    const { provider, email, return_to, returnTo, signup, login_hint, loginHint } = req.query;

    const clientId = process.env.WORKOS_CLIENT_ID;
    const redirectUri = process.env.WORKOS_REDIRECT_URI;

    const options = {
      clientId,
      redirectUri,
    };

    // Add login hint (email pre-fill)
    const hint = login_hint || loginHint || email;
    if (hint) {
      options.loginHint = hint.trim();
    }

    // Handle returnTo via state
    const returnToValue = return_to || returnTo;
    const validatedReturnTo = validateReturnTo(returnToValue);
    if (validatedReturnTo) {
      options.state = JSON.stringify({ returnTo: validatedReturnTo });
    }

    // Support sign-up screen hint (if enabled)
    const signupEnabled = process.env.SIGNUP_ENABLED === "true";
    if (signup === "true") {
      if (!signupEnabled) {
        return res.redirect("/signin?error=signup_disabled");
      }
      options.screenHint = "sign-up";
    }

    // Direct OAuth provider or hosted AuthKit UI
    const providerKey = provider?.toLowerCase();
    const workosProvider = providerKey ? OAUTH_PROVIDERS[providerKey] : undefined;

    // WorkOS requires one of: provider, connectionId, or organizationId
    // When no specific OAuth provider is requested, use 'authkit' to show the hosted UI
    options.provider = workosProvider || "authkit";

    const signInUrl = workos.userManagement.getAuthorizationUrl(options);

    return res.redirect(signInUrl);
  } catch (error) {
    console.error("WorkOS signin error:", error);
    return res.redirect("/signin?error=callback_failed");
  }
}
