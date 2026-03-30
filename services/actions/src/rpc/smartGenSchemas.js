import apiError from "../utils/apiError.js";
import cubejsApi from "../utils/cubejsApi.js";
import { invalidateUserCache } from "../utils/cubeCache.js";

export default async (session, input, headers) => {
  const {
    datasource_id: dataSourceId,
    branch_id: branchId,
    table_name: tableName,
    table_schema: tableSchema,
    array_join_columns: arrayJoinColumns,
    max_map_keys: maxMapKeys,
    merge_strategy: mergeStrategy,
    profile_data: profileData,
    dry_run: dryRun,
    filters,
    file_name: fileName,
    cube_name: cubeName,
    selected_ai_metrics: selectedAIMetrics,
    selected_columns: selectedColumns,
    nested_filters: nestedFilters,
  } = input || {};

  const userId = session?.["x-hasura-user-id"];

  if (nestedFilters) {
    console.log('[smartGenSchemas] nested_filters received:', JSON.stringify(nestedFilters));
  }

  try {
    // CRITICAL: pass branchId to cubejsApi constructor for correct branch scoping
    const result = await cubejsApi({
      dataSourceId,
      branchId,
      userId,
      authToken: headers?.authorization,
    }).smartGenerate({
      table: tableName,
      schema: tableSchema,
      branchId,
      arrayJoinColumns,
      maxMapKeys,
      mergeStrategy,
      profileData,
      dryRun,
      filters,
      file_name: fileName,
      cube_name: cubeName,
      selected_ai_metrics: selectedAIMetrics,
      selected_columns: selectedColumns,
      nestedFilters,
    });

    // Ensure subsequent Explore/Meta requests resolve the latest branch version
    // immediately after model generation instead of waiting for cache TTL expiry.
    if (userId) {
      invalidateUserCache(userId);
    }

    return result;
  } catch (err) {
    return apiError(err);
  }
};
