import { it } from "node:test";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const source = readFileSync(new URL("../utils/dataSourceHelpers.js", import.meta.url), "utf8");
for (const kind of ["WorkOS", "FraiOS"]) {
  it(`${kind} lookup failures release singleflight without unhandled rejections`, () => {
    const name = `provisionUserFrom${kind}`;
    const start = source.indexOf(`export async function ${name}(`);
    const end = source.indexOf(`async function _${name}(`, start);
    execFileSync(process.execPath, ["--input-type=module", "--eval", `
      import assert from 'node:assert/strict';
      const inflightProvisions = new Map();
      const getWorkosSubCacheEntry = () => null;
      let calls = 0;
      async function _${name}() {
        calls++;
        if (calls === 1) throw new Error('Authority unavailable');
        return 'user';
      }
      ${source.slice(start, end)}
      const payload = { sub: 'user', userId: 'user', email: 'user@example.test', partition: 'test' };
      const results = await Promise.allSettled([${name}(payload), ${name}(payload)]);
      assert.equal(calls, 1);
      assert.deepEqual(results.map(result => result.status), ['rejected', 'rejected']);
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(inflightProvisions.size, 0);
      assert.equal(await ${name}(payload), 'user');
      assert.equal(calls, 2);
      assert.equal(inflightProvisions.size, 0);
    `], { stdio: 'pipe' });
  });
}
