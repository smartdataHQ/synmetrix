import { $, echo, chalk } from "zx";
import { Args, Flags } from "@oclif/core";
import { existsSync } from "node:fs";
import BaseCommand from "../../BaseCommand.js";
import { callCompose, PROJECT_DIR } from "../../utils.js";
import { getLogFilePath } from "../../devUtils.js";

export default class DevLogs extends BaseCommand {
  static description = "View development service logs";

  static args = {
    name: Args.string({ description: "Service name (e.g. hasura, cubejs, client-v2)", required: false }),
  };

  static flags = {
    ...BaseCommand.flags,
    tail: Flags.integer({ char: "t", description: "Number of lines to tail", default: 500 }),
  };

  protected async init(): Promise<void> {
    const { flags } = await this.parse(DevLogs);
    this.context = {
      dockerComposeFile: `${PROJECT_DIR}/docker-compose.${flags.env}.yml`,
      runtimeEnv: flags.env,
      networkName: flags.networkName,
    };
  }

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(DevLogs);
    const { name } = args;
    const tail = flags.tail;

    if (name === "client-v2") {
      const logFile = getLogFilePath(PROJECT_DIR);
      if (!existsSync(logFile)) {
        echo(chalk.red("client-v2 log file not found. Is client-v2 running?"));
        return;
      }
      echo(chalk.blue(`Tailing client-v2 logs (${logFile})...`));
      await $`tail -f -n ${tail} ${logFile}`;
    } else if (name === undefined) {
      await callCompose(this.context, ["logs", "-f", "--tail", String(tail)]);
    } else {
      await callCompose(this.context, ["logs", name, "-f", "--tail", String(tail)]);
    }
  }
}
