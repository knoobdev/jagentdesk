import { createInterface } from "node:readline/promises";
import { Command } from "commander";
import type { HostSummary, HostUpdate } from "@jagentdesk/client";
import {
  withOutput,
  type CommandOptions,
  type OutputSchema,
  type CommandResult,
} from "../../output/index.js";
import { addJsonAndDaemonHostOptions, collectMultiple } from "../../utils/command-options.js";
import { connectToDaemon } from "../../utils/client.js";

const schema: OutputSchema<HostSummary> = {
  idField: "registrationId",
  columns: [
    { header: "ID", field: "registrationId" },
    { header: "LABEL", field: "label" },
    { header: "SERVER", field: "serverId" },
    { header: "ENABLED", field: "enabled" },
    { header: "STATUS", field: "status" },
    { header: "SOURCE", field: (row) => `${row.source.id}/${row.source.key}` },
  ],
};
function metadata(values: string[] = []): Record<string, string> {
  return Object.fromEntries(
    values.map((entry) => {
      const split = entry.indexOf("=");
      if (split < 1) throw { code: "invalid_metadata", message: "Metadata must use key=value" };
      return [entry.slice(0, split), entry.slice(split + 1)];
    }),
  );
}
interface Options extends CommandOptions {
  label?: string;
  meta?: string[];
  removeMeta?: string[];
  connection?: string;
  replaceIdentity?: boolean;
  host?: string;
}
async function run(
  action: string,
  id: string | undefined,
  options: Options,
): Promise<CommandResult<HostSummary>> {
  const client = await connectToDaemon({ host: options.host });
  try {
    const pair = async (connection: string, registrationId?: string) => {
      const challenge = await client.beginHostPairing(
        { connection, label: options.label, metadata: metadata(options.meta) },
        registrationId,
        options.replaceIdentity,
      );
      process.stderr.write(
        `Verification code: ${challenge.code.slice(0, 3)} ${challenge.code.slice(3)}\nCompare this code with the destination's Pair a device screen.\n`,
      );
      const readline = createInterface({ input: process.stdin, output: process.stderr });
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(),
        Math.max(1, challenge.expiresAt - Date.now()),
      );
      try {
        const answer = await readline.question("Do the codes match? Type y to confirm: ", {
          signal: controller.signal,
        });
        return await client.confirmHostPairing(
          challenge.transactionId,
          answer.trim().toLowerCase() === "y",
        );
      } finally {
        clearTimeout(timer);
        readline.close();
      }
    };
    if (action === "add") return { type: "single", data: await pair(id!), schema };
    if (action === "ls") return { type: "list", data: (await client.listHosts()).hosts, schema };
    const host = (await client.listHosts()).hosts.find((entry) => entry.registrationId === id);
    if (!host) throw { code: "host_unknown", message: `Unknown registration ${id}` };
    if (action === "inspect")
      return {
        type: "single",
        data: host,
        schema: { ...schema, renderHuman: () => JSON.stringify(host, null, 2) },
      };
    if (action === "rm") {
      await client.removeHost(id!);
      return { type: "single", data: host, schema };
    }
    const patch: HostUpdate = {};
    if (action === "enable" || action === "disable") patch.enabled = action === "enable";
    if (options.label !== undefined) patch.label = options.label || null;
    if (options.connection !== undefined) {
      await pair(options.connection, id);
    }

    if (options.meta?.length || options.removeMeta?.length) {
      patch.metadata = { ...host.metadata, ...metadata(options.meta) };
      for (const key of options.removeMeta ?? []) delete patch.metadata[key];
    }
    return { type: "single", data: await client.updateHost(id!, patch), schema };
  } finally {
    await client.close();
  }
}
export function createHostCommand(): Command {
  const host = new Command("host").description("Manage hosts connected to the selected daemon");
  addJsonAndDaemonHostOptions(
    host.command("ls").description("List saved hosts, including disabled and failed entries"),
  ).action(
    withOutput((_options: Options, _command: Command) =>
      run("ls", undefined, _command.optsWithGlobals() as Options),
    ),
  );
  addJsonAndDaemonHostOptions(
    host
      .command("add")
      .argument("<connection>")
      .option("--label <name>")
      .option("--meta <key=value>", "Set metadata", collectMultiple, []),
  ).action(
    withOutput((connection: string, _options: Options, _command: Command) =>
      run("add", connection, _command.optsWithGlobals() as Options),
    ),
  );
  addJsonAndDaemonHostOptions(
    host
      .command("update")
      .argument("<registration-id>")
      .option("--label <name>")
      .option("--connection <connection>")
      .option("--replace-identity", "Accept a new destination identity")
      .option("--meta <key=value>", "Replace supplied metadata keys", collectMultiple, [])
      .option("--remove-meta <key>", "Remove a metadata key", collectMultiple, []),
  ).action(
    withOutput((id: string, _options: Options, _command: Command) =>
      run("update", id, _command.optsWithGlobals() as Options),
    ),
  );
  for (const action of ["inspect", "enable", "disable", "rm"])
    addJsonAndDaemonHostOptions(host.command(action).argument("<registration-id>")).action(
      withOutput((id: string, _options: Options, _command: Command) =>
        run(action, id, _command.optsWithGlobals() as Options),
      ),
    );
  return host;
}
