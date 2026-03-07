import { expect, test } from "@oclif/test";

describe("dev:status", () => {
  test
    .stderr()
    .stdout()
    .command(["dev:status"])
    .it("runs dev:status and shows table output", (ctx) => {
      expect(ctx.stdout).to.include("Service");
      expect(ctx.stdout).to.include("client-v2");
    });
});
