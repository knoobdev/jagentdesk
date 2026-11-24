import { type SpeechSettingsPatch } from "@jagentdesk/protocol/speech/rpc-schemas";
import { mergeSpeechSettingsPatch, type SpeechSettingsOwner } from "./speech/speech-settings.js";
import { BUILTIN_PLUGIN_MANIFESTS } from "@jagentdesk/protocol/builtin-plugins";
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
import {
  convertLegacyOptions,
  foldProfileFeatureValues,
  resolveAdapter,
  withLegacyProfileFeatureValues,
} from "./agent/option-controls.js";
import { type AgentProfile } from "@jagentdesk/protocol/agent-profile";

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

/**
 * Profiles are held and persisted with `options` only, in the current keys: a profile is old
 * data entering, so it is converted for the adapter its provider runs on, which `config.json`'s
 * `providers` section names through `extends`.
 */
function foldConfigProfiles<T extends { agentProfiles?: AgentProfile[] }>(input: {
  config: T;
  providers: Record<string, ProviderOverride> | undefined;
  source: "stored" | "client write";
  held?: AgentProfile[];
}): T {
  const { config, providers, source, held = [] } = input;
  if (!config.agentProfiles) return config;
  const convert = (provider: string, options: Record<string, unknown> | undefined) =>
    convertLegacyOptions({
      provider: resolveAdapter({ provider, extendsOf: (id) => providers?.[id]?.extends }),
      options,
    });
  const identity = (_provider: string, options: Record<string, unknown> | undefined) => options;
  const foldWith = (profile: AgentProfile, convertWith: typeof convert) =>
    foldProfileFeatureValues({
      profile,
      stored: held.find((candidate) => candidate.id === profile.id),
      source,
      convert: convertWith,
    });
  return {
    ...config,
    agentProfiles: config.agentProfiles.map((profile) => {
      // A malformed value rejects a client write before anything is committed.
      if (source === "client write") return foldWith(profile, convert);
      try {
        return foldWith(profile, convert);
      } catch {
        // A hand-edited `config.json` value that cannot convert must not stop the daemon from
        // starting; it keeps its keys and is rejected when an agent is created from it.
        return foldWith(profile, identity);
      }
    }),
  };
}

/** The config API boundary: the unchanged app reads profile options from `featureValues`. */
export function toWireDaemonConfig(config: MutableDaemonConfig): MutableDaemonConfig {
  if (!config.agentProfiles) return config;
  return { ...config, agentProfiles: config.agentProfiles.map(withLegacyProfileFeatureValues) };
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

  constructor(
    jagentdeskHome: string,
    initial: MutableDaemonConfig,
    logger?: LoggerLike,
    private readonly options: { speech?: SpeechSettingsOwner } = {},
  ) {
    this.jagentdeskHome = jagentdeskHome;
    this.logger = getLogger(logger);
    const persisted = loadPersistedConfig(jagentdeskHome, this.logger);
    const builtinPlugins = initial.builtinPlugins ?? persisted.builtinPlugins;
    this.current = MutableDaemonConfigSchema.parse({
      ...foldConfigProfiles({ config: initial, providers: initial.providers, source: "stored" }),
      ...options.speech?.read(persisted),
      ...(builtinPlugins ? { builtinPlugins } : {}),
    });
    if (!builtinPlugins) {
      const legacy = {
        "browser-tools":
          persisted.daemon?.browserTools?.enabled ?? initial.browserTools?.enabled === true,
        autorun: persisted.daemon?.autorun?.enabled ?? initial.autorun?.enabled === true,
        "session-share":
          persisted.daemon?.sessionSharing?.enabled ?? initial.sessionSharing?.enabled === true,
      };
      this.patch({
        builtinPlugins: Object.fromEntries(
          BUILTIN_PLUGIN_MANIFESTS.map((manifest) => [
            manifest.id,
            {
              enabled:
                manifest.id in legacy
                  ? legacy[manifest.id as keyof typeof legacy]
                  : manifest.defaultEnabled,
            },
          ]),
        ),
      });
      this.logger?.info("Migrated built-in plugin flags to builtinPlugins in config.json");
    }
    this.migrateConfiguredGoose(initial, persisted, builtinPlugins);
  }

  private migrateConfiguredGoose(
    initial: MutableDaemonConfig,
    persisted: PersistedConfig,
    previous: MutableDaemonConfig["builtinPlugins"],
  ): void {
    // COMPAT(gooseBuiltinSwitch): added in v0.9.59; remove after 2027-05-24 once configured Goose hosts have migrated.
    if (
      (initial.providers?.goose || persisted.agents?.providers?.goose) &&
      !previous?.["goose-provider"]
    ) {
      this.patch({ builtinPlugins: { "goose-provider": { enabled: true } } });
    }
  }

  public get(): MutableDaemonConfig {
    return this.current;
  }

  public patch(partial: MutableDaemonConfigPatch): MutableDaemonConfig {
    const parsedPatch = MutableDaemonConfigPatchSchema.parse(partial);
    const {
      removeProviders = [],
      removePlugins = [],
      features: speechPatch,
      ...configPatch
    } = parsedPatch;
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
    const speechPersisted = this.readPatchedSpeech(speechPatch, merged);
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

    if (
      !configChanged &&
      removedProviders.length === 0 &&
      removedPlugins.length === 0 &&
      speechPatch === undefined
    ) {
      return this.current;
    }

    const persistedBeforePatch = this.persistConfig(next, removedProviders, speechPatch);
    if (!configChanged) {
      this.applySpeech(speechPersisted);
      return this.current;
    }

    const previous = this.current;
    const appliedFieldChanges: AppliedFieldChange[] = [];
    this.current = next;
    try {
      this.applySpeech(speechPersisted);
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

  private foldPatchProfiles<
    T extends { agentProfiles?: AgentProfile[]; providers?: Record<string, ProviderOverride> },
  >(submittedPatch: T): T {
    return foldConfigProfiles({
      config: submittedPatch,
      // The provider graph this request will commit, so `extends` survives a partial edit.
      providers: deepMerge(this.current.providers ?? {}, submittedPatch.providers ?? {}),
      source: "client write",
      held: this.current.agentProfiles,
    });
  }

  private async applySupportedPatch(
    parsedPatch: SupportedMutableConfigPatch,
  ): Promise<MutableDaemonConfig> {
    if (parsedPatch.relay?.enabled !== undefined && !this.relayEnabledMutable) {
      throw new Error(
        "Relay is controlled by a daemon launch override. Remove JAGENTDESK_RELAY_ENABLED or the relay CLI flag before changing it here.",
      );
    }
    const { removeProviders = [], ...submittedPatch } = parsedPatch;
    const patch = this.foldPatchProfiles(submittedPatch);
    const { features: speechPatch, ...configPatch } = patch;
    const removedProviders = Array.from(new Set(removeProviders));
    const merged = deepMerge(this.current, configPatch);
    if (speechPatch !== undefined) Object.assign(merged, this.readPatchedSpeech(speechPatch));
    if (parsedPatch.skills?.selection !== undefined) {
      merged.skills = { selection: parsedPatch.skills.selection };
    }
    if (parsedPatch.plugins !== undefined) merged.plugins = parsedPatch.plugins;
    const next = MutableDaemonConfigSchema.parse(
      omitMetadataGenerationProvidersFromConfig(
        omitProvidersFromConfig(merged, removedProviders),
        removedProviders,
      ),
    );

    const configChanged = !isEqualValue(this.current, next);

    // A replaced API key leaves the speech view unchanged, so a speech patch always persists.
    // Profiles held folded in memory may still be on disk with `featureValues`; saving them writes `options`.
    const profilesStaleOnDisk =
      patch.agentProfiles !== undefined &&
      !isEqualValue(patch.agentProfiles, this.lastKnownPersisted.daemon?.agentProfiles);
    if (
      !configChanged &&
      removedProviders.length === 0 &&
      speechPatch === undefined &&
      !profilesStaleOnDisk
    ) {
      return this.current;
    }

    const { previous: persistedBeforePatch, knownNext } = await this.persistConfig(
      patch,
      removedProviders,
    );
    const speechChanged = this.speechPersistedChanged(this.lastKnownPersisted, knownNext);
    if (configChanged) {
      try {
        this.applyReplacement(next, { removedProviders });
      } catch (error) {
        await savePersistedConfigAsync(this.jagentdeskHome, persistedBeforePatch, this.logger);
        throw error;
      }
    }
    this.lastKnownPersisted = knownNext;
    if (speechChanged) this.speechOwner?.apply(knownNext);

    return this.current;
  }

  private applySpeech(persisted: PersistedConfig | undefined): void {
    if (persisted) this.options.speech?.apply(persisted);
  }

  private readPatchedSpeech(
    patch: SpeechSettingsPatch | undefined,
    merged: Record<string, unknown>,
  ): PersistedConfig | undefined {
    if (patch === undefined) return undefined;
    if (!this.options.speech)
      throw new Error("Speech settings are unavailable for this daemon instance");
    const persisted = mergeSpeechSettingsPatch(
      loadPersistedConfig(this.jagentdeskHome, this.logger),
      patch,
    );
    Object.assign(merged, this.options.speech.read(persisted));
    return persisted;
  }

  private async reloadPersisted(): Promise<DaemonConfigReloadResult> {
    if (!this.reloadSource) {
      throw new Error("Daemon config reload is unavailable for this daemon instance");
    }

    const persisted = await loadPersistedConfigAsync(this.jagentdeskHome, this.logger);
    const resolved = this.reloadSource.resolve(persisted);
    // Plugin source changes require the plugin lifecycle operation or a daemon
    // restart. The global switch is independently reloadable.
    const desired = MutableDaemonConfigSchema.parse({
      ...foldConfigProfiles({
        config: resolved.mutable,
        providers: resolved.mutable.providers,
        source: "stored",
      }),
      plugins: this.current.plugins,
      ...this.readSpeech(persisted),
    });
    const changedSinceLastApply = diffPaths(this.lastKnownPersisted, persisted);
    const overrideControlledPaths = compactOwnedPaths(
      changedSinceLastApply.filter((path) =>
        resolved.overrideControlledPaths.some((owner) => pathBelongsTo(path, owner)),
      ),
      resolved.overrideControlledPaths,
    );
    const appliedPaths: string[] = RELOADABLE_PATHS.filter((persistedPath) => {
      if (resolved.overrideControlledPaths.some((owner) => pathBelongsTo(persistedPath, owner))) {
        return false;
      }
      const mutablePath = PERSISTED_TO_MUTABLE_PATH.get(persistedPath);
      return (
        mutablePath !== undefined &&
        !isEqualValue(
          getValueAtPath(this.current, mutablePath),
          getValueAtPath(desired, mutablePath),
        )
      );
    });
    const restartRequiredPaths = compactOwnedPaths(
      diffPaths(this.startupPersisted, persisted).filter((path) => {
        if (path === "$schema" || path === "version") return false;
        if (RELOADABLE_PATHS.some((owner) => pathBelongsTo(path, owner))) return false;
        if (this.speechOwner && SPEECH_PERSISTED_PATHS.some((owner) => pathBelongsTo(path, owner)))
          return false;
        return !resolved.overrideControlledPaths.some((owner) => pathBelongsTo(path, owner));
      }),
      [],
    );

    const removedProviders = Object.keys(this.current.providers).filter(
      (provider) => !(provider in desired.providers),
    );
    const speechChanged = this.speechPersistedChanged(this.lastKnownPersisted, persisted);
    this.applyReplacement(desired, { removedProviders });
    this.lastKnownPersisted = persisted;
    if (speechChanged && this.speechOwner) {
      this.speechOwner.apply(persisted);
      appliedPaths.push(
        ...SPEECH_PERSISTED_PATHS.filter((owner) =>
          changedSinceLastApply.some((path) => pathBelongsTo(path, owner)),
        ),
      );
    }

    return {
      appliedPaths: [...appliedPaths].sort(),
      restartRequiredPaths,
      overrideControlledPaths,
    };
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
    speechPatch?: SpeechSettingsPatch,
  ): PersistedConfig {
    const persisted = loadPersistedConfig(this.jagentdeskHome, this.logger);
    const nextPersisted = mergeMutableConfigIntoPersistedConfig({
      persisted: speechPatch ? mergeSpeechSettingsPatch(persisted, speechPatch) : persisted,
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
  const autorunEnabled = readAutorunEnabled(mutable);
  const sessionSharingEnabled = readSessionSharingEnabled(mutable);
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

  let nextAgents = {
    ...persistedAgents,
    resumeOnStartup: mutable.resumeOnStartup,
    resumePrompt: mutable.resumePrompt,
  } as PersistedConfig["agents"];
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

  nextAgents = {
    ...nextAgents,
    resumeOnStartup: mutable.resumeOnStartup,
    resumePrompt: mutable.resumePrompt,
    idleRuntimeCleanup: mutable.idleRuntimeCleanup !== false,
  };
  return {
    ...persisted,
    // The live plugin map already has removePlugins applied, so it replaces the stored one.
    ...(mutable.builtinPlugins !== undefined ? { builtinPlugins: mutable.builtinPlugins } : {}),
    ...(mutable.pluginsEnabled !== undefined ? { pluginsEnabled: mutable.pluginsEnabled } : {}),
    ...(mutable.plugins !== undefined ? { plugins: mutable.plugins } : {}),
    daemon: {
      ...persisted.daemon,
      mcp: {
        ...persisted.daemon?.mcp,
        injectIntoAgents: mutable.mcp.injectIntoAgents,
      },
      browserTools: {
        ...persisted.daemon?.browserTools,
        enabled: browserToolsEnabled,
        // Fingerprint profiles live in the daemon config; without these they were lost on
        // every daemon restart.
        ...(mutable.browserTools.profiles !== undefined
          ? { profiles: mutable.browserTools.profiles }
          : {}),
        ...(mutable.browserTools.activeProfileId !== undefined
          ? { activeProfileId: mutable.browserTools.activeProfileId }
          : {}),
      },
      autorun: {
        ...persisted.daemon?.autorun,
        enabled: autorunEnabled,
      },
      sessionSharing: {
        ...persisted.daemon?.sessionSharing,
        enabled: sessionSharingEnabled,
      },
      ...(mutable.relay !== undefined
        ? { relay: { ...persisted.daemon?.relay, ...mutable.relay } }
        : {}),
      autoArchiveAfterMerge: mutable.autoArchiveAfterMerge,
      enableTerminalAgentHooks: mutable.enableTerminalAgentHooks,
      appendSystemPrompt: mutable.appendSystemPrompt,
      operatorContext: mutable.operatorContext,
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

function readAutorunEnabled(mutable: MutableDaemonConfig): boolean {
  const autorun = (mutable as { autorun?: unknown }).autorun;
  if (!isRecord(autorun)) {
    return false;
  }
  return autorun["enabled"] === true;
}

function readSessionSharingEnabled(mutable: MutableDaemonConfig): boolean {
  const sharing = (mutable as { sessionSharing?: unknown }).sessionSharing;
  if (!isRecord(sharing)) {
    return false;
  }
  return sharing["enabled"] === true;
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
