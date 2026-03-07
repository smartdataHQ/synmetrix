import { $, echo, chalk } from "zx";
import { Args } from "@oclif/core";
import { existsSync } from "node:fs";
import BaseCommand from "../../BaseCommand.js";
import { callCompose, PROJECT_DIR } from "../../utils.js";
import {
  checkPrerequisites,
  checkPortAvailability,
  probePostgres,
  ensureEnvFiles,
  cleanStaleContainers,
  startClientV2,
  installClientV2Deps,
  getServiceStatus,
  formatStatusTable,
  waitForHasura,
  getClientV2Dir,
  DEV_SERVICES,
  DEV_PORTS,
} from "../../devUtils.js";

export default class DevSetup extends BaseCommand {
  static description = "First-time development environment setup";

  static flags = {
    ...BaseCommand.flags,
  };

  protected async init(): Promise<void> {
    // Ensure env files exist BEFORE BaseCommand.init() which hard-fails if they are missing
    const { copied } = ensureEnvFiles(PROJECT_DIR);
    if (copied.length > 0) {
      echo(chalk.yellow("Created env files:"), copied.join(", "));
    }
    await super.init();
  }

  public async run(): Promise<void> {
    const { flags } = await this.parse(DevSetup);
    const ctx = this.context;
    const networkName = flags.networkName;

    // 1. Check prerequisites
    echo(chalk.blue("Checking prerequisites..."));
    const missing = await checkPrerequisites();
    if (missing.length > 0) {
      echo(chalk.red("Missing prerequisites:"));
      for (const m of missing) {
        echo(chalk.red(`  - ${m.name}: ${m.installGuide}`));
      }
      this.exit(1);
    }
    echo(chalk.green("All prerequisites satisfied."));

    // 2. ensureEnvFiles already ran in init()

    // 3. Probe Postgres
    echo(chalk.blue("Probing PostgreSQL..."));
    const pgHost = process.env.POSTGRES_HOST || "localhost";
    const pgPort = parseInt(process.env.POSTGRES_PORT || "5432", 10);
    const pgReachable = await probePostgres(pgHost, pgPort);
    if (!pgReachable) {
      echo(chalk.red(`PostgreSQL is not reachable at ${pgHost}:${pgPort}`));
      this.exit(2);
    }
    echo(chalk.green(`PostgreSQL reachable at ${pgHost}:${pgPort}`));

    // 4. Create Docker network
    echo(chalk.blue("Creating Docker network..."));
    await $`docker network create --attachable ${networkName}`.nothrow();

    // 5. Clean stale containers
    echo(chalk.blue("Cleaning stale containers..."));
    await cleanStaleContainers(ctx);

    // 6. Check port availability
    echo(chalk.blue("Checking port availability..."));
    const conflicting = await checkPortAvailability(Object.values(DEV_PORTS));
    if (conflicting.length > 0) {
      echo(chalk.red(`Ports already in use: ${conflicting.join(", ")}`));
      this.exit(3);
    }
    echo(chalk.green("All ports available."));

    // 7. Start Docker Compose services
    echo(chalk.blue("Starting Docker Compose services..."));
    await callCompose(ctx, ["up", "-d", ...DEV_SERVICES]);

    // 8. Wait for Hasura
    echo(chalk.blue("Waiting for Hasura to be ready..."));
    const hasuraReady = await waitForHasura(8080);
    if (!hasuraReady) {
      echo(chalk.yellow("Warning: Hasura did not become ready within the timeout."));
    } else {
      echo(chalk.green("Hasura is ready."));
    }

    // 9. Run Hasura migrations
    echo(chalk.blue("Applying Hasura migrations..."));
    try {
      await callCompose(ctx, [
        "exec", "-T", "hasura_cli",
        "hasura-cli", "migrate", "apply",
        "--endpoint", "http://hasura:8080",
        "--admin-secret", process.env.HASURA_GRAPHQL_ADMIN_SECRET || "",
      ]);
      echo(chalk.green("Hasura migrations applied."));
    } catch {
      echo(chalk.red("Failed to apply Hasura migrations."));
      this.exit(5);
    }

    // 10. Check client-v2 directory
    const clientDir = getClientV2Dir(PROJECT_DIR);
    if (!existsSync(clientDir)) {
      echo(chalk.red(`client-v2 directory not found at ${clientDir}`));
      this.exit(4);
    }

    // 11. Install client-v2 dependencies
    echo(chalk.blue("Installing client-v2 dependencies..."));
    await installClientV2Deps(PROJECT_DIR);

    // 12. Start client-v2
    echo(chalk.blue("Starting client-v2..."));
    const pid = startClientV2(PROJECT_DIR);
    echo(chalk.green(`client-v2 started (PID: ${pid})`));

    // 13. Show status
    echo(chalk.blue("\nService Status:"));
    const services = await getServiceStatus(ctx, PROJECT_DIR);
    echo(formatStatusTable(services));
  }
}
