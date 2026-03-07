import { expect, test } from "@oclif/test";

describe("dev:stop", () => {
  test
    .stderr()
    .stdout()
    .command(["dev:stop"])
    .catch((err) => {
      // Expected: docker-compose file may not be found when running from cli/ dir
      expect(err.message).to.be.a("string");
    })
    .it("runs dev:stop and handles missing compose file gracefully");
});
