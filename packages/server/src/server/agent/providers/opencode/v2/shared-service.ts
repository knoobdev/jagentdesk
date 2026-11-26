import { OpenCode } from "@opencode/client";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Logger } from "pino";
import type { ProviderRuntimeSettings } from "../../../provider-launch-config.js";
import type { OpenCodeBridge } from "../bridge.js";
import { OpenCodeHttpError } from "../http-error.js";
import { resolveOpenCodeHomeDir } from "../paths.js";
import { openCodeConfigDirectory, provisionLocalBridge } from "./bridge-provisioning.js";
import { awaitJAgentDeskPlugin } from "./readiness.js";
import {
  compatibleVersion,
  isLocalOpenCodeHost,
  type OpenCodeServiceSelection,
} from "./service-selection.js";
import type { V2Api } from "./api.js";

interface SharedServiceOptions {
  logger: Logger;
  settings?: ProviderRuntimeSettings;
  bridge?: OpenCodeBridge;
}

export interface OpenCodeSessionToolsStatus {
  bound: boolean;
  tools: string[];
}

export interface SharedService {
  client: V2Api;
  exited: Promise<Error>;
  stop(): Promise<void>;
  bindSession(sessionId: string, cwd: string): Promise<void>;
  unbindSession(sessionId: string, cwd: string): Promise<void>;
  refreshLocation(cwd: string, signal?: AbortSignal): Promise<void>;
  /** Spec 04 §27b.0: the bridge plugin's tools for one session; null when the plugin cannot tell. */
  sessionToolsStatus(sessionId: string, cwd: string): Promise<OpenCodeSessionToolsStatus | null>;
}

export async function connectSharedService(
  selection: Extract<OpenCodeServiceSelection, { kind: "explicit" | "discovered" }>,
  options: SharedServiceOptions,
): Promise<SharedService> {
  const server = selection.server;
  const { logger } = options;
  const lifetime = new AbortController();
  const closed = new Error(`OpenCode external server connection closed (${server.url})`);
  let resolveExited!: (error: Error) => void;
  const exited = new Promise<Error>((resolve) => {
    resolveExited = resolve;
  });
  const authorization = server.password
    ? `Basic ${Buffer.from(`opencode:${server.password}`).toString("base64")}`
    : undefined;
  const client = OpenCode.make({
    baseUrl: server.url,
    ...(authorization ? { headers: { Authorization: authorization } } : {}),
    fetch: async (request, init) => {
      const signal = init?.signal
        ? AbortSignal.any([init.signal, lifetime.signal])
        : lifetime.signal;
      let response: Response;
      try {
        response = await fetch(request, { ...init, signal });
      } catch (error) {
        // JAgentDesk does not own this process, so a refused connection is its only exit signal.
        if (isConnectionRefused(error)) markExited(error);
        throw error;
      }
      const html = response.headers.get("content-type")?.includes("text/html") ?? false;
      if (!response.ok || html) {
        const requestUrl = request instanceof Request ? request.url : String(request);
        throw new OpenCodeHttpError(new URL(requestUrl).pathname, response.status, html);
      }
      return response;
    },
  });
  const markExited = (cause: unknown) => {
    if (lifetime.signal.aborted) return;
    const error = new Error(`OpenCode server at ${server.url} stopped accepting connections`, {
      cause,
    });
    logger.warn({ url: server.url }, "OpenCode v2 server stopped accepting connections");
    lifetime.abort(error);
    resolveExited(error);
  };
  let info: Awaited<ReturnType<typeof client.server.info>>;
  try {
    info = await client.server.info({
      signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(30_000)]),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot reach OpenCode v2 server at ${server.url}: ${message}`, {
      cause: error,
    });
  }
  if (!compatibleVersion(info.version))
    throw new Error(
      `Unsupported OpenCode version ${info.version}; version 2.0.10 or newer is required`,
    );
  const bridge = options.bridge;
  const pluginDirectory = bridge ? fileURLToPath(await bridge.materializeV2Plugin()) : undefined;
  if (selection.kind === "discovered" && pluginDirectory) {
    const env = { ...globalThis.process.env, ...options.settings?.env };
    const configDirectory = openCodeConfigDirectory(env);
    const home = resolveOpenCodeHomeDir();
    await mkdir(home, { recursive: true });
    const entries = await client.config.get({ location: { directory: home } });
    if (
      !entries.some(
        (entry) =>
          entry.type === "directory" && path.resolve(entry.path) === path.resolve(configDirectory),
      )
    )
      throw new Error(
        `OpenCode service does not use the expected configuration directory ${configDirectory}; configure the bridge on that service explicitly`,
      );
    await provisionLocalBridge({
      configDirectory,
      artifact: path.join(pluginDirectory, "server.js"),
    });
  }
  const advertised =
    options.settings?.env?.JAGENTDESK_OPENCODE_BRIDGE_URL ??
    globalThis.process.env.JAGENTDESK_OPENCODE_BRIDGE_URL;
  validateBridgeAddress(selection, bridge, advertised);
  const generation: SharedService = {
    client,
    stop: async () => {
      if (lifetime.signal.aborted) return;
      lifetime.abort(closed);
      resolveExited(closed);
    },
    exited,
    ...bridgeBindings(client, bridge, advertised, pluginDirectory),
  };
  logger.info({ url: server.url }, "Using existing OpenCode v2 server");
  return generation;
}

function isConnectionRefused(error: unknown): boolean {
  const cause = error instanceof Error ? error.cause : undefined;
  return Boolean(
    cause && typeof cause === "object" && "code" in cause && cause.code === "ECONNREFUSED",
  );
}

function validateBridgeAddress(
  selection: Extract<OpenCodeServiceSelection, { kind: "explicit" | "discovered" }>,
  bridge: OpenCodeBridge | undefined,
  advertised: string | undefined,
): void {
  if (advertised) {
    let bridgeUrl: URL;
    try {
      bridgeUrl = new URL(advertised);
    } catch {
      throw new Error("JAGENTDESK_OPENCODE_BRIDGE_URL must be an absolute HTTP or HTTPS URL");
    }
    if (bridgeUrl.protocol !== "http:" && bridgeUrl.protocol !== "https:")
      throw new Error("JAGENTDESK_OPENCODE_BRIDGE_URL must be an absolute HTTP or HTTPS URL");
  }
  const hostname = new URL(selection.server.url).hostname;
  if (bridge && selection.kind === "explicit" && !advertised && !isLocalOpenCodeHost(hostname))
    throw new Error(
      "Remote OpenCode requires JAGENTDESK_OPENCODE_BRIDGE_URL pointing to a reachable JAgentDesk bridge tunnel and the JAgentDesk plugin installed on the server",
    );
}

export function bridgeBindings(
  client: ReturnType<typeof OpenCode.make>,
  bridge: OpenCodeBridge | undefined,
  advertised?: string,
  pluginDirectory?: string,
): Pick<SharedService, "bindSession" | "unbindSession" | "refreshLocation" | "sessionToolsStatus"> {
  return {
    bindSession: async (sessionId, cwd) => {
      if (!bridge) return;
      const location = { directory: cwd };
      let result: Awaited<ReturnType<typeof client.rpc.call>>;
      try {
        await awaitJAgentDeskPlugin({ client, location });
        result = await client.rpc.call({
          location,
          rpcID: "jagentdesk.bridge",
          method: "bind",
          input: { sessionID: sessionId, ...bridge.sharedV2Connection(advertised) },
        });
      } catch (error) {
        throw new Error(
          `Cannot connect the JAgentDesk tool bridge to OpenCode. Install the plugin from ${pluginDirectory ?? "JAgentDesk's runtime directory"} and configure a reachable bridge URL: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
      if (result.output && typeof result.output === "object" && "error" in result.output)
        throw new Error(String(result.output.error));
    },
    unbindSession: async (sessionId, cwd) => {
      if (bridge)
        await client.rpc.call(
          {
            location: { directory: cwd },
            rpcID: "jagentdesk.bridge",
            method: "unbind",
            input: { sessionID: sessionId, ...bridge.sharedV2Connection(advertised) },
          },
          { signal: AbortSignal.timeout(2_000) },
        );
    },
    refreshLocation: async (cwd, signal) => {
      if (!bridge) return;
      const location = { directory: cwd };
      await awaitJAgentDeskPlugin({ client, location, signal });
      await client.rpc.call(
        { location, rpcID: "jagentdesk.bridge", method: "refresh", input: {} },
        { signal },
      );
    },
    sessionToolsStatus: async (sessionId, cwd) => {
      if (!bridge) return null;
      let result: Awaited<ReturnType<typeof client.rpc.call>>;
      try {
        result = await client.rpc.call(
          {
            location: { directory: cwd },
            rpcID: "jagentdesk.bridge",
            method: "status",
            input: { sessionID: sessionId },
          },
          { signal: AbortSignal.timeout(5_000) },
        );
      } catch {
        // COMPAT(openCodeBridgeStatus): added in v0.10.2, remove after 2027-05-26; older loaded plugins lack `status`.
        return null;
      }
      const output = result.output;
      if (!output || typeof output !== "object" || !("bound" in output)) return null;
      const tools = "tools" in output && Array.isArray(output.tools) ? output.tools : [];
      return {
        bound: output.bound === true,
        tools: tools.filter((name: unknown): name is string => typeof name === "string"),
      };
    },
  };
}
