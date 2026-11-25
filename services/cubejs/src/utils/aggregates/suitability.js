/**
 * Decides, for one request, whether one aggregate can answer every query of
 * it exactly, and which. Pure and synchronous: everything it needs (derived
 * cubes, the catalog) is already in memory.
 */
const SUB_DAY_SECONDS = { second: 1, minute: 60, hour: 3600 };
const CUSTOM_SUB_DAY = /^(min|hour)_(\d+)$/;
const UTC_TIMEZONES = new Set(["UTC", "Etc/UTC", "GMT", "Etc/GMT"]);
const WHOLE_DAYS = new Set(["day", "week", "month", "quarter", "year"]); // unions of whole UTC days
const WHOLE_MONTHS = new Set(["month", "quarter", "year"]); // unions of whole UTC months (weeks excluded)

function subDayGranularitySeconds(granularity) {
  if (Object.hasOwn(SUB_DAY_SECONDS, granularity)) return SUB_DAY_SECONDS[granularity];
  const match = typeof granularity === "string" && CUSTOM_SUB_DAY.exec(granularity);
  if (!match) return null;
  const n = Number(match[2]);
  if (!Number.isInteger(n) || n <= 0) return null;
  if (match[1] === "min") return n < 60 && 60 % n === 0 ? n * 60 : null;
  return n < 24 && 24 % n === 0 ? n * 3600 : null;
}
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}$/;
const START_TIMESTAMP = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z?$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const isStartOfUtcMonth = (ms) => {
  if (ms % 86400_000 !== 0) return false;
  return new Date(ms).getUTCDate() === 1;
};

const cubeOf = (member) => {
  const parts = String(member).split(".");
  return parts.length === 2 ? parts[0] : null; // a longer path goes through a join
};

/** Every member a query names, or null when one of them is not a plain member name. */
function membersOf(query) {
  const members = [];
  const add = (member) => {
    if (typeof member !== "string") return false;
    members.push(member);
    return true;
  };
  for (const key of ["measures", "dimensions", "segments"]) {
    for (const member of query[key] || []) if (!add(member)) return null;
  }
  for (const entry of query.timeDimensions || []) if (!add(entry?.dimension)) return null;
  const walk = (filters) => {
    for (const filter of filters || []) {
      if (Array.isArray(filter?.and)) {
        if (!walk(filter.and)) return false;
      } else if (Array.isArray(filter?.or)) {
        if (!walk(filter.or)) return false;
      } else if (!add(filter?.member ?? filter?.dimension)) return false;
    }
    return true;
  };
  if (!walk(query.filters)) return null;
  const order = Array.isArray(query.order) ? query.order : Object.keys(query.order || {}).map((id) => ({ id }));
  for (const entry of order) if (!add(Array.isArray(entry) ? entry[0] : entry?.id)) return null;
  return members;
}

/** The one cube a query reads, or why it cannot be routed at all. */
function shapeOf(query) {
  if (!query || typeof query !== "object") return { reason: "unsupported_query" };
  if (query.ungrouped || query.subqueryJoins?.length || query.joinHints?.length || query.maskedMembers?.length) {
    return { reason: "unsupported_query" };
  }
  const members = membersOf(query);
  if (!members || members.length === 0) return { reason: "unsupported_query" };
  const cubes = new Set(members.map(cubeOf));
  if (cubes.size !== 1 || cubes.has(null)) return { reason: "multi_cube" };
  return { cube: [...cubes][0], members };
}

/** The one cube a request reads: `{cube}`, or `{reason}` when it cannot be routed. */
export function cubeOfRequest(queries) {
  if (!Array.isArray(queries) || queries.length === 0) return { reason: "unsupported_query" };
  const shapes = queries.map(shapeOf);
  if (queries.length === 1) return shapes[0].reason ? { reason: shapes[0].reason } : { cube: shapes[0].cube };
  const cube = shapes[0].cube;
  if (shapes.some((shape) => shape.reason || shape.cube !== cube)) return { reason: "request_mixed" };
  return { cube };
}

const toMs = (text) => Date.parse(`${text}Z`);

/** [start, last millisecond] of a resolved range, or null when it is not one. */
function rangeOf(values, { datesAllowed }) {
  if (!Array.isArray(values) || values.length !== 2) return null;
  const [from, to] = values;
  if (typeof from !== "string" || typeof to !== "string") return null;
  const start = TIMESTAMP.test(from) ? toMs(from) : datesAllowed && DATE.test(from) ? toMs(`${from}T00:00:00.000`) : NaN;
  const end = TIMESTAMP.test(to) ? toMs(to) : datesAllowed && DATE.test(to) ? toMs(`${to}T23:59:59.999`) : NaN;
  return Number.isNaN(start) || Number.isNaN(end) ? null : [start, end];
}

/** Start millisecond of a single-value `afterOrOnDate` filter, or null when malformed. */
function startBoundOf(values) {
  if (!Array.isArray(values) || values.length !== 1) return null;
  const [from] = values;
  if (typeof from !== "string") return null;
  let start = NaN;
  if (DATE.test(from)) {
    start = toMs(`${from}T00:00:00.000`);
  } else if (START_TIMESTAMP.test(from)) {
    const iso = from.replace(" ", "T");
    start = iso.endsWith("Z") ? Date.parse(iso) : toMs(iso);
  }
  return Number.isNaN(start) ? null : start;
}

/** Why `query` cannot be answered from this aggregate, or null when it can. */
function qualify(query, members, derived, structure, now) {
  for (const member of members) {
    if (!derived.available.has(member)) {
      return `member_unavailable:${member}:${derived.leftOut.get(member) || "unsupported_member"}`;
    }
  }
  if (query.timezone && !UTC_TIMEZONES.has(query.timezone)) return "timezone";

  const isMonthGrain = structure.grainKind === "month" || structure.grain === "1 month";
  const grain = structure.grainSeconds;
  const grainMs = grain * 1000;
  const ranges = [];
  const lowerBounds = [];
  const startAligned = isMonthGrain ? isStartOfUtcMonth : (start) => start % grainMs === 0;
  const aligned = isMonthGrain
    ? ([start, end]) => isStartOfUtcMonth(start) && isStartOfUtcMonth(end + 1)
    : ([start, end]) => start % grainMs === 0 && (end + 1) % grainMs === 0;

  for (const entry of query.timeDimensions || []) {
    if (!derived.timeMembers.has(entry.dimension)) continue; // an ordinary grouping column
    const { granularity } = entry;
    if (granularity) {
      if (isMonthGrain) {
        if (!WHOLE_MONTHS.has(granularity)) return "granularity";
      } else if (!WHOLE_DAYS.has(granularity)) {
        const seconds = subDayGranularitySeconds(granularity);
        if (!seconds || seconds % grain !== 0) return "granularity";
      }
    }
    if (entry.dateRange === undefined || entry.dateRange === null) continue;
    const range = rangeOf(entry.dateRange, { datesAllowed: false });
    if (!range || !aligned(range)) return "range_not_aligned";
    ranges.push(range);
  }

  // The time dimension may be filtered by a plain date range or an aligned lower bound
  // (`afterOrOnDate`), and never inside an OR.
  const timeFilters = (filters, insideOr) => {
    for (const filter of filters || []) {
      const group = filter?.and || filter?.or;
      if (Array.isArray(group)) {
        const problem = timeFilters(group, insideOr || Boolean(filter.or));
        if (problem) return problem;
      } else if (derived.timeMembers.has(filter?.member ?? filter?.dimension)) {
        if (insideOr) return "time_filter";
        if (filter.operator === "inDateRange") {
          const range = rangeOf(filter.values, { datesAllowed: true });
          if (!range) return "time_filter";
          if (!aligned(range)) return "range_not_aligned";
          ranges.push(range);
        } else if (filter.operator === "afterOrOnDate") {
          const start = startBoundOf(filter.values);
          if (start === null) return "time_filter";
          if (!startAligned(start)) return "range_not_aligned";
          lowerBounds.push(start);
        } else {
          return "time_filter";
        }
      }
    }
    return null;
  };
  const filterProblem = timeFilters(query.filters, false);
  if (filterProblem) return filterProblem;

  if (structure.verifiedAt == null) return "not_verified";
  if (now - structure.verifiedAt > structure.maxStalenessSeconds * 1000) return "stale";

  // Window rule: inside what the aggregate holds, or long enough that its newest part may lag.
  if (ranges.length > 0 || lowerBounds.length > 0) {
    const start = Math.max(...ranges.map((range) => range[0]), ...lowerBounds);
    if (ranges.length > 0) {
      const end = Math.min(...ranges.map((range) => range[1])) + 1;
      const inside = structure.coveredUntil != null && end <= structure.coveredUntil;
      if (!inside && end - start < structure.minWindowSeconds * 1000) return "window_too_short";
    } else {
      // Open-ended lower bound (`afterOrOnDate`): reaches through `now`, so never
      // strictly inside `coveredUntil`; enforce `minWindowSeconds` against `now - start`.
      if (now - start < structure.minWindowSeconds * 1000) return "window_too_short";
    }
  }
  return null;
}

/**
 * @param {object[]} queries the request's queries, as Cube normalized and rewrote them
 * @param {Map<string, object>} derivedByAggregate aggregate table -> derived cube, for the request's cube
 * @param {{aggregates: object[]}|null} catalogEntry
 * @param {() => number} clock the database server's time in milliseconds
 * @returns {{cube: string|null, aggregate: string|null, variantKey: string|null, coveredUntil: number|null, reason: string|null}}
 */
export function decide(queries, derivedByAggregate, catalogEntry, clock) {
  const stay = (reason, cube = null) => ({ cube, aggregate: null, variantKey: null, coveredUntil: null, reason });
  if (!catalogEntry) return stay("no_catalog");

  const shapes = Array.isArray(queries) ? queries.map(shapeOf) : [];
  const request = cubeOfRequest(queries);
  if (request.reason) return stay(request.reason);
  const { cube } = request;

  const candidates = [...derivedByAggregate.values()].filter((derived) => derived.cube === cube);
  if (candidates.length === 0) return stay("no_aggregate", cube);
  const usable = candidates
    .filter((derived) => !derived.ineligible)
    .map((derived) => ({ derived, structure: catalogEntry.aggregates.find((entry) => entry.table === derived.aggregate) }))
    .filter(({ structure }) => structure)
    // the coarsest grain first, then the smallest table
    .sort((left, right) => right.structure.grainSeconds - left.structure.grainSeconds || left.structure.totalRows - right.structure.totalRows);
  if (usable.length === 0) {
    const ineligible = candidates.find((derived) => derived.ineligible);
    return stay(ineligible ? `cube_not_eligible:${ineligible.ineligible}` : "no_aggregate", cube);
  }

  const now = clock();
  let reason = null;
  let someQueryFits = false;
  for (const { derived, structure } of usable) {
    const problems = queries.map((query, index) => qualify(query, shapes[index].members, derived, structure, now));
    if (problems.every((problem) => problem === null)) {
      return { cube, aggregate: structure.table, variantKey: derived.variantKey, coveredUntil: structure.coveredUntil, reason: null };
    }
    someQueryFits ||= problems.some((problem) => problem === null);
    reason = problems.find(Boolean);
  }
  return stay(queries.length > 1 && someQueryFits ? "request_mixed" : reason, cube);
}
