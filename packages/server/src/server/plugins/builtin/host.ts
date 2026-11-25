import type { BuiltinPluginId } from "@jagentdesk/protocol/builtin-plugins";
import type { SessionInboundMessage, SessionOutboundMessage } from "../../messages.js";
import type { TerminalManager } from "../../../terminal/terminal-manager.js";
import type { RemoteDockerHosts } from "../../ssh/remote-docker/hosts.js";
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
/** Per-agent catalog context: approval stays in core; the feature only asks for it. */
export interface BuiltinAgentToolContext {
  callerAgentId: string | null;
  /** The calling agent's non-empty title, for permission prompts. */
  callerAgentTitle(): string | null;
  requestPermission(
    agentId: string,
    request: BuiltinHostToolPermissionRequest,
  ): Promise<AgentPermissionResponse>;
  service: BuiltinServiceLookup;
  provided: BuiltinProvidedLookup;
}
export interface BuiltinAgentToolOptions {
  /** Catalog position. Core calls each slot where the tools were registered before migration. */
  slot?: string;
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
export interface BuiltinSessionOptions {
  /** Create the contribution with the session (and on enable), not on its first RPC. Use when
   * the contribution forwards daemon pushes the client listens for before sending any request. */
  eager?: boolean;
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
  /** Whether this client declared a client capability (for example binary screen frames). */
  supportsClientCapability(capability: string): boolean;
  /** Bytes queued on this client's transport, or null when unknown (backpressure). */
  transportBufferedAmount(): number | null;
  terminals?: TerminalManager | null;
  remoteDocker: () => RemoteDockerHosts | undefined;
  push(message: SessionOutboundMessage): void;
  pushBinary(frame: Uint8Array): void;
}
export interface BuiltinSessionContribution {
  handle(message: SessionInboundMessage): void | Promise<void>;
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
    options?: BuiltinSessionOptions,
  ): void;
  /** One instance per daemon, started and stopped with the plugin. */
  backgroundService<T extends BuiltinBackgroundService>(
    create: (services: BuiltinCoreServices) => T,
  ): BuiltinServiceHandle<T>;
  agentTools(
    register: (registerTool: RegisterBuiltinTool, context: BuiltinAgentToolContext) => void,
    options?: BuiltinAgentToolOptions,
  ): void;
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
  install: (registerTool: RegisterBuiltinTool, context: BuiltinAgentToolContext) => void;
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
      running.push(lifecycle);
    }
    return async () => {
      await Promise.all(running.map((lifecycle) => lifecycle.stop()));
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
  registerAgentTools(
    snapshot: ReadonlySet<BuiltinPluginId> | undefined,
    register: RegisterBuiltinTool,
    reserve?: (name: string) => void,
    context: Partial<BuiltinAgentToolContext> = {},
    slot: string = DEFAULT_TOOL_SLOT,
  ): void {
    const toolContext: BuiltinAgentToolContext = {
      callerAgentId: context.callerAgentId ?? null,
      callerAgentTitle: context.callerAgentTitle ?? (() => null),
      requestPermission:
        context.requestPermission ??
        (() => Promise.reject(new Error("Tool permission requests are unavailable"))),
      service: context.service ?? (() => undefined),
      provided: this.provided,
    };
    for (const tools of this.tools) {
      if (tools.slot !== slot) continue;
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
        services.logger.error({ err: error }, "Built-in session lifecycle failed");
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
    const contribution = registration.create(this.services);
    const instance: BuiltinSessionContribution = {
      handle: (input) => contribution.handle(input),
      stop: () => lifecycleDeadline(registration.id, "stop", () => contribution.stop()),
      ...(contribution.start
        ? {
            start: () => lifecycleDeadline(registration.id, "start", () => contribution.start?.()),
          }
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
