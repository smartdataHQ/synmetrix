import apiError from "../utils/apiError.js";
import cubejsApi from "../utils/cubejsApi.js";

export default async (session, input, headers) => {
  const {
    datasource_id: dataSourceId,
    branch_id: branchId,
    table_name: tableName,
    table_schema: tableSchema,
  } = input || {};

  const userId = session?.["x-hasura-user-id"];

  try {
    // CRITICAL: pass branchId to cubejsApi constructor for correct branch scoping
    const result = await cubejsApi({
      dataSourceId,
      branchId,
      userId,
      authToken: headers?.authorization,
    }).profileTable({
      table: tableName,
      schema: tableSchema,
      branchId,
    });

    return result;
  } catch (err) {
    return apiError(err);
  }
};
