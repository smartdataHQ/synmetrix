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
 * Supports two authentication methods:
 * 1. WorkOS JWT as password (new): password is a JWT, username is datasource ID
 * 2. Legacy sql_credentials lookup (existing): username/password from sql_credentials table
 *
 * @param {null} _ - Unused parameter.
 * @param {Object} user - The user object with username and password.
 * @returns {Promise} - Resolves to { password, securityContext }
 */
const checkSqlAuth = async (_, user) => {
  const password = typeof user === "string" ? user : user?.password;
  const username = typeof user === "string" ? _ : user?.username;

  // Detect if password looks like a JWT (WorkOS RS256)
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

  // Legacy sql_credentials path (unchanged)
  const sqlCredentials = await findSqlCredentials(username || user);

  return {
    password: sqlCredentials?.password,
    securityContext: {
      userId: sqlCredentials?.user_id,
      userScope: buildSqlSecurityContext(sqlCredentials),
    },
  };
};

export default checkSqlAuth;
