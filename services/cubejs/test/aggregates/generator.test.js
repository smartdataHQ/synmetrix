/**
 * SC-007: an aggregate generated for any time-series table answers like its
 * source. For three tables of different shape: generate, apply, fill in two
 * inserts, and compare every stored metric before and after the database
 * merges the parts. Needs the disposable ClickHouse.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";

import { fillSelect, quote } from "../../src/utils/aggregates/contract.js";
import { generate } from "../../src/utils/aggregates/generator.js";
import * as h from "./harness.js";

const COMMON = { timeColumn: "timestamp", minAge: "0 second", minWindow: "60 day", maxStaleness: "1 day" };
const TABLES = [
  { ...COMMON, source: "gen_test.retail_lines", grain: "1 day", coarse: "1 month", groupBy: ["partition", "store", "category", "product_id", "uom", "bundled_units", "unit_price", "tax_rate"] },
  { ...COMMON, source: "gen_test.series_points", grain: "30 minute", coarse: "1 day", groupBy: ["partition", "period", "access", "unit"] },
  { ...COMMON, source: "gen_test.wide_events", grain: "1 hour", coarse: "1 day", groupBy: ["partition", "type", "event", "country", "is_bot"] },
];
const ROWS = 20000;

const unwrapped = (type) => type.replace(/^(?:LowCardinality|Nullable)\((.*)\)$/s, "$1").replace(/^(?:LowCardinality|Nullable)\((.*)\)$/s, "$1");

/**
 * A deterministic value of the column's type for row `number`; null for types
 * the tests do not need. Grouping columns all follow one of twelve "products",
 * so that many source rows fall into each aggregate row.
 */
function valueOf({ name, type }, index, { timeColumn, groupBy }) {
  const inner = unwrapped(type);
  const n = groupBy.includes(name) ? "(number % 12)" : "number";
  let value;
  if (name === timeColumn) value = `toDateTime64('2026-01-30 00:00:00', 3, 'UTC') + toIntervalSecond(number * 17)`;
  else if (name === "partition") value = `['t1', 't2'][1 + intDiv(number, 7) % 2]`;
  else if (/^(String|FixedString)/.test(inner)) value = `concat('v', toString(intDiv(${n}, ${1 + (index % 2)}) % ${3 + (index % 3)}))`;
  else if (/^Enum/.test(inner)) value = `['Local', 'Group', 'Shared'][1 + ${n} % 3]`;
  else if (inner === "Bool") value = `${n} % ${2 + (index % 2)} = 0`;
  else if (/^(Float|Decimal)/.test(inner)) value = `(${n} % ${5 + (index % 5)}) * 0.5`;
  else if (/^U?Int/.test(inner)) value = `${n} % ${7 + (index % 4)}`;
  else if (/^Map\((LowCardinality\(String\)|String), (U?Int|Float)/.test(type)) {
    value = `if(number % 3 = 0, map('a', number % 5), map('a', number % 5, 'b', number % 2))`;
  } else return null;
  if (/Nullable\(/.test(type)) value = `if(${n} % 7 = ${index % 7}, NULL, ${value})`;
  // the insert converts to LowCardinality itself; casting to it needs a setting for numeric types
  return `CAST(${value} AS ${type.replace(/^LowCardinality\((.*)\)$/s, "$1")})`;
}

async function populate({ source, timeColumn, groupBy }) {
  const [database, table] = source.split(".");
  const columns = await h.run(
    `SELECT name, type FROM system.columns WHERE database = '${database}' AND table = '${table}' AND default_kind NOT IN ('ALIAS', 'MATERIALIZED') ORDER BY position`,
  );
  const filled = columns.map((column, index) => [column.name, valueOf(column, index, { timeColumn, groupBy })]).filter(([, value]) => value);
  await h.run(
    `INSERT INTO ${source} (${filled.map(([name]) => quote(name)).join(", ")}) SELECT ${filled.map(([, value]) => value).join(", ")} FROM numbers(${ROWS})`,
  );
}

/** The same question for the source and for the aggregate: every stored metric at a coarser grouping. */
function comparison(structure, coarse) {
  const roles = [...structure.columns];
  const groups = roles.filter(([, column]) => column.role === "group").map(([name]) => name).slice(0, 2);
  const bucket = `toStartOfInterval(${quote(structure.timeColumn)}, INTERVAL ${coarse}, 'UTC')`;
  const keys = [...groups.map(quote), `${bucket} AS bucket`];
  const source = [...keys];
  const aggregate = [...keys];
  roles.forEach(([name, column], index) => {
    const c = quote(name);
    if (column.role === "sum") {
      source.push(`sum(${c}) AS s${index}`, `avg(${c}) AS a${index}`, `min(${c}) AS n${index}`, `max(${c}) AS x${index}`, `count(${c}) AS c${index}`);
      aggregate.push(
        `sum(${c}) AS s${index}`,
        `toFloat64(sum(${c})) / nullIf(sum(${quote(`${name}__count`)}), 0) AS a${index}`,
        `min(${quote(`${name}__min`)}) AS n${index}`,
        `max(${quote(`${name}__max`)}) AS x${index}`,
        `sum(${quote(`${name}__count`)}) AS c${index}`,
      );
    } else if (column.role === "sumMap") {
      for (const key of ["a", "b"]) {
        source.push(`sum(${c}['${key}']) AS m${index}${key}`, `avg(${c}['${key}']) AS v${index}${key}`);
        aggregate.push(`sum(${c}['${key}']) AS m${index}${key}`, `toFloat64(sum(${c}['${key}'])) / nullIf(sum(_rows), 0) AS v${index}${key}`);
      }
    }
  });
  source.push("count() AS total");
  aggregate.push("sum(_rows) AS total");
  const groupBy = `GROUP BY ${[...groups.map(quote), "bucket"].join(", ")}`;
  return {
    source: `SELECT ${source.join(", ")} FROM ${structure.source} ${groupBy}`,
    aggregate: `SELECT ${aggregate.join(", ")} FROM ${structure.table} ${groupBy}`,
  };
}

before(async () => {
  await h.loadFixture("generator_sources");
});

after(async () => {
  await h.close();
});

for (const { coarse, ...options } of TABLES) {
  describe(`an aggregate generated for ${options.source}`, () => {
    let structure;
    let questions;
    let rowsBeforeMerge;

    it("is created from the printed definition and accepted by the catalog, with no unusable column", async () => {
      await populate(options);
      const result = await generate(h.run, options);
      assert.equal(result.declined, undefined);
      await h.run(result.definition.replace(/;$/, ""));

      structure = await h.structureOf(result.table);
      const roles = [...structure.columns.values()].map((column) => column.role);
      assert.ok(!roles.includes("unusable"), JSON.stringify([...structure.columns].filter(([, column]) => column.role === "unusable")));
      assert.ok(roles.includes("sum") || roles.includes("sumMap"));
      assert.equal(structure.grain, options.grain);
      questions = comparison(structure, coarse);
    });

    it("equals the source on every stored metric after being filled in two inserts", async () => {
      const partitions = await h.sourcePartitions(structure);
      assert.ok(partitions.length >= 2);
      for (const { partition_id: id } of partitions) {
        const fill = fillSelect(structure, id);
        for (const half of [0, 1]) {
          const sql = fill.sql.replace(
            `WHERE src._partition_id = '${id}'`,
            `WHERE src._partition_id = '${id}' AND cityHash64(src.${quote(structure.timeColumn)}) % 2 = ${half}`,
          );
          await h.run(`INSERT INTO ${structure.table} (${fill.columns.map(quote).join(", ")}) ${sql}`);
        }
      }
      const [{ parts }] = await h.run(
        `SELECT count() AS parts FROM system.parts WHERE database = '${structure.database}' AND table = '${structure.name}' AND active`,
      );
      assert.ok(Number(parts) >= 2 * partitions.length - 1, `${parts} parts`);

      const [expected, actual] = [await h.run(questions.source), await h.run(questions.aggregate)];
      assert.ok(expected.length > 10);
      h.assertSameRows(actual, expected, { label: `${options.source} before merging` });

      const [{ sourceRows, aggregateRows }] = await h.run(
        `SELECT (SELECT count() FROM ${structure.source}) AS sourceRows, (SELECT count() FROM ${structure.table}) AS aggregateRows`,
      );
      assert.equal(Number(sourceRows), ROWS);
      assert.ok(Number(aggregateRows) < ROWS, `${aggregateRows} aggregate rows for ${ROWS} source rows`);
      rowsBeforeMerge = Number(aggregateRows);
    });

    it("still equals the source after the database merged the parts", async () => {
      await h.run(`OPTIMIZE TABLE ${structure.table} FINAL`);
      const [expected, actual] = [await h.run(questions.source), await h.run(questions.aggregate)];
      h.assertSameRows(actual, expected, { label: `${options.source} after merging` });
      // the two halves of every bucket were combined: far fewer rows than the source has
      const [{ merged }] = await h.run(`SELECT count() AS merged FROM ${structure.table}`);
      assert.ok(Number(merged) < rowsBeforeMerge && Number(merged) < ROWS / 3, `${merged} rows after merging, ${rowsBeforeMerge} before`);
    });
  });
}
