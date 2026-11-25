import type { BuiltinPluginId } from "@jagentdesk/protocol/builtin-plugins";
import type { ClientCapability } from "@jagentdesk/protocol/client-capabilities";
import type { SessionInboundMessage, SessionOutboundMessage } from "../../messages.js";
import type { TerminalManager } from "../../../terminal/terminal-manager.js";
import type { RemoteDockerHosts } from "../../ssh/remote-docker/hosts.js";
import type {
  JAgentDeskToolConfig,
  JAgentDeskToolExecutionContext,
  JAgentDeskToolResult,
} from "../../agent/tools/types.js";
import type { BuiltinCoreServices } from "./services.js";
import type { AgentManager, AgentManagerOptions } from "../../agent/agent-manager.js";
import type { AgentStorage } from "../../agent/agent-storage.js";
import type { SkillInvocationResolver } from "../../agent/agent-prompt.js";
import type { SpecPlanSource } from "../../agent/spec-plan.js";
import type { HostCapabilityService } from "../../host-capabilities/service.js";
import type { SpecModePhase } from "@jagentdesk/protocol/spec-mode";
import {
  BuiltinPluginError,
  type BuiltinPluginLifecycle,
  type BuiltinPluginState,
} from "./state.js";

export type RegisterBuiltinTool = <Input>(
  name: string,
  config: JAgentDeskToolConfig,
  handler: (input: Input, context: JAgentDeskToolExecutionContext) => Promise<JAgentDeskToolResult>,
) => void;
/**
 * Core-declared interfaces that core flows (prompt delivery, agent spawn, guest attach) consume
 * from a feature. A feature provides one through `host.provide`; core never imports the feature.
 */
export interface BuiltinPorts {
  /** Prompt delivery resolves attached skill ids to the provider's native invocation. */
  skillInvocation: SkillInvocationResolver;
  /** Spec mode's turn rewriting, agent launch environment, and per-agent state. */
  specMode: SpecModePort;
  /** The Plan view's spec-kit phases and tasks (activity graph). */
  specPlan: SpecPlanSource;
  /** Autonomous mode status, read by Spec mode (the two exclude each other). */
  autorun: AutorunPort;
  /** Insights records every billed turn (AgentManager `onUsageBilled`). */
  usageHistory: UsageHistoryPort;
}
export interface UsageHistoryPort {
  record(billed: Parameters<NonNullable<AgentManagerOptions["onUsageBilled"]>>[0]): void;
}
export interface AutorunPort {
  isRunning(agentId: string): Promise<boolean>;
}
export interface BuiltinPushNotice {
  title: string;
  body: string;
  data?: Record<string, string>;
}
export interface SpecModePort {
  /** The pending phase's spec-kit command for this message; null when Spec mode is off. */
  prepareUserMessage(
    agentId: string,
    text: string,
  ): Promise<{ phase: SpecModePhase; text: string } | null>;
  revertPhaseStart(agentId: string, phase: SpecModePhase): Promise<void>;
  isEnabled(agentId: string): Promise<boolean>;
  launchEnv(agentId: string): Record<string, string> | null;
}
export type BuiltinPortKey = keyof BuiltinPorts;
/** Daemon-owned dependencies a feature's daemon service may use. */
export interface BuiltinDaemonDeps {
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  /** Push to every connected session. */
  broadcast(message: SessionOutboundMessage): void;
  /** Null until the daemon is listening and has probed the host. */
  hostCapabilities(): HostCapabilityService | null;
  /** Push notification to paired devices; the daemon adds its serverId to `data`. */
  sendPush(notice: BuiltinPushNotice): void;
}
export interface BuiltinDaemonContext extends BuiltinCoreServices, BuiltinDaemonDeps {
  /** The daemon home. Preserve a migrated feature's existing storage paths under it. */
  readonly home: string;
  isEnabled(id: BuiltinPluginId): boolean;
  /** Ports provided by built-ins registered before this one. */
  port<K extends BuiltinPortKey>(key: K): BuiltinPorts[K] | undefined;
  /** As `port`, but undefined while the providing built-in is turned off. */
  enabledPort<K extends BuiltinPortKey>(key: K): BuiltinPorts[K] | undefined;
}
export interface BuiltinDaemonRef<T> {
  get(scope: BuiltinDaemonScope | undefined): T | undefined;
}
export interface BuiltinToolContext {
  daemon?: BuiltinDaemonScope;
  callerAgentId?: string;
  agentManager: AgentManager;
}
export interface BuiltinSessionServices extends BuiltinCoreServices {
  daemon?: BuiltinDaemonScope;
  /** Whether the session's client advertised the capability (session-wide). */
  supports(capability: ClientCapability): boolean;
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  terminals?: TerminalManager | null;
  remoteDocker: () => RemoteDockerHosts | undefined;
  push(message: SessionOutboundMessage): void;
  pushBinary(frame: Uint8Array): void;
}
/** Per-request facts about the connection that sent it. */
export interface BuiltinRequestContext {
  supports(capability: ClientCapability): boolean;
}
export interface BuiltinSessionContribution {
  handle(message: SessionInboundMessage, request: BuiltinRequestContext): void | Promise<void>;
  /** Synchronous cancellation must precede awaited teardown. Called on toggle and disconnect. */
  stop(): void | Promise<void>;
  start?(): void | Promise<void>;
}
export interface BuiltinBackgroundService {
  start(signal: AbortSignal): void | Promise<void>;
  stop(): void | Promise<void>;
}
async function lifecycleDeadline(
  id: BuiltinPluginId,
  operation: "start" | "stop",
  work: () => void | Promise<void>,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve(work()),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Built-in ${id} ${operation} exceeded 5000 ms`)),
          5000,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
function backgroundLifecycle(
  id: BuiltinPluginId,
  service: BuiltinBackgroundService,
): BuiltinPluginLifecycle {
  let controller: AbortController | undefined;
  return {
    async start() {
      controller = new AbortController();
      const signal = controller.signal;
      try {
        await lifecycleDeadline(id, "start", () => service.start(signal));
      } catch (error) {
        controller.abort();
        throw error;
      }
    },
    stop() {
      controller?.abort();
      return lifecycleDeadline(id, "stop", () => service.stop());
    },
  };
}
export interface BuiltinServerHost {
  readonly id: BuiltinPluginId;
  /** Both dispatcher admission and dispatch are derived from these exact wire names. */
  rpc(
    namespace: string,
    methods: readonly SessionInboundMessage["type"][],
    create: (services: BuiltinSessionServices) => BuiltinSessionContribution,
  ): void;
  backgroundService(
    create: (services: BuiltinCoreServices, daemon: BuiltinDaemonScope) => BuiltinBackgroundService,
  ): void;
  /**
   * One instance per daemon, created when the daemon starts its built-ins, whether or not the
   * feature is enabled (matching phase 1 construction). Use a background service for work that
   * must stop while disabled.
   */
  daemonService<T>(
    create: (context: BuiltinDaemonContext) => T | Promise<T>,
    dispose?: (value: T) => void | Promise<void>,
  ): BuiltinDaemonRef<T>;
  provide<K extends BuiltinPortKey>(
    key: K,
    get: (daemon: BuiltinDaemonScope) => BuiltinPorts[K] | undefined,
  ): void;
  /** Core always supplies the context; host tests may omit it. */
  agentTools(
    register: (registerTool: RegisterBuiltinTool, context?: BuiltinToolContext) => void,
  ): void;
}
interface PortRegistration {
  id: BuiltinPluginId;
  get: (daemon: BuiltinDaemonScope) => unknown;
}
interface DaemonServiceRegistration {
  id: BuiltinPluginId;
  ref: BuiltinDaemonRef<unknown>;
  create: (context: BuiltinDaemonContext) => unknown;
  dispose?: (value: unknown) => void | Promise<void>;
}

/** Per-daemon instances of the built-ins' daemon services and ports. */
export class BuiltinDaemonScope {
  private readonly instances = new Map<BuiltinDaemonRef<unknown>, unknown>();
  private stopBackgrounds: () => Promise<void> = async () => {};
  constructor(
    private readonly ports: ReadonlyMap<BuiltinPortKey, PortRegistration>,
    private readonly disposers: readonly DaemonServiceRegistration[],
    private readonly state?: BuiltinPluginState,
  ) {}
  /** @internal */
  set<T>(ref: BuiltinDaemonRef<T>, value: T): void {
    this.instances.set(ref as BuiltinDaemonRef<unknown>, value);
  }
  /** @internal */
  read<T>(ref: BuiltinDaemonRef<T>): T | undefined {
    return this.instances.get(ref as BuiltinDaemonRef<unknown>) as T | undefined;
  }
  /** @internal */
  onStop(stop: () => Promise<void>): void {
    this.stopBackgrounds = stop;
  }
  port<K extends BuiltinPortKey>(key: K): BuiltinPorts[K] | undefined {
    return this.ports.get(key)?.get(this) as BuiltinPorts[K] | undefined;
  }
  /** Core flows that phase 1 gated on the providing feature use this. */
  enabledPort<K extends BuiltinPortKey>(key: K): BuiltinPorts[K] | undefined {
    const registration = this.ports.get(key);
    if (!registration || (this.state && !this.state.isEnabled(registration.id))) return undefined;
    return this.port(key);
  }
  async stop(): Promise<void> {
    await this.stopBackgrounds();
    for (const registration of this.disposers.toReversed()) {
      const value = this.instances.get(registration.ref);
      if (value !== undefined) await registration.dispose?.(value);
    }
  }
}
interface RpcRegistration {
  id: BuiltinPluginId;
  namespace: string;
  methods: readonly SessionInboundMessage["type"][];
  create: (services: BuiltinSessionServices) => BuiltinSessionContribution;
}

export class BuiltinServerRegistry {
  private readonly rpcs = new Map<string, RpcRegistration>();
  private readonly backgrounds = new Map<
    BuiltinPluginId,
    (services: BuiltinCoreServices, daemon: BuiltinDaemonScope) => BuiltinBackgroundService
  >();
  private readonly daemonServices: DaemonServiceRegistration[] = [];
  private readonly ports = new Map<BuiltinPortKey, PortRegistration>();
  private readonly tools = new Map<
    BuiltinPluginId,
    (register: RegisterBuiltinTool, context?: BuiltinToolContext) => void
  >();
  forPlugin(id: BuiltinPluginId): BuiltinServerHost {
    return {
      id,
      rpc: (namespace, methods, create) => {
        if (!/^[a-z][a-z0-9_.-]*[./]$/.test(namespace))
          throw new Error(`Invalid RPC namespace for ${id}`);
        const registration = { id, namespace, methods, create };
        for (const method of methods) {
          if (!method.startsWith(namespace) || this.rpcs.has(method))
            throw new Error(`Invalid or duplicate built-in RPC: ${method}`);
          this.rpcs.set(method, registration);
        }
      },
      backgroundService: (create) => {
        if (this.backgrounds.has(id))
          throw new Error(`Duplicate built-in background service: ${id}`);
        this.backgrounds.set(id, create);
      },
      daemonService: <T>(
        create: (context: BuiltinDaemonContext) => T | Promise<T>,
        dispose?: (value: T) => void | Promise<void>,
      ) => {
        const ref: BuiltinDaemonRef<T> = { get: (scope) => scope?.read(ref) };
        this.daemonServices.push({
          id,
          ref: ref as BuiltinDaemonRef<unknown>,
          create,
          dispose: dispose as ((value: unknown) => void | Promise<void>) | undefined,
        });
        return ref;
      },
      provide: (key, get) => {
        if (this.ports.has(key)) throw new Error(`Duplicate built-in port: ${key}`);
        this.ports.set(key, { id, get });
      },
      agentTools: (register) => {
        if (this.tools.has(id)) throw new Error(`Duplicate built-in tools: ${id}`);
        this.tools.set(id, register);
      },
    };
  }
  /**
   * Creates the daemon's services in plugin order, then registers background lifecycles.
   * Without daemon dependencies (host tests), daemon services are not created.
   */
  async start(
    state: BuiltinPluginState,
    services: BuiltinCoreServices,
    daemon?: BuiltinDaemonDeps & { home: string },
  ): Promise<BuiltinDaemonScope> {
    const scope = new BuiltinDaemonScope(this.ports, this.daemonServices, state);
    if (daemon) {
      const context: BuiltinDaemonContext = {
        ...services,
        ...daemon,
        isEnabled: (id) => state.isEnabled(id),
        port: (key) => scope.port(key),
        enabledPort: (key) => scope.enabledPort(key),
      };
      for (const registration of this.daemonServices)
        scope.set(registration.ref, await registration.create(context));
    }
    const running: BuiltinPluginLifecycle[] = [];
    for (const [id, create] of this.backgrounds) {
      const lifecycle = backgroundLifecycle(id, create(services, scope));
      await state.registerLifecycle(id, lifecycle);
      running.push(lifecycle);
    }
    scope.onStop(async () => {
      await Promise.all(running.map((lifecycle) => lifecycle.stop()));
    });
    return scope;
  }
  /** An empty daemon scope with this registry's ports, for tests that install instances. */
  createScope(state?: BuiltinPluginState): BuiltinDaemonScope {
    return new BuiltinDaemonScope(this.ports, this.daemonServices, state);
  }
  rpcNames(): string[] {
    return [...this.rpcs.keys()].sort();
  }
  owns(type: string): boolean {
    return this.rpcs.has(type);
  }
  /**
   * `only` installs one plugin's tools at the catalog position its phase 1 registration held,
   * so the tool order agents see does not change.
   */
  registerAgentTools(
    snapshot: ReadonlySet<BuiltinPluginId> | undefined,
    register: RegisterBuiltinTool,
    reserve?: (name: string) => void,
    context?: BuiltinToolContext,
    only?: BuiltinPluginId,
  ): void {
    for (const [id, install] of this.tools) {
      if (only && id !== only) continue;
      install((name, config, handler) => {
        // Keep names reserved while disabled so installed hooks cannot replace core tools.
        reserve?.(name);
        if (!snapshot || snapshot.has(id)) register(name, config, handler);
      }, context);
    }
  }
  session(
    state: BuiltinPluginState | undefined,
    services: BuiltinSessionServices,
  ): BuiltinServerSession {
    return new BuiltinServerSession(this.rpcs, state, services);
  }
}

export class BuiltinServerSession {
  private readonly instances = new Map<RpcRegistration, BuiltinSessionContribution>();
  private readonly unsubscribe: (() => void) | undefined;
  private pending = Promise.resolve();
  private disposed = false;
  private readonly active = new Set<RpcRegistration>();
  constructor(
    private readonly rpcs: ReadonlyMap<string, RpcRegistration>,
    private readonly state: BuiltinPluginState | undefined,
    private readonly services: BuiltinSessionServices,
  ) {
    this.unsubscribe = state?.subscribe(() => {
      // Begin cancellation in the config notification turn, before any further incoming RPC.
      const operations: Promise<void>[] = [];
      for (const [registration, instance] of this.instances) {
        const enabled = state.isEnabled(registration.id);
        if (enabled === this.active.has(registration)) continue;
        if (enabled) {
          this.active.add(registration);
          operations.push(this.pending.then(() => instance.start?.()));
        } else {
          this.active.delete(registration);
          operations.push(Promise.resolve(instance.stop()));
        }
      }
      this.pending = Promise.all([this.pending, ...operations])
        .then(() => undefined)
        .catch((error) => {
          services.logger.error({ err: error }, "Built-in session lifecycle failed");
        });
    });
  }
  dispatch(
    message: SessionInboundMessage,
    request: BuiltinRequestContext = { supports: () => false },
  ): Promise<void> | undefined {
    const registration = this.rpcs.get(message.type);
    if (!registration) return undefined;
    return this.invoke(registration, message, request);
  }
  private async invoke(
    registration: RpcRegistration,
    message: SessionInboundMessage,
    request: BuiltinRequestContext,
  ): Promise<void> {
    if (this.disposed || (this.state && !this.state.isEnabled(registration.id)))
      throw new BuiltinPluginError("plugin_disabled", `Plugin turned off: ${registration.id}`);
    await this.pending;
    if (this.disposed || (this.state && !this.state.isEnabled(registration.id)))
      throw new BuiltinPluginError("plugin_disabled", `Plugin turned off: ${registration.id}`);
    let instance = this.instances.get(registration);
    if (!instance) {
      const contribution = registration.create(this.services);
      instance = {
        handle: (input, context) => contribution.handle(input, context),
        stop: () => lifecycleDeadline(registration.id, "stop", () => contribution.stop()),
        ...(contribution.start
          ? {
              start: () =>
                lifecycleDeadline(registration.id, "start", () => contribution.start?.()),
            }
          : {}),
      };
      this.instances.set(registration, instance);
      this.active.add(registration);
      await instance.start?.();
    }
    await instance.handle(message, request);
  }
  async dispose(): Promise<void> {
    this.disposed = true;
    this.unsubscribe?.();
    await this.pending;
    await Promise.all([...this.instances.values()].map((instance) => instance.stop()));
    this.instances.clear();
  }
}
