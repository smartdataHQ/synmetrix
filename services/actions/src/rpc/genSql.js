import crypto from "crypto";

import apiError from "../utils/apiError.js";
import cubejsApi from "../utils/cubejsApi.js";
import { fetchGraphQL } from "../utils/graphql.js";
import {
  replaceQueryParams,
  updatePlaygroundState,
} from "../utils/playgroundState.js";

const { JWT_KEY } = process.env;

/**
 * HMAC-sign SQL so that run-sql can verify it was generated internally
 * (by gen_sql via queryRewrite-governed compilation), not user-supplied.
 */
function signSql(sql) {
  return crypto.createHmac("sha256", JWT_KEY).update(sql).digest("hex");
}

const explorationQuery = `
  query ($id: uuid!) {
    explorations_by_pk(id: $id) {
      id
      branch_id
      datasource_id
      playground_state
    }
  }
`;

export const rawSql = async (exploration, args, authToken) => {
  const { playground_state: playgroundState } = exploration;

  const { userId, limit, offset } = args || {};

  const cubejs = cubejsApi({
    dataSourceId: exploration.datasource_id,
    branchId: exploration.branch_id,
    userId,
    authToken,
  });

  const meta = await cubejs.meta();

  const { updatedPlaygroundState } = updatePlaygroundState(
    playgroundState,
    meta
  );

  if (limit !== undefined && limit !== null) {
    if (limit === 0) {
      delete updatedPlaygroundState.limit;
    } else {
      updatedPlaygroundState.limit = limit;
    }
  }

  if (offset) {
    updatedPlaygroundState.offset = offset;
  }

  const sql = await cubejs.query(updatedPlaygroundState, "sql");

  if (sql) {
    sql.sql = replaceQueryParams(sql.sql, sql.params);
  }

  return sql;
};

export default async (session, input, headers) => {
  const { exploration_id: explorationId, limit: limitOverride } = input || {};
  const userId = session?.["x-hasura-user-id"];
  const { authorization: authToken } = headers || {};

  try {
    const exploration = await fetchGraphQL(
      explorationQuery,
      { id: explorationId },
      authToken
    );

    const explorationData = exploration?.data?.explorations_by_pk;

    const { sql, params, preAggregations } = await rawSql(
      explorationData,
      {
        userId,
        limit: limitOverride,
      },
      authToken
    );

    // Build column_metadata from playground_state
    const ps = explorationData?.playground_state || {};
    const columnMetadata = [
      ...(ps.measures || []).map((m) => ({
        alias: m.toLowerCase().replace(/\./g, "__"),
        member: m,
        role: "measure",
      })),
      ...(ps.dimensions || []).map((d) => ({
        alias: d.toLowerCase().replace(/\./g, "__"),
        member: d,
        role: "dimension",
      })),
      ...(ps.timeDimensions || []).map((td) => {
        const member = typeof td === "string" ? td : td.dimension;
        return {
          alias: member.toLowerCase().replace(/\./g, "__"),
          member,
          role: "timeDimension",
        };
      }),
    ];

    return {
      result: {
        sql,
        params,
        preAggregations,
      },
      column_metadata: columnMetadata,
      sql_signature: signSql(sql),
    };
  } catch (err) {
    return apiError(err);
  }
};
