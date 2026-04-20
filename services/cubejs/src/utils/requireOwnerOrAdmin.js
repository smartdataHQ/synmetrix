/**
 * requireOwnerOrAdmin — resolve whether the caller has owner or admin role on
 * the given team. Shared by every Model-Management handler gating on
 * owner/admin (delete, rollback, refresh, validate-in-branch replace/preview-delete).
 *
 * A member carries one or more `member_roles` rows, each with a
 * `team_role` value in (`owner`, `admin`, `member`, ...). Team membership is
 * resolved from `user.members`, as returned by `findUser()`.
 *
 * @param {{members?: Array<{team_id:string, member_roles?: Array<{team_role:string}>}>}} user
 * @param {string} teamId
 * @returns {boolean}
 */
export function requireOwnerOrAdmin(user, teamId) {
  if (!user || !teamId || !Array.isArray(user.members)) return false;
  for (const m of user.members) {
    if (m?.team_id !== teamId) continue;
    const roles = m.member_roles || [];
    for (const r of roles) {
      if (r?.team_role === "owner" || r?.team_role === "admin") return true;
    }
  }
  return false;
}
