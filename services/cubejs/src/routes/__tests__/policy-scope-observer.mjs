import { createInterface } from "node:readline";
import { loadRules } from "../../utils/queryRewrite.js";

const target = process.argv[2];
if (!/^__spec127_scope_probe_[a-f0-9]{32}$/.test(target || "")) {
  throw new Error("An isolated spec127 probe target is required");
}

const input = createInterface({ input: process.stdin });
console.log(JSON.stringify({ state: "ready", pid: process.pid }));
for await (const command of input) {
  if (command === "stop") break;
  if (command !== "probe") throw new Error("Unknown probe command");
  try {
    const rules = await loadRules();
    console.log(
      JSON.stringify({
        state: "observed",
        matches: rules.filter((rule) => rule.cube_name === target).length,
      }),
    );
  } catch {
    console.log(JSON.stringify({ state: "authority-error" }));
  }
}
input.close();
