import { ErrorCode } from "./errorCodes.js";

/**
 * Map the first entry of a Hasura `errors[]` array onto a stable
 * Model-Management error code.
 *
 * Hasura emits `extensions.code` values like `permission-error`, `not-exists`,
 * `constraint-violation`, `validation-failed`, `invalid-jwt`, etc. The map
 * below covers every code actually reached by routes in this feature. Any
 * code outside the map returns `null`, which callers treat as
 * "propagate as 503 hasura_unavailable" per R11.
 *
 * @param {Array<{extensions?:{code?:string}, message?:string}>|null|undefined} errors
 * @param {{action?: 'delete'|'rollback'|'validate'|'meta'|'diff'|'refresh'}} [ctx]
 * @returns {string|null}
 */
export function mapHasuraErrorCode(errors, ctx = {}) {
  if (!Array.isArray(errors) || errors.length === 0) return null;
  const first = errors[0];
  const code = first?.extensions?.code;
  if (!code) return null;

  const action = ctx.action;

  if (code === "permission-error" || code === "access-denied") {
    if (action === "delete") return ErrorCode.DELETE_BLOCKED_AUTHORIZATION;
    if (action === "rollback") return ErrorCode.ROLLBACK_BLOCKED_AUTHORIZATION;
    return null;
  }
  if (code === "not-exists" || code === "not-found") {
    if (action === "meta") return ErrorCode.CUBE_NOT_FOUND;
    if (action === "validate") return ErrorCode.VALIDATE_TARGET_NOT_FOUND;
    if (action === "rollback") return ErrorCode.ROLLBACK_VERSION_NOT_ON_BRANCH;
    return null;
  }
  if (code === "constraint-violation" || code === "constraint-error") {
    if (action === "delete") return ErrorCode.DELETE_BLOCKED_BY_REFERENCES;
    return null;
  }

  return null;
}
