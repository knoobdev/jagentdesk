import { readFileSync } from "node:fs";
import path from "node:path";
import { Command } from "commander";
import WsWebSocket from "ws";
import {
  loadConfig,
  loadExistingRelayIdentity,
  parseRelayChallenge,
  resolveJAgentDeskHome,
} from "@jagentdesk/server";
import { buildRelayWebSocketUrl } from "@jagentdesk/protocol/daemon-endpoints";

export interface RelayResetInput {
  endpoint: string;
  useTls: boolean;
  serverId: string;
  signer: ReturnType<typeof loadExistingRelayIdentity>;
  timeoutMs?: number;
}

export async function resetRelayOwnership(input: RelayResetInput): Promise<void> {
  const url = new URL(buildRelayWebSocketUrl({ ...input, role: "server" }));
  url.searchParams.set("reset", "1");
  await new Promise<void>((resolve, reject) => {
    const socket = new WsWebSocket(url);
    let answered = false;
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error("Relay reset timed out"));
    }, input.timeoutMs ?? 15_000);
    socket.on("message", (raw) => {
      const challenge = parseRelayChallenge(raw.toString());
      if (!challenge || answered) {
        socket.close(1002, "Unexpected reset response");
        return;
      }
      answered = true;
      socket.send(
        JSON.stringify({
          type: "relay_auth",
          publicKey: input.signer.publicKeyB64url,
          signature: input.signer.signOwnership(input.serverId, challenge.nonce),
        }),
      );
    });
    socket.on("close", (code) => {
      clearTimeout(timer);
      if (answered && code === 1000) resolve();
      else
        reject(
          new Error(
            `Relay reset rejected (${code}). Use the current pinned key; if it is lost, use a new serverId.`,
          ),
        );
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      socket.terminate();
      reject(error);
    });
  });
}

export function createRelayCommand(): Command {
  return new Command("relay").description("Manage the encrypted relay").addCommand(
    new Command("reset")
      .description("Clear the relay ownership pin using the current pinned daemon key")
      .option("--home <path>", "JAgentDesk home containing the current pinned key")
      .action(async (options: { home?: string }) => {
        const home = options.home ?? resolveJAgentDeskHome();
        const config = loadConfig(home);
        const serverId = readFileSync(path.join(home, "server-id"), "utf8").trim();
        if (!serverId) throw new Error("The existing server-id is required for relay reset");
        if (!config.relayEndpoint) throw new Error("No relay endpoint is configured");
        await resetRelayOwnership({
          endpoint: config.relayEndpoint,
          useTls: config.relayUseTls ?? true,
          serverId,
          signer: loadExistingRelayIdentity(home),
        });
        process.stdout.write("Relay ownership pin cleared.\n");
      }),
  );
}
