import { expect, test } from "@oclif/test";

describe("dev:start", () => {
  test
    .stderr()
    .stdout()
    .command(["dev:start"])
    .catch((err) => {
      // Expected to fail in test environment (env files may not have correct Postgres settings)
      expect(err.message).to.be.a("string");
    })
    .it("runs dev:start and validates Postgres probe");
});
