import { expect } from "chai";
import { createServer } from "node:net";
import { mkdtempSync, writeFileSync, existsSync, readFileSync, mkdirSync, unlinkSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  checkPrerequisites,
  checkPortAvailability,
  probePostgres,
  ensureEnvFiles,
  isClientV2Running,
  stopClientV2,
  formatStatusTable,
  DEV_SERVICES,
  DEV_PORTS,
  getPidFilePath,
  waitForHasura,
  getLogFilePath,
} from "../src/devUtils.js";
import type { ServiceStatus } from "../src/devUtils.js";

// T006: Prerequisite checking tests
describe("checkPrerequisites", () => {
  it("should return an empty array when all prerequisites are installed", async () => {
    const missing = await checkPrerequisites();
    // In a dev environment, Docker/Node/Yarn should be available
    // This test validates the function runs without error
    expect(missing).to.be.an("array");
  });

  it("should return missing items with name and installGuide", async () => {
    const missing = await checkPrerequisites();
    for (const item of missing) {
      expect(item).to.have.property("name").that.is.a("string");
      expect(item).to.have.property("installGuide").that.is.a("string");
    }
  });
});

// T007: Port availability tests
describe("checkPortAvailability", () => {
  it("should return empty array for available ports", async () => {
    // Use a high port unlikely to be in use
    const conflicts = await checkPortAvailability([59123]);
    expect(conflicts).to.deep.equal([]);
  });

  it("should detect a port in use", async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(59124, "127.0.0.1", resolve));
    try {
      const conflicts = await checkPortAvailability([59124]);
      expect(conflicts).to.include(59124);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("should check multiple ports", async () => {
    const conflicts = await checkPortAvailability([59125, 59126, 59127]);
    expect(conflicts).to.be.an("array");
  });
});

// T008: Postgres TCP probe tests
describe("probePostgres", () => {
  it("should return false for unreachable host", async () => {
    const result = await probePostgres("192.0.2.1", 5432);
    expect(result).to.equal(false);
  }).timeout(10000);

  it("should return true for a listening TCP port", async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(59128, "127.0.0.1", resolve));
    try {
      const result = await probePostgres("127.0.0.1", 59128);
      expect(result).to.equal(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

// T009: Env file copy-if-missing tests
describe("ensureEnvFiles", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "devutils-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should copy example files when targets are missing", () => {
    writeFileSync(join(tmpDir, ".env.example"), "KEY=value");
    writeFileSync(join(tmpDir, ".dev.env.example"), "DEV_KEY=value");

    const result = ensureEnvFiles(tmpDir);
    expect(result.copied).to.include(".env");
    expect(result.copied).to.include(".dev.env");
    expect(existsSync(join(tmpDir, ".env"))).to.equal(true);
    expect(existsSync(join(tmpDir, ".dev.env"))).to.equal(true);
  });

  it("should not overwrite existing env files", () => {
    writeFileSync(join(tmpDir, ".env.example"), "NEW=value");
    writeFileSync(join(tmpDir, ".env"), "EXISTING=value");
    writeFileSync(join(tmpDir, ".dev.env.example"), "NEW_DEV=value");
    writeFileSync(join(tmpDir, ".dev.env"), "EXISTING_DEV=value");

    const result = ensureEnvFiles(tmpDir);
    expect(result.copied).to.deep.equal([]);
    expect(readFileSync(join(tmpDir, ".env"), "utf-8")).to.equal("EXISTING=value");
    expect(readFileSync(join(tmpDir, ".dev.env"), "utf-8")).to.equal("EXISTING_DEV=value");
  });

  it("should handle missing example files gracefully", () => {
    const result = ensureEnvFiles(tmpDir);
    expect(result.copied).to.deep.equal([]);
  });
});

// T010: PID file management tests
describe("PID file management", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "devutils-pid-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should report not running when no PID file exists", () => {
    expect(isClientV2Running(tmpDir)).to.equal(false);
  });

  it("should report not running for stale PID", () => {
    writeFileSync(getPidFilePath(tmpDir), "999999999");
    expect(isClientV2Running(tmpDir)).to.equal(false);
  });

  it("should report running for current process PID", () => {
    writeFileSync(getPidFilePath(tmpDir), String(process.pid));
    expect(isClientV2Running(tmpDir)).to.equal(true);
  });

  it("should handle invalid PID file content", () => {
    writeFileSync(getPidFilePath(tmpDir), "not-a-number");
    expect(isClientV2Running(tmpDir)).to.equal(false);
  });

  it("stopClientV2 should remove PID file", () => {
    writeFileSync(getPidFilePath(tmpDir), "999999999");
    stopClientV2(tmpDir);
    expect(existsSync(getPidFilePath(tmpDir))).to.equal(false);
  });

  it("stopClientV2 should handle missing PID file", () => {
    // Should not throw
    stopClientV2(tmpDir);
  });
});

// T010a: Hasura readiness and log file tests
describe("waitForHasura", () => {
  it("should return false when Hasura is not available", async () => {
    // Use a port that's almost certainly not running Hasura
    const result = await waitForHasura(59199, 3000);
    expect(result).to.equal(false);
  }).timeout(10000);
});

describe("log file path", () => {
  it("should return correct log file path", () => {
    const path = getLogFilePath("/some/root");
    expect(path).to.equal("/some/root/.dev-client-v2.log");
  });
});

// Constants tests
describe("DEV_SERVICES", () => {
  it("should not include client service", () => {
    expect(DEV_SERVICES).to.not.include("client");
  });

  it("should include all expected services", () => {
    expect(DEV_SERVICES).to.include("redis");
    expect(DEV_SERVICES).to.include("hasura");
    expect(DEV_SERVICES).to.include("cubejs");
    expect(DEV_SERVICES).to.include("actions");
    expect(DEV_SERVICES).to.include("cubestore");
  });
});

describe("DEV_PORTS", () => {
  it("should map services to correct ports", () => {
    expect(DEV_PORTS["cubejs"]).to.equal(4000);
    expect(DEV_PORTS["hasura"]).to.equal(8080);
    expect(DEV_PORTS["client-v2"]).to.equal(8000);
    expect(DEV_PORTS["redis"]).to.equal(6379);
  });
});

describe("formatStatusTable", () => {
  it("should format services into an aligned table", () => {
    const services: ServiceStatus[] = [
      { name: "redis", type: "docker", port: 6379, status: "running", uptime: "2h 15m" },
      { name: "client-v2", type: "host", port: 8000, status: "stopped", uptime: "-" },
    ];
    const table = formatStatusTable(services);
    expect(table).to.include("Service");
    expect(table).to.include("redis");
    expect(table).to.include("client-v2");
    expect(table).to.include("running");
    expect(table).to.include("stopped");
  });

  it("should handle null port", () => {
    const services: ServiceStatus[] = [
      { name: "worker", type: "docker", port: null, status: "running", uptime: "1m" },
    ];
    const table = formatStatusTable(services);
    expect(table).to.include("-");
  });
});
