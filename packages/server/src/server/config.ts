import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveJAgentDeskNodeEnv } from "./jagentdesk-env.js";
import { z } from "zod";
import { expandTilde } from "../utils/path.js";

import type { JAgentDeskDaemonConfig } from "./bootstrap.js";
import {
  loadPersistedConfig,
  LogFormatSchema,
  LogLevelSchema,
  type PersistedConfig,
} from "./persisted-config.js";
import type { AgentProvider } from "./agent/agent-sdk-types.js";
import type {
  AgentProviderRuntimeSettingsMap,
  ProviderOverride,
} from "./agent/provider-launch-config.js";
import { ProviderOverrideSchema } from "./agent/provider-launch-config.js";
import { AgentProviderSchema } from "@jagentdesk/protocol/provider-manifest";
import { hashDaemonPassword } from "./auth.js";
import { resolveSpeechConfig } from "./speech/speech-config-resolver.js";
import { mergeHostnames, parseHostnamesEnv, type HostnamesConfig } from "./hostnames.js";
import { resolveGitProcessPolicy } from "../utils/git-process-scheduler.js";
import { DEFAULT_JAGENTDESK_DAEMON_PORT } from "@jagentdesk/protocol/defaults";

const DEFAULT_APP_BASE_URL = "jagentdesk://app";
const DEFAULT_TRUSTED_PROXIES = ["loopback"];

interface ResolveBundledWebUiDistDirInput {
  moduleUrl?: string | URL;
  resourcesPath?: string;
}

export function resolveBundledWebUiDistDir(input: ResolveBundledWebUiDistDirInput = {}): string {
  const moduleUrl = input.moduleUrl ?? import.meta.url;
  const moduleDir = path.dirname(fileURLToPath(moduleUrl));

  if (path.basename(moduleDir) === "server" && path.basename(path.dirname(moduleDir)) === "src") {
    return path.resolve(moduleDir, "..", "..", "dist", "server", "web-ui");
  }

  if (
    path.basename(moduleDir) === "server" &&
    path.basename(path.dirname(moduleDir)) === "server" &&
    path.basename(path.dirname(path.dirname(moduleDir))) === "dist"
  ) {
    const appDistDir = input.resourcesPath ? path.join(input.resourcesPath, "app-dist") : null;

    if (appDistDir && existsSync(appDistDir)) {
      return appDistDir;
    }

    return path.resolve(moduleDir, "..", "web-ui");
  }

  return path.resolve(moduleDir, "web-ui");
}

const processResourcesPath = "resourcesPath" in process ? process.resourcesPath : undefined;
const BUNDLED_WEB_UI_DIST_DIR = resolveBundledWebUiDistDir({
  resourcesPath: typeof processResourcesPath === "string" ? processResourcesPath : undefined,
});

function parseBooleanEnv(value: string | undefined): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  return undefined;
}

function normalizeLogEnv(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  return value.trim().toLowerCase();
}

function resolveGitProcessConfig(
  env: NodeJS.ProcessEnv,
  persisted: ReturnType<typeof loadPersistedConfig>,
): NonNullable<JAgentDeskDaemonConfig["git"]> {
  return resolveGitProcessPolicy({
    env,
    persisted: persisted.daemon?.git,
  });
}

export type CliConfigOverrides = Partial<{
  listen: string;
  mcpEnabled: boolean;
  mcpInjectIntoAgents: boolean;
  webUiEnabled: boolean;
  hostnames: HostnamesConfig;
}>;

type TrustedProxiesConfig = true | string[];

function resolveLogConfigFromEnv(
  env: NodeJS.ProcessEnv,
  persisted: ReturnType<typeof loadPersistedConfig>,
): PersistedConfig["log"] {
  const envLogLevel = LogLevelSchema.safeParse(normalizeLogEnv(env.JAGENTDESK_LOG_LEVEL));
  const envLogFormat = LogFormatSchema.safeParse(normalizeLogEnv(env.JAGENTDESK_LOG_FORMAT));

  if (!envLogLevel.success && !envLogFormat.success) {
    return persisted.log;
  }

  return {
    ...persisted.log,
    ...(envLogLevel.success ? { level: envLogLevel.data } : {}),
    ...(envLogFormat.success ? { format: envLogFormat.data } : {}),
  };
}

const OptionalVoiceLlmProviderSchema = z
  .union([z.string(), z.null(), z.undefined()])
  .transform((value): string | null =>
    typeof value === "string" ? value.trim().toLowerCase() : null,
  )
  .pipe(z.union([AgentProviderSchema, z.null()]));

function parseOptionalVoiceLlmProvider(value: unknown): AgentProvider | null {
  const parsed = OptionalVoiceLlmProviderSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function extractProviderOverrides(
  providers: Record<string, unknown> | undefined,
): Record<string, ProviderOverride> | undefined {
  if (!providers) {
    return undefined;
  }

  const providerOverrides = Object.entries(providers).flatMap(([providerId, provider]) => {
    const parsed = ProviderOverrideSchema.safeParse(provider);
    return parsed.success ? [[providerId, parsed.data] as const] : [];
  });

  return providerOverrides.length > 0 ? Object.fromEntries(providerOverrides) : undefined;
}

function extractAgentProviderSettings(
  providerOverrides: Record<string, ProviderOverride> | undefined,
): AgentProviderRuntimeSettingsMap | undefined {
  if (!providerOverrides) {
    return undefined;
  }

  const runtimeSettings = Object.entries(providerOverrides).flatMap(([providerId, provider]) => {
    const parsedProviderId = AgentProviderSchema.safeParse(providerId);
    if (!parsedProviderId.success || (!provider.command && !provider.env)) {
      return [];
    }

    return [
      [
        parsedProviderId.data,
        {
          command: provider.command
            ? {
                mode: "replace" as const,
                argv: provider.command,
              }
            : undefined,
          env: provider.env,
        },
      ] as const,
    ];
  });

  return runtimeSettings.length > 0
    ? (Object.fromEntries(runtimeSettings) as AgentProviderRuntimeSettingsMap)
    : undefined;
}

interface ResolvedServiceProxy {
  publicBaseUrl: string | null;
  standaloneListen: string | null;
}

interface ResolvedVoiceLlm {
  provider: AgentProvider | null;
  providerExplicit: boolean;
  model: string | null;
}

function resolveServiceProxyPublicBaseUrl(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  try {
    return new URL(value).toString().replace(/\/$/, "");
  } catch {
    throw new Error(`Invalid JAGENTDESK_SERVICE_PROXY_PUBLIC_BASE_URL: ${value}`);
  }
}

function resolveServiceProxyConfig(
  env: NodeJS.ProcessEnv,
  persisted: ReturnType<typeof loadPersistedConfig>,
): ResolvedServiceProxy {
  const enabledShim =
    parseBooleanEnv(env.JAGENTDESK_SERVICE_PROXY_ENABLED) ??
    persisted.daemon?.serviceProxy?.enabled;
  // COMPAT(serviceProxyEnabled): added 2026-06-02, remove after 2026-12-02.
  // `enabled=false` used to disable the separate service proxy listener. Localhost
  // service proxying is now always enabled; this only suppresses optional layers.
  const optionalLayersEnabled = enabledShim !== false;
  const publicBaseUrl = optionalLayersEnabled
    ? resolveServiceProxyPublicBaseUrl(
        env.JAGENTDESK_SERVICE_PROXY_PUBLIC_BASE_URL ??
          persisted.daemon?.serviceProxy?.publicBaseUrl ??
          null,
      )
    : null;
  const standaloneListen = optionalLayersEnabled
    ? (env.JAGENTDESK_SERVICE_PROXY_LISTEN ?? persisted.daemon?.serviceProxy?.listen ?? null)
    : null;

  return { publicBaseUrl, standaloneListen };
}

interface ResolvedWebUi {
  enabled: boolean;
  distDir: string | null;
}

function resolveWebUiConfig(
  jagentdeskHome: string,
  env: NodeJS.ProcessEnv,
  cli: CliConfigOverrides | undefined,
  persisted: ReturnType<typeof loadPersistedConfig>,
): ResolvedWebUi {
  const enabled =
    cli?.webUiEnabled ??
    parseBooleanEnv(env.JAGENTDESK_WEB_UI_ENABLED) ??
    persisted.features?.webUi?.enabled ??
    false;
  const rawDistDir = env.JAGENTDESK_WEB_UI_DIST_DIR ?? persisted.features?.webUi?.distDir;
  const trimmedDistDir = rawDistDir?.trim();
  const distDir = trimmedDistDir
    ? path.resolve(
        path.isAbsolute(trimmedDistDir) ? trimmedDistDir : jagentdeskHome,
        trimmedDistDir,
      )
    : BUNDLED_WEB_UI_DIST_DIR;
  return {
    enabled,
    distDir,
  };
}

function resolveVoiceLlmConfig(
  env: NodeJS.ProcessEnv,
  persisted: ReturnType<typeof loadPersistedConfig>,
): ResolvedVoiceLlm {
  const envVoiceLlmProvider = parseOptionalVoiceLlmProvider(env.JAGENTDESK_VOICE_LLM_PROVIDER);
  const persistedVoiceLlmProvider = parseOptionalVoiceLlmProvider(
    persisted.features?.voiceMode?.llm?.provider,
  );
  return {
    provider: envVoiceLlmProvider ?? persistedVoiceLlmProvider ?? null,
    providerExplicit: envVoiceLlmProvider !== null || persistedVoiceLlmProvider !== null,
    model: persisted.features?.voiceMode?.llm?.model ?? null,
  };
}

function resolveCorsAllowedOrigins(
  env: NodeJS.ProcessEnv,
  persisted: ReturnType<typeof loadPersistedConfig>,
): string[] {
  const envCorsOrigins = env.JAGENTDESK_CORS_ORIGINS
    ? env.JAGENTDESK_CORS_ORIGINS.split(",").map((s) => s.trim())
    : [];
  const persistedCorsOrigins = persisted.daemon?.cors?.allowedOrigins ?? [];
  return Array.from(
    new Set([...persistedCorsOrigins, ...envCorsOrigins].filter((s) => s.length > 0)),
  );
}

function parseTrustedProxiesEnv(value: string | undefined): TrustedProxiesConfig | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }

  const normalized = trimmed.toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return [];
  }

  return trimmed
    .split(",")
    .map((proxy) => proxy.trim())
    .filter((proxy) => proxy.length > 0);
}

function resolveTrustedProxiesConfig(
  env: NodeJS.ProcessEnv,
  persisted: ReturnType<typeof loadPersistedConfig>,
): TrustedProxiesConfig {
  return (
    parseTrustedProxiesEnv(env.JAGENTDESK_TRUSTED_PROXIES) ??
    persisted.daemon?.trustedProxies ??
    DEFAULT_TRUSTED_PROXIES
  );
}

// JAGENTDESK_LISTEN can be:
// - host:port (TCP)
// - /path/to/socket (Unix socket)
// - unix:///path/to/socket (Unix socket)
// Default is TCP at 127.0.0.1:6768
function resolveListenAddress(
  env: NodeJS.ProcessEnv,
  cli: CliConfigOverrides | undefined,
  persisted: ReturnType<typeof loadPersistedConfig>,
): string {
  return (
    cli?.listen ??
    env.JAGENTDESK_LISTEN ??
    persisted.daemon?.listen ??
    `127.0.0.1:${env.PORT ?? DEFAULT_JAGENTDESK_DAEMON_PORT}`
  );
}

function resolveAuthConfig(
  env: NodeJS.ProcessEnv,
  persisted: ReturnType<typeof loadPersistedConfig>,
): JAgentDeskDaemonConfig["auth"] {
  const envPassword = env.JAGENTDESK_PASSWORD?.trim();
  if (envPassword) {
    return { password: hashDaemonPassword(envPassword) };
  }
  return persisted.daemon?.auth?.password
    ? { password: persisted.daemon.auth.password }
    : undefined;
}

function resolveWorktreesRoot(
  jagentdeskHome: string,
  persisted: ReturnType<typeof loadPersistedConfig>,
): string | undefined {
  const configuredRoot = persisted.worktrees?.root?.trim();
  if (!configuredRoot) {
    return undefined;
  }

  const expandedRoot = expandTilde(configuredRoot);
  return path.isAbsolute(expandedRoot)
    ? path.resolve(expandedRoot)
    : path.resolve(jagentdeskHome, expandedRoot);
}

function resolveAppendSystemPrompt(persisted: ReturnType<typeof loadPersistedConfig>): string {
  return persisted.daemon?.appendSystemPrompt ?? "";
}

function resolveBrowserToolsEnabled(persisted: ReturnType<typeof loadPersistedConfig>): boolean {
  return persisted.daemon?.browserTools?.enabled ?? false;
}

function resolveStaticLoadConfigSettings(
  env: NodeJS.ProcessEnv,
  cli: CliConfigOverrides | undefined,
  persisted: ReturnType<typeof loadPersistedConfig>,
) {
  return {
    mcpEnabled: cli?.mcpEnabled ?? persisted.daemon?.mcp?.enabled ?? true,
    mcpInjectIntoAgents:
      cli?.mcpInjectIntoAgents ?? persisted.daemon?.mcp?.injectIntoAgents ?? false,
    browserToolsEnabled: resolveBrowserToolsEnabled(persisted),
    autoArchiveAfterMerge: persisted.daemon?.autoArchiveAfterMerge ?? false,
    appendSystemPrompt: resolveAppendSystemPrompt(persisted),
    terminalProfiles: persisted.daemon?.terminalProfiles,
    orchestration: persisted.daemon?.orchestration,
    hostnames: mergeHostnames([
      persisted.daemon?.hostnames,
      parseHostnamesEnv(env.JAGENTDESK_HOSTNAMES ?? env.JAGENTDESK_ALLOWED_HOSTS),
      cli?.hostnames,
    ]),
    trustedProxies: resolveTrustedProxiesConfig(env, persisted),
    appBaseUrl: env.JAGENTDESK_APP_BASE_URL ?? persisted.app?.baseUrl ?? DEFAULT_APP_BASE_URL,
  };
}

export function loadConfig(
  jagentdeskHome: string,
  options?: {
    env?: NodeJS.ProcessEnv;
    cli?: CliConfigOverrides;
  },
): JAgentDeskDaemonConfig {
  const env = options?.env ?? process.env;
  const persisted = loadPersistedConfig(jagentdeskHome);

  const listen = resolveListenAddress(env, options?.cli, persisted);
  const {
    mcpEnabled,
    mcpInjectIntoAgents,
    browserToolsEnabled,
    autoArchiveAfterMerge,
    appendSystemPrompt,
    terminalProfiles,
    orchestration,
    hostnames,
    trustedProxies,
    appBaseUrl,
  } = resolveStaticLoadConfigSettings(env, options?.cli, persisted);

  const serviceProxy = resolveServiceProxyConfig(env, persisted);
  const webUi = resolveWebUiConfig(jagentdeskHome, env, options?.cli, persisted);

  const { openai, speech } = resolveSpeechConfig({
    jagentdeskHome,
    env,
    persisted,
  });

  const voiceLlm = resolveVoiceLlmConfig(env, persisted);
  const providerOverrides = extractProviderOverrides(
    persisted.agents?.providers as Record<string, unknown> | undefined,
  );

  return {
    listen,
    jagentdeskHome,
    desktopManaged: env.JAGENTDESK_DESKTOP_MANAGED === "1",
    worktreesRoot: resolveWorktreesRoot(jagentdeskHome, persisted),
    corsAllowedOrigins: resolveCorsAllowedOrigins(env, persisted),
    hostnames,
    trustedProxies,
    mcpEnabled,
    mcpInjectIntoAgents,
    browserToolsEnabled,
    git: resolveGitProcessConfig(env, persisted),
    autoArchiveAfterMerge,
    enableTerminalAgentHooks: persisted.daemon?.enableTerminalAgentHooks ?? false,
    appendSystemPrompt,
    terminalProfiles,
    orchestration,
    mcpDebug: env.MCP_DEBUG === "1",
    isDev: resolveJAgentDeskNodeEnv(env) === "development",
    agentStoragePath: path.join(jagentdeskHome, "agents"),
    staticDir: "public",
    agentClients: {},
    tailnetHost: env.JAGENTDESK_TAILNET_HOST ?? persisted.tailnet?.host,
    tailnetStateDir: env.TS_STATE_DIR ?? persisted.tailnet?.stateDir,
    tailnetHostname: persisted.tailnet?.hostname,
    serviceProxy,
    webUi,
    appBaseUrl,
    auth: resolveAuthConfig(env, persisted),
    openai,
    speech,
    voiceLlmProvider: voiceLlm.provider,
    voiceLlmProviderExplicit: voiceLlm.providerExplicit,
    voiceLlmModel: voiceLlm.model,
    agentProviderSettings: extractAgentProviderSettings(providerOverrides),
    metadataGeneration: persisted.agents?.metadataGeneration,
    providerOverrides,
    log: resolveLogConfigFromEnv(env, persisted),
  };
}
