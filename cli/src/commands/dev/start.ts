import { $, echo, chalk } from "zx";
import { existsSync } from "node:fs";
import BaseCommand from "../../BaseCommand.js";
import { callCompose, PROJECT_DIR } from "../../utils.js";
import {
  checkPortAvailability,
  probePostgres,
  startClientV2,
  isClientV2Running,
  getServiceStatus,
  formatStatusTable,
  getClientV2Dir,
  DEV_SERVICES,
  DEV_PORTS,
} from "../../devUtils.js";

export default class DevStart extends BaseCommand {
  static description = "Start the development environment";

  static flags = {
    ...BaseCommand.flags,
  };

  public async run(): Promise<void> {
    const { flags } = await this.parse(DevStart);
    const ctx = this.context;
    const networkName = flags.networkName;

    // 1. Probe Postgres
    echo(chalk.blue("Probing PostgreSQL..."));
    const pgHost = process.env.POSTGRES_HOST || "localhost";
    const pgPort = parseInt(process.env.POSTGRES_PORT || "5432", 10);
    const pgReachable = await probePostgres(pgHost, pgPort);
    if (!pgReachable) {
      echo(chalk.red(`PostgreSQL is not reachable at ${pgHost}:${pgPort}`));
      this.exit(2);
    }
    echo(chalk.green(`PostgreSQL reachable at ${pgHost}:${pgPort}`));

    // 2. Check port availability (skip ports of already-running services)
    echo(chalk.blue("Checking port availability..."));
    const allPorts = Object.values(DEV_PORTS);
    const conflicting = await checkPortAvailability(allPorts);
    if (conflicting.length > 0) {
      // Get currently running services to exclude their ports
      const currentStatus = await getServiceStatus(ctx, PROJECT_DIR);
      const runningPorts = new Set(
        currentStatus
          .filter((s) => s.status === "running" && s.port !== null)
          .map((s) => s.port!)
      );
      const realConflicts = conflicting.filter((p) => !runningPorts.has(p));
      if (realConflicts.length > 0) {
        echo(chalk.red(`Ports already in use: ${realConflicts.join(", ")}`));
        this.exit(3);
      }
    }
    echo(chalk.green("Ports OK."));

    // 3. Create Docker network
    await $`docker network create --attachable ${networkName}`.nothrow();

    // 4. Start Docker Compose services
    echo(chalk.blue("Starting Docker Compose services..."));
    await callCompose(ctx, ["up", "-d", ...DEV_SERVICES]);

    // 5. Check client-v2 directory
    const clientDir = getClientV2Dir(PROJECT_DIR);
    if (!existsSync(clientDir)) {
      echo(chalk.red(`client-v2 directory not found at ${clientDir}`));
      this.exit(4);
    }

    // 6. Start client-v2 (skip if already running)
    if (isClientV2Running(PROJECT_DIR)) {
      echo(chalk.yellow("client-v2 is already running, skipping."));
    } else {
      echo(chalk.blue("Starting client-v2..."));
      const pid = startClientV2(PROJECT_DIR);
      echo(chalk.green(`client-v2 started (PID: ${pid})`));
    }

    // 7. Show status
    echo(chalk.blue("\nService Status:"));
    const services = await getServiceStatus(ctx, PROJECT_DIR);
    echo(formatStatusTable(services));
  }
}
