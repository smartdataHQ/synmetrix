import { expect, test } from "@oclif/test";

describe("dev:logs", () => {
  test
    .stderr()
    .stdout()
    .command(["dev:logs", "client-v2"])
    .it("handles client-v2 logs when not running", (ctx) => {
      expect(ctx.stdout).to.include("not found");
    });
});
