import {
  BUILTIN_PLUGIN_MANIFESTS,
  BUILTIN_PLUGIN_FEATURES,
  builtinPluginCascade,
  type BuiltinPluginId,
  type BuiltinPluginListItem,
  type BuiltinPluginManifest,
} from "@jagentdesk/protocol/builtin-plugins";
import type { HostCapabilities } from "@jagentdesk/protocol/host-capabilities";
import type { DaemonConfigStore } from "../../daemon-config-store.js";

export class BuiltinPluginError extends Error {
  constructor(
    readonly code: "plugin_dependency" | "plugin_unavailable" | "plugin_disabled",
    message: string,
  ) {
    super(message);
  }
}

export interface BuiltinPluginLifecycle {
  start(): void | Promise<void>;
  stop(): void | Promise<void>;
}

/** State and lifecycle for the static feature entries in BuiltinPluginLoader. */
export class BuiltinPluginState {
  private readonly unavailable = new Map<BuiltinPluginId, string>();
  private capabilities: HostCapabilities | null = null;
  private readonly lifecycles = new Map<BuiltinPluginId, BuiltinPluginLifecycle>();
  private readonly running = new Set<BuiltinPluginId>();
  private readonly listeners = new Set<() => void>();
  private pending = Promise.resolve();
  private readonly agentSnapshots = new Map<string, ReadonlySet<BuiltinPluginId>>();

  constructor(
    private readonly config: Pick<DaemonConfigStore, "get" | "patch" | "onFieldChange">,
    readonly manifests: readonly BuiltinPluginManifest[] = BUILTIN_PLUGIN_MANIFESTS,
  ) {
    config.onFieldChange("builtinPlugins", () => {
      for (const listener of this.listeners) listener();
    });
  }

  list(): BuiltinPluginListItem[] {
    const entries = this.manifests.map((manifest): BuiltinPluginListItem => {
      const caps = manifest.hostCapabilities;
      // Host probes publish an empty snapshot while checking. Only a settled
      // result can make a plugin unavailable (and stop its dependents).
      const checks = caps?.flatMap((id) => this.capabilities?.[id] ?? []);
      const available =
        !this.unavailable.has(manifest.id) &&
        (!checks?.length || checks.some(({ state }) => state === "available"));
      const unavailableReason =
        this.unavailable.get(manifest.id) ??
        (available
          ? undefined
          : caps
              ?.map((id) => this.capabilities?.[id]?.reason)
              .filter(Boolean)
              .join(" ") || "Required host tools are unavailable.");
      return {
        ...manifest,
        requires: [...manifest.requires],
        enabled:
          this.config.get().builtinPlugins?.[manifest.id]?.enabled ?? manifest.defaultEnabled,
        available,
        ...(unavailableReason ? { unavailableReason } : {}),
      };
    });
    // A missing dependency's host capability also makes its dependents unavailable.
    for (let pass = 0; pass < entries.length; pass++) {
      for (const entry of entries) {
        const missing = entries.find(
          (required) => entry.requires.includes(required.id) && !required.available,
        );
        if (missing) {
          entry.available = false;
          entry.unavailableReason = `Requires ${missing.name}: ${missing.unavailableReason}`;
        }
      }
    }
    return entries;
  }

  async setAvailability(id: BuiltinPluginId, reason: string | null): Promise<void> {
    const change = this.pending.then(async () => {
      const previous = this.unavailable.get(id);
      if (reason === null) this.unavailable.delete(id);
      else this.unavailable.set(id, reason);
      if (previous !== this.unavailable.get(id)) {
        await this.reconcile();
        for (const listener of this.listeners) listener();
      }
      return undefined;
    });
    this.pending = change.catch(() => {});
    await change;
  }

  isEnabled(id: BuiltinPluginId): boolean {
    const entry = this.list().find((plugin) => plugin.id === id);
    return (
      entry !== undefined &&
      entry.enabled &&
      entry.available &&
      entry.requires.every((required) => this.isEnabled(required))
    );
  }

  /**
   * The set one agent runtime opened with. Stateless HTTP MCP requests read it, so a runtime's
   * tool list stays the one it was given; `adoptForAgent` moves it to the host's current set
   * right before the agent's next launch (spec 04 §27b.1).
   */
  forAgent(agentId?: string): ReadonlySet<BuiltinPluginId> {
    if (agentId) {
      const existing = this.agentSnapshots.get(agentId);
      if (existing) return existing;
    }
    const snapshot = this.current();
    if (agentId) this.agentSnapshots.set(agentId, snapshot);
    return snapshot;
  }

  /** Built-ins on for this host right now. */
  current(): ReadonlySet<BuiltinPluginId> {
    return new Set(
      this.manifests.filter((entry) => this.isEnabled(entry.id)).map((entry) => entry.id),
    );
  }

  adoptForAgent(agentId: string): ReadonlySet<BuiltinPluginId> {
    const snapshot = this.current();
    this.agentSnapshots.set(agentId, snapshot);
    return snapshot;
  }

  forgetAgent(agentId: string): void {
    this.agentSnapshots.delete(agentId);
  }

  featureFlags(): Record<string, boolean> {
    return Object.fromEntries(
      this.manifests.flatMap(({ id }) =>
        BUILTIN_PLUGIN_FEATURES[id].map((flag) => [flag, this.isEnabled(id)]),
      ),
    );
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async registerLifecycle(id: BuiltinPluginId, lifecycle: BuiltinPluginLifecycle): Promise<void> {
    // Host capability probes can settle while an asynchronous plugin is starting.
    // Share their queue so the same source cannot be published twice before running is set.
    const change = this.pending.then(async () => {
      this.lifecycles.set(id, lifecycle);
      await this.reconcile();
      return undefined;
    });
    this.pending = change.catch(() => {});
    await change;
  }

  private async reconcile(): Promise<void> {
    for (const manifest of this.manifests.toReversed()) {
      if (this.running.has(manifest.id) && !this.isEnabled(manifest.id)) {
        this.running.delete(manifest.id);
        await this.lifecycles.get(manifest.id)?.stop();
      }
    }
    for (const manifest of this.manifests) {
      if (
        !this.running.has(manifest.id) &&
        this.isEnabled(manifest.id) &&
        this.lifecycles.has(manifest.id)
      ) {
        await this.lifecycles.get(manifest.id)?.start();
        this.running.add(manifest.id);
      }
    }
  }

  async setCapabilities(capabilities: HostCapabilities): Promise<void> {
    const change = this.pending.then(async () => {
      this.capabilities = capabilities;
      await this.reconcile();
      for (const listener of this.listeners) listener();
      return undefined;
    });
    this.pending = change.catch(() => {});
    await change;
  }

  async set(
    id: BuiltinPluginId,
    enabled: boolean,
    cascade = false,
  ): Promise<BuiltinPluginListItem[]> {
    const change = this.pending.then(async () => {
      const entries = this.list();
      const target = entries.find((entry) => entry.id === id);
      if (!target) throw new Error(`Unknown built-in plugin: ${id}`);
      const related = builtinPluginCascade(entries, id, enabled);
      if (related.length && !cascade)
        throw new BuiltinPluginError(
          "plugin_dependency",
          `Also turn ${enabled ? "on" : "off"} ${related.map((required) => entries.find((entry) => entry.id === required)!.name).join(", ")}?`,
        );
      const ids = [id, ...related];
      if (enabled) {
        const unavailable = entries.find((entry) => ids.includes(entry.id) && !entry.available);
        if (unavailable)
          throw new BuiltinPluginError(
            "plugin_unavailable",
            `${unavailable.name}: ${unavailable.unavailableReason}`,
          );
      }
      this.config.patch({
        builtinPlugins: Object.fromEntries(ids.map((pluginId) => [pluginId, { enabled }])),
      });
      await this.reconcile();
      // Source plugins publish their accounts during startup, after the config-change event.
      for (const listener of this.listeners) listener();
      return this.list();
    });
    this.pending = change.then(
      () => undefined,
      () => undefined,
    );
    return change;
  }
}
