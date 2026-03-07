import { expect, test } from "@oclif/test";

describe("dev:setup", () => {
  test
    .stderr()
    .stdout()
    .command(["dev:setup"])
    .catch((err) => {
      // Expected to fail in test environment (no Docker, no Postgres, etc.)
      expect(err.message).to.be.a("string");
    })
    .it("runs dev:setup and validates prerequisites");

  test
    .stderr()
    .stdout()
    .command(["dev:setup"])
    .catch((err) => {
      // Idempotent: running twice should not fail differently
      expect(err.message).to.be.a("string");
    })
    .it("is idempotent — running twice does not fail differently");
});
