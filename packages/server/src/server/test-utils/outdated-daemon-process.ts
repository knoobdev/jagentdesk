import { readFile } from "node:fs/promises";
import path from "node:path";
import { createTestJAgentDeskDaemon } from "./jagentdesk-daemon.js";

async function main(): Promise<void> {
  const metroPort = process.env.E2E_METRO_PORT;
  if (!metroPort) {
    throw new Error("E2E_METRO_PORT is not set");
  }

  const daemon = await createTestJAgentDeskDaemon({
    corsAllowedOrigins: [`http://localhost:${metroPort}`],
    daemonVersion: "0.0.0",
    desktopManaged: process.env.E2E_DESKTOP_MANAGED === "1",
    daemonStatusRpcCapability: process.env.E2E_DAEMON_STATUS_RPC_CAPABILITY !== "0",
  });
  const serverId = (await readFile(path.join(daemon.jagentdeskHome, "server-id"), "utf8")).trim();

  process.send?.({
    type: "ready",
    endpoint: `127.0.0.1:${daemon.port}`,
    serverId,
  });

  const shutdown = async () => {
    await daemon.close();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}

void main().catch((error) => {
  process.send?.({
    type: "error",
    error: error instanceof Error ? (error.stack ?? error.message) : String(error),
  });
  process.exit(1);
});
