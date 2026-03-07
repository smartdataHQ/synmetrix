import { WorkOS } from "@workos-inc/node";

let _workos = null;

function getWorkOS() {
  if (!_workos) {
    const apiKey = process.env.WORKOS_API_KEY;
    if (!apiKey) {
      throw new Error("WORKOS_API_KEY is not set");
    }
    _workos = new WorkOS(apiKey);
  }
  return _workos;
}

export const workos = new Proxy(
  {},
  {
    get(_, prop) {
      return getWorkOS()[prop];
    },
  }
);

export async function fetchOrganizationById(organizationId) {
  return workos.organizations.getOrganization(organizationId);
}

export async function listUserSessions(userId) {
  const sessions = await workos.userManagement.listSessions(userId);
  return sessions.data.filter((session) => session.status === "active");
}

export async function revokeSessionsById(sessionArray) {
  const revocations = sessionArray.map((session) =>
    workos.userManagement.revokeSession({ sessionId: session.id })
  );
  const results = await Promise.allSettled(revocations);
  results.forEach((result, index) => {
    if (result.status === "rejected" && sessionArray[index]) {
      console.error(
        `Failed to revoke session ${sessionArray[index].id}:`,
        result.reason
      );
    }
  });
  return results;
}

export async function revokeAllUserSessions(userId) {
  const sessions = await listUserSessions(userId);
  if (sessions.length === 0) return [];
  return revokeSessionsById(sessions);
}
