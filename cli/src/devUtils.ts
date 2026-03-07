import { $ } from "zx";
import { createServer, Socket } from "node:net";
import { copyFileSync, existsSync, readFileSync, writeFileSync, unlinkSync, openSync, closeSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import type { CustomContext } from "./BaseCommand.js";

// T019: Docker Compose services to start (excludes `client` per FR-015)
export const DEV_SERVICES = [
  "redis",
  "actions",
  "cubejs",
  "cubejs_refresh_worker",
  "hasura",
  "hasura_cli",
  "hasura_plus",
  "minio",
  "mailhog",
  "cubestore",
] as const;

// T020: Port map for conflict checking
export const DEV_PORTS: Record<string, number> = {
  cubejs: 4000,
  "client-v2": 8000,
  hasura: 8080,
  hasura_plus: 8081,
  cubestore: 3030,
  redis: 6379,
  mailhog: 8025,
  minio: 9000,
  minio_console: 9001,
  hasura_cli: 9695,
};

export interface ServiceStatus {
  name: string;
  type: "docker" | "host";
  port: number | null;
  status: "running" | "stopped" | "unhealthy" | "not started";
  uptime: string;
}

interface Prerequisite {
  name: string;
  command: string;
  installGuide: string;
}

const PREREQUISITES: Prerequisite[] = [
  { name: "Docker", command: "docker --version", installGuide: "Install from https://docker.com" },
  { name: "Docker Compose", command: "docker compose version", installGuide: "Included with Docker Desktop, or install docker-compose-plugin" },
  { name: "Node.js", command: "node --version", installGuide: "Install from https://nodejs.org (v18+)" },
  { name: "Yarn", command: "yarn --version", installGuide: "Run: npm install -g yarn" },
  { name: "Bun", command: "bun --version", installGuide: "Install from https://bun.sh" },
];

async function quietExec(pieces: TemplateStringsArray, ...args: any[]) {
  const prev = $.verbose;
  $.verbose = false;
  try {
    return await $(pieces, ...args);
  } finally {
    $.verbose = prev;
  }
}

// T011: Validate prerequisites
export async function checkPrerequisites(): Promise<{ name: string; installGuide: string }[]> {
  const missing: { name: string; installGuide: string }[] = [];
  for (const prereq of PREREQUISITES) {
    try {
      const parts = prereq.command.split(" ");
      const prev = $.verbose;
      $.verbose = false;
      try {
        await $`${parts}`;
      } finally {
        $.verbose = prev;
      }
    } catch {
      missing.push({ name: prereq.name, installGuide: prereq.installGuide });
    }
  }
  return missing;
}

// T012: Check port availability
export async function checkPortAvailability(ports: number[]): Promise<number[]> {
  const conflicting: number[] = [];
  for (const port of ports) {
    const inUse = await isPortInUse(port);
    if (inUse) {
      conflicting.push(port);
    }
  }
  return conflicting;
}

function isPortInUse(port: number): Promise<boolean> {
  return new Promise((res) => {
    const server = createServer();
    server.once("error", () => {
      res(true);
    });
    server.once("listening", () => {
      server.close(() => {
        // Also check 0.0.0.0 since Docker binds on all interfaces
        const server2 = createServer();
        server2.once("error", () => res(true));
        server2.once("listening", () => server2.close(() => res(false)));
        server2.listen(port, "0.0.0.0");
      });
    });
    server.listen(port, "127.0.0.1");
  });
}

// T013: Postgres TCP connectivity probe
export async function probePostgres(host: string, port: number): Promise<boolean> {
  return new Promise((res) => {
    const socket = new Socket();
    const timeout = 5000;
    socket.setTimeout(timeout);
    socket.once("connect", () => {
      socket.destroy();
      res(true);
    });
    socket.once("error", () => {
      socket.destroy();
      res(false);
    });
    socket.once("timeout", () => {
      socket.destroy();
      res(false);
    });
    socket.connect(port, host);
  });
}

// T014: Env file copy-if-missing
export function ensureEnvFiles(rootDir: string): { copied: string[] } {
  const mappings = [
    { example: ".env.example", target: ".env" },
    { example: ".dev.env.example", target: ".dev.env" },
  ];
  const copied: string[] = [];
  for (const { example, target } of mappings) {
    const examplePath = join(rootDir, example);
    const targetPath = join(rootDir, target);
    if (!existsSync(targetPath) && existsSync(examplePath)) {
      copyFileSync(examplePath, targetPath);
      copied.push(target);
    }
  }
  return { copied };
}

// T015: Clean stale containers
export async function cleanStaleContainers(ctx: CustomContext): Promise<void> {
  if (!ctx.dockerComposeFile) return;
  try {
    const prev = $.verbose;
    $.verbose = false;
    try {
      const result = await $`docker compose -f ${ctx.dockerComposeFile} ps -a --status=exited --status=created --format ${"{{.Name}}"}`;
      const names = result.stdout.trim().split("\n").filter(Boolean);
      if (names.length > 0) {
        await $`docker rm -f ${names}`.nothrow();
      }
    } finally {
      $.verbose = prev;
    }
  } catch {
    // No stale containers or compose not available — safe to continue
  }
}

// T016: Client-v2 process management
export function getClientV2Dir(rootDir: string): string {
  return resolve(rootDir, "../client-v2");
}

export function getPidFilePath(rootDir: string): string {
  return join(rootDir, ".dev-client-v2.pid");
}

export function getLogFilePath(rootDir: string): string {
  return join(rootDir, ".dev-client-v2.log");
}

export function isClientV2Running(rootDir: string): boolean {
  const pidFile = getPidFilePath(rootDir);
  if (!existsSync(pidFile)) return false;
  try {
    const pid = parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
    if (isNaN(pid)) return false;
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function startClientV2(rootDir: string): number {
  const clientDir = getClientV2Dir(rootDir);
  const logPath = getLogFilePath(rootDir);
  const pidFile = getPidFilePath(rootDir);

  if (isClientV2Running(rootDir)) {
    const pid = parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
    return pid;
  }

  // Clean stale PID file
  if (existsSync(pidFile)) {
    unlinkSync(pidFile);
  }

  const logFd = openSync(logPath, "a");
  const child = spawn("bun", ["run", "dev"], {
    cwd: clientDir,
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });

  child.unref();
  closeSync(logFd);

  if (child.pid) {
    writeFileSync(pidFile, String(child.pid), "utf-8");
  }

  return child.pid ?? 0;
}

export function stopClientV2(rootDir: string): void {
  const pidFile = getPidFilePath(rootDir);
  if (!existsSync(pidFile)) return;
  try {
    const pid = parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
    if (!isNaN(pid)) {
      process.kill(pid, "SIGTERM");
    }
  } catch {
    // Process already gone
  }
  try {
    unlinkSync(pidFile);
  } catch {
    // File already removed
  }
}

export async function installClientV2Deps(rootDir: string): Promise<void> {
  const clientDir = getClientV2Dir(rootDir);
  const nodeModules = join(clientDir, "node_modules");
  if (!existsSync(nodeModules)) {
    await $`cd ${clientDir} && bun install`;
  }
}

// T017: Get service status
export async function getServiceStatus(ctx: CustomContext, rootDir: string): Promise<ServiceStatus[]> {
  const statuses: ServiceStatus[] = [];

  // Docker services
  if (ctx.dockerComposeFile) {
    try {
      const prev = $.verbose;
      $.verbose = false;
      let result;
      try {
        result = await $`docker compose -f ${ctx.dockerComposeFile} ps --format json`;
      } finally {
        $.verbose = prev;
      }
      const lines = result.stdout.trim().split("\n").filter(Boolean);
      for (const line of lines) {
        try {
          const container = JSON.parse(line);
          const name = container.Service || container.Name || "unknown";
          const state = (container.State || "stopped").toLowerCase();
          const portNum = DEV_PORTS[name] ?? null;
          const status: ServiceStatus["status"] = state === "running" ? "running" : state === "exited" ? "stopped" : "unhealthy";
          const uptime = container.Status || "-";
          statuses.push({ name, type: "docker", port: portNum, status, uptime });
        } catch {
          // Skip unparseable lines
        }
      }
    } catch {
      // Docker compose not available or no containers
    }
  }

  // Client-v2
  const clientStatus: ServiceStatus = {
    name: "client-v2",
    type: "host",
    port: 8000,
    status: "not started",
    uptime: "-",
  };

  if (isClientV2Running(rootDir)) {
    clientStatus.status = "running";
    const pidFile = getPidFilePath(rootDir);
    try {
      const { mtimeMs } = statSync(pidFile);
      const elapsed = Date.now() - mtimeMs;
      clientStatus.uptime = formatUptime(elapsed);
    } catch {
      clientStatus.uptime = "unknown";
    }
  }

  statuses.push(clientStatus);
  return statuses;
}

function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

// T018: Format status table
export function formatStatusTable(services: ServiceStatus[]): string {
  const header = ["Service", "Type", "Port", "Status", "Uptime"];
  const rows = services.map((s) => [
    s.name,
    s.type,
    s.port !== null ? String(s.port) : "-",
    s.status,
    s.uptime,
  ]);

  // Calculate column widths
  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => r[i].length))
  );

  const pad = (s: string, w: number) => s.padEnd(w);
  const line = widths.map((w) => "─".repeat(w)).join("──");
  const formatRow = (row: string[]) =>
    row.map((cell, i) => pad(cell, widths[i])).join("  ");

  return [formatRow(header), line, ...rows.map(formatRow)].join("\n");
}

// T018a: Wait for Hasura readiness
export async function waitForHasura(port: number, timeoutMs: number = 60000): Promise<boolean> {
  const start = Date.now();
  const url = `http://localhost:${port}/healthz`;
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return true;
    } catch {
      // Not ready yet
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}
