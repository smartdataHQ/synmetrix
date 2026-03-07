import { echo, chalk } from "zx";
import BaseCommand from "../../BaseCommand.js";
import { PROJECT_DIR } from "../../utils.js";
import { getServiceStatus, formatStatusTable } from "../../devUtils.js";

export default class DevStatus extends BaseCommand {
  static description = "Display development environment health summary";

  static flags = {
    ...BaseCommand.flags,
  };

  protected async init(): Promise<void> {
    const { flags } = await this.parse(DevStatus);
    this.context = {
      dockerComposeFile: `${PROJECT_DIR}/docker-compose.${flags.env}.yml`,
      runtimeEnv: flags.env,
      networkName: flags.networkName,
    };
  }

  public async run(): Promise<void> {
    echo(chalk.blue("Service Status:"));
    const services = await getServiceStatus(this.context, PROJECT_DIR);
    echo(formatStatusTable(services));
  }
}
