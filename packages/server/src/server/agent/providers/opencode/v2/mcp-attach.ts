import { setTimeout as delay } from "node:timers/promises";
import type { Logger } from "pino";
import type { McpServerConfig } from "../../../agent-sdk-types.js";
import type { V2Api } from "./api.js";
import { awaitSessionMcpTools } from "./readiness.js";

interface AttachInput {
  client: Pick<V2Api, "mcp" | "session">;
  sessionID: string;
  location: { directory: string };
  mcpServers: Record<string, McpServerConfig> | undefined;
  signal?: AbortSignal;
  logger: Pick<Logger, "warn">;
  toolWaitTimeoutMs?: number;
}

/**
 * Adds this session's injected MCP servers and waits for each one to be usable.
 *
 * OpenCode reports a server "connected" as soon as its transport is up, before
 * that server's tools have been listed. A prompt dispatched inside that window
 * runs without the server's tools (the JAgentDesk MCP tools vanish for every
 * agent whose first prompt loses the race). After the connection is up, wait
 * until the session context actually exposes one of the server's tools —
 * exposed names are `<server>_<tool>`. The wait is bounded: on timeout, warn
 * and continue so agent startup can never hang on it.
 */
export async function attachMcpServers(input: AttachInput): Promise<void> {
  for (const [server, config] of Object.entries(input.mcpServers ?? {})) {
    await input.client.mcp.add({
      server,
      location: input.location,
      config:
        config.type === "stdio"
          ? {
              type: "local",
              command: [config.command, ...(config.args ?? [])],
              environment: config.env,
              codemode: false,
            }
          : {
              type: "remote",
              url: config.url,
              headers: config.headers,
              oauth: false,
              codemode: false,
            },
    });
    await awaitMcp(input.client, input.location, server, input.signal);
    const toolsReady = await awaitSessionMcpTools({
      client: input.client,
      sessionID: input.sessionID,
      server,
      signal: input.signal,
      timeoutMs: input.toolWaitTimeoutMs,
    });
    if (!toolsReady)
      input.logger.warn(
        { server, sessionID: input.sessionID },
        "OpenCode MCP server tools did not appear in the session context; continuing",
      );
  }
}

async function awaitMcp(
  client: Pick<V2Api, "mcp">,
  location: { directory: string },
  server: string,
  signal?: AbortSignal,
): Promise<void> {
  const lifetime = AbortSignal.any([
    signal ?? AbortSignal.timeout(30_000),
    AbortSignal.timeout(30_000),
  ]);
  while (true) {
    const catalog = await client.mcp.list({ location }, { signal: lifetime });
    const entry = catalog.data.find((item) => item.name === server);
    if (entry?.status.status === "connected") return;
    if (entry && entry.status.status !== "pending") {
      const reason = entry.status.status === "failed" ? entry.status.error : entry.status.status;
      throw new Error(`OpenCode MCP server ${server} failed to connect: ${reason}`);
    }
    await delay(50, undefined, { signal: lifetime });
  }
}
