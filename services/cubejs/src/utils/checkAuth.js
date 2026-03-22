import jwt from "jsonwebtoken";

import {
  findUser,
  provisionUserFromWorkOS,
  provisionUserFromFraiOS,
} from "./dataSourceHelpers.js";
import { detectTokenType, verifyWorkOSToken, verifyFraiOSToken } from "./workosAuth.js";
import defineUserScope from "./defineUserScope.js";

const { JWT_KEY, JWT_ALGORITHM } = process.env;

/**
 * Checks the authorization of the request and sets the security context.
 * Supports dual-token verification: WorkOS RS256 and Hasura HS256.
 *
 * @param {Object} req - The request object.
 * @returns {Promise<void>} A promise that resolves when the security context is set.
 */
const checkAuth = async (req) => {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    const error = new Error("Provide Hasura Authorization token");
    error.status = 403;
    throw error;
  }

  const dataSourceId = req.headers["x-hasura-datasource-id"];
  const branchId = req.headers["x-hasura-branch-id"];
  const branchVersionId = req.headers["x-hasura-branch-version-id"];

  let authToken;

  if (authHeader.startsWith("Bearer ")) {
    authToken = authHeader.split(" ")[1];
  } else {
    authToken = authHeader;
  }

  if (!authToken) {
    const error = new Error("Provide Hasura Authorization token");
    error.status = 403;
    throw error;
  }

  let userId;
  const tokenType = detectTokenType(authToken);

  if (tokenType === "workos") {
    // WorkOS RS256 path
    const payload = await verifyWorkOSToken(authToken);
    userId = await provisionUserFromWorkOS(payload);
  } else if (tokenType === "fraios") {
    // FraiOS HS256 path
    const payload = await verifyFraiOSToken(authToken);
    userId = await provisionUserFromFraiOS(payload);
  } else {
    // Hasura HS256 path (existing)
    let jwtDecoded;
    try {
      jwtDecoded = jwt.verify(authToken, JWT_KEY, {
        algorithms: [JWT_ALGORITHM],
      });
    } catch (err) {
      throw err;
    }

    userId = jwtDecoded?.hasura?.["x-hasura-user-id"];
  }

  if (!dataSourceId) {
    const error = new Error(
      "400: No x-hasura-datasource-id provided, headers: " +
        JSON.stringify(req.headers)
    );
    error.status = 400;
    throw error;
  }

  const user = await findUser({ userId });

  if (!user.dataSources?.length || !user.members?.length) {
    const error = new Error(`404: user "${userId}" not found`);
    error.status = 404;
    throw error;
  }

  const userScope = defineUserScope(
    user.dataSources,
    user.members,
    dataSourceId,
    branchId,
    branchVersionId
  );

  req.securityContext = {
    authToken,
    userId,
    userScope,
  };
};

const checkAuthMiddleware = async (req, _, next) => {
  try {
    await checkAuth(req);
    next();
  } catch (err) {
    next(err);
  }
};

export { checkAuth };
export default checkAuthMiddleware;
