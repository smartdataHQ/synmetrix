import {
  findSqlCredentials,
  findUser,
  provisionUserFromWorkOS,
  provisionUserFromFraiOS,
} from "./dataSourceHelpers.js";
import { detectTokenType, verifyWorkOSToken, verifyFraiOSToken } from "./workosAuth.js";

import buildSecurityContext from "./buildSecurityContext.js";
import defineUserScope, {
  getDataSourceAccessList,
} from "./defineUserScope.js";

const buildSqlSecurityContext = (sqlCredentials) => {
  if (!sqlCredentials) {
    throw new Error("Incorrect user name or password");
  }

  const dataSourceId = sqlCredentials?.datasource?.id;
  const teamId = sqlCredentials?.datasource?.team_id;
  const allMembers = sqlCredentials?.user?.members;

  const dataSourceAccessList = getDataSourceAccessList(
    allMembers,
    dataSourceId,
    teamId
  );

  const dataSourceContext = buildSecurityContext(sqlCredentials?.datasource);

  return {
    dataSource: dataSourceContext,
    ...dataSourceAccessList,
  };
};

/**
 * Check SQL authentication for a user.
 *
 * Cube.js v1.6 invokes this callback as `checkSqlAuth(request, user, password)`
 * (see @cubejs-backend/api-gateway/dist/src/sql-server.js — the callback is
 * wrapped with three positional args). Earlier builds passed a single object
 * `{ username, password }`; the defensive branches below keep backward-
 * compatibility with that older shape.
 *
 * Supports two authentication methods:
 * 1. WorkOS / FraiOS JWT as password: password is a JWT, username is the datasource ID
 * 2. Legacy sql_credentials lookup: username/password from the sql_credentials table
 *
 * @param {Object} request - Cube.js SQL request metadata (protocol, method, apiType)
 * @param {string|Object} userArg - Username string (v1.6+) or legacy { username, password } object
 * @param {string} [passwordArg] - Password string (v1.6+); absent in legacy object-shape calls
 * @returns {Promise<{ password: string, securityContext: Object }>}
 */
const checkSqlAuth = async (request, userArg, passwordArg) => {
  // Resolve the two shapes Cube has used for this callback:
  //   new: (request, username: string, password: string)
  //   legacy: (_req, { username, password })
  const username =
    typeof userArg === "string" ? userArg : userArg?.username;
  const password =
    passwordArg ??
    (typeof userArg === "string" ? undefined : userArg?.password);

  // Detect if password looks like a JWT (WorkOS RS256 / FraiOS HS256)
  if (password && password.includes(".") && password.split(".").length === 3) {
    const tokenType = detectTokenType(password);

    if (tokenType === "workos") {
      // WorkOS JWT path — fail closed on verification failure
      const payload = await verifyWorkOSToken(password);
      const userId = await provisionUserFromWorkOS(payload);

      const userData = await findUser({ userId });

      if (!userData.dataSources?.length || !userData.members?.length) {
        const error = new Error(`404: user "${userId}" not found`);
        error.status = 404;
        throw error;
      }

      // Username is the datasource ID
      const datasourceId = username;
      const dataSource = userData.dataSources.find(
        (ds) => ds.id === datasourceId
      );

      if (!dataSource) {
        const error = new Error(
          `403: access denied for datasource "${datasourceId}"`
        );
        error.status = 403;
        throw error;
      }

      const userScope = defineUserScope(
        userData.dataSources,
        userData.members,
        datasourceId
      );

      return {
        password,
        securityContext: {
          userId,
          userScope,
        },
      };
    } else if (tokenType === "fraios") {
      // FraiOS JWT path — same flow, different verification
      const payload = await verifyFraiOSToken(password);
      const userId = await provisionUserFromFraiOS(payload);

      const userData = await findUser({ userId });

      if (!userData.dataSources?.length || !userData.members?.length) {
        const error = new Error(`404: user "${userId}" not found`);
        error.status = 404;
        throw error;
      }

      const datasourceId = username;
      const dataSource = userData.dataSources.find(
        (ds) => ds.id === datasourceId
      );

      if (!dataSource) {
        const error = new Error(
          `403: access denied for datasource "${datasourceId}"`
        );
        error.status = 403;
        throw error;
      }

      const userScope = defineUserScope(
        userData.dataSources,
        userData.members,
        datasourceId
      );

      return {
        password,
        securityContext: {
          userId,
          userScope,
        },
      };
    }
  }

  // Legacy sql_credentials path — lookup by the plaintext username.
  // Cube.js compares the supplied password against `password` in the return value.
  if (!username || typeof username !== "string") {
    throw new Error("Incorrect user name or password");
  }
  const sqlCredentials = await findSqlCredentials(username);

  return {
    password: sqlCredentials?.password,
    securityContext: {
      userId: sqlCredentials?.user_id,
      userScope: buildSqlSecurityContext(sqlCredentials),
    },
  };
};

export default checkSqlAuth;
