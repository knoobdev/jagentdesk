import {
  loadPersistedConfig,
  savePersistedConfig,
  type PersistedConfig,
} from "./persisted-config.js";
import { ProviderOverrideSchema } from "./agent/provider-launch-config.js";
import {
  MutableDaemonConfigSchema,
  MutableDaemonConfigPatchSchema,
} from "@jagentdesk/protocol/messages";

export type { MutableDaemonConfig, MutableDaemonConfigPatch } from "@jagentdesk/protocol/messages";

type MutableDaemonConfig = import("@jagentdesk/protocol/messages").MutableDaemonConfig;
type MutableDaemonConfigPatch = import("@jagentdesk/protocol/messages").MutableDaemonConfigPatch;
type ProviderOverride = import("./agent/provider-launch-config.js").ProviderOverride;

interface LoggerLike {
  child(bindings: Record<string, unknown>): LoggerLike;
  info(...args: unknown[]): void;
}

export interface DaemonConfigChangeDetails {
  removedProviders: readonly string[];
}

type ConfigListener = (config: MutableDaemonConfig, details: DaemonConfigChangeDetails) => void;
type FieldChangeHandler = (value: unknown) => void;

interface AppliedFieldChange {
  handler: FieldChangeHandler;
  previousValue: unknown;
}

function getLogger(logger: LoggerLike | undefined): LoggerLike | undefined {
  return logger?.child({ module: "daemon-config-store" });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepMerge<T extends Record<string, unknown>>(
  current: T,
  patch: Record<string, unknown>,
): T {
  const next: Record<string, unknown> = { ...current };

  for (const [key, patchValue] of Object.entries(patch)) {
    if (patchValue === undefined) {
      continue;
    }
    const currentValue = next[key];
    if (isRecord(currentValue) && isRecord(patchValue)) {
      next[key] = deepMerge(currentValue, patchValue);
      continue;
    }
    next[key] = patchValue;
  }

  return next as T;
}

function omitOrchestrationRoles(
  config: Record<string, unknown>,
  roleIds: string[],
): Record<string, unknown> {
  if (roleIds.length === 0) return config;
  const orchestration = config.orchestration;
  if (!isRecord(orchestration)) return config;
  const roles = orchestration.roles;
  if (!isRecord(roles)) return config;
  const nextRoles: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(roles)) {
    if (!roleIds.includes(key)) {
      nextRoles[key] = value;
    }
  }
  return { ...config, orchestration: { ...orchestration, roles: nextRoles } };
}

function omitProvidersFromConfig<T extends { providers?: Record<string, unknown> }>(
  config: T,
  providers: readonly string[],
): T {
  if (providers.length === 0 || !config.providers) {
    return config;
  }

  let changed = false;
  const nextProviders = { ...config.providers };
  for (const provider of providers) {
    if (provider in nextProviders) {
      delete nextProviders[provider];
      changed = true;
    }
  }

  return changed ? ({ ...config, providers: nextProviders } as T) : config;
}

function omitPluginsFromConfig<T extends { plugins?: Record<string, unknown> }>(
  config: T,
  plugins: readonly string[],
): T {
  if (plugins.length === 0 || !config.plugins) {
    return config;
  }

  let changed = false;
  const nextPlugins = { ...config.plugins };
  for (const plugin of plugins) {
    if (plugin in nextPlugins) {
      delete nextPlugins[plugin];
      changed = true;
    }
  }

  return changed ? ({ ...config, plugins: nextPlugins } as T) : config;
}

function omitMetadataGenerationProvidersFromConfig<
  T extends { metadataGeneration?: { providers?: Array<{ provider?: unknown }> } },
>(config: T, providers: readonly string[]): T {
  if (providers.length === 0 || !config.metadataGeneration?.providers) {
    return config;
  }

  const removedProviderIds = new Set(providers);
  const nextProviders = config.metadataGeneration.providers.filter((entry) => {
    return typeof entry.provider !== "string" || !removedProviderIds.has(entry.provider);
  });
  if (nextProviders.length === config.metadataGeneration.providers.length) {
    return config;
  }

  return {
    ...config,
    metadataGeneration: {
      ...config.metadataGeneration,
      providers: nextProviders,
    },
  } as T;
}

function omitProvidersFromOverrides(
  overrides: Record<string, ProviderOverride> | undefined,
  providers: readonly string[],
): Record<string, ProviderOverride> | undefined {
  if (!overrides) {
    return undefined;
  }

  const nextOverrides = { ...overrides };
  for (const provider of providers) {
    delete nextOverrides[provider];
  }

  return Object.keys(nextOverrides).length > 0 ? nextOverrides : undefined;
}

function omitProvidersFromPersistedAgents(
  agents: PersistedConfig["agents"],
): Record<string, unknown> | undefined {
  if (!agents) {
    return undefined;
  }

  const { providers: _providers, ...rest } = agents as Record<string, unknown>;
  return Object.keys(rest).length > 0 ? rest : undefined;
}

function getValueAtPath(config: MutableDaemonConfig, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>((value, segment) => (isRecord(value) ? value[segment] : undefined), config);
}

function isEqualValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function applyMutableProviderConfigToOverrides(
  baseOverrides: Record<string, ProviderOverride> | undefined,
  mutableProviders: MutableDaemonConfig["providers"] | undefined,
): Record<string, ProviderOverride> | undefined {
  if (!baseOverrides && (!mutableProviders || Object.keys(mutableProviders).length === 0)) {
    return undefined;
  }

  const nextOverrides: Record<string, ProviderOverride> = { ...baseOverrides };
  for (const [providerId, providerConfig] of Object.entries(mutableProviders ?? {})) {
    nextOverrides[providerId] = {
      ...nextOverrides[providerId],
      ...ProviderOverrideSchema.strip().parse(providerConfig),
    };
  }

  return nextOverrides;
}

export class DaemonConfigStore {
  private current: MutableDaemonConfig;
  private readonly jagentdeskHome: string;
  private readonly logger: LoggerLike | undefined;
  private readonly changeListeners = new Set<ConfigListener>();
  private readonly fieldChangeHandlers = new Map<string, Set<FieldChangeHandler>>();

  constructor(jagentdeskHome: string, initial: MutableDaemonConfig, logger?: LoggerLike) {
    this.jagentdeskHome = jagentdeskHome;
    this.logger = getLogger(logger);
    this.current = MutableDaemonConfigSchema.parse(initial);
  }

  public get(): MutableDaemonConfig {
    return this.current;
  }

  public patch(partial: MutableDaemonConfigPatch): MutableDaemonConfig {
    const parsedPatch = MutableDaemonConfigPatchSchema.parse(partial);
    const { removeProviders = [], removePlugins = [], ...configPatch } = parsedPatch;
    const removedProviders = Array.from(new Set(removeProviders));
    const removedPlugins = Array.from(new Set(removePlugins));
    let removedRoleIds: string[] = [];
    if (configPatch.orchestration && "removeRoleIds" in configPatch.orchestration) {
      const { removeRoleIds, ...orchestrationRest } = configPatch.orchestration;
      removedRoleIds = Array.from(new Set(removeRoleIds ?? [])).filter(
        (id) => id !== "supervisor" && id !== "lead" && id !== "peer",
      );
      configPatch.orchestration = orchestrationRest;
    }
    const merged = omitOrchestrationRoles(deepMerge(this.current, configPatch), removedRoleIds);
    const next = MutableDaemonConfigSchema.parse(
      omitPluginsFromConfig(
        omitMetadataGenerationProvidersFromConfig(
          omitProvidersFromConfig(merged, removedProviders),
          removedProviders,
        ),
        removedPlugins,
      ),
    );

    const changedFieldPaths = Array.from(this.fieldChangeHandlers.keys()).filter((path) => {
      return !isEqualValue(getValueAtPath(this.current, path), getValueAtPath(next, path));
    });
    const configChanged = !isEqualValue(this.current, next);

    if (!configChanged && removedProviders.length === 0 && removedPlugins.length === 0) {
      return this.current;
    }

    const persistedBeforePatch = this.persistConfig(next, removedProviders);
    if (!configChanged) return this.current;

    const previous = this.current;
    const appliedFieldChanges: AppliedFieldChange[] = [];
    this.current = next;
    try {
      for (const path of changedFieldPaths) {
        const handlers = this.fieldChangeHandlers.get(path);
        if (!handlers) {
          continue;
        }
        const value = getValueAtPath(next, path);
        const previousValue = getValueAtPath(previous, path);
        for (const handler of handlers) {
          appliedFieldChanges.push({ handler, previousValue });
          handler(value);
        }
      }
    } catch (error) {
      this.current = previous;
      for (const change of appliedFieldChanges.toReversed()) {
        change.handler(change.previousValue);
      }
      savePersistedConfig(this.jagentdeskHome, persistedBeforePatch, this.logger);
      throw error;
    }

    const changeDetails: DaemonConfigChangeDetails = { removedProviders };
    for (const listener of this.changeListeners) {
      listener(next, changeDetails);
    }

    return next;
  }

  public onFieldChange(path: string, handler: FieldChangeHandler): () => void {
    const handlers = this.fieldChangeHandlers.get(path) ?? new Set<FieldChangeHandler>();
    handlers.add(handler);
    this.fieldChangeHandlers.set(path, handlers);

    return () => {
      const currentHandlers = this.fieldChangeHandlers.get(path);
      if (!currentHandlers) {
        return;
      }
      currentHandlers.delete(handler);
      if (currentHandlers.size === 0) {
        this.fieldChangeHandlers.delete(path);
      }
    };
  }

  public onChange(listener: ConfigListener): () => void {
    this.changeListeners.add(listener);
    return () => {
      this.changeListeners.delete(listener);
    };
  }

  private persistConfig(
    config: MutableDaemonConfig,
    removeProviders: readonly string[],
  ): PersistedConfig {
    const persisted = loadPersistedConfig(this.jagentdeskHome, this.logger);
    const nextPersisted = mergeMutableConfigIntoPersistedConfig({
      persisted,
      mutable: config,
      removeProviders,
    });
    savePersistedConfig(this.jagentdeskHome, nextPersisted, this.logger);
    return persisted;
  }
}

function mergeMutableConfigIntoPersistedConfig(params: {
  persisted: PersistedConfig;
  mutable: MutableDaemonConfig;
  removeProviders: readonly string[];
}): PersistedConfig {
  const { persisted, mutable, removeProviders } = params;
  const browserToolsEnabled = readBrowserToolsEnabled(mutable);
  const metadataGenerationProviders = readMetadataGenerationProviders(mutable);
  const persistedProviderOverrides = omitProvidersFromOverrides(
    persisted.agents?.providers as Record<string, ProviderOverride> | undefined,
    removeProviders,
  );
  const providerOverrides = applyMutableProviderConfigToOverrides(
    persistedProviderOverrides,
    mutable.providers,
  );
  const persistedAgents = omitProvidersFromPersistedAgents(persisted.agents);
  const persistedMetadataGeneration = {
    providers: metadataGenerationProviders,
  };
  const shouldPersistMetadataGeneration =
    metadataGenerationProviders.length > 0 || persisted.agents?.metadataGeneration !== undefined;

  let nextAgents = persistedAgents as PersistedConfig["agents"];
  if (providerOverrides && Object.keys(providerOverrides).length > 0) {
    nextAgents = {
      ...persistedAgents,
      providers: providerOverrides,
      ...(shouldPersistMetadataGeneration
        ? { metadataGeneration: persistedMetadataGeneration }
        : {}),
    } as PersistedConfig["agents"];
  } else if (shouldPersistMetadataGeneration) {
    nextAgents = {
      ...persistedAgents,
      metadataGeneration: persistedMetadataGeneration,
    } as PersistedConfig["agents"];
  }

  return {
    ...persisted,
    daemon: {
      ...persisted.daemon,
      mcp: {
        ...persisted.daemon?.mcp,
        injectIntoAgents: mutable.mcp.injectIntoAgents,
      },
      browserTools: {
        ...persisted.daemon?.browserTools,
        enabled: browserToolsEnabled,
      },
      autoArchiveAfterMerge: mutable.autoArchiveAfterMerge,
      enableTerminalAgentHooks: mutable.enableTerminalAgentHooks,
      appendSystemPrompt: mutable.appendSystemPrompt,
      orchestration: mutable.orchestration,
      ...(mutable.terminalProfiles !== undefined
        ? { terminalProfiles: mutable.terminalProfiles }
        : {}),
    },
    agents: nextAgents,
  } as PersistedConfig;
}

function readBrowserToolsEnabled(mutable: MutableDaemonConfig): boolean {
  const browserTools = mutable.browserTools;
  if (!isRecord(browserTools)) {
    return false;
  }
  return browserTools["enabled"] === true;
}

function readMetadataGenerationProviders(
  mutable: MutableDaemonConfig,
): Array<{ provider: string; model?: string; thinkingOptionId?: string }> {
  const metadataGeneration = mutable.metadataGeneration;
  if (!isRecord(metadataGeneration)) {
    return [];
  }
  const providers = metadataGeneration["providers"];
  if (!Array.isArray(providers)) {
    return [];
  }
  return providers.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry["provider"] !== "string") {
      return [];
    }
    return [
      {
        provider: entry["provider"],
        ...(typeof entry["model"] === "string" ? { model: entry["model"] } : {}),
        ...(typeof entry["thinkingOptionId"] === "string"
          ? { thinkingOptionId: entry["thinkingOptionId"] }
          : {}),
      },
    ];
  });
}
