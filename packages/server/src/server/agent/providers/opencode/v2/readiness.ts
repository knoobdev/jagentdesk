import { setTimeout as delay } from "node:timers/promises";
import { raceProviderRefreshAbort } from "../../../provider-refresh-deadline.js";
import type { V2Api } from "./api.js";

interface ReadinessInput {
  client: Pick<V2Api, "plugin">;
  location: { directory: string };
  signal?: AbortSignal;
  timeoutMs?: number;
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

// A cold request can own location activation. Canceling it on a shorter per-request
// deadline can interrupt the graph we are waiting for. Use one deadline for activation
// and subsequent inventory polling, including adapters that ignore the signal.
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
      const plugins = await raceProviderRefreshAbort(
        lifetime,
        client.plugin.list({ location }, { signal: lifetime }),
      );
      if (!requireBridge && plugins.data.length > 0) return;
      const bridge = plugins.data.find((plugin) => plugin.id === "jagentdesk");
      if (requireBridge && bridge?.state.status === "active") return;
      if (requireBridge && bridge?.state.status === "failed")
        throw new Error(`OpenCode JAgentDesk tool bridge plugin failed: ${bridge.state.error}`);
      await delay(50, undefined, { signal: lifetime });
    }
  } catch (error) {
    signal?.throwIfAborted();
    if (deadline.aborted)
      throw new OpenCodeLocationReadyTimeoutError(location.directory, timeoutMs);
    throw error;
  }
}
