// Deterministic rollout cohorts (013, research D8): canary first (fftech.is
// team + configured extras), then hash(team_id) mod N — reproducible across
// runs so reruns and debugging are predictable.

import crypto from "crypto";

const FFTECH_TEAM_NAME = "fftech.is";

export const assignCohort = (teamId, cohorts) => {
  const digest = crypto.createHash("md5").update(String(teamId)).digest("hex");
  return parseInt(digest.slice(0, 8), 16) % cohorts;
};

/**
 * Split teams into ordered cohorts: [canary, cohort-0, ..., cohort-N-1].
 * Canary = the fftech.is team plus config.canaryTeamIds; canary members are
 * excluded from the hashed cohorts.
 */
export const buildCohorts = (teams, config) => {
  const canarySet = new Set(config.canaryTeamIds || []);
  const canaryTeams = [];
  const rest = [];

  for (const team of teams) {
    if (canarySet.has(team.id) || team.name === FFTECH_TEAM_NAME) {
      canaryTeams.push(team);
    } else {
      rest.push(team);
    }
  }

  const buckets = Array.from({ length: config.cohorts }, (_, i) => ({
    name: `cohort-${i}`,
    teams: [],
  }));
  for (const team of rest) {
    buckets[assignCohort(team.id, config.cohorts)].teams.push(team);
  }

  return [{ name: "canary", teams: canaryTeams }, ...buckets];
};

/**
 * Halt when a cohort's failure rate EXCEEDS the threshold. At-or-below the
 * threshold the rollout continues — isolated failures never stop the fleet
 * (FR-010 halt vs FR-018 isolation).
 */
export const shouldHalt = ({ failures, total, threshold }) => {
  if (!total) return false;
  return failures / total > threshold;
};
