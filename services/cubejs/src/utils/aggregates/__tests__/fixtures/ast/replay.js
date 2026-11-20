/**
 * Lets unit tests use ClickHouse's real answers without a database: parse
 * trees for expressions, and table descriptions for the generator. Statements
 * are answered from recorded.json. To record new ones, start the disposable
 * ClickHouse (test/aggregates/docker-compose.clickhouse.yml) and run the
 * tests once with AGGREGATES_RECORD=1.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const file = new URL("./recorded.json", import.meta.url);
const recorded = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
const url = process.env.AGGREGATES_TEST_CLICKHOUSE_URL || "http://127.0.0.1:18124/?user=test&password=test";
export const recording = process.env.AGGREGATES_RECORD === "1";

async function post(sql, format) {
  const response = await fetch(`${url}${format ? `&default_format=${format}` : ""}`, { method: "POST", body: sql });
  if (!response.ok) throw new Error(await response.text());
  return response;
}

/** Answers a read from the recording: rows as objects. */
export async function replay(sql) {
  const key = createHash("md5").update(sql).digest("hex");
  if (!recorded[key]) {
    if (!recording) {
      throw new Error(`no recorded answer for this statement; run once with AGGREGATES_RECORD=1\n${sql}`);
    }
    const rows = (await (await post(sql, "JSON")).json()).data;
    // a parse tree is kept as its lines; anything else as rows
    recorded[key] = rows.every((row) => Object.keys(row).join() === "explain") ? rows.map((row) => row.explain) : rows;
    writeFileSync(file, `${JSON.stringify(recorded, null, 1)}\n`);
  }
  return recorded[key].map((row) => (typeof row === "string" ? { explain: row } : row));
}

/** While recording, runs the statements of an engine-test fixture so that the tables exist. */
export async function prepare(fixture) {
  if (!recording) return;
  const text = readFileSync(new URL(`../../../../../../test/aggregates/fixtures/${fixture}.sql`, import.meta.url), "utf8");
  const statements = text.split(/;\s*\n/).map((statement) => statement.replace(/^\s*--.*$/gm, "").trim()).filter(Boolean);
  for (const statement of statements) await post(statement);
}
