import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { cubeOfRequest, decide } from "../suitability.js";

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 10, 20, 12); // 20 November 2026, 12:00 UTC
const COVERED = Date.UTC(2026, 10, 1); // the aggregate holds everything before 1 November

const aggregate = (patch = {}) => ({
  table: "cst.sales_lines__agg_1day",
  source: "cst.sales_lines",
  timeColumn: "timestamp",
  grainSeconds: 86400,
  minAgeSeconds: 7 * 86400,
  minWindowSeconds: 60 * 86400,
  maxStalenessSeconds: 86400,
  totalRows: 1000,
  verifiedAt: NOW - HOUR,
  coveredUntil: COVERED,
  ...patch,
});
const halfHour = (patch = {}) => aggregate({ table: "cst.sales_lines__agg_30minute", grainSeconds: 1800, totalRows: 48000, ...patch });

const AVAILABLE = ["sold_location", "main_category", "timestamp", "sale_day", "store0", "units", "avg_units", "count"];
const derivedFor = (structure, patch = {}) => ({
  variantKey: `key:${structure.table}`,
  cube: "line_items",
  aggregate: structure.table,
  available: new Set(AVAILABLE.map((name) => `line_items.${name}`)),
  leftOut: new Map([
    ["line_items.transactions", "column_not_in_aggregate"],
    ["line_items.big_line", "not_grouping_column"],
  ]),
  timeMembers: new Set(["line_items.timestamp"]),
  ineligible: null,
  ...patch,
});

/** Decides a request against the given aggregates, all derived for `line_items`. */
function decideWith(queries, aggregates = [aggregate()], derivedPatch = {}) {
  const derived = new Map(aggregates.map((structure) => [structure.table, derivedFor(structure, derivedPatch)]));
  return decide(queries, derived, { aggregates, rejected: [] }, () => NOW);
}
const routed = (decision) => decision.aggregate?.replace("cst.sales_lines__agg_", "") ?? decision.reason;

const m = (name) => `line_items.${name}`;
const query = (patch = {}) => ({
  measures: [m("units")],
  dimensions: [],
  timeDimensions: [],
  filters: [],
  timezone: "UTC",
  limit: 10000,
  ...patch,
});
const stamp = (text) => (text.length === 10 ? `${text}T00:00:00.000` : text);
const until = (text) => (text.length === 10 ? `${text}T23:59:59.999` : text);
/** A query bucketed by `granularity` over [from, to], given as dates or full timestamps. */
const over = (granularity, from, to, patch = {}) =>
  query({
    timeDimensions: [{ dimension: m("timestamp"), ...(granularity ? { granularity } : {}), dateRange: [stamp(from), until(to)] }],
    ...patch,
  });

describe("decide: requests that qualify", () => {
  it("chooses the aggregate and reports what it covers", () => {
    assert.deepEqual(decideWith([over("month", "2026-01-01", "2026-03-31")]), {
      cube: "line_items",
      aggregate: "cst.sales_lines__agg_1day",
      variantKey: "key:cst.sales_lines__agg_1day",
      coveredUntil: COVERED,
      reason: null,
    });
  });

  it("accepts every bucket that is a whole multiple of the grain", () => {
    for (const granularity of ["day", "week", "month", "quarter", "year", undefined]) {
      assert.equal(routed(decideWith([over(granularity, "2026-01-01", "2026-03-31")])), "1day", String(granularity));
    }
    for (const granularity of ["hour", "day", "month"]) {
      assert.equal(routed(decideWith([over(granularity, "2026-01-01", "2026-03-31")], [halfHour()])), "30minute", granularity);
    }
  });

  it("accepts dimensions, segments, filters and ordering on available members", () => {
    const decision = decideWith([
      over("day", "2026-02-01", "2026-02-28", {
        measures: [m("units"), m("avg_units"), m("count")],
        dimensions: [m("main_category")],
        segments: [m("store0")],
        order: [{ id: m("units"), desc: true }],
        filters: [
          { member: m("sold_location"), operator: "equals", values: ["store1"] },
          { or: [{ member: m("main_category"), operator: "set" }, { and: [{ member: m("sold_location"), operator: "notSet" }] }] },
        ],
      }),
    ]);
    assert.equal(routed(decision), "1day");
  });

  it("accepts a date range given as a filter on the time dimension", () => {
    const filtered = (values) => query({ filters: [{ member: m("timestamp"), operator: "inDateRange", values }] });
    assert.equal(routed(decideWith([filtered(["2026-02-01", "2026-02-28"])])), "1day");
    assert.equal(routed(decideWith([filtered(["2026-02-01T00:00:00.000", "2026-02-28T23:59:59.999"])])), "1day");
    assert.equal(
      routed(decideWith([query({ filters: [{ and: [{ member: m("timestamp"), operator: "inDateRange", values: ["2026-02-01", "2026-02-28"] }] }] })])),
      "1day",
    );
  });

  it("accepts a time dimension that is an ordinary grouping column, with any bucket and range", () => {
    const decision = decideWith([
      query({ timeDimensions: [{ dimension: m("sale_day"), granularity: "hour", dateRange: ["2026-11-19T10:15:00.000", "2026-11-20T09:00:00.000"] }] }),
    ]);
    assert.equal(routed(decision), "1day");
  });

  it("applies the window rule", () => {
    // ends before the coverage boundary, however short
    assert.equal(routed(decideWith([over("day", "2026-10-30", "2026-10-31")])), "1day");
    // reaches past it and is at least min_window (60 days) long
    assert.equal(routed(decideWith([over("day", "2026-09-22", "2026-11-20")])), "1day");
    assert.equal(routed(decideWith([over("month", "2025-12-01", "2026-11-30")])), "1day");
    // no time range at all
    assert.equal(routed(decideWith([query({ dimensions: [m("sold_location")], measures: [] })])), "1day");
    assert.equal(routed(decideWith([query({ timeDimensions: [{ dimension: m("timestamp"), granularity: "month" }] })])), "1day");
  });

  it("routes several queries of one request when one aggregate fits them all", () => {
    const decision = decideWith([over("day", "2026-01-01", "2026-01-07"), over("day", "2025-01-01", "2025-01-07")]);
    assert.equal(routed(decision), "1day");
  });

  it("uses an aggregate verified exactly max_staleness ago", () => {
    assert.equal(routed(decideWith([over("day", "2026-01-01", "2026-01-07")], [aggregate({ verifiedAt: NOW - DAY })])), "1day");
  });
});

describe("decide: requests that stay on the source", () => {
  const reason = (queries, aggregates, derivedPatch) => decideWith(queries, aggregates, derivedPatch).reason;
  const inside = (patch) => over("day", "2026-01-01", "2026-01-31", patch);

  it("has no catalog yet", () => {
    assert.deepEqual(decide([inside()], new Map(), null, () => NOW), {
      cube: null, aggregate: null, variantKey: null, coveredUntil: null, reason: "no_catalog",
    });
  });

  it("has no aggregate for the cube's source", () => {
    const decision = decide([inside()], new Map(), { aggregates: [], rejected: [] }, () => NOW);
    assert.deepEqual([decision.cube, decision.reason], ["line_items", "no_aggregate"]);
  });

  it("reads a cube that cannot be derived", () => {
    assert.equal(reason([inside()], undefined, { ineligible: "not_plain_read" }), "cube_not_eligible:not_plain_read");
  });

  it("asks for a bucket the grain cannot build", () => {
    assert.equal(reason([over("hour", "2026-01-01", "2026-01-31")]), "granularity");
    assert.equal(reason([over("minute", "2026-01-01", "2026-01-31")], [halfHour()]), "granularity");
    assert.equal(reason([over("hour", "2026-01-01", "2026-01-31")], [halfHour({ grainSeconds: 2700 })]), "granularity");
    assert.equal(reason([over("fiscal_week", "2026-01-01", "2026-01-31")]), "granularity");
  });

  it("has a range that does not start and end on a bucket boundary", () => {
    assert.equal(reason([over("day", "2026-01-01T12:00:00.000", "2026-01-31")]), "range_not_aligned");
    assert.equal(reason([over("day", "2026-01-01", "2026-01-31T11:59:59.999")]), "range_not_aligned");
    assert.equal(reason([over("day", "2026-01-01", "2026-01-31T23:59:59.000")]), "range_not_aligned");
    assert.equal(reason([query({ timeDimensions: [{ dimension: m("timestamp"), dateRange: "last 7 days" }] })]), "range_not_aligned");
    assert.equal(
      reason([query({ filters: [{ member: m("timestamp"), operator: "inDateRange", values: ["2026-01-01T06:00:00.000", "2026-01-31T23:59:59.999"] }] })]),
      "range_not_aligned",
    );
  });

  it("is not bucketed in UTC", () => {
    assert.equal(reason([inside({ timezone: "Atlantic/Reykjavik" })]), "timezone");
    assert.equal(reason([inside({ timezone: "America/New_York" })]), "timezone");
  });

  it("filters the time dimension with anything but a plain date range", () => {
    const filtered = (filter) => inside({ filters: [filter] });
    const time = m("timestamp");
    for (const filter of [
      { member: time, operator: "beforeDate", values: ["2026-01-15"] },
      { member: time, operator: "afterDate", values: ["2026-01-15"] },
      { member: time, operator: "notInDateRange", values: ["2026-01-10", "2026-01-12"] },
      { member: time, operator: "inDateRange", values: ["2026-01-10"] },
      { member: time, operator: "inDateRange", values: ["last week"] },
      { member: time, operator: "inDateRange", values: ["2026-01-10 00:00:00", "2026-01-12 23:59:59"] },
      { or: [{ member: time, operator: "inDateRange", values: ["2026-01-10", "2026-01-12"] }, { member: m("sold_location"), operator: "set" }] },
    ]) {
      assert.equal(reason([filtered(filter)]), "time_filter", JSON.stringify(filter));
    }
  });

  it("is a short window that reaches past what the aggregate holds", () => {
    // 22 September to 19 November is 59 days: one bucket short of min_window
    assert.equal(reason([over("day", "2026-09-22", "2026-11-19")]), "window_too_short");
    assert.equal(routed(decideWith([over("day", "2026-09-21", "2026-11-19")])), "1day"); // exactly min_window
    assert.equal(reason([over("day", "2026-11-14", "2026-11-20")]), "window_too_short");
    assert.equal(reason([over("day", "2026-10-25", "2026-11-01")]), "window_too_short"); // ends one bucket past the boundary
    assert.equal(
      reason([query({ filters: [{ member: m("timestamp"), operator: "inDateRange", values: ["2026-11-01", "2026-11-20"] }] })]),
      "window_too_short",
    );
  });

  it("has no refresh record, or one that is too old", () => {
    assert.equal(reason([inside()], [aggregate({ verifiedAt: null, coveredUntil: null })]), "not_verified");
    assert.equal(reason([query()], [aggregate({ verifiedAt: null, coveredUntil: null })]), "not_verified");
    assert.equal(reason([inside()], [aggregate({ verifiedAt: NOW - DAY - 1 })]), "stale");
  });

  it("reads more than one cube", () => {
    assert.equal(reason([inside({ dimensions: ["stores.city"] })]), "multi_cube");
    assert.equal(reason([inside({ filters: [{ member: "stores.city", operator: "set" }] })]), "multi_cube");
    assert.equal(reason([inside({ dimensions: ["line_items.stores.city"] })]), "multi_cube");
  });

  it("uses a query feature that is not supported", () => {
    assert.equal(reason([inside({ ungrouped: true })]), "unsupported_query");
    assert.equal(reason([inside({ subqueryJoins: [{ sql: "SELECT 1", on: "1 = 1", alias: "x" }] })]), "unsupported_query");
    assert.equal(reason([inside({ measures: [{ expression: ["sum(1)"], name: "x", cubeName: "line_items" }] })]), "unsupported_query");
    assert.equal(reason([inside({ maskedMembers: [m("units")] })]), "unsupported_query");
    assert.equal(reason([{ timezone: "UTC" }]), "unsupported_query");
  });

  it("asks for a member the aggregate cannot give, and says which and why", () => {
    assert.equal(reason([inside({ measures: [m("units"), m("transactions")] })]), "member_unavailable:line_items.transactions:column_not_in_aggregate");
    assert.equal(reason([inside({ dimensions: [m("big_line")] })]), "member_unavailable:line_items.big_line:not_grouping_column");
    assert.equal(
      reason([inside({ filters: [{ and: [{ member: m("transactions"), operator: "gt", values: ["1"] }] }] })]),
      "member_unavailable:line_items.transactions:column_not_in_aggregate",
    );
    assert.equal(reason([inside({ order: [{ id: m("big_line"), desc: false }] })]), "member_unavailable:line_items.big_line:not_grouping_column");
    assert.equal(reason([inside({ segments: [m("unknown")] })]), "member_unavailable:line_items.unknown:unsupported_member");
  });

  it("holds queries that do not all fit one aggregate", () => {
    assert.equal(reason([inside(), inside({ measures: [m("transactions")] })]), "request_mixed");
    assert.equal(reason([inside(), over("day", "2026-01-01", "2026-01-31", { measures: ["returns.count"] })]), "request_mixed");
    assert.equal(reason([inside(), inside({ ungrouped: true })]), "request_mixed");
    // every query fails for the same reason: that reason
    assert.equal(reason([over("hour", "2026-01-01", "2026-01-31"), over("hour", "2025-01-01", "2025-01-31")]), "granularity");
  });
});

describe("decide: the best available aggregate", () => {
  const both = [halfHour(), aggregate()];

  it("prefers the coarsest grain that qualifies", () => {
    assert.equal(routed(decideWith([over("day", "2026-01-01", "2026-01-31")], both)), "1day");
    assert.equal(routed(decideWith([over("month", "2026-01-01", "2026-03-31")], both)), "1day");
    assert.equal(routed(decideWith([over("hour", "2026-01-01", "2026-01-31")], both)), "30minute");
    assert.equal(routed(decideWith([over("minute", "2026-01-01", "2026-01-31")], both)), "granularity");
  });

  it("prefers fewer rows among equal grains", () => {
    const wide = aggregate({ table: "cst.sales_lines__agg_wide", totalRows: 90000 });
    const narrow = aggregate({ table: "cst.sales_lines__agg_narrow", totalRows: 300 });
    assert.equal(decideWith([over("day", "2026-01-01", "2026-01-31")], [wide, narrow]).aggregate, "cst.sales_lines__agg_narrow");
  });

  it("checks range boundaries against each grain", () => {
    const from1030 = over("hour", "2026-01-01T10:30:00.000", "2026-01-02T10:29:59.999");
    const from1015 = over(undefined, "2026-01-01T10:15:00.000", "2026-01-02T10:14:59.999");
    assert.equal(routed(decideWith([{ ...from1030, timeDimensions: [{ ...from1030.timeDimensions[0], granularity: undefined }] }], both)), "30minute");
    assert.equal(routed(decideWith([from1015], both)), "range_not_aligned");
    assert.equal(routed(decideWith([over(undefined, "2026-01-01T10:30:00.000", "2026-01-02T10:29:59.999")], [aggregate()])), "range_not_aligned");
  });

  it("uses one aggregate for every query of a request", () => {
    const decision = decideWith(
      [over("day", "2026-01-01", "2026-01-07"), over(undefined, "2025-01-01T10:30:00.000", "2025-01-08T10:29:59.999")],
      both,
    );
    assert.equal(routed(decision), "30minute");
  });

  it("skips an aggregate that is not verified when another one is", () => {
    const decision = decideWith([over("day", "2026-01-01", "2026-01-31")], [halfHour(), aggregate({ verifiedAt: null, coveredUntil: null })]);
    assert.equal(routed(decision), "30minute");
  });
});

describe("cubeOfRequest", () => {
  it("names the one cube a request reads", () => {
    assert.deepEqual(cubeOfRequest([query(), query({ dimensions: [m("sold_location")] })]), { cube: "line_items" });
    assert.equal(cubeOfRequest([query({ dimensions: ["stores.city"] })]).reason, "multi_cube");
    assert.equal(cubeOfRequest([query(), query({ measures: ["returns.count"] })]).reason, "request_mixed");
    assert.equal(cubeOfRequest([]).reason, "unsupported_query");
  });
});

describe("decide: speed", () => {
  it("decides in under 5 ms at the 95th percentile with a warm catalog (SC-005)", () => {
    // The first candidate's cube has about 150 members.
    const names = Array.from({ length: 150 }, (_, index) => `member_${index}`);
    const patch = { available: new Set([...AVAILABLE, ...names].map((name) => `line_items.${name}`)) };
    const request = [
      over("month", "2025-12-01", "2026-11-30", {
        measures: names.slice(0, 12).map(m),
        dimensions: names.slice(12, 18).map(m),
        filters: names.slice(18, 26).map((name) => ({ member: m(name), operator: "equals", values: ["x"] })),
      }),
    ];
    const aggregates = [halfHour(), aggregate()];
    const derived = new Map(aggregates.map((structure) => [structure.table, derivedFor(structure, patch)]));
    const entry = { aggregates, rejected: [] };
    const timings = [];
    for (let i = 0; i < 1000; i += 1) {
      const started = performance.now();
      const decision = decide(request, derived, entry, () => NOW);
      timings.push(performance.now() - started);
      assert.equal(decision.aggregate, "cst.sales_lines__agg_1day");
    }
    timings.sort((a, b) => a - b);
    assert.ok(timings[949] < 5, `95th percentile ${timings[949]} ms`);
  });
});
