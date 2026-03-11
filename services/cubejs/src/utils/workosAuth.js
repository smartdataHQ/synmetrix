import * as jose from "jose";

const { WORKOS_CLIENT_ID, WORKOS_API_KEY, WORKOS_ISSUER } = process.env;

// JWKS endpoint: use custom issuer if provided, otherwise default WorkOS URL
const jwksBaseUrl = WORKOS_ISSUER || "https://api.workos.com";
const JWKS_URL = new URL(`/sso/jwks/${WORKOS_CLIENT_ID}`, jwksBaseUrl);
// WorkOS issuer format: {baseUrl}/user_management/{clientId}
const issuer = WORKOS_ISSUER
  ? `${WORKOS_ISSUER}/user_management/${WORKOS_CLIENT_ID}`
  : `https://api.workos.com/user_management/${WORKOS_CLIENT_ID}`;

// jose handles key caching, rotation, and cooldown automatically
const jwks = jose.createRemoteJWKSet(JWKS_URL);

/**
 * Detect token type by decoding the JWT header without verification.
 * @param {string} token - Raw JWT string
 * @returns {"workos" | "hasura"} Token type
 */
export function detectTokenType(token) {
  try {
    const header = jose.decodeProtectedHeader(token);
    return header.alg === "RS256" ? "workos" : "hasura";
  } catch {
    return "hasura"; // Default to existing path on decode failure
  }
}

/**
 * Verify a WorkOS RS256 JWT using the JWKS endpoint.
 * @param {string} token - Raw JWT string
 * @returns {Promise<Object>} Decoded JWT payload
 * @throws {Error} With `status` property (403 for auth errors, 503 for JWKS failures)
 */
export async function verifyWorkOSToken(token) {
  try {
    const { payload } = await jose.jwtVerify(token, jwks, {
      algorithms: ["RS256"],
      issuer,
    });
    return payload;
  } catch (err) {
    const error = new Error(err.message);

    if (err.code === "ERR_JWT_EXPIRED") {
      error.message = "TokenExpiredError: jwt expired";
      error.status = 403;
    } else if (
      err.code === "ERR_JWS_SIGNATURE_VERIFICATION_FAILED" ||
      err.code === "ERR_JWT_CLAIM_VALIDATION_FAILED"
    ) {
      error.message = "JsonWebTokenError: invalid signature";
      error.status = 403;
    } else if (err.code === "ERR_JWKS_NO_MATCHING_KEY") {
      // Key mismatch — token's kid doesn't match any JWKS key
      error.message = "JsonWebTokenError: invalid signature";
      error.status = 403;
    } else if (
      err.message.includes("fetch") ||
      err.message.includes("ECONNREFUSED") ||
      err.message.includes("network")
    ) {
      error.message = "503: Unable to verify token";
      error.status = 503;
    } else {
      error.message = `JsonWebTokenError: ${err.message}`;
      error.status = 403;
    }

    throw error;
  }
}

/**
 * Fetch a WorkOS user profile by their WorkOS user ID.
 * @param {string} workosUserId - WorkOS user ID (e.g., "user_01KEC615...")
 * @returns {Promise<{email: string, firstName: string|null, lastName: string|null, profilePictureUrl: string|null}>}
 * @throws {Error} With `status` property (404, 503)
 */
export async function fetchWorkOSUserProfile(workosUserId) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    const res = await fetch(
      `https://api.workos.com/user_management/users/${workosUserId}`,
      {
        headers: {
          Authorization: `Bearer ${WORKOS_API_KEY}`,
        },
        signal: controller.signal,
      }
    );

    if (!res.ok) {
      const error = new Error(
        res.status === 404
          ? `404: WorkOS user "${workosUserId}" not found`
          : `503: Unable to provision user`
      );
      error.status = res.status === 404 ? 404 : 503;
      throw error;
    }

    const data = await res.json();
    const firstName = data.first_name || data.firstName || null;
    const lastName = data.last_name || data.lastName || null;

    return {
      email: data.email,
      firstName,
      lastName,
      profilePictureUrl:
        data.profile_picture_url || data.profilePictureUrl || null,
    };
  } catch (err) {
    if (err.status) throw err; // Already has status property

    const error = new Error("503: Unable to provision user");
    error.status = 503;
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
