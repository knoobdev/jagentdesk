import { decorateOpenCodeV2Env, materializeOpenCodeV2Plugin } from "../bridge.js";
import { resolveJAgentDeskHome } from "../../../../jagentdesk-home.js";
import { OpenCode } from "@opencode/client";
import type { V2Api } from "./api.js";
import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import type { Logger } from "pino";
import type { LaunchWrap } from "../../../../../utils/launch-wrap.js";
import { spawnProcess } from "../../../../../utils/spawn.js";
import { terminateWithTreeKill } from "../../../../../utils/tree-kill.js";
import {
  createProviderEnvSpec,
  resolveProviderLaunch,
  type ProviderRuntimeSettings,
} from "../../../provider-launch-config.js";
import type { ManagedProcessRegistry } from "../../../../managed-processes/managed-processes.js";
import { resolveOpenCodeHomeDir } from "../paths.js";
import { validateOpenCodeResponse } from "./http-response.js";
import { raceProviderRefreshAbort } from "../../../provider-refresh-deadline.js";
import {
  mergeOpenCodeConfigContent,
  type OpenCodeProviderInjection,
} from "../../../../custom-providers/materialization.js";
import { resolveExternalOpenCodeServer, type ExternalOpenCodeServer } from "./external-server.js";
import {
  processEnvironmentOverrides,
  selectOpenCodeService,
  type OpenCodeServiceSelection,
} from "./service-selection.js";
import {
  bridgeBindings,
  connectSharedService,
  type OpenCodeMcpPath,
  type OpenCodeSessionToolsStatus,
} from "./shared-service.js";
import {
  hasManagedBridge,
  openCodeConfigDirectory,
  provisionLocalBridge,
} from "./bridge-provisioning.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { OpenCodeBridge } from "../bridge.js";

export interface V2Connection {
  client: V2Api;
  release(): Promise<void>;
  retain(): V2Connection;
  bindSession(sessionId: string, cwd: string): Promise<void>;
  unbindSession(sessionId: string, cwd: string): Promise<void>;
  refreshLocation(cwd: string, signal?: AbortSignal): Promise<void>;
  /** Spec 04 §27b.0: the bridge plugin's tools for one session; null when the plugin cannot tell. */
  sessionToolsStatus(sessionId: string, cwd: string): Promise<OpenCodeSessionToolsStatus | null>;
  /** Spec 33.7: how this server runs an agent's own MCP servers, decided once per server. */
  mcpPath(cwd: string): Promise<OpenCodeMcpPath>;
  readonly exited: Promise<Error>;
}
interface Generation {
  client: V2Api;
  users: number;
  stop(): Promise<void>;
  exited: Promise<Error>;
  bindSession(sessionId: string, cwd: string): Promise<void>;
  unbindSession(sessionId: string, cwd: string): Promise<void>;
  refreshLocation(cwd: string, signal?: AbortSignal): Promise<void>;
  /** Spec 04 §27b.0: the bridge plugin's tools for one session; null when the plugin cannot tell. */
  sessionToolsStatus(sessionId: string, cwd: string): Promise<OpenCodeSessionToolsStatus | null>;
  mcpPath(cwd: string): Promise<OpenCodeMcpPath>;
}
export interface V2RuntimeOptions {
  logger: Logger;
  settings?: ProviderRuntimeSettings;
  managedProcesses?: ManagedProcessRegistry;
  decorateEnv?: (env: Record<string, string>) => Promise<Record<string, string>>;
  /** Resolves the daemon-managed API provider definition merged into OPENCODE_CONFIG_CONTENT at spawn (spec 34.3). */
  providerConfigInjection?: () => Promise<OpenCodeProviderInjection | null>;
  externalServer?: ExternalOpenCodeServer;
  selection?: OpenCodeServiceSelection;
  bridge?: OpenCodeBridge;
}

export interface V2RuntimeAcquireOptions {
  fresh?: boolean;
  /**
   * Spec 33.7 legacy path: a server of the agent's own, for its `mcp.add` servers and process
   * env, when the shared server does not report `features.mcpTools`.
   */
  dedicated?: boolean;
  env?: Record<string, string>;
  /** Start a server for this caller alone, behind this wrap. Other callers never share it. */
  wrap?: LaunchWrap;
  signal?: AbortSignal;
}

// The runtime owns a credential for each subprocess; sessions only receive its authenticated client.
export class V2Runtime {
  private current: Promise<Generation> | null = null;
  private generations = new Set<Generation>();
  private starts = new Set<Promise<Generation>>();
  private closed = false;
  private retired = false;
  private readonly selection: Promise<OpenCodeServiceSelection>;

  constructor(private readonly options: V2RuntimeOptions) {
    if (options.providerConfigInjection) {
      // Custom API configuration must reach an isolated process (spec 34.3).
      this.selection = Promise.resolve({ kind: "owned" });
    } else {
      this.selection = options.selection
        ? Promise.resolve(options.selection)
        : selectOpenCodeService({
            explicit:
              options.externalServer ??
              resolveExternalOpenCodeServer({
                ...globalThis.process.env,
                ...options.settings?.env,
              }),
            env: options.settings?.env,
          });
    }
  }

  async acquire(input: V2RuntimeAcquireOptions = {}): Promise<V2Connection> {
    if (this.closed || this.retired) throw new Error("OpenCode runtime is closed");
    input.signal?.throwIfAborted();
    this.assertBridgePort();
    const selected = await raceProviderRefreshAbort(input.signal, this.selection);
    assertWrappable(input, selected);
    const pending = this.pendingGeneration(input, selected);
    let generation: Generation;
    try {
      generation = await raceProviderRefreshAbort(input.signal, pending);
    } catch (error) {
      if (this.current === pending) this.current = null;
      if (input.signal?.aborted) {
        void pending
          .then(async (started) => {
            if (started.users !== 0) return undefined;
            this.generations.delete(started);
            await started.stop();
            return undefined;
          })
          .catch((cleanupError: unknown) => {
            this.options.logger.warn(
              { error: String(cleanupError) },
              "OpenCode canceled startup cleanup failed",
            );
          });
      }
      throw error;
    }
    if (!this.generations.has(generation)) {
      if (this.current === pending) this.current = null;
      throw new Error("OpenCode helper server exited");
    }
    const connection = this.lease(generation, pending);
    if (input.signal?.aborted || this.closed) {
      await connection.release();
      input.signal?.throwIfAborted();
      throw new Error("OpenCode runtime is closed");
    }
    return connection;
  }

  private pendingGeneration(
    input: V2RuntimeAcquireOptions,
    selected: OpenCodeServiceSelection,
  ): Promise<Generation> {
    // Spec 33.7 legacy path, and a launch wrap: a server of the caller's own, never the shared one.
    // A discovered server is only a preference; a wrapped caller gets a server JAgentDesk starts.
    if (input.env || input.dedicated || input.wrap)
      return this.startTracked({ kind: "owned" }, input.env ?? {}, input.wrap);
    this.current ??= this.startTracked(
      this.requiresOwnedServer(selected) ? { kind: "owned" } : selected,
    );
    return this.current;
  }

  private assertBridgePort(): void {
    const port = this.options.settings?.env?.JAGENTDESK_OPENCODE_BRIDGE_PORT;
    if (!port || !this.options.bridge) return;
    const actual = new URL(this.options.bridge.sharedV2Connection().baseUrl).port;
    if (Number(port) !== Number(actual))
      throw new Error(
        "JAGENTDESK_OPENCODE_BRIDGE_PORT changed; restart JAgentDesk to apply the bridge port",
      );
  }

  // JAgentDesk starts its own server, instead of refusing, when the provider env configures the
  // OpenCode process: an existing server cannot honor it.
  private requiresOwnedServer(selection: OpenCodeServiceSelection): boolean {
    if (selection.kind === "owned") return true;
    return processEnvironmentOverrides(this.options.settings?.env, selection.kind).length > 0;
  }

  private lease(generation: Generation, pending: Promise<Generation>): V2Connection {
    if (this.closed || !this.generations.has(generation))
      throw new Error("OpenCode helper server is no longer running");
    generation.users += 1;
    let released = false;
    const release = async () => {
      if (released) return;
      released = true;
      generation.users -= 1;
      if (generation.users !== 0) return;
      if (this.current === pending) return;
      this.generations.delete(generation);
      await generation.stop();
    };
    return {
      client: generation.client,
      release,
      retain: () => this.lease(generation, pending),
      bindSession: generation.bindSession,
      unbindSession: generation.unbindSession,
      refreshLocation: generation.refreshLocation,
      sessionToolsStatus: generation.sessionToolsStatus,
      mcpPath: generation.mcpPath,
      exited: generation.exited,
    };
  }

  /**
   * The registry dropped the client that owns this runtime. Idle servers stop now; a server with
   * sessions on it stops when the last one releases it (it is no longer `current`).
   */
  async retire(): Promise<void> {
    this.retired = true;
    this.current = null;
    await Promise.allSettled(this.starts);
    const idle = [...this.generations].filter((generation) => generation.users === 0);
    for (const generation of idle) this.generations.delete(generation);
    this.options.logger.info(
      { stopped: idle.length, inUse: this.generations.size },
      "OpenCode runtime retired",
    );
    await Promise.all(idle.map((generation) => generation.stop()));
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    await Promise.allSettled(this.starts);
    await Promise.all([...this.generations].map((generation) => generation.stop()));
    this.generations.clear();
    this.current = null;
  }

  private startTracked(
    selection: OpenCodeServiceSelection,
    dedicatedEnv?: Record<string, string>,
    wrap?: LaunchWrap,
  ): Promise<Generation> {
    const pending = this.start(selection, dedicatedEnv, wrap);
    this.starts.add(pending);
    void pending.then(
      (generation) =>
        generation.exited.then(() => {
          if (this.current === pending) this.current = null;
          return undefined;
        }),
      () => undefined,
    );
    void pending.then(
      () => this.starts.delete(pending),
      () => this.starts.delete(pending),
    );
    return pending;
  }

  private async start(
    selection: OpenCodeServiceSelection,
    dedicatedEnv?: Record<string, string>,
    wrap?: LaunchWrap,
  ): Promise<Generation> {
    if (selection.kind !== "owned") {
      const generation: Generation = {
        ...(await connectSharedService(selection, this.options)),
        users: 0,
      };
      this.generations.add(generation);
      return generation;
    }

    const { settings, managedProcesses, logger } = this.options;
    const launch = await resolveProviderLaunch({
      commandConfig: settings?.command,
      defaultBinary: "opencode",
    });
    const cwd = resolveOpenCodeHomeDir();
    await mkdir(cwd, { recursive: true });
    const password = randomBytes(32).toString("base64url");
    const inheritedConfig = globalThis.process.env.OPENCODE_CONFIG_CONTENT;
    let configured: Record<string, string> = {
      ...(inheritedConfig ? { OPENCODE_CONFIG_CONTENT: inheritedConfig } : {}),
      ...settings?.env,
      ...dedicatedEnv,
    };
    const injection = this.options.providerConfigInjection
      ? await this.options.providerConfigInjection()
      : null;
    if (injection) {
      // Spec 34.3: merge the daemon-managed provider into the inherited config;
      // the user's other providers and global files stay untouched.
      const merged = mergeOpenCodeConfigContent(
        configured.OPENCODE_CONFIG_CONTENT ?? inheritedConfig,
        injection,
      );
      configured = { ...configured, OPENCODE_CONFIG_CONTENT: merged };
    }
    const bridge = this.options.bridge;
    const plugin = bridge
      ? await bridge.materializeV2Plugin()
      : await materializeOpenCodeV2Plugin(resolveJAgentDeskHome());
    const globalConfig = openCodeConfigDirectory({ ...globalThis.process.env, ...configured });
    const managed = await hasManagedBridge(globalConfig);
    if (managed && bridge)
      await provisionLocalBridge({
        configDirectory: globalConfig,
        artifact: path.join(fileURLToPath(plugin), "server.js"),
      });
    let decorated = configured;
    if (this.options.decorateEnv) {
      decorated = await this.options.decorateEnv(configured);
    } else if (!managed) {
      decorated = decorateOpenCodeV2Env(
        configured,
        plugin,
        bridge ? {} : { mode: "structured-only" },
      );
    }
    const args = [...launch.args, "serve", "--hostname", "127.0.0.1", "--port", "0"];
    const process = spawnProcess(launch.command, args, {
      cwd,
      detached: globalThis.process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      wrap,
      ...createProviderEnvSpec({
        runtimeSettings: settings,
        overlays: [{ ...decorated, OPENCODE_PASSWORD: password }],
      }),
    });
    const processAbort = new AbortController();
    const exited = new Promise<Error>((resolve) =>
      process.once("exit", (code) => {
        const error = new Error(`OpenCode helper server exited (${code})`);
        processAbort.abort(error);
        resolve(error);
      }),
    );
    let stopped: Promise<void> | undefined;
    const record =
      process.pid && managedProcesses
        ? managedProcesses
            .record({
              owner: { provider: "opencode", kind: "helper-server" },
              pid: process.pid,
              command: launch.command,
              args,
            })
            .catch((error: unknown) => {
              logger.warn({ error }, "Could not record OpenCode helper process");
              return null;
            })
        : Promise.resolve(null);
    const stop = () => {
      stopped ??= (async () => {
        await terminateWithTreeKill(process, { gracefulTimeoutMs: 5_000, forceTimeoutMs: 1_000 });
        const entry = await record;
        if (entry) await managedProcesses?.remove(entry.id);
      })();
      return stopped;
    };
    const deadline = Date.now() + 30_000;
    try {
      const url = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(
          () => finish(new Error("OpenCode v2 server startup timed out after 30s")),
          30_000,
        );
        let buffer = "";
        const finish = (result: string | Error) => {
          clearTimeout(timer);
          process.stdout?.off("data", onData);
          process.off("error", onError);
          process.off("exit", onExit);
          if (result instanceof Error) reject(result);
          else resolve(result);
        };
        const onData = (chunk: Buffer) => {
          buffer = (buffer + chunk.toString()).slice(-8192);
          const match = buffer.match(/server listening on (http:\/\/127\.0\.0\.1:\d+)(?:\r?\n)/);
          if (match) finish(match[1]);
        };
        const onError = (error: Error) => finish(error);
        const onExit = (code: number | null) =>
          finish(new Error(`OpenCode v2 server exited during startup (${code})`));
        process.stdout?.on("data", onData);
        process.once("error", onError);
        process.once("exit", onExit);
        // Drain stderr without retaining provider output that may contain credentials.
        process.stderr?.on("data", () => undefined);
      });
      const client = OpenCode.make({
        baseUrl: url,
        headers: {
          Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`,
        },
        fetch: async (request, init) => {
          const signal = init?.signal
            ? AbortSignal.any([init.signal, processAbort.signal])
            : processAbort.signal;
          const response = await fetch(request, { ...init, signal });
          return validateOpenCodeResponse(request, response);
        },
      });
      const info = await client.server.info({
        signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
      });
      const generation: Generation = {
        client,
        users: 0,
        stop,
        exited,
        ...bridgeBindings(client, bridge, undefined, undefined, {
          logger,
          version: info.version,
          dedicated: dedicatedEnv !== undefined,
        }),
      };
      this.generations.add(generation);
      process.once("exit", () => {
        this.generations.delete(generation);
        void stop().catch((error: unknown) =>
          logger.warn({ error }, "OpenCode process cleanup failed"),
        );
      });
      return generation;
    } catch (error) {
      await stop();
      throw error;
    }
  }
}

function assertWrappable(
  input: V2RuntimeAcquireOptions,
  selection: OpenCodeServiceSelection,
): void {
  if (input.wrap && selection.kind === "explicit")
    throw new Error(
      "OpenCode is configured to use an existing server, so JAgentDesk cannot start it behind a launch wrap",
    );
}
