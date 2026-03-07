import { echo, chalk } from "zx";
import BaseCommand from "../../BaseCommand.js";
import { callCompose, PROJECT_DIR } from "../../utils.js";
import { stopClientV2 } from "../../devUtils.js";

export default class DevStop extends BaseCommand {
  static description = "Stop all development services";

  static flags = {
    ...BaseCommand.flags,
  };

  protected async init(): Promise<void> {
    const { flags } = await this.parse(DevStop);
    this.context = {
      dockerComposeFile: `${PROJECT_DIR}/docker-compose.${flags.env}.yml`,
      runtimeEnv: flags.env,
      networkName: flags.networkName,
    };
  }

  public async run(): Promise<void> {
    // 1. Stop client-v2
    echo(chalk.blue("Stopping client-v2..."));
    stopClientV2(PROJECT_DIR);
    echo(chalk.green("client-v2 stopped."));

    // 2. Stop Docker Compose services
    echo(chalk.blue("Stopping Docker Compose services..."));
    await callCompose(this.context, ["stop"]);
    echo(chalk.green("All services stopped."));
  }
}
