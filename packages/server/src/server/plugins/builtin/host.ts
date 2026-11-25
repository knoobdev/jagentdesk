import type { BuiltinPluginId } from "@jagentdesk/protocol/builtin-plugins";
import type { SessionInboundMessage, SessionOutboundMessage } from "../../messages.js";
import type { TerminalManager } from "../../../terminal/terminal-manager.js";
import type { RemoteDockerHosts } from "../../ssh/remote-docker/hosts.js";
import type { RemoteK8sClusters } from "../../ssh/remote-k8s/service.js";
import type { RemoteDbTunnels } from "../../ssh/remote-db/service.js";
import type { ClusterRegistry } from "../../cluster/cluster-registry.js";
import type { DatabaseRegistry } from "../../database/database-registry.js";
import type { JAgentDeskToolHostDependencies } from "../../agent/tools/jagentdesk-tools.js";
import type {
  JAgentDeskToolConfig,
  JAgentDeskToolExecutionContext,
  JAgentDeskToolResult,
} from "../../agent/tools/types.js";
import type { Bot } from "@jagentdesk/protocol/bots/types";
import type { AgentPermissionResponse } from "../../agent/agent-sdk-types.js";
import type { BotTrigger } from "../../bots/service.js";
import type { BuiltinCoreServices } from "./services.js";
import {
  BuiltinPluginError,
  type BuiltinPluginLifecycle,
  type BuiltinPluginState,
} from "./state.js";

/**
 * One value per daemon, shared by a feature's background service, sessions and tool catalogs.
 * Every services object of a daemon carries that daemon's config store, which keys the value.
 */
export interface BuiltinDaemonSlot<T> {
  get(services: BuiltinCoreServices): T | undefined;
  set(services: BuiltinCoreServices, value: T): void;
}
export function createDaemonSlot<T>(): BuiltinDaemonSlot<T> {
  const values = new WeakMap<object, T>();
  return {
    get: (services) => values.get(services.config),
    set: (services, value) => {
      values.set(services.config, value);
    },
  };
}

export type RegisterBuiltinTool = <Input>(
  name: string,
  config: JAgentDeskToolConfig,
  handler: (input: Input, context: JAgentDeskToolExecutionContext) => Promise<JAgentDeskToolResult>,
) => void;
/** A daemon-wide service created by `backgroundService`; resolve it per daemon with `service()`. */
export interface BuiltinServiceHandle<T> {
  readonly id: BuiltinPluginId;
  readonly key: symbol;
  /** Phantom type marker; never read. */
  readonly type?: T;
}
export type BuiltinServiceLookup = <T>(handle: BuiltinServiceHandle<T>) => T | undefined;
export interface BuiltinHostToolPermissionRequest {
  name: string;
  kind: string;
  title?: string;
  description?: string;
  input?: Record<string, unknown>;
}
/**
 * Per-agent inputs available while a feature installs its tools into one agent's catalog.
 * Approval stays in core; the feature only asks for it.
 */
export interface BuiltinToolContext {
  callerAgentId: string | null;
  /** Labels of the calling agent when the catalog is built. */
  callerLabels(): Readonly<Record<string, string>> | undefined;
  /** The calling agent's non-empty title, for permission prompts. */
  callerAgentTitle(): string | null;
  requestPermission(
    agentId: string,
    request: BuiltinHostToolPermissionRequest,
  ): Promise<AgentPermissionResponse>;
  requestHostToolPermission?: JAgentDeskToolHostDependencies["requestHostToolPermission"];
  clusters?: ClusterRegistry;
  databases?: DatabaseRegistry;
  /** Daemon core services; absent in catalogs built without a daemon. */
  services?: BuiltinCoreServices;
  service: BuiltinServiceLookup;
  provided: BuiltinProvidedLookup;
}
export type BuiltinAgentToolContext = BuiltinToolContext;
export interface BuiltinAgentToolOptions {
  /** Catalog position. Core installs each slot where the tools were registered before migration. */
  slot?: string;
}
/**
 * Which tools one catalog position installs: the tools registered in `slot` (default
 * `"default"`), restricted to `only` (in that order) or to every feature not in `except`.
 */
export interface BuiltinToolSelection {
  slot?: string;
  only?: readonly BuiltinPluginId[];
  except?: readonly BuiltinPluginId[];
}
export interface BuiltinBotTriggerContext {
  now: number;
  state(key: string): number | undefined;
  setState(key: string, value: number): void;
  service: BuiltinServiceLookup;
}
export interface BuiltinBotTriggerSource {
  /** Source name in logs and on each trigger. */
  name: string;
  poll(bot: Bot, context: BuiltinBotTriggerContext): Promise<BotTrigger[]>;
}
/**
 * Services one built-in offers the built-ins that require it. Core declares each contract so a
 * feature never imports another feature; the consumer's `requires` keeps the provider enabled.
 */
export interface BuiltinProvidedServices {
  /** Devices: install one app file on several iOS simulators (Workbench's sim_install_batch). */
  "devices.simulator-installer": {
    installOnMany(
      udids: string[],
      filePath: string,
    ): Promise<{ udid: string; ok: boolean; error: string | null }[]>;
  };
}
export type BuiltinProvidedLookup = <K extends keyof BuiltinProvidedServices>(
  key: K,
) => BuiltinProvidedServices[K] | undefined;
export interface BuiltinSessionServices extends BuiltinCoreServices {
  service: BuiltinServiceLookup;
  provided: BuiltinProvidedLookup;
  /**
   * Whether this client declared a client capability (for example binary screen frames);
   * re-read on `capabilitiesChanged`.
   */
  supportsClientCapability(capability: string): boolean;
  /** Bytes queued on this client's transport, or null when unknown (backpressure). */
  transportBufferedAmount(): number | null;
  terminals?: TerminalManager | null;
  remoteDocker: () => RemoteDockerHosts | undefined;
  remoteK8s: () => RemoteK8sClusters | undefined;
  remoteDb: () => RemoteDbTunnels | undefined;
  push(message: SessionOutboundMessage): void;
  pushBinary(frame: Uint8Array): void;
}
export interface BuiltinSessionContribution {
  handle(message: SessionInboundMessage): void | Promise<void>;
  /** Synchronous cancellation must precede awaited teardown. Called on toggle and disconnect. */
  stop(): void | Promise<void>;
  start?(): void | Promise<void>;
  /** The client re-sent its capabilities. */
  capabilitiesChanged?(): void;
}
export interface BuiltinRpcOptions {
  /**
   * Create the contribution when the session opens (and on enable), not on the first request.
   * Use it when the contribution forwards daemon pushes or registers a delegate the client
   * relies on before sending any request.
   */
  eager?: boolean;
}
export type BuiltinSessionOptions = BuiltinRpcOptions;
export interface BuiltinBackgroundService {
  start(signal: AbortSignal): void | Promise<void>;
  stop(): void | Promise<void>;
  /** Called once when the daemon starts with the plugin turned off. */
  idle?(): void | Promise<void>;
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
    options?: BuiltinRpcOptions,
  ): void;
  /** One instance per daemon, started and stopped with the plugin. */
  backgroundService<T extends BuiltinBackgroundService>(
    create: (services: BuiltinCoreServices) => T,
  ): BuiltinServiceHandle<T>;
  agentTools(
    register: (registerTool: RegisterBuiltinTool, context: BuiltinToolContext) => void,
    options?: BuiltinAgentToolOptions,
  ): void;
  /** One value per daemon, shared by its background service, sessions and tools. */
  shared<T>(create: (services: BuiltinCoreServices) => T): (services: BuiltinCoreServices) => T;
  /** Bots poll every registered source while this plugin is enabled. */
  botTriggerSource(source: BuiltinBotTriggerSource): void;
  provide<K extends keyof BuiltinProvidedServices>(key: K, value: BuiltinProvidedServices[K]): void;
}
interface RpcRegistration {
  id: BuiltinPluginId;
  namespace: string;
  methods: readonly SessionInboundMessage["type"][];
  create: (services: BuiltinSessionServices) => BuiltinSessionContribution;
  eager: boolean;
}
interface ToolRegistration {
  id: BuiltinPluginId;
  install: (registerTool: RegisterBuiltinTool, context: BuiltinToolContext) => void;
  slot: string;
}
interface BackgroundRegistration {
  key: symbol;
  create: (services: BuiltinCoreServices) => BuiltinBackgroundService;
}
const DEFAULT_TOOL_SLOT = "default";

export class BuiltinServerRegistry {
  private readonly rpcs = new Map<string, RpcRegistration>();
  private readonly backgrounds = new Map<BuiltinPluginId, BackgroundRegistration>();
  private readonly tools: ToolRegistration[] = [];
  private readonly providedServices = new Map<string, unknown>();
  private readonly triggers = new Map<BuiltinPluginId, BuiltinBotTriggerSource>();
  /** Daemon services keyed by daemon home: several daemons can share one test process. */
  private readonly scopes = new Map<string, Map<symbol, BuiltinBackgroundService>>();
  forPlugin(id: BuiltinPluginId): BuiltinServerHost {
    return {
      id,
      rpc: (namespace, methods, create, options) => {
        if (!/^[a-z][a-z0-9_.-]*[./]$/.test(namespace))
          throw new Error(`Invalid RPC namespace for ${id}`);
        const registration = { id, namespace, methods, create, eager: options?.eager === true };
        for (const method of methods) {
          if (!method.startsWith(namespace) || this.rpcs.has(method))
            throw new Error(`Invalid or duplicate built-in RPC: ${method}`);
          this.rpcs.set(method, registration);
        }
      },
      backgroundService: <T extends BuiltinBackgroundService>(
        create: (services: BuiltinCoreServices) => T,
      ) => {
        if (this.backgrounds.has(id))
          throw new Error(`Duplicate built-in background service: ${id}`);
        const key = Symbol(id);
        this.backgrounds.set(id, { key, create });
        const handle: BuiltinServiceHandle<T> = { id, key };
        return handle;
      },
      agentTools: (install, options) => {
        const slot = options?.slot ?? DEFAULT_TOOL_SLOT;
        if (this.tools.some((tools) => tools.id === id && tools.slot === slot))
          throw new Error(`Duplicate built-in tools: ${id}/${slot}`);
        this.tools.push({ id, install, slot });
      },
      shared: (create) => {
        // Keyed by the daemon's config store: every session and tool catalog of one daemon shares it.
        const values = new WeakMap<object, ReturnType<typeof create>>();
        return (services) => {
          if (!values.has(services.config)) values.set(services.config, create(services));
          return values.get(services.config)!;
        };
      },
      provide: (key, value) => {
        if (this.providedServices.has(key)) throw new Error(`Duplicate provided service: ${key}`);
        this.providedServices.set(key, value);
      },
      botTriggerSource: (source) => {
        if (this.triggers.has(id)) throw new Error(`Duplicate built-in bot trigger source: ${id}`);
        this.triggers.set(id, source);
      },
    };
  }
  provided: BuiltinProvidedLookup = (key) =>
    this.providedServices.get(key) as BuiltinProvidedServices[typeof key] | undefined;
  /** Resolves a daemon service for the daemon rooted at `home`. */
  lookup(home: string): BuiltinServiceLookup {
    return <T>(handle: BuiltinServiceHandle<T>) =>
      this.scopes.get(home)?.get(handle.key) as T | undefined;
  }
  /** Enabled sources only; the daemon's bot runtime polls them after its own GitHub source. */
  botTriggerSources(
    state: Pick<BuiltinPluginState, "isEnabled"> | undefined,
    home: string,
  ): {
    name: string;
    poll(bot: Bot, context: Omit<BuiltinBotTriggerContext, "service">): Promise<BotTrigger[]>;
  }[] {
    const service = this.lookup(home);
    return [...this.triggers]
      .filter(([id]) => !state || state.isEnabled(id))
      .map(([, source]) => ({
        name: source.name,
        poll: (bot, context) => source.poll(bot, { ...context, service }),
      }));
  }
  async start(
    state: BuiltinPluginState,
    services: BuiltinCoreServices,
  ): Promise<() => Promise<void>> {
    const running: BuiltinPluginLifecycle[] = [];
    const scope = new Map<symbol, BuiltinBackgroundService>();
    this.scopes.set(services.home, scope);
    // Create every service before starting any, so a session or tool never sees a partial scope.
    const created = [...this.backgrounds].map(([id, { key, create }]) => {
      const service = create(services);
      scope.set(key, service);
      return [id, service] as const;
    });
    for (const [id, service] of created) {
      const lifecycle = backgroundLifecycle(id, service);
      await state.registerLifecycle(id, lifecycle);
      if (!state.isEnabled(id)) await lifecycleDeadline(id, "stop", () => service.idle?.());
      running.push(lifecycle);
    }
    // Dependents load after what they require; stop them first.
    return async () => {
      for (const lifecycle of running.toReversed()) {
        await Promise.resolve(lifecycle.stop()).catch((error: unknown) => {
          services.logger.error({ err: error }, "Built-in shutdown failed");
        });
      }
      if (this.scopes.get(services.home) === scope) this.scopes.delete(services.home);
    };
  }
  toolSlots(): string[] {
    return [...new Set(this.tools.map((tools) => tools.slot))];
  }
  rpcNames(): string[] {
    return [...this.rpcs.keys()].sort();
  }
  owns(type: string): boolean {
    return this.rpcs.has(type);
  }
  /**
   * Installs feature tools at one catalog position. A string selects a slot. Core calls each
   * position where the features' tools were registered before migration, so the order agents see
   * does not change.
   */
  registerAgentTools(
    snapshot: ReadonlySet<BuiltinPluginId> | undefined,
    register: RegisterBuiltinTool,
    reserve?: (name: string) => void,
    context: Partial<BuiltinToolContext> = {},
    selection: BuiltinToolSelection | string = {},
  ): void {
    const select = typeof selection === "string" ? { slot: selection } : selection;
    const slot = select.slot ?? DEFAULT_TOOL_SLOT;
    const toolContext: BuiltinToolContext = {
      ...context,
      callerAgentId: context.callerAgentId ?? null,
      callerLabels: context.callerLabels ?? (() => undefined),
      callerAgentTitle: context.callerAgentTitle ?? (() => null),
      requestPermission:
        context.requestPermission ??
        (() => Promise.reject(new Error("Tool permission requests are unavailable"))),
      service: context.service ?? (() => undefined),
      provided: this.provided,
    };
    const inSlot = this.tools.filter((tools) => tools.slot === slot);
    const selected = select.only
      ? select.only.flatMap((id) => inSlot.filter((tools) => tools.id === id))
      : inSlot.filter((tools) => !select.except?.includes(tools.id));
    for (const tools of selected) {
      tools.install((name, config, handler) => {
        // Keep names reserved while disabled so installed hooks cannot replace core tools.
        reserve?.(name);
        if (!snapshot || snapshot.has(tools.id)) register(name, config, handler);
      }, toolContext);
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
  private readonly ready = new Map<RpcRegistration, Promise<BuiltinSessionContribution>>();
  private readonly unsubscribe: (() => void) | undefined;
  private pending = Promise.resolve();
  private disposed = false;
  private readonly active = new Set<RpcRegistration>();
  constructor(
    private readonly rpcs: ReadonlyMap<string, RpcRegistration>,
    private readonly state: BuiltinPluginState | undefined,
    private readonly services: BuiltinSessionServices,
  ) {
    this.pending = Promise.all(
      [...this.eagerRegistrations()]
        .filter((registration) => !state || state.isEnabled(registration.id))
        .map((registration) => this.ensure(registration)),
    )
      .then(() => undefined)
      .catch((error) => {
        services.logger.error({ err: error }, "Built-in session start failed");
      });
    this.unsubscribe = state?.subscribe(() => {
      // Begin cancellation in the config notification turn, before any further incoming RPC.
      const operations: Promise<void>[] = [];
      for (const registration of this.eagerRegistrations())
        if (!this.instances.has(registration) && state.isEnabled(registration.id))
          operations.push(this.pending.then(() => this.ensure(registration)).then(() => undefined));
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
  /** The client re-sent its capabilities. */
  capabilitiesChanged(): void {
    for (const [registration, instance] of this.instances)
      if (this.active.has(registration)) instance.capabilitiesChanged?.();
  }
  dispatch(message: SessionInboundMessage): Promise<void> | undefined {
    const registration = this.rpcs.get(message.type);
    if (!registration) return undefined;
    return this.invoke(registration, message);
  }
  private async invoke(
    registration: RpcRegistration,
    message: SessionInboundMessage,
  ): Promise<void> {
    if (this.disposed || (this.state && !this.state.isEnabled(registration.id)))
      throw new BuiltinPluginError("plugin_disabled", `Plugin turned off: ${registration.id}`);
    await this.pending;
    if (this.disposed || (this.state && !this.state.isEnabled(registration.id)))
      throw new BuiltinPluginError("plugin_disabled", `Plugin turned off: ${registration.id}`);
    const instance = await this.ensure(registration);
    await instance.handle(message);
  }
  private eagerRegistrations(): Set<RpcRegistration> {
    return new Set([...this.rpcs.values()].filter((registration) => registration.eager));
  }
  private ensure(registration: RpcRegistration): Promise<BuiltinSessionContribution> {
    const existing = this.ready.get(registration);
    if (existing) return existing;
    if (this.disposed)
      return Promise.reject(
        new BuiltinPluginError("plugin_disabled", `Plugin turned off: ${registration.id}`),
      );
    const contribution = registration.create(this.services);
    const instance: BuiltinSessionContribution = {
      handle: (input) => contribution.handle(input),
      stop: () => lifecycleDeadline(registration.id, "stop", () => contribution.stop()),
      ...(contribution.start
        ? {
            start: () => lifecycleDeadline(registration.id, "start", () => contribution.start?.()),
          }
        : {}),
      ...(contribution.capabilitiesChanged
        ? { capabilitiesChanged: () => contribution.capabilitiesChanged?.() }
        : {}),
    };
    this.instances.set(registration, instance);
    this.active.add(registration);
    const ready = Promise.resolve(instance.start?.()).then(() => instance);
    this.ready.set(registration, ready);
    return ready;
  }
  async dispose(): Promise<void> {
    this.disposed = true;
    this.unsubscribe?.();
    await this.pending;
    await Promise.all([...this.instances.values()].map((instance) => instance.stop()));
    this.instances.clear();
    this.ready.clear();
  }
}
