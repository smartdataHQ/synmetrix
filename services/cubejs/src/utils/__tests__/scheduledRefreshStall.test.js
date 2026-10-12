import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";

describe("scheduled refresh stall detection", () => {
  it("reports a stall once no interval has started for 30 minutes", async () => {
    mock.timers.enable({ apis: ["Date"], now: 0 });
    // The interval's datasource lookup hangs, as it did on dev.
    mock.module("../dataSourceHelpers.js", {
      namedExports: { getDataSources: () => new Promise(() => {}) },
    });
    const { default: scheduledRefreshContexts, scheduledRefreshStalledFor } =
      await import("../scheduledRefreshContexts.js");

    mock.timers.tick(29 * 60 * 1000);
    assert.equal(scheduledRefreshStalledFor(), 0);

    mock.timers.tick(2 * 60 * 1000);
    assert.equal(scheduledRefreshStalledFor(), 31 * 60 * 1000);

    scheduledRefreshContexts();
    assert.equal(scheduledRefreshStalledFor(), 0);

    mock.timers.tick(31 * 60 * 1000);
    assert.equal(scheduledRefreshStalledFor(), 31 * 60 * 1000);
  });
});
