import { type Logger } from "pino";
import { type ProviderOptions, type ToolPolicy } from "@jagentdesk/protocol/agent-types";
import {
  type AgentClient,
  type AgentCreateConfigUnattendedInput,
  type AgentMode,
  type AgentModelDefinition,
  type AgentPersistenceHandle,
  type AgentProvider,
  type AgentRuntimeInfo,
  type AgentSession,
  type AgentStreamEvent,
  type FetchCatalogOptions,
  type ProviderRefreshContext,
  type ProviderCatalog,
  type ResolveAgentCreateConfigInput,
  type ResolveAgentCreateConfigResult,
  type ResolveAgentDefaultModeInput,
  type AgentSessionConfig,
  normalizeAgentModelDefinition,
} from "./agent-sdk-types.js";
import {
  isDefaultAgentCreateConfigUnattended,
  resolveDefaultAgentCreateConfig,
} from "./create-agent-mode.js";
import { runProviderRefreshActivity } from "./provider-refresh-deadline.js";
import { type WorkspaceGitService } from "../workspace-git-service.js";
import { type ManagedProcessRegistry } from "../managed-processes/managed-processes.js";
import {
  type AgentProviderRuntimeSettingsMap,
  type ProviderOverride,
  type ProviderProfileModel,
  type ProviderRuntimeSettings,
} from "./provider-launch-config.js";
import { ClaudeAgentClient } from "./providers/claude/agent.js";
import { CodexAppServerAgentClient } from "./providers/codex-app-server-agent.js";
import { CopilotACPAgentClient } from "./providers/copilot-acp-agent.js";
import { CursorACPAgentClient } from "./providers/cursor-acp-agent.js";
import { GenericACPAgentClient } from "./providers/generic-acp-agent.js";
import { KimiACPAgentClient } from "./providers/kimi-acp-agent.js";
import { KiroACPAgentClient } from "./providers/kiro-acp-agent.js";
import { OpenCodeRuntimeClient } from "./providers/opencode/runtime-client.js";
import { type OpenCodeBridge } from "./providers/opencode/bridge.js";
import { OmpAgentClient } from "./providers/omp/agent.js";
import { type OmpRuntime } from "./providers/omp/runtime.js";
import { PiRpcAgentClient } from "./providers/pi/agent.js";
import { TraeACPAgentClient } from "./providers/trae-acp-agent.js";
import { MockLoadTestAgentClient } from "./providers/mock-load-test-agent.js";
import { MockSlowProviderClient } from "./providers/mock-slow-provider.js";
import { ToolPolicyUnsupportedError, mergeProviderOptions } from "./provider-options.js";
import {
  AGENT_PROVIDER_DEFINITIONS,
  BUILTIN_PROVIDER_IDS,
  DEV_AGENT_PROVIDER_DEFINITIONS,
  getAgentProviderDefinition,
  type AgentProviderDefinition,
} from "@jagentdesk/protocol/provider-manifest";
import { convertLegacyOptions } from "./option-controls.js";

function isNonEmptyStringArray(value: string[]): value is [string, ...string[]] {
  return value.length > 0;
}

export type { AgentProviderDefinition };

export { AGENT_PROVIDER_DEFINITIONS, getAgentProviderDefinition };

export interface ProviderDefinition extends AgentProviderDefinition {
  iconSvg?: string;
  enabled: boolean;
  /**
   * The id of another *registered* provider this one extends (e.g. a Z.AI
   * profile that extends "claude"). null for built-in providers and for
   * generic ACP providers (which only extend the literal "acp" sentinel).
   */
  derivedFromProviderId: string | null;
  supportsExactMcpPreapproval: boolean;
  applyToolPolicy: (
    config: AgentSessionConfig,
    toolPolicy: ToolPolicy | undefined,
  ) => AgentSessionConfig;
  createClient: (logger: Logger) => AgentClient;
  resolveCreateConfig: (input: ResolveAgentCreateConfigInput) => ResolveAgentCreateConfigResult;
  isCreateConfigUnattended: (input: AgentCreateConfigUnattendedInput) => boolean;
  /**
   * Single catalog discovery call used by ProviderSnapshotManager. Should spawn
   * at most one provider runtime process and return both models and modes.
   */
  fetchCatalog: (
    options: FetchCatalogOptions,
    client?: AgentClient,
    context?: ProviderRefreshContext,
  ) => Promise<ProviderCatalog>;
}

/** One daemon-managed API provider definition to merge into OPENCODE_CONFIG_CONTENT (spec 34.3). */
export interface OpenCodeProviderInjection {
  id: string;
  config: Record<string, unknown>;
}

export type OpenCodeProviderInjectionResolver = (
  providerId: string,
) => Promise<OpenCodeProviderInjection | null>;

/** Spawn-time env for one Anthropic-compatible API provider (ANTHROPIC_BASE_URL / AUTH_TOKEN). */
export type ClaudeSpawnEnvResolver = (providerId: string) => Promise<Record<string, string> | null>;

/** Provider metadata and an unconfigured factory; the registry owns override application. */
export interface RegisteredProviderDefinition extends AgentProviderDefinition {
  requiresConfiguration?: boolean;
  iconSvg?: string;
  supportsExactMcpPreapproval: boolean;
  createClient: (logger: Logger, runtimeSettings?: ProviderRuntimeSettings) => AgentClient;
}

export interface BuildProviderRegistryOptions {
  pluginProviders?: Record<string, RegisteredProviderDefinition>;
  runtimeSettings?: AgentProviderRuntimeSettingsMap;
  providerOverrides?: Record<string, ProviderOverride>;
  workspaceGitService?: Pick<WorkspaceGitService, "resolveRepoRoot">;
  managedProcesses?: ManagedProcessRegistry;
  isDev?: boolean;
  ompRuntime?: OmpRuntime;
  openCodeBridge?: OpenCodeBridge;
  openCodeProviderInjection?: OpenCodeProviderInjectionResolver;
  claudeSpawnEnv?: ClaudeSpawnEnvResolver;
}

interface ProviderClientFactoryOptions extends Pick<
  BuildProviderRegistryOptions,
  "workspaceGitService" | "managedProcesses" | "ompRuntime"
> {
  openCodeBridge?: OpenCodeBridge;
  customProvider?: {
    id: string;
    label: string;
    extends: string;
  };
  openCodeProviderInjection?: OpenCodeProviderInjectionResolver;
  claudeSpawnEnv?: ClaudeSpawnEnvResolver;
}

type ProviderClientFactory = (
  logger: Logger,
  runtimeSettings?: ProviderRuntimeSettings,
  options?: ProviderClientFactoryOptions,
) => AgentClient;

interface ResolvedProvider {
  definition: AgentProviderDefinition;
  runtimeSettings?: ProviderRuntimeSettings;
  profileModels: ProviderProfileModel[];
  additionalModels: ProviderProfileModel[];
  profileModelsAreAdditive: boolean;
  enabled: boolean;
  derivedFromProviderId: string | null;
  providerOptions?: ProviderOptions;
  createBaseClient: (logger: Logger) => AgentClient;
  contract: ProviderContract;
}

interface ProviderContract {
  supportsExactMcpPreapproval: boolean;
  applyToolPolicy?: (provider: string, toolPolicy: ToolPolicy) => ToolPolicy;
}

const PROVIDER_CONTRACTS: Record<string, ProviderContract> = {
  claude: { supportsExactMcpPreapproval: true },
  codex: { supportsExactMcpPreapproval: true },
  opencode: { supportsExactMcpPreapproval: true },
};

const UNSUPPORTED_PROVIDER_CONTRACT: ProviderContract = {
  supportsExactMcpPreapproval: false,
};

const HUB_E2E_PROVIDER_ID = "hub-e2e";

const HUB_E2E_MCP_SERVER = "hub";

const HUB_E2E_TOOL_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/u;

// The cross-repository Hub harness owns this synthetic provider ID. It exercises the production
// registry path without extending exact-preapproval support to user-defined ACP providers.
const HUB_E2E_PROVIDER_CONTRACT: ProviderContract = {
  supportsExactMcpPreapproval: true,
  applyToolPolicy: (provider, toolPolicy) => {
    for (const grant of toolPolicy.preapproved) {
      if (
        grant.kind !== "mcp" ||
        grant.server !== HUB_E2E_MCP_SERVER ||
        !HUB_E2E_TOOL_NAME.test(grant.tool)
      ) {
        throw new ToolPolicyUnsupportedError(
          provider,
          `Provider '${provider}' accepts only exact MCP tool grants for the injected '${HUB_E2E_MCP_SERVER}' server`,
        );
      }
    }
    return {
      preapproved: toolPolicy.preapproved.map((grant) => ({ ...grant })),
    };
  },
};

const PROVIDER_CLIENT_FACTORIES: Record<string, ProviderClientFactory> = {
  claude: (logger, runtimeSettings, options) =>
    new ClaudeAgentClient({
      logger,
      runtimeSettings,
      ...(options?.claudeSpawnEnv && options.customProvider
        ? {
            spawnEnvOverlay: () =>
              options.claudeSpawnEnv?.(options.customProvider?.id ?? "") ?? Promise.resolve(null),
          }
        : {}),
    }),
  codex: (logger, runtimeSettings, options) =>
    new CodexAppServerAgentClient(logger, runtimeSettings, {
      workspaceGitService: options?.workspaceGitService,
      customProvider: options?.customProvider,
    }),
  copilot: (logger, runtimeSettings) =>
    new CopilotACPAgentClient({
      logger,
      runtimeSettings,
    }),
  cursor: (logger, runtimeSettings) =>
    new CursorACPAgentClient({
      logger,
      command: getCursorACPCommand(runtimeSettings),
      env: runtimeSettings?.env,
    }),
  opencode: (logger, runtimeSettings, options) =>
    new OpenCodeRuntimeClient(logger, runtimeSettings, {
      managedProcesses: options?.managedProcesses,
      bridge: options?.openCodeBridge,
      ...(options?.openCodeProviderInjection && options.customProvider
        ? {
            providerConfigInjection: () =>
              options.openCodeProviderInjection?.(options.customProvider?.id ?? "") ??
              Promise.resolve(null),
          }
        : {}),
    }),
  pi: (logger, runtimeSettings) =>
    new PiRpcAgentClient({
      logger,
      runtimeSettings,
    }),
  omp: (logger, runtimeSettings, options) =>
    new OmpAgentClient({
      logger,
      runtimeSettings,
      runtime: options?.ompRuntime,
    }),
  mock: (logger) => new MockLoadTestAgentClient(logger),
  "mock-slow": () => new MockSlowProviderClient(),
};

function getCursorACPCommand(
  runtimeSettings: ProviderRuntimeSettings | undefined,
): [string, ...string[]] {
  if (
    runtimeSettings?.command?.mode === "replace" &&
    isNonEmptyStringArray(runtimeSettings.command.argv)
  ) {
    return runtimeSettings.command.argv;
  }

  return ["cursor-agent", "acp"];
}

function getProviderClientFactory(provider: string): ProviderClientFactory {
  const factory = PROVIDER_CLIENT_FACTORIES[provider];
  if (!factory) {
    throw new Error(`No provider client factory registered for '${provider}'`);
  }
  return factory;
}

function toRuntimeSettings(override?: ProviderOverride): ProviderRuntimeSettings | undefined {
  if (!override?.command && !override?.env && !override?.disallowedTools) {
    return undefined;
  }

  return {
    command: override.command
      ? {
          mode: "replace",
          argv: override.command,
        }
      : undefined,
    env: override.env,
    disallowedTools: override.disallowedTools,
  };
}

function mergeRuntimeSettings(
  base: ProviderRuntimeSettings | undefined,
  override: ProviderRuntimeSettings | undefined,
): ProviderRuntimeSettings | undefined {
  if (!base && !override) {
    return undefined;
  }

  return {
    command: override?.command ?? base?.command,
    env:
      base?.env || override?.env
        ? {
            ...base?.env,
            ...override?.env,
          }
        : undefined,
    disallowedTools:
      base?.disallowedTools || override?.disallowedTools
        ? [...(base?.disallowedTools ?? []), ...(override?.disallowedTools ?? [])]
        : undefined,
  };
}

function applyOverrideToDefinition(
  definition: AgentProviderDefinition,
  override?: ProviderOverride,
): AgentProviderDefinition {
  if (!override) {
    return definition;
  }

  return {
    ...definition,
    label: override.label ?? definition.label,
    description: override.description ?? definition.description,
  };
}

function createDerivedDefinition(
  providerId: string,
  baseDefinition: AgentProviderDefinition,
  override: ProviderOverride,
): AgentProviderDefinition {
  if (!override.label) {
    throw new Error(`Custom provider '${providerId}' requires a label`);
  }

  return {
    ...baseDefinition,
    id: providerId,
    label: override.label,
    // An api provider (spec 34.2) is not the base provider: use its own
    // description when set, otherwise none — never the base provider's.
    description: override.api
      ? override.description
      : (override.description ?? baseDefinition.description),
  };
}

function mapPersistenceHandle(
  provider: AgentProvider,
  handle: AgentPersistenceHandle | null,
): AgentPersistenceHandle | null {
  if (!handle) {
    return null;
  }

  return {
    ...handle,
    provider,
  };
}

function mapRuntimeInfo(provider: AgentProvider, runtimeInfo: AgentRuntimeInfo): AgentRuntimeInfo {
  return {
    ...runtimeInfo,
    provider,
  };
}

function mapStreamEvent(provider: AgentProvider, event: AgentStreamEvent): AgentStreamEvent {
  return {
    ...event,
    provider,
  };
}

function mapModel(
  provider: AgentProvider,
  model: AgentModelDefinition | ProviderProfileModel,
): AgentModelDefinition {
  return normalizeAgentModelDefinition({ ...model, provider });
}

function resolveConfiguredModels(
  provider: AgentProvider,
  client: AgentClient,
  models: ProviderProfileModel[],
): AgentModelDefinition[] {
  return models.map((model) => {
    const mapped = mapModel(provider, model);
    return client.resolveConfiguredModel?.(mapped) ?? mapped;
  });
}

function mergeModels(
  provider: AgentProvider,
  profileModels: ProviderProfileModel[],
  additionalModels: ProviderProfileModel[],
  runtimeModels: AgentModelDefinition[],
  options?: { profileModelsAreAdditive?: boolean },
): AgentModelDefinition[] {
  const baseModels = runtimeModels.map((model) => mapModel(provider, model));
  if (profileModels.length > 0 && options?.profileModelsAreAdditive !== true) {
    return mergeModelAdditions(
      provider,
      profileModels.map((model) => mapModel(provider, model)),
      additionalModels,
    );
  }

  return mergeModelAdditions(provider, baseModels, [...profileModels, ...additionalModels]);
}

function mergeModelAdditions(
  provider: AgentProvider,
  baseModels: AgentModelDefinition[],
  modelAdditions: Array<ProviderProfileModel | AgentModelDefinition>,
): AgentModelDefinition[] {
  if (modelAdditions.length === 0) {
    return baseModels;
  }

  const mergedModels = [...baseModels];
  let hasAdditionalDefault = false;

  for (const model of modelAdditions) {
    const additionalModel = mapModel(provider, model);
    hasAdditionalDefault ||= additionalModel.isDefault === true;

    const existingIndex = mergedModels.findIndex((candidate) => candidate.id === model.id);
    if (existingIndex === -1) {
      mergedModels.push(additionalModel);
      continue;
    }

    const existingModel = mergedModels[existingIndex];
    const explicitlyEnablesCompatibilityModel =
      existingModel?.isSelectable === false && additionalModel.isSelectable === undefined;
    mergedModels[existingIndex] = {
      ...existingModel,
      ...additionalModel,
      ...(explicitlyEnablesCompatibilityModel ? { isSelectable: true } : {}),
    };
  }

  if (!hasAdditionalDefault) {
    return mergedModels;
  }

  const additionalDefaultIds = new Set(
    modelAdditions.filter((model) => model.isDefault === true).map((model) => model.id),
  );

  return mergedModels.map((model) =>
    additionalDefaultIds.has(model.id) ? model : Object.assign({}, model, { isDefault: false }),
  );
}

// Every session member must cross this boundary, including optional capabilities.
type ForwardedAgentSession = { [K in keyof Required<AgentSession>]: AgentSession[K] };

export function wrapSessionProvider(provider: AgentProvider, inner: AgentSession): AgentSession {
  return {
    provider,
    get id() {
      return inner.id;
    },
    get capabilities() {
      return inner.capabilities;
    },
    get persistenceUpdatedOnResume() {
      return inner.persistenceUpdatedOnResume;
    },
    get initialTimeline() {
      return inner.initialTimeline;
    },
    get controls() {
      return inner.controls;
    },
    get openOptionsPatch() {
      return inner.openOptionsPatch;
    },
    usageSession: inner.usageSession?.bind(inner),
    run: (prompt, options) => inner.run(prompt, options),
    startTurn: (prompt, options) => inner.startTurn(prompt, options),
    get steerActiveTurn() {
      return inner.steerActiveTurn?.bind(inner);
    },
    subscribe: (callback) => inner.subscribe((event) => callback(mapStreamEvent(provider, event))),
    async *streamHistory() {
      for await (const event of inner.streamHistory()) {
        yield mapStreamEvent(provider, event);
      }
    },
    getRuntimeInfo: async () => mapRuntimeInfo(provider, await inner.getRuntimeInfo()),
    getAvailableModes: () => inner.getAvailableModes(),
    getCurrentMode: () => inner.getCurrentMode(),
    setMode: (modeId) => inner.setMode(modeId),
    getPendingPermissions: () => inner.getPendingPermissions(),
    respondToPermission: (requestId, response) => inner.respondToPermission(requestId, response),
    describePersistence: () => mapPersistenceHandle(provider, inner.describePersistence()),
    interrupt: () => inner.interrupt(),
    stopBackgroundWork: inner.stopBackgroundWork?.bind(inner),
    close: () => inner.close(),
    canStopRuntime: inner.canStopRuntime?.bind(inner),
    listCommands: inner.listCommands?.bind(inner),
    checkJAgentDeskTools: inner.checkJAgentDeskTools?.bind(inner),
    setModel: inner.setModel?.bind(inner),
    setThinkingOption: inner.setThinkingOption?.bind(inner),
    applyOptions: inner.applyOptions?.bind(inner),
    revertConversation: inner.revertConversation?.bind(inner),
    revertFiles: inner.revertFiles?.bind(inner),
    revertBoth: inner.revertBoth?.bind(inner),
    tryHandleOutOfBand: inner.tryHandleOutOfBand?.bind(inner),
  } satisfies ForwardedAgentSession;
}

function wrapClientProvider(
  provider: AgentProvider,
  inner: AgentClient,
  profileModels: ProviderProfileModel[],
  additionalModels: ProviderProfileModel[],
  profileModelsAreAdditive: boolean,
  configuredOptions: ProviderOptions | undefined,
): AgentClient {
  const listImportableSessions = inner.listImportableSessions?.bind(inner);
  const importSession = inner.importSession?.bind(inner);
  const listControls = inner.listControls?.bind(inner);
  const archiveNativeSession = inner.archiveNativeSession?.bind(inner);
  const unarchiveNativeSession = inner.unarchiveNativeSession?.bind(inner);
  const configuredModelIds = [...profileModels, ...additionalModels].map((model) => model.id);
  // Converted where it is used, so a malformed configured default fails the call that reads it
  // rather than the registry that holds every provider.
  const configuredDefaults = () =>
    convertLegacyOptions({ provider: inner.provider, options: configuredOptions });
  const withDefaults = (own: ProviderOptions | undefined) =>
    mergeProviderOptions(configuredDefaults(), own);

  return {
    provider,
    get capabilities() {
      return inner.capabilities;
    },
    shutdown: inner.shutdown?.bind(inner),
    resolveUsageLaunch: inner.resolveUsageLaunch?.bind(inner),
    createSession: async (config, launchContext, options) =>
      wrapSessionProvider(
        provider,
        await inner.createSession(
          {
            ...config,
            provider: inner.provider,
            providerOptions: withDefaults(config.providerOptions),
          },
          launchContext,
          { ...options, configuredModelIds },
        ),
      ),
    resumeSession: async (handle, overrides, launchContext, options) =>
      wrapSessionProvider(
        provider,
        await inner.resumeSession(
          {
            ...handle,
            provider: inner.provider,
          },
          {
            ...overrides,
            provider: inner.provider,
            providerOptions: withDefaults(overrides?.providerOptions),
          },
          launchContext,
          { ...options, configuredModelIds },
        ),
      ),
    fetchCatalog: async (options, context) => {
      const catalog = await inner.fetchCatalog(
        { ...options, providerOptions: configuredDefaults() },
        context,
      );
      return {
        ...catalog,
        models: mergeModels(provider, profileModels, additionalModels, catalog.models, {
          profileModelsAreAdditive,
        }),
        modes: catalog.modes,
      };
    },
    resolveDefaultModeId: inner.resolveDefaultModeId
      ? async ({ config, env, signal }: ResolveAgentDefaultModeInput) =>
          await inner.resolveDefaultModeId?.({
            config: {
              ...config,
              provider: inner.provider,
              providerOptions: withDefaults(config.providerOptions),
            },
            env,
            signal,
          })
      : undefined,
    resolveCreateConfig: inner.resolveCreateConfig?.bind(inner),
    resolveConfiguredModel: inner.resolveConfiguredModel?.bind(inner),
    isCreateConfigUnattended: inner.isCreateConfigUnattended?.bind(inner),
    effectiveOptions: (own) => withDefaults(own) ?? {},
    listControls: listControls
      ? async (config) =>
          await listControls({
            ...config,
            provider: inner.provider,
            providerOptions: withDefaults(config.providerOptions),
          })
      : undefined,
    listImportableSessions: listImportableSessions
      ? async (options) =>
          await listImportableSessions({ ...options, providerOptions: configuredDefaults() })
      : undefined,
    importSession: importSession
      ? async (input, context) => {
          const imported = await importSession(input, {
            ...context,
            config: {
              ...context.config,
              provider: inner.provider,
              providerOptions: withDefaults(context.config.providerOptions),
            },
            storedConfig: {
              ...context.storedConfig,
              provider: inner.provider,
            },
          });
          const persistence = mapPersistenceHandle(provider, imported.persistence);
          if (!persistence) {
            throw new Error(`Provider '${provider}' import did not return persistence`);
          }
          return {
            ...imported,
            session: wrapSessionProvider(provider, imported.session),
            config: {
              ...imported.config,
              provider,
              providerOptions: context.storedConfig.providerOptions,
            },
            persistence,
          };
        }
      : undefined,
    archiveNativeSession: archiveNativeSession
      ? async (handle) => await archiveNativeSession({ ...handle, provider: inner.provider })
      : undefined,
    unarchiveNativeSession: unarchiveNativeSession
      ? async (handle) => await unarchiveNativeSession({ ...handle, provider: inner.provider })
      : undefined,
    isAvailable: (signal) => inner.isAvailable(signal),
    getDiagnostic: inner.getDiagnostic?.bind(inner),
    installation: inner.installation,
  };
}

function createRegistryEntry(
  logger: Logger,
  provider: AgentProvider,
  resolved: ResolvedProvider,
): ProviderDefinition {
  const modelClient = createResolvedProviderClient(logger, provider, resolved);
  const profileModels = resolveConfiguredModels(provider, modelClient, resolved.profileModels);
  const additionalModels = resolveConfiguredModels(
    provider,
    modelClient,
    resolved.additionalModels,
  );
  const hasReplacementModels = profileModels.length > 0 && !resolved.profileModelsAreAdditive;
  const replacementModels = hasReplacementModels
    ? profileModels.map((model) => mapModel(provider, model))
    : [];

  const decorateModes = (modes: AgentMode[]): AgentMode[] =>
    modes.map((mode) => {
      if (mode.icon && mode.colorTier) return mode;
      const definitionMode = resolved.definition.modes.find((d) => d.id === mode.id);
      if (!definitionMode) return mode;
      return Object.assign({}, mode, {
        icon: mode.icon ?? definitionMode.icon,
        colorTier: mode.colorTier ?? definitionMode.colorTier,
      });
    });

  const hasStaticModes = resolved.definition.modes.length > 0;

  return {
    ...resolved.definition,
    enabled: resolved.enabled,
    derivedFromProviderId: resolved.derivedFromProviderId,
    supportsExactMcpPreapproval: resolved.contract.supportsExactMcpPreapproval,
    applyToolPolicy: (config, toolPolicy) => {
      if (toolPolicy && !resolved.contract.supportsExactMcpPreapproval) {
        throw new ToolPolicyUnsupportedError(provider);
      }
      return {
        ...config,
        toolPolicy: toolPolicy
          ? (resolved.contract.applyToolPolicy?.(provider, toolPolicy) ?? toolPolicy)
          : undefined,
      };
    },
    createClient: (providerLogger: Logger) =>
      createResolvedProviderClient(providerLogger, provider, resolved),
    resolveCreateConfig: modelClient.resolveCreateConfig ?? resolveDefaultAgentCreateConfig,
    isCreateConfigUnattended:
      modelClient.isCreateConfigUnattended ?? isDefaultAgentCreateConfigUnattended,
    fetchCatalog: async (
      options: FetchCatalogOptions,
      client?: AgentClient,
      context?: ProviderRefreshContext,
    ) => {
      const catalogClient = client ?? modelClient;
      if (hasReplacementModels) {
        // Replacement models skip runtime model discovery, but additionalModels
        // must still be merged on top. If modes are dynamic, probe for modes via
        // the single catalog API; otherwise use static/empty modes with no runtime.
        const models = mergeModelAdditions(provider, replacementModels, additionalModels);
        if (hasStaticModes) {
          const defaultModeId = await runProviderRefreshActivity(
            context,
            "default-mode",
            async () =>
              await catalogClient.resolveDefaultModeId?.({
                config: {
                  provider,
                  cwd: options.scope === "workspace" ? options.cwd : process.cwd(),
                },
                signal: context?.signal,
              }),
          );
          return {
            models,
            modes: decorateModes(resolved.definition.modes),
            defaultModeId,
          };
        }
        const catalog = await catalogClient.fetchCatalog(options, context);
        return { ...catalog, models, modes: decorateModes(catalog.modes) };
      }

      const catalog = await catalogClient.fetchCatalog(options, context);
      return {
        ...catalog,
        models: mergeModels(provider, profileModels, additionalModels, catalog.models, {
          profileModelsAreAdditive: resolved.profileModelsAreAdditive,
        }),
        modes: decorateModes(catalog.modes),
      };
    },
  };
}

function createResolvedProviderClient(
  logger: Logger,
  provider: AgentProvider,
  resolved: ResolvedProvider,
): AgentClient {
  const inner = resolved.createBaseClient(logger);
  const profileModels = resolveConfiguredModels(provider, inner, resolved.profileModels);
  const additionalModels = resolveConfiguredModels(provider, inner, resolved.additionalModels);
  return wrapClientProvider(
    provider,
    inner,
    profileModels,
    additionalModels,
    resolved.profileModelsAreAdditive,
    resolved.providerOptions,
  );
}

interface RegisteredProvider {
  definition: AgentProviderDefinition;
  createClient: ProviderClientFactory;
  contract: ProviderContract;
  runtimeSettings?: ProviderRuntimeSettings;
  override?: ProviderOverride;
}

function resolveRegisteredProvider(input: RegisteredProvider): ResolvedProvider {
  const { definition, override, contract } = input;
  const runtimeSettings = mergeRuntimeSettings(input.runtimeSettings, toRuntimeSettings(override));
  return {
    definition: applyOverrideToDefinition(definition, override),
    runtimeSettings,
    profileModels: override?.models ?? [],
    additionalModels: override?.additionalModels ?? [],
    profileModelsAreAdditive: false,
    enabled: override?.enabled ?? definition.enabledByDefault ?? true,
    derivedFromProviderId: null,
    providerOptions: configuredProviderOptions(override),
    createBaseClient: (logger) => input.createClient(logger, runtimeSettings),
    contract,
  };
}

function buildResolvedBuiltinProviders(
  providerOverrides: Record<string, ProviderOverride>,
  runtimeSettings: AgentProviderRuntimeSettingsMap | undefined,
  options: Pick<
    BuildProviderRegistryOptions,
    "workspaceGitService" | "managedProcesses" | "ompRuntime" | "openCodeBridge"
  >,
  isDev: boolean,
): Map<string, ResolvedProvider> {
  const resolvedProviders = new Map<string, ResolvedProvider>();

  const definitions = isDev
    ? [...AGENT_PROVIDER_DEFINITIONS, ...DEV_AGENT_PROVIDER_DEFINITIONS]
    : AGENT_PROVIDER_DEFINITIONS;

  for (const definition of definitions) {
    const override = providerOverrides[definition.id];
    const factory = getProviderClientFactory(definition.id);
    const mergedRuntimeSettings = mergeRuntimeSettings(
      runtimeSettings?.[definition.id],
      toRuntimeSettings(override),
    );

    resolvedProviders.set(definition.id, {
      definition: applyOverrideToDefinition(definition, override),
      runtimeSettings: mergedRuntimeSettings,
      profileModels: override?.models ?? [],
      additionalModels: override?.additionalModels ?? [],
      profileModelsAreAdditive: false,
      enabled: override?.enabled ?? definition.enabledByDefault ?? true,
      derivedFromProviderId: null,
      providerOptions: configuredProviderOptions(override),
      createBaseClient: (logger) =>
        factory(logger, mergedRuntimeSettings, {
          workspaceGitService: options.workspaceGitService,
          managedProcesses: options.managedProcesses,
          ompRuntime: options.ompRuntime,
          openCodeBridge: options.openCodeBridge,
        }),
      contract: PROVIDER_CONTRACTS[definition.id] ?? UNSUPPORTED_PROVIDER_CONTRACT,
    });
  }

  return resolvedProviders;
}

/** api entries (spec 34.2): Anthropic-compatible endpoints cannot run Anthropic-only server tools. */
function withAnthropicToolRestriction(override: ProviderOverride): ProviderOverride {
  if (override.api?.protocol !== "anthropic") return override;
  if ((override.disallowedTools ?? []).includes("WebSearch")) return override;
  return {
    ...override,
    disallowedTools: [...(override.disallowedTools ?? []), "WebSearch"],
  };
}

/** api entries without an explicit extends derive their driver from the protocol (spec 34.2). */
function resolveDerivedBaseProviderId(override: ProviderOverride): string {
  return override.extends ?? (override.api?.protocol === "anthropic" ? "claude" : "opencode");
}

/**
 * Spec 34.3: the injected OpenCode config keys the provider by the JAgentDesk
 * provider id, so the model id OpenCode resolves is "<providerId>/<modelId>".
 * The registry therefore exposes openai api-provider models in that form (labels
 * and thinking options unchanged — a thinking option id is the OpenCode variant
 * id). providers.custom.list / config.json keep the raw id; anthropic api
 * providers pass their model ids to Claude Code verbatim and are not rewritten.
 */
function openCodeApiModels(
  providerId: string,
  override: ProviderOverride,
  key: "models" | "additionalModels",
): ProviderProfileModel[] {
  const models = override[key] ?? [];
  if (override.api?.protocol !== "openai") return models;
  return models.map((model) => Object.assign({}, model, { id: `${providerId}/${model.id}` }));
}

function addDerivedProviders(
  resolvedProviders: Map<string, ResolvedProvider>,
  providerOverrides: Record<string, ProviderOverride>,
  options: Pick<
    BuildProviderRegistryOptions,
    "managedProcesses" | "openCodeBridge" | "openCodeProviderInjection" | "claudeSpawnEnv"
  >,
): void {
  for (const [providerId, rawOverride] of Object.entries(providerOverrides)) {
    if (resolvedProviders.has(providerId) || BUILTIN_PROVIDER_IDS.includes(providerId)) {
      continue;
    }

    if (!rawOverride.extends && !rawOverride.api) {
      // Plugin overrides can precede registration (including disabled or removed plugins).
      continue;
    }

    const override = withAnthropicToolRestriction(rawOverride);

    if (override.extends === "acp") {
      if (!override.command || !isNonEmptyStringArray(override.command)) {
        throw new Error(`ACP provider '${providerId}' requires a command`);
      }
      // Capture command in const for closure - TypeScript can't track type refinement inside closures
      const command = override.command;

      resolvedProviders.set(providerId, {
        definition: createDerivedDefinition(
          providerId,
          {
            id: providerId,
            label: override.label ?? providerId,
            description: override.description ?? "Custom ACP provider",
            defaultModeId: null,
            modes: [],
          },
          override,
        ),
        runtimeSettings: toRuntimeSettings(override),
        profileModels: override.models ?? [],
        additionalModels: override.additionalModels ?? [],
        profileModelsAreAdditive: false,
        enabled: override.enabled !== false,
        derivedFromProviderId: null,
        providerOptions: configuredProviderOptions(override),
        createBaseClient: (logger) => {
          const acpOptions = {
            logger,
            command,
            env: override.env,
            providerId,
            label: override.label ?? providerId,
          };
          if (providerId === "cursor") {
            return new CursorACPAgentClient(acpOptions);
          }
          if (providerId === "kimi") {
            return new KimiACPAgentClient(acpOptions);
          }
          if (providerId === "kiro") {
            return new KiroACPAgentClient(acpOptions);
          }
          if (providerId === "traecli") {
            return new TraeACPAgentClient(acpOptions);
          }
          return new GenericACPAgentClient(acpOptions);
        },
        contract:
          providerId === HUB_E2E_PROVIDER_ID
            ? HUB_E2E_PROVIDER_CONTRACT
            : UNSUPPORTED_PROVIDER_CONTRACT,
      });
      continue;
    }

    const baseProviderId = resolveDerivedBaseProviderId(override);
    const baseProvider = resolvedProviders.get(baseProviderId);
    if (!baseProvider) {
      throw new Error(
        `Custom provider '${providerId}' extends unknown provider '${baseProviderId}'`,
      );
    }

    const mergedRuntimeSettings = mergeRuntimeSettings(
      baseProvider.runtimeSettings,
      toRuntimeSettings(override),
    );
    const baseDefinition = baseProvider.definition;
    const baseFactory = getProviderClientFactory(baseProviderId);
    const providerOptions = configuredProviderOptions(override) ?? baseProvider.providerOptions;

    resolvedProviders.set(providerId, {
      definition: createDerivedDefinition(providerId, baseDefinition, override),
      runtimeSettings: mergedRuntimeSettings,
      profileModels: openCodeApiModels(providerId, override, "models"),
      additionalModels: openCodeApiModels(providerId, override, "additionalModels"),
      profileModelsAreAdditive: false,
      enabled: override.enabled !== false,
      derivedFromProviderId: baseProviderId,
      providerOptions,
      createBaseClient: (logger) =>
        baseFactory(logger, mergedRuntimeSettings, {
          managedProcesses: options.managedProcesses,
          openCodeBridge: options.openCodeBridge,
          openCodeProviderInjection: options.openCodeProviderInjection,
          claudeSpawnEnv: options.claudeSpawnEnv,
          customProvider: {
            id: providerId,
            label: override.label ?? providerId,
            extends: baseProviderId,
          },
        }),
      contract: baseProvider.contract,
    });
  }
}

export function buildProviderRegistry(
  logger: Logger,
  options?: BuildProviderRegistryOptions,
): Record<AgentProvider, ProviderDefinition> {
  const runtimeSettings = options?.runtimeSettings;
  const providerOverrides = options?.providerOverrides ?? {};
  const resolvedProviders = buildResolvedBuiltinProviders(
    providerOverrides,
    runtimeSettings,
    {
      workspaceGitService: options?.workspaceGitService,
      managedProcesses: options?.managedProcesses,
      ompRuntime: options?.ompRuntime,
      openCodeBridge: options?.openCodeBridge,
    },
    options?.isDev === true,
  );
  for (const [provider, definition] of Object.entries(options?.pluginProviders ?? {})) {
    if (resolvedProviders.has(provider)) {
      throw new Error(`Plugin provider '${provider}' conflicts with a built-in provider`);
    }
    const override = providerOverrides[provider];
    if (requiresMissingConfiguration(definition, override)) continue;

    if (isDerivedOverride(override)) {
      logger.warn({ provider }, "Plugin provider shadowed by configured provider");
      continue;
    }
    resolvedProviders.set(
      provider,
      resolveRegisteredProvider({
        definition,
        override,
        runtimeSettings: runtimeSettings?.[provider],
        createClient: definition.createClient,
        contract: {
          supportsExactMcpPreapproval: definition.supportsExactMcpPreapproval,
        },
      }),
    );
  }
  addDerivedProviders(resolvedProviders, providerOverrides, {
    managedProcesses: options?.managedProcesses,
    openCodeBridge: options?.openCodeBridge,
    openCodeProviderInjection: options?.openCodeProviderInjection,
    claudeSpawnEnv: options?.claudeSpawnEnv,
  });

  return Object.fromEntries(
    [...resolvedProviders.entries()].map(([provider, resolved]) => [
      provider,
      createRegistryEntry(logger, provider, resolved),
    ]),
  ) as Record<AgentProvider, ProviderDefinition>;
}

export function getProviderIds(
  registry: Record<AgentProvider, ProviderDefinition>,
): AgentProvider[] {
  return Object.keys(registry);
}

// Deprecated: Use buildProviderRegistry instead
export const PROVIDER_REGISTRY: Record<AgentProvider, ProviderDefinition> =
  null as unknown as Record<AgentProvider, ProviderDefinition>;

export function createAllClients(
  logger: Logger,
  options?: BuildProviderRegistryOptions,
): Record<AgentProvider, AgentClient> {
  return createClientsFromRegistry(buildProviderRegistry(logger, options), logger);
}

export function createClientsFromRegistry(
  registry: Record<AgentProvider, ProviderDefinition>,
  logger: Logger,
): Record<AgentProvider, AgentClient> {
  return Object.fromEntries(
    Object.entries(registry).map(([provider, definition]) => [
      provider,
      definition.createClient(logger),
    ]),
  ) as Record<AgentProvider, AgentClient>;
}

export async function shutdownProviders(
  logger: Logger,
  options?: BuildProviderRegistryOptions,
): Promise<void> {
  const clients = createAllClients(logger, options);
  await shutdownAgentClients(Object.values(clients), logger);
}

export async function shutdownAgentClients(
  clients: Iterable<AgentClient>,
  logger: Logger,
): Promise<void> {
  await Promise.all(
    Array.from(clients).map(async (client) => {
      if (!client.shutdown) return;
      try {
        await client.shutdown();
      } catch (error) {
        logger.warn({ err: error, provider: client.provider }, "Provider client shutdown failed");
      }
    }),
  );
}

function configuredProviderOptions(
  override: ProviderOverride | undefined,
): ProviderOptions | undefined {
  // COMPAT(providerParams): added in v0.10.0, remove after 2027-03-30 once configs use options.
  // options wins as a whole record when both spellings are supplied.
  return override?.options ?? override?.params;
}

function requiresMissingConfiguration(
  definition: RegisteredProviderDefinition,
  override: ProviderOverride | undefined,
): boolean {
  return definition.requiresConfiguration === true && !override;
}

function isDerivedOverride(override: ProviderOverride | undefined): boolean {
  return Boolean(override?.extends);
}
