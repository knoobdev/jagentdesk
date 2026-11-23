import { setTimeout as delay } from "node:timers/promises";
import type { McpServerConfig } from "../../../agent-sdk-types.js";
import type { V2Api } from "./api.js";
import { raceProviderRefreshAbort } from "../../../provider-refresh-deadline.js";

interface AttachInput {
  client: Pick<V2Api, "mcp">;
  location: { directory: string };
  mcpServers: Record<string, McpServerConfig> | undefined;
  signal?: AbortSignal;
}

// OpenCode lists tools during connection establishment, before publishing
// "connected". session.context is message history, so a new session can stay
// empty forever even when all MCP tools are ready.
export async function attachMcpServers(input: AttachInput): Promise<void> {
  for (const [server, config] of Object.entries(input.mcpServers ?? {})) {
    const deadline = AbortSignal.timeout(30_000);
    const lifetime = input.signal ? AbortSignal.any([input.signal, deadline]) : deadline;
    lifetime.throwIfAborted();
    await raceProviderRefreshAbort(
      lifetime,
      input.client.mcp.add(
        {
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
        },
        { signal: lifetime },
      ),
    );
    await awaitMcp(input.client, input.location, server, lifetime);
  }
}

async function awaitMcp(
  client: Pick<V2Api, "mcp">,
  location: { directory: string },
  server: string,
  lifetime: AbortSignal,
): Promise<void> {
  while (true) {
    const catalog = await raceProviderRefreshAbort(
      lifetime,
      client.mcp.list({ location }, { signal: lifetime }),
    );
    const entry = catalog.data.find((item) => item.name === server);
    if (entry?.status.status === "connected") return;
    if (entry && entry.status.status !== "pending") {
      const reason = entry.status.status === "failed" ? entry.status.error : entry.status.status;
      throw new Error(`OpenCode MCP server ${server} failed to connect: ${reason}`);
    }
    await delay(50, undefined, { signal: lifetime });
  }
}
