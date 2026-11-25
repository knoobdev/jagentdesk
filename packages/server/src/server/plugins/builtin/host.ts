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
/** Per-agent inputs available while a feature installs its tools into one agent's catalog. */
export interface BuiltinToolContext {
  callerAgentId: string | null;
  /** Labels of the calling agent when the catalog is built. */
  callerLabels(): Readonly<Record<string, string>> | undefined;
  requestHostToolPermission?: JAgentDeskToolHostDependencies["requestHostToolPermission"];
  clusters?: ClusterRegistry;
  databases?: DatabaseRegistry;
  /** Daemon core services; absent in catalogs built without a daemon. */
  services?: BuiltinCoreServices;
}
export interface BuiltinSessionServices extends BuiltinCoreServices {
  terminals?: TerminalManager | null;
  remoteDocker: () => RemoteDockerHosts | undefined;
  remoteK8s: () => RemoteK8sClusters | undefined;
  remoteDb: () => RemoteDbTunnels | undefined;
  /** Whether the connected client advertised a capability; re-read on `capabilitiesChanged`. */
  supportsClientCapability(capability: string): boolean;
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
  /** Create the contribution when the session opens (and on enable), not on the first request. */
  eager?: boolean;
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
    options?: BuiltinRpcOptions,
  ): void;
  backgroundService(create: (services: BuiltinCoreServices) => BuiltinBackgroundService): void;
  agentTools(
    register: (registerTool: RegisterBuiltinTool, context: BuiltinToolContext) => void,
  ): void;
  /** One value per daemon, shared by its background service, sessions and tools. */
  shared<T>(create: (services: BuiltinCoreServices) => T): (services: BuiltinCoreServices) => T;
}
interface RpcRegistration {
  id: BuiltinPluginId;
  namespace: string;
  methods: readonly SessionInboundMessage["type"][];
  create: (services: BuiltinSessionServices) => BuiltinSessionContribution;
  eager: boolean;
}
type ToolInstaller = (register: RegisterBuiltinTool, context: BuiltinToolContext) => void;

export class BuiltinServerRegistry {
  private readonly rpcs = new Map<string, RpcRegistration>();
  private readonly backgrounds = new Map<
    BuiltinPluginId,
    (services: BuiltinCoreServices) => BuiltinBackgroundService
  >();
  private readonly tools = new Map<BuiltinPluginId, ToolInstaller>();
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
      backgroundService: (create) => {
        if (this.backgrounds.has(id))
          throw new Error(`Duplicate built-in background service: ${id}`);
        this.backgrounds.set(id, create);
      },
      agentTools: (register) => {
        if (this.tools.has(id)) throw new Error(`Duplicate built-in tools: ${id}`);
        this.tools.set(id, register);
      },
      shared: (create) => {
        // Keyed by the daemon's config store: every session and tool catalog of one daemon shares it.
        const values = new WeakMap<object, ReturnType<typeof create>>();
        return (services) => {
          if (!values.has(services.config)) values.set(services.config, create(services));
          return values.get(services.config)!;
        };
      },
    };
  }
  async start(
    state: BuiltinPluginState,
    services: BuiltinCoreServices,
  ): Promise<() => Promise<void>> {
    const running: BuiltinPluginLifecycle[] = [];
    for (const [id, create] of this.backgrounds) {
      const lifecycle = backgroundLifecycle(id, create(services));
      await state.registerLifecycle(id, lifecycle);
      running.push(lifecycle);
    }
    return async () => {
      await Promise.all(running.map((lifecycle) => lifecycle.stop()));
    };
  }
  rpcNames(): string[] {
    return [...this.rpcs.keys()].sort();
  }
  owns(type: string): boolean {
    return this.rpcs.has(type);
  }
  /**
   * Installs feature tools in catalog order. `only` lists the features for one catalog slot in
   * order; `except` installs every other feature in load order.
   */
  registerAgentTools(
    snapshot: ReadonlySet<BuiltinPluginId> | undefined,
    register: RegisterBuiltinTool,
    context: BuiltinToolContext,
    reserve?: (name: string) => void,
    slot: { only?: readonly BuiltinPluginId[]; except?: readonly BuiltinPluginId[] } = {},
  ): void {
    const ids = slot.only ?? [...this.tools.keys()].filter((id) => !slot.except?.includes(id));
    for (const id of ids) {
      const install = this.tools.get(id);
      install?.((name, config, handler) => {
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
      for (const registration of this.eagerRegistrations())
        if (!this.instances.has(registration) && state.isEnabled(registration.id))
          operations.push(
            this.pending.then(() => this.instantiate(registration)).then(() => undefined),
          );
      this.pending = Promise.all([this.pending, ...operations])
        .then(() => undefined)
        .catch((error) => {
          services.logger.error({ err: error }, "Built-in session lifecycle failed");
        });
    });
    const eager = this.eagerRegistrations().filter(
      (registration) => !state || state.isEnabled(registration.id),
    );
    if (eager.length)
      this.pending = Promise.all(eager.map((registration) => this.instantiate(registration)))
        .then(() => undefined)
        .catch((error) => {
          services.logger.error({ err: error }, "Built-in session start failed");
        });
  }
  private eagerRegistrations(): RpcRegistration[] {
    return [...new Set(this.rpcs.values())].filter((registration) => registration.eager);
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
    const instance = this.instances.get(registration) ?? (await this.instantiate(registration));
    await instance.handle(message);
  }
  private async instantiate(registration: RpcRegistration): Promise<BuiltinSessionContribution> {
    const existing = this.instances.get(registration);
    if (existing) return existing;
    if (this.disposed)
      throw new BuiltinPluginError("plugin_disabled", `Plugin turned off: ${registration.id}`);
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
    await instance.start?.();
    return instance;
  }
  async dispose(): Promise<void> {
    this.disposed = true;
    this.unsubscribe?.();
    await this.pending;
    await Promise.all([...this.instances.values()].map((instance) => instance.stop()));
    this.instances.clear();
  }
}
