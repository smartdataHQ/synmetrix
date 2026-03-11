import { SignJWT } from "jose";

const { JWT_EXPIRES_IN, JWT_ALGORITHM, JWT_CLAIMS_NAMESPACE, JWT_KEY } =
  process.env;

/**
 * Mint an HS256 Hasura JWT for a given userId.
 * Ported from services/actions/src/utils/jwt.js with issuer "services:cubejs".
 *
 * @param {string} userId - Internal user ID (UUID)
 * @returns {Promise<string>} Signed JWT string
 */
export async function mintHasuraToken(userId) {
  const secret = new TextEncoder().encode(JWT_KEY);

  return new SignJWT({
    [JWT_CLAIMS_NAMESPACE]: {
      "x-hasura-user-id": userId,
      "x-hasura-allowed-roles": ["user"],
      "x-hasura-default-role": "user",
    },
  })
    .setProtectedHeader({ alg: JWT_ALGORITHM })
    .setIssuedAt()
    .setIssuer("services:cubejs")
    .setAudience("services:hasura")
    .setExpirationTime(`${JWT_EXPIRES_IN}m`)
    .setSubject(userId)
    .sign(secret);
}
