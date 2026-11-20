// Regenerates batch.txt from cases.json on the disposable ClickHouse
// (test/aggregates/docker-compose.clickhouse.yml). Run after a ClickHouse
// upgrade: node src/utils/aggregates/__tests__/fixtures/ast/capture.mjs
import { readFileSync, writeFileSync } from "node:fs";

const here = new URL(".", import.meta.url);
const cases = JSON.parse(readFileSync(new URL("cases.json", here), "utf8"));
const url = process.env.AGGREGATES_TEST_CLICKHOUSE_URL || "http://127.0.0.1:18124/?user=test&password=test";
const sql = `EXPLAIN AST SELECT ${cases.map(([, expression]) => `tuple(${expression})`).join(", ")}`;
const response = await fetch(`${url}&default_format=JSON`, { method: "POST", body: sql });
if (!response.ok) throw new Error(await response.text());
const { data } = await response.json();
writeFileSync(new URL("batch.txt", here), `${data.map((row) => row.explain).join("\n")}\n`);
console.log(`${cases.length} cases, ${data.length} lines`);
