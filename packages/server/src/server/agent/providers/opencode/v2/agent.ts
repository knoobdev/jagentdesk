import { OpenCodeV2Session } from "./session.js";
import { V2_CAPABILITIES } from "./capabilities.js";
import {
  permissionRules,
  applyResumeOverrides,
  controls,
  requiresDedicatedV2Server,
} from "./configuration.js";
import { SessionMcp } from "./session-mcp.js";
import { commands } from "./commands.js";
import { waitForLocationReady } from "./readiness.js";
import { type SessionInfo } from "@opencode/client";
import { type Logger } from "pino";
import {
  type AgentCapabilityFlags,
  type AgentClient,
  type AgentCreateSessionOptions,
  type AgentResumeSessionOptions,
  type AgentLaunchContext,
  type AgentPersistenceHandle,
  type AgentSession,
  type AgentSessionConfig,
  type FetchCatalogOptions,
  type ImportableProviderSession,
  type ImportProviderSessionInput,
  type ImportProviderSessionContext,
  type ListImportableSessionsOptions,
  type ProviderRefreshContext,
  type AgentDraftControls,
} from "../../../agent-sdk-types.js";
import {
  createProviderEnv,
  type ProviderRuntimeSettings,
} from "../../../provider-launch-config.js";
import { type ManagedProcessRegistry } from "../../../../managed-processes/managed-processes.js";
import { importSessionFromPersistence } from "../../../provider-session-import.js";
import { type OpenCodeBridge } from "../bridge.js";
import { resolveOpenCodeHomeDir } from "../paths.js";
import { V2Runtime, type V2Connection, type V2RuntimeAcquireOptions } from "./runtime.js";
import { type OpenCodeProviderInjection } from "../../../../custom-providers/materialization.js";
import { type OpenCodeServiceSelection } from "./service-selection.js";
import { modelRef, modesFromV2, modelsFromV2 } from "./mapping.js";

interface PreparedLaunch {
  launch: AgentLaunchContext | undefined;
  /** The complete shell environment, when the launch sets one. */
  environment: Record<string, string> | undefined;
  mcp?: SessionMcp;
  /** Spec 33.7 legacy path: `mcp.add` on a server of the agent's own. */
  legacy?: boolean;
}

type V2AgentRuntime = Pick<V2Runtime, "acquire" | "shutdown"> & Partial<Pick<V2Runtime, "retire">>;

/**
 * A wrapped launch gets a server of its own, started behind the wrap with the launch's environment,
 * so it never shares a server that runs outside its wrap.
 */
function wrappedServer(
  launch: AgentLaunchContext | undefined,
): V2RuntimeAcquireOptions | undefined {
  return launch?.wrap ? { dedicated: true, env: launch.env, wrap: launch.wrap } : undefined;
}

interface ResumeTarget {
  handle: AgentPersistenceHandle;
  overrides: Partial<AgentSessionConfig> | undefined;
  launch: AgentLaunchContext | undefined;
  historyOnly: boolean;
}

interface V2AgentOptions {
  logger: Logger;
  settings?: ProviderRuntimeSettings;
  managedProcesses?: ManagedProcessRegistry;
  bridge?: OpenCodeBridge;
  runtime?: V2AgentRuntime;
  providerConfigInjection?: () => Promise<OpenCodeProviderInjection | null>;
  selection?: OpenCodeServiceSelection;
}

export class OpenCodeV2AgentClient implements AgentClient {
  readonly provider = "opencode";

  readonly capabilities: AgentCapabilityFlags;

  private readonly runtime: V2AgentRuntime;

  private readonly connections = new Map<string, V2Connection>();

  constructor(private readonly options: V2AgentOptions) {
    this.capabilities = {
      ...V2_CAPABILITIES,
      supportsNativeJAgentDeskTools: Boolean(options.bridge),
    };
    this.runtime =
      options.runtime ??
      new V2Runtime({
        ...options,
      });
  }

  async isAvailable() {
    return true;
  }

  async shutdown() {
    await this.runtime.shutdown();
  }

  async retire() {
    await this.runtime.retire?.();
  }

  async fetchCatalog(options: FetchCatalogOptions, context?: ProviderRefreshContext) {
    const connection = await this.runtime.acquire({
      fresh: options.force,
      signal: context?.signal,
    });
    const location = {
      directory: options.scope === "workspace" ? options.cwd : resolveOpenCodeHomeDir(),
    };
    const request = { signal: context?.signal };
    const activity = <T>(name: string, operation: () => Promise<T>) =>
      context ? context.runActivity(name, operation) : operation();
    try {
      await activity("plugin.list", () =>
        waitForLocationReady({ client: connection.client, location, signal: request.signal }),
      );
      if (options.force)
        await activity("jagentdesk.bridge.refresh", () =>
          connection.refreshLocation(location.directory, request.signal),
        );
      const [models, agents, providers] = await Promise.all([
        activity("model.list", () => connection.client.model.list({ location }, request)),
        activity("agent.list", () => connection.client.agent.list({ location }, request)),
        activity("provider.list", () => connection.client.provider.list({ location }, request)),
      ]);
      if (!providers.data.length)
        throw new Error(
          "OpenCode has no connected providers. Authenticate using opencode auth login.",
        );
      return { models: modelsFromV2(models.data), modes: modesFromV2(agents.data) };
    } finally {
      await connection.release();
    }
  }
  async createSession(
    config: AgentSessionConfig,
    launch?: AgentLaunchContext,
    options?: AgentCreateSessionOptions,
  ): Promise<AgentSession> {
    const { connection, prepared } = await this.connectLaunch(config, launch, false);
    try {
      const info = await connection.client.session.create({
        location: { directory: config.cwd },
        title: config.title,
        agent: config.modeId ?? "build",
        model: config.model ? modelRef(config.model, config.thinkingOptionId) : undefined,
        permissions: permissionRules(config),
      });
      return await this.attach(
        connection,
        info,
        config,
        prepared,
        options?.persistSession !== false,
      );
    } catch (error) {
      await connection.release();
      await prepared.mcp?.close();
      throw error;
    }
  }
  async resumeSession(
    handle: AgentPersistenceHandle,
    overrides?: Partial<AgentSessionConfig>,
    launch?: AgentLaunchContext,
    options?: AgentResumeSessionOptions,
  ): Promise<AgentSession> {
    return this.resumeOn(
      // A live connection may run outside this launch's wrap, so a wrapped resume starts its own.
      () =>
        launch?.wrap
          ? undefined
          : this.connections.get(handle.nativeHandle ?? handle.sessionId)?.retain(),
      { handle, overrides, launch, historyOnly: options?.purpose === "history" },
    );
  }

  private async resumeOn(
    existing: () => V2Connection | undefined,
    { handle, overrides, launch, historyOnly }: ResumeTarget,
  ): Promise<AgentSession> {
    const cwd = overrides?.cwd ?? handle.metadata?.cwd;
    if (typeof cwd !== "string")
      throw new Error("OpenCode resume requires the original working directory");
    const config: AgentSessionConfig = {
      ...handle.metadata,
      ...overrides,
      provider: "opencode",
      cwd,
    };
    const { connection, prepared } = await this.connectLaunch(
      config,
      launch,
      historyOnly,
      existing(),
    );
    try {
      const info = await connection.client.session.get({
        sessionID: handle.nativeHandle ?? handle.sessionId,
      });
      await applyResumeOverrides(connection.client, info, overrides);
      return await this.attach(connection, info, config, prepared, true, historyOnly);
    } catch (error) {
      await connection.release();
      await prepared.mcp?.close();
      throw error;
    }
  }
  /**
   * Spec 33.7. An agent with its own MCP servers or process env runs on the shared server when
   * that server reports `features.mcpTools` (session path). Otherwise it keeps the legacy path:
   * a server of its own, with its MCP servers attached through `mcp.add`. The shared server
   * decides once; a session already open on a connection stays on it. A wrapped launch always
   * runs on a server of its own behind the wrap, which then decides the path the same way.
   */
  private async connectLaunch(
    config: AgentSessionConfig,
    launch: AgentLaunchContext | undefined,
    historyOnly: boolean,
    existing?: V2Connection,
  ): Promise<{ connection: V2Connection; prepared: PreparedLaunch }> {
    let connection = existing ?? (await this.runtime.acquire(wrappedServer(launch)));
    try {
      const isolated = !historyOnly && requiresDedicatedV2Server(config, launch);
      if (isolated && (await connection.mcpPath(config.cwd)) === "legacy") {
        if (!existing && !launch?.wrap) {
          const dedicated = await this.runtime.acquire({ env: launch?.env, dedicated: true });
          const shared = connection;
          connection = dedicated;
          await shared.release();
        }
        return {
          connection,
          prepared: { launch, environment: this.launchEnvironment(launch), legacy: true },
        };
      }
      return { connection, prepared: await this.prepareLaunch(config, launch, historyOnly) };
    } catch (error) {
      await connection.release();
      throw error;
    }
  }
  /** The complete shell environment, which OpenCode applies instead of its own. */
  private launchEnvironment(launch: AgentLaunchContext | undefined) {
    // Carries the whole launch env, including the browser and PATH shims, to every shell.
    return launch?.env
      ? createProviderEnv({ runtimeSettings: this.options.settings, overlays: [launch.env] })
      : undefined;
  }
  /**
   * Resolves what the session receives from its launch. OpenCode's own MCP servers are shared by
   * a location, so JAgentDesk hosts each session's servers itself, before OpenCode sees the session.
   */
  private async prepareLaunch(
    config: AgentSessionConfig,
    launch: AgentLaunchContext | undefined,
    historyOnly: boolean,
  ): Promise<PreparedLaunch> {
    const environment = this.launchEnvironment(launch);
    const servers = config.mcpServers ?? {};
    if (historyOnly || Object.keys(servers).length === 0) return { launch, environment };
    if (!this.options.bridge)
      throw new Error(
        "OpenCode MCP servers require the JAgentDesk tool bridge, which is not running",
      );
    const mcp = await SessionMcp.connect({
      servers,
      cwd: config.cwd,
      env: environment ?? createProviderEnv({ runtimeSettings: this.options.settings }),
      wrap: launch?.wrap,
    });
    return { launch, environment, mcp };
  }
  private async attach(
    connection: V2Connection,
    info: SessionInfo,
    config: AgentSessionConfig,
    { launch, environment, mcp, legacy }: PreparedLaunch,
    persist: boolean,
    historyOnly = false,
  ) {
    let ownedConnection = connection;
    const bridge = this.options.bridge;
    const bound = new Map<string, () => void>();
    const bindChild = (childId: string) => {
      this.connections.set(childId, ownedConnection);
      if (bound.has(childId)) return;
      const childUnbind = bridge?.bindSession({
        sessionId: childId,
        env: launch?.env ?? {},
        tools: launch?.jagentdeskTools,
      });
      if (childUnbind) bound.set(childId, childUnbind);
    };
    // The bridge serves descendants before the session exists, so it reads the session late.
    let session: OpenCodeV2Session | undefined;
    let unbind: (() => void) | undefined;
    unbind = bridge?.bindSession({
      sessionId: info.id,
      env: launch?.env ?? {},
      tools: launch?.jagentdeskTools,
      mcp,
      adoptDescendant: async (childId) => {
        bindChild(childId);
        await session?.adoptDescendant(childId);
      },
    });
    this.connections.set(info.id, connection);
    const releaseBindings = () => {
      unbind?.();
      for (const cleanup of bound.values()) cleanup();
      for (const [id, owner] of this.connections)
        if (owner === ownedConnection) this.connections.delete(id);
    };
    const moved = (next: V2Connection) => {
      for (const [id, owner] of this.connections)
        if (owner === ownedConnection) this.connections.set(id, next);
      ownedConnection = next;
    };
    session = new OpenCodeV2Session({
      connection,
      info,
      config,
      logger: this.options.logger,
      persist,
      requiresJAgentDeskPlugin: Boolean(bridge),
      environment,
      mcp,
      legacyMcp: legacy,
      unbind: releaseBindings,
      bindChild,
      acquire: () =>
        this.runtime.acquire(
          wrappedServer(launch) ?? (legacy ? { env: launch?.env, dedicated: true } : undefined),
        ),
      moved,
      historyOnly,
    });
    session.expectedBridgeTools = bridge ? (launch?.jagentdeskTools?.tools.size ?? 0) : 0;
    try {
      await session.initialize();
      return session;
    } catch (error) {
      await session.close();
      throw error;
    }
  }
  async listControls(config: AgentSessionConfig): Promise<AgentDraftControls> {
    return { controls, options: config.providerOptions ?? {} };
  }
  async listCommands(config: AgentSessionConfig) {
    const connection = await this.runtime.acquire();
    try {
      return await commands(connection.client, config.cwd);
    } finally {
      await connection.release();
    }
  }
  async listImportableSessions(
    options: ListImportableSessionsOptions = {},
  ): Promise<ImportableProviderSession[]> {
    const connection = await this.runtime.acquire();
    try {
      const sessions: SessionInfo[] = [];
      let cursor: string | undefined;
      const scanLimit = Math.min(options.scanLimit ?? 100, 500);
      do {
        const page = await connection.client.session.list({
          ...(cursor ? { cursor } : { directory: options.cwd }),
          limit: Math.min(50, scanLimit - sessions.length),
        });
        sessions.push(...page.data);
        cursor = page.cursor.next ?? undefined;
      } while (cursor && sessions.length < scanLimit);
      return sessions
        .filter((info) => !info.parentID && !info.time.archived)
        .slice(0, options.limit ?? 50)
        .map((info) => ({
          providerHandleId: info.id,
          cwd: info.location.directory,
          title: info.title ?? null,
          firstPromptPreview: null,
          lastPromptPreview: null,
          lastActivityAt: new Date(info.time.updated),
        }));
    } finally {
      await connection.release();
    }
  }
  async importSession(input: ImportProviderSessionInput, context: ImportProviderSessionContext) {
    // The lookup and the resume share one connection, so a wrapped import never starts a server
    // outside its wrap.
    const launch = context.launchContext;
    const connection = await this.runtime.acquire(wrappedServer(launch));
    try {
      const info = await connection.client.session.get({ sessionID: input.providerHandleId });
      return await importSessionFromPersistence({
        provider: "opencode",
        request: input,
        context,
        resumeSession: (handle, overrides, resumeLaunch) =>
          launch?.wrap
            ? this.resumeOn(() => connection.retain(), {
                handle,
                overrides,
                launch: resumeLaunch,
                historyOnly: false,
              })
            : this.resumeSession(handle, overrides, resumeLaunch),
        config: {
          title: info.title,
          modeId: info.agent,
          model: info.model ? `${info.model.providerID}/${info.model.id}` : undefined,
        },
      });
    } finally {
      await connection.release();
    }
  }
}
