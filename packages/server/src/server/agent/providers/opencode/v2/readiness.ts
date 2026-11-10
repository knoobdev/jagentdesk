import { setTimeout as delay } from "node:timers/promises";
import { raceProviderRefreshAbort } from "../../../provider-refresh-deadline.js";
import type { V2Api } from "./api.js";

interface ReadinessInput {
  client: Pick<V2Api, "plugin">;
  location: { directory: string };
  signal?: AbortSignal;
  timeoutMs?: number;
}

interface SessionToolsInput {
  client: Pick<V2Api, "session">;
  sessionID: string;
  server: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * Waits until the session context exposes at least one tool of the given MCP
 * server. Exposed tool names are `<server>_<tool>`. Returns false when the
 * wait times out; the caller decides whether that is fatal.
 */
export async function awaitSessionMcpTools(input: SessionToolsInput): Promise<boolean> {
  const { client, sessionID, server, signal, timeoutMs = 15_000 } = input;
  signal?.throwIfAborted();
  const prefix = `${server}_`;
  const deadline = AbortSignal.timeout(timeoutMs);
  const lifetime = signal ? AbortSignal.any([signal, deadline]) : deadline;
  try {
    while (true) {
      const requestTimeout = AbortSignal.timeout(5_000);
      const requestSignal = AbortSignal.any([lifetime, requestTimeout]);
      try {
        const context = await raceProviderRefreshAbort(
          requestSignal,
          client.session.context({ sessionID }, { signal: requestSignal }),
        );
        if (contextHasServerTool(context, prefix)) return true;
      } catch (error) {
        lifetime.throwIfAborted();
        if (!requestTimeout.aborted) throw error;
      }
      await delay(100, undefined, { signal: lifetime });
    }
  } catch (error) {
    signal?.throwIfAborted();
    if (deadline.aborted) return false;
    throw error;
  }
}

function contextHasServerTool(context: unknown, prefix: string): boolean {
  if (!Array.isArray(context)) return false;
  for (const message of context) {
    if (typeof message !== "object" || message === null) continue;
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (typeof part !== "object" || part === null) continue;
      const name = (part as { name?: unknown }).name;
      if (typeof name === "string" && name.startsWith(prefix)) return true;
    }
  }
  // Tool names also surface inside message text (tool results, catalog
  // notices), which carries no stable structured field to walk.
  return JSON.stringify(context).includes(`"${prefix}`);
}

export class OpenCodeLocationReadyTimeoutError extends Error {
  constructor(
    readonly directory: string,
    readonly waitedMs: number,
  ) {
    super(`OpenCode location ${directory} did not activate within ${waitedMs}ms`);
    this.name = "OpenCodeLocationReadyTimeoutError";
  }
}

export function waitForLocationReady(input: ReadinessInput): Promise<void> {
  return waitForPlugins({ ...input, requireBridge: false });
}

export function awaitJAgentDeskPlugin(input: ReadinessInput): Promise<void> {
  return waitForPlugins({ ...input, requireBridge: true });
}

// A cold location exposes an empty inventory before its config plugins register
// commands and skills. Bound both the inventory request and the polling loop.
interface PluginReadinessInput extends ReadinessInput {
  requireBridge: boolean;
}
async function waitForPlugins(input: PluginReadinessInput): Promise<void> {
  const { client, location, signal, requireBridge, timeoutMs = 30_000 } = input;
  signal?.throwIfAborted();
  const deadline = AbortSignal.timeout(timeoutMs);
  const lifetime = signal ? AbortSignal.any([signal, deadline]) : deadline;
  try {
    while (true) {
      const requestTimeout = AbortSignal.timeout(5_000);
      const requestSignal = AbortSignal.any([lifetime, requestTimeout]);
      try {
        const plugins = await raceProviderRefreshAbort(
          requestSignal,
          client.plugin.list({ location }, { signal: requestSignal }),
        );
        if (!requireBridge && plugins.data.length > 0) return;
        const bridge = plugins.data.find((plugin) => plugin.id === "jagentdesk");
        if (requireBridge && bridge?.state.status === "active") return;
        if (requireBridge && bridge?.state.status === "failed")
          throw new Error(`OpenCode JAgentDesk tool bridge plugin failed: ${bridge.state.error}`);
      } catch (error) {
        lifetime.throwIfAborted();
        if (!requestTimeout.aborted) throw error;
      }
      await delay(50, undefined, { signal: lifetime });
    }
  } catch (error) {
    signal?.throwIfAborted();
    if (deadline.aborted)
      throw new OpenCodeLocationReadyTimeoutError(location.directory, timeoutMs);
    throw error;
  }
}
