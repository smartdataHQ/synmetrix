import { it } from "node:test";

// A renamed Cube export (1.8 turned the dist QueryType enum into
// QueryTypeEnum) fails at module link time and takes the whole server down.
it("every route links against the installed Cube packages", async () => {
  await import("../index.js");
});
