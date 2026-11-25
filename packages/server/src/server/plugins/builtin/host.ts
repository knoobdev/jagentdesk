import type { BuiltinPluginId } from "@jagentdesk/protocol/builtin-plugins";
import type { SessionInboundMessage, SessionOutboundMessage } from "../../messages.js";
import type { TerminalManager } from "../../../terminal/terminal-manager.js";
import type { RemoteDockerHosts } from "../../ssh/remote-docker/hosts.js";
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

/** The opening agent and the daemon's services, captured when its tool catalog is built. */
export interface BuiltinToolContext {
  callerAgentId: string | null;
  services: BuiltinCoreServices | undefined;
}
export type RegisterBuiltinTool = <Input>(
  name: string,
  config: JAgentDeskToolConfig,
  handler: (input: Input, context: JAgentDeskToolExecutionContext) => Promise<JAgentDeskToolResult>,
) => void;
export interface BuiltinSessionServices extends BuiltinCoreServices {
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
  ): void;
  backgroundService(create: (services: BuiltinCoreServices) => BuiltinBackgroundService): void;
  agentTools(
    register: (registerTool: RegisterBuiltinTool, context: BuiltinToolContext) => void,
  ): void;
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
    (services: BuiltinCoreServices) => BuiltinBackgroundService
  >();
  private readonly tools = new Map<
    BuiltinPluginId,
    (register: RegisterBuiltinTool, context: BuiltinToolContext) => void
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
      agentTools: (register) => {
        if (this.tools.has(id)) throw new Error(`Duplicate built-in tools: ${id}`);
        this.tools.set(id, register);
      },
    };
  }
  async start(
    state: BuiltinPluginState,
    services: BuiltinCoreServices,
  ): Promise<() => Promise<void>> {
    const running: BuiltinPluginLifecycle[] = [];
    for (const [id, create] of this.backgrounds) {
      const service = create(services);
      const lifecycle = backgroundLifecycle(id, service);
      await state.registerLifecycle(id, lifecycle);
      if (!state.isEnabled(id)) await lifecycleDeadline(id, "stop", () => service.idle?.());
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
  registerAgentTools(
    snapshot: ReadonlySet<BuiltinPluginId> | undefined,
    register: RegisterBuiltinTool,
    reserve?: (name: string) => void,
    context: BuiltinToolContext = { callerAgentId: null, services: undefined },
  ): void {
    for (const [id, install] of this.tools) {
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
    let instance = this.instances.get(registration);
    if (!instance) {
      const contribution = registration.create(this.services);
      instance = {
        handle: (input) => contribution.handle(input),
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
    await instance.handle(message);
  }
  async dispose(): Promise<void> {
    this.disposed = true;
    this.unsubscribe?.();
    await this.pending;
    await Promise.all([...this.instances.values()].map((instance) => instance.stop()));
    this.instances.clear();
  }
}
