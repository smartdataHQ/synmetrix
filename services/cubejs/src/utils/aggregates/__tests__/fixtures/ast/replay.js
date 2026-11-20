/**
 * Lets unit tests use ClickHouse's real parse trees without a database.
 * Statements are answered from recorded.json. To record new ones, start the
 * disposable ClickHouse (test/aggregates/docker-compose.clickhouse.yml) and
 * run the tests once with AGGREGATES_RECORD=1.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const file = new URL("./recorded.json", import.meta.url);
const recorded = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
const url = process.env.AGGREGATES_TEST_CLICKHOUSE_URL || "http://127.0.0.1:18124/?user=test&password=test";

export async function replay(sql) {
  const key = createHash("md5").update(sql).digest("hex");
  if (!recorded[key]) {
    if (process.env.AGGREGATES_RECORD !== "1") {
      throw new Error(`no recorded parse tree for this statement; run once with AGGREGATES_RECORD=1\n${sql}`);
    }
    const response = await fetch(`${url}&default_format=JSON`, { method: "POST", body: sql });
    if (!response.ok) throw new Error(await response.text());
    recorded[key] = (await response.json()).data.map((row) => row.explain);
    writeFileSync(file, `${JSON.stringify(recorded, null, 1)}\n`);
  }
  return recorded[key].map((explain) => ({ explain }));
}
