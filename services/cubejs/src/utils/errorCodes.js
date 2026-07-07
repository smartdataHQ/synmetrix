/**
 * Canonical Model-Management API error codes (FR-017).
 *
 * Every code emitted by a Model-Management handler MUST come from this enum.
 * Every `contracts/011-model-mgmt-api/*.yaml` ErrorCode enum MUST match this
 * list exactly — drift is caught at build time by scripts/lint-error-codes.mjs.
 */

export const ErrorCode = Object.freeze({
  VALIDATE_INVALID_MODE: "validate_invalid_mode",
  VALIDATE_TARGET_NOT_FOUND: "validate_target_not_found",
  VALIDATE_UNRESOLVED_REFERENCE: "validate_unresolved_reference",
  REFRESH_BRANCH_NOT_VISIBLE: "refresh_branch_not_visible",
  REFRESH_UNAUTHORIZED: "refresh_unauthorized",
  DELETE_BLOCKED_BY_REFERENCES: "delete_blocked_by_references",
  DELETE_BLOCKED_HISTORICAL_VERSION: "delete_blocked_historical_version",
  DELETE_BLOCKED_AUTHORIZATION: "delete_blocked_authorization",
  CUBE_NOT_FOUND: "cube_not_found",
  DIFF_CROSS_BRANCH: "diff_cross_branch",
  DIFF_INVALID_REQUEST: "diff_invalid_request",
  ROLLBACK_VERSION_NOT_ON_BRANCH: "rollback_version_not_on_branch",
  ROLLBACK_BLOCKED_AUTHORIZATION: "rollback_blocked_authorization",
  ROLLBACK_INVALID_REQUEST: "rollback_invalid_request",
  ROLLBACK_SOURCE_COLUMNS_MISSING: "rollback_source_columns_missing",
});

export const ErrorCodeSet = Object.freeze(new Set(Object.values(ErrorCode)));

export function isKnownErrorCode(code) {
  return ErrorCodeSet.has(code);
}

/**
 * Default-models query pre-processor codes (013, FR-016/SC-005).
 *
 * Deliberately NOT part of the Model-Management `ErrorCode` enum above: the
 * 011 OpenAPI contracts must not receive these values (lint-error-codes.mjs
 * only harvests the lowercase enum). Value casing follows
 * specs/013-mature-default-models/contracts/query-preprocessor.md.
 */
export const DefaultModelErrorCode = Object.freeze({
  MEMBER_UNAVAILABLE: "DEFAULT_MODEL_MEMBER_UNAVAILABLE",
  // 014: query uses more distinct dynamic keys of one map than declared slots
  SLOTS_EXHAUSTED: "DYNAMIC_KEY_SLOTS_EXHAUSTED",
});
