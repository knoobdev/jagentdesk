import { log } from "@clack/prompts";
import { Command } from "commander";
import chalk from "chalk";
import {
  generateLocalPairingOffer,
  getOrCreateServerId,
  loadConfig,
  resolveJAgentDeskHome,
} from "@jagentdesk/server";
import { tryConnectToDaemon } from "../../utils/client.js";
import { resolveLocalDaemonState, resolveTcpHostFromListen } from "./local-daemon.js";
import { addJsonOption } from "../../utils/command-options.js";
import { formatPairingInstructions } from "../../output/pairing.js";

interface PairOptions {
  home?: string;
  json?: boolean;
}

export interface PairCommandDependencies {
  resolveOffer: typeof resolveLocalPairingOffer;
  isInteractive: () => boolean;
  output: PairCommandOutput;
}

export interface PairCommandOutput {
  columns: number | undefined;
  writeStdout(message: string): void;
  writeStderr(message: string): void;
  setExitCode(code: number): void;
  success(message: string): void;
}

export interface PairingOffer {
  tailnetEnabled: boolean;
  url: string | null;
  qr: string | null;
}

const PAIRING_DAEMON_RPC_TIMEOUT_MS = 1500;

function createProcessOutput(): PairCommandOutput {
  return {
    columns: process.stdout.columns,
    writeStdout(message) {
      process.stdout.write(message);
    },
    writeStderr(message) {
      process.stderr.write(message);
    },
    setExitCode(code) {
      process.exitCode = code;
    },
    success(message) {
      log.success(message);
    },
  };
}

export function pairCommand(): Command {
  return addJsonOption(new Command("pair").description("Print the daemon pairing QR code and link"))
    .option("--home <path>", "JAgentDesk home directory (default: ~/.jagentdesk)")
    .action(async (_options: PairOptions, command: Command) => {
      await runPairCommand(command.optsWithGlobals());
    });
}

export async function resolveLocalPairingOffer(options: {
  jagentdeskHome: string;
}): Promise<PairingOffer> {
  const state = resolveLocalDaemonState({ home: options.jagentdeskHome });
  const serverId = getOrCreateServerId(state.home);
  const daemonOffer = await resolveDaemonPairingOffer(state.listen, serverId);
  if (daemonOffer) return daemonOffer;

  if (state.running) {
    throw new Error(
      "The running daemon did not provide a pairing offer. Check daemon connectivity or update the daemon.",
    );
  }

  const config = loadConfig(options.jagentdeskHome);
  const host = process.env.JAGENTDESK_TAILNET_HOST?.trim() || null;
  const tcpListen = host ? resolveTcpHostFromListen(config.listen) : null;
  const port = tcpListen === null ? null : tcpListen.slice(tcpListen.lastIndexOf(":") + 1);
  const tailnetAddress = host && port ? `${host}:${port}` : null;

  const offer = await generateLocalPairingOffer({
    jagentdeskHome: options.jagentdeskHome,
    tailnetAddress,
    appBaseUrl: config.appBaseUrl,
    includeQr: true,
  });
  return {
    tailnetEnabled: offer.tailnetEnabled,
    url: offer.url || null,
    qr: offer.qr ?? null,
  };
}

async function resolveDaemonPairingOffer(
  listen: string,
  expectedServerId: string,
): Promise<PairingOffer | null> {
  const client = await tryConnectToDaemon({
    host: listen,
    timeout: PAIRING_DAEMON_RPC_TIMEOUT_MS,
  });
  if (!client) return null;

  try {
    const serverInfo = client.getLastServerInfoMessage();
    if (serverInfo?.serverId.trim() !== expectedServerId) {
      throw new Error(
        "The reachable daemon belongs to a different JAgentDesk home. Check --home or the daemon listen configuration.",
      );
    }
    if (serverInfo?.features?.daemonStatusRpc !== true) {
      throw new Error("Update the JAgentDesk daemon before pairing from this command.");
    }

    const offer = await client.getDaemonPairingOffer({
      timeout: PAIRING_DAEMON_RPC_TIMEOUT_MS,
    });
    return {
      tailnetEnabled: offer.tailnetEnabled === true,
      url: offer.url || null,
      qr: offer.qr ?? null,
    };
  } finally {
    await client.close().catch(() => undefined);
  }
}

export async function runPairCommand(
  options: PairOptions,
  dependencyOverrides: Partial<PairCommandDependencies> = {},
): Promise<void> {
  if (options.home) process.env.JAGENTDESK_HOME = options.home;
  const dependencies: PairCommandDependencies = {
    resolveOffer: resolveLocalPairingOffer,
    isInteractive: () => Boolean(process.stdin.isTTY && process.stdout.isTTY),
    output: createProcessOutput(),
    ...dependencyOverrides,
  };

  const jagentdeskHome = resolveJAgentDeskHome();
  const pairing = await dependencies.resolveOffer({ jagentdeskHome });

  if (!pairing.tailnetEnabled || !pairing.url) {
    if (options.json) {
      dependencies.output.writeStderr(
        `${JSON.stringify({
          code: "TAILNET_NOT_CONFIGURED",
          message: "Tailnet pairing is not configured for this daemon.",
          action:
            "Set JAGENTDESK_TAILNET_HOST and restart the daemon, then run jagentdesk daemon pair again.",
        })}\n`,
      );
    } else {
      dependencies.output.writeStderr(
        `${chalk.red("Tailnet pairing is not configured for this daemon.")}\n`,
      );
      dependencies.output.writeStderr(
        `${chalk.yellow("Set JAGENTDESK_TAILNET_HOST and restart the daemon, then run jagentdesk daemon pair again.")}\n`,
      );
    }
    dependencies.output.setExitCode(1);
    return;
  }

  if (options.json) {
    dependencies.output.writeStdout(
      `${JSON.stringify(
        { tailnetEnabled: pairing.tailnetEnabled, url: pairing.url, qr: pairing.qr },
        null,
        2,
      )}\n`,
    );
    return;
  }

  dependencies.output.writeStdout(
    formatPairingInstructions({
      url: pairing.url,
      qr: pairing.qr,
      columns: dependencies.output.columns,
    }),
  );
}
