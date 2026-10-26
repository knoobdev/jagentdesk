import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { BuiltinPluginConfigSchema } from "@jagentdesk/protocol/builtin-plugins";
import { DEFAULT_JAGENTDESK_DAEMON_PORT } from "@jagentdesk/protocol/defaults";

import {
  AgentProviderRuntimeSettingsMapSchema,
  migrateProviderSettings,
  ProviderOverridesSchema,
} from "./agent/provider-launch-config.js";
import type { AgentProviderRuntimeSettingsMap } from "./agent/provider-launch-config.js";
import { ensurePrivateFile, writePrivateFileAtomicSync } from "./private-files.js";
import { TerminalProfileSchema } from "@jagentdesk/protocol/messages";
import { PluginIdSchema, PluginSourceSchema } from "@jagentdesk/protocol/plugin-config";
import { BrowserFingerprintProfileSchema } from "@jagentdesk/protocol/browser-automation/fingerprint-profile";
import { JAgentDeskServicePortAllocationSchema } from "@jagentdesk/protocol/jagentdesk-config-schema";
import { OrchestrationConfigSchema } from "@jagentdesk/protocol/orchestration";

export const LogLevelSchema = z.enum(["trace", "debug", "info", "warn", "error", "fatal"]);
export const LogFormatSchema = z.enum(["pretty", "json"]);

const LogConfigSchema = z
  .object({
    // Legacy global log settings (kept for backwards compatibility).
    level: LogLevelSchema.optional(),
    format: LogFormatSchema.optional(),

    console: z
      .object({
        level: LogLevelSchema.optional(),
        format: LogFormatSchema.optional(),
      })
      .strict()
      .optional(),

    file: z
      .object({
        level: LogLevelSchema.optional(),
        path: z.string().min(1).optional(),
        rotate: z
          .object({
            maxSize: z.string().min(1).optional(),
            maxFiles: z.number().int().positive().optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const LocalSpeechProviderSchema = z
  .object({
    modelsDir: z.string().min(1).optional(),
  })
  .strict();

const ProvidersSchema = z
  .object({
    local: LocalSpeechProviderSchema.optional(),
  })
  .strict();

const WorktreesConfigSchema = z
  .object({
    root: z.string().min(1).optional(),
    servicePorts: JAgentDeskServicePortAllocationSchema.optional(),
  })
  .strict();

const BcryptHashSchema = z.string().regex(/^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/, {
  message: "Expected a bcrypt hash",
});

const DaemonAuthSchema = z
  .object({
    password: BcryptHashSchema.optional(),
  })
  .strict();

const SpeechProviderIdSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.enum(["openai", "local"]));

const SpeechModelSchema = z.string().min(1).optional();
const OpenAiConnectionFields = {
  apiKey: z.string().trim().min(1).optional(),
  baseUrl: z.string().trim().min(1).optional(),
};

export const SpeechSttConfigSchema = z.discriminatedUnion("provider", [
  z
    .object({
      provider: z.literal("local"),
      model: SpeechModelSchema,
      language: z.string().trim().min(1).optional(),
    })
    .strict(),
  z
    .object({
      provider: z.literal("openai"),
      ...OpenAiConnectionFields,
      model: SpeechModelSchema,
      language: z.string().trim().min(1).optional(),
      confidenceThreshold: z.number().optional(),
    })
    .strict(),
]);

export const SpeechTtsConfigSchema = z.discriminatedUnion("provider", [
  z
    .object({
      provider: z.literal("local"),
      model: SpeechModelSchema,
      speakerId: z.number().int().optional(),
      speed: z.number().optional(),
    })
    .strict(),
  z
    .object({
      provider: z.literal("openai"),
      ...OpenAiConnectionFields,
      model: SpeechModelSchema,
      voice: z.string().trim().min(1).optional(),
    })
    .strict(),
]);

const FeatureDictationSchema = z
  .object({
    enabled: z.boolean().optional(),
    stt: SpeechSttConfigSchema.optional(),
  })
  .strict();

const FeatureVoiceModeSchema = z
  .object({
    enabled: z.boolean().optional(),
    llm: z
      .object({
        provider: z.string().optional(),
        model: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
    stt: SpeechSttConfigSchema.optional(),
    turnDetection: z
      .object({
        provider: SpeechProviderIdSchema.optional(),
      })
      .strict()
      .optional(),
    tts: SpeechTtsConfigSchema.optional(),
  })
  .strict();

const FeatureWebUiSchema = z
  .object({
    enabled: z.boolean().optional(),
    distDir: z.string().min(1).optional(),
  })
  .strict();

const StructuredGenerationProviderConfigSchema = z
  .object({
    provider: z.string().min(1),
    model: z.string().min(1).optional(),
    thinkingOptionId: z.string().min(1).optional(),
  })
  .strict();

const AgentMetadataGenerationSchema = z
  .object({
    providers: z.array(StructuredGenerationProviderConfigSchema).optional(),
  })
  .strict();

const BUILTIN_PROVIDER_IDS = ["claude", "codex", "copilot", "opencode", "pi", "omp"] as const;

function isLegacyProviderEntry(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const command = (value as Record<string, unknown>).command;
  if (!command || typeof command !== "object" || Array.isArray(command)) {
    return false;
  }

  return typeof (command as Record<string, unknown>).mode === "string";
}

function normalizeAgentProviders(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }

  const rawProviders = value as Record<string, unknown>;
  const hasLegacyEntries = Object.values(rawProviders).some((entry) =>
    isLegacyProviderEntry(entry),
  );
  if (!hasLegacyEntries) {
    return value;
  }

  const legacyEntries: Record<string, unknown> = {};
  const normalizedEntries: Record<string, unknown> = {};

  for (const [providerId, providerValue] of Object.entries(rawProviders)) {
    if (isLegacyProviderEntry(providerValue)) {
      legacyEntries[providerId] = providerValue;
      continue;
    }
    normalizedEntries[providerId] = providerValue;
  }

  const parsedLegacyEntries = AgentProviderRuntimeSettingsMapSchema.safeParse(legacyEntries);
  if (!parsedLegacyEntries.success) {
    return value;
  }

  return {
    ...normalizedEntries,
    ...migrateProviderSettings(parsedLegacyEntries.data, [...BUILTIN_PROVIDER_IDS]),
  };
}

export const PersistedConfigSchema = z
  .object({
    $schema: z.string().optional(),

    // v1 schema marker
    version: z.literal(1).optional(),

    // v1 config layout
    daemon: z
      .object({
        listen: z.string().optional(),
        hostnames: z.union([z.literal(true), z.array(z.string())]).optional(),
        allowedHosts: z.union([z.literal(true), z.array(z.string())]).optional(),
        trustedProxies: z
          .union([z.literal(true), z.array(z.string())])
          .optional()
          .describe(
            'Express trusted proxy setting for X-Forwarded-* headers. Defaults to ["loopback"]. Use true only when the final trusted proxy overwrites client-supplied forwarded headers.',
          ),
        mcp: z
          .object({
            enabled: z.boolean().optional(),
            injectIntoAgents: z.boolean().optional(),
          })
          .passthrough()
          .optional(),
        browserTools: z
          .object({
            enabled: z.boolean().optional(),
            profiles: z.array(BrowserFingerprintProfileSchema).optional(),
            activeProfileId: z.string().nullable().optional(),
          })
          .passthrough()
          .optional(),
        // Autonomous run (spec §20.12). Default OFF; opt-in per daemon.
        autorun: z
          .object({
            enabled: z.boolean().optional(),
          })
          .passthrough()
          .optional(),
        // Session sharing (spec §21.11). Default OFF; opt-in per daemon.
        sessionSharing: z
          .object({
            enabled: z.boolean().optional(),
          })
          .passthrough()
          .optional(),
        // Relay second connection path (spec 35.3). Default ON; endpoint is the
        // deployed Worker and is overridable here or via JAGENTDESK_RELAY_*.
        relay: z
          .object({
            enabled: z.boolean().optional(),
            endpoint: z.string().min(1).optional(),
            useTls: z.boolean().optional(),
          })
          .strict()
          .optional(),
        git: z
          .object({
            maxProcessesPerSecond: z.number().int().positive().optional(),
            maxProcessConcurrency: z.number().int().positive().optional(),
          })
          .strict()
          .optional(),
        autoArchiveAfterMerge: z.boolean().optional(),
        enableTerminalAgentHooks: z.boolean().optional(),
        appendSystemPrompt: z.string().optional(),
        operatorContext: z.string().optional(),
        terminalProfiles: z.array(TerminalProfileSchema).optional(),
        orchestration: OrchestrationConfigSchema.optional(),
        cors: z
          .object({
            allowedOrigins: z.array(z.string()).optional(),
          })
          .strict()
          .optional(),
        serviceProxy: z
          .object({
            // COMPAT(serviceProxyEnabled): added 2026-06-02, remove after 2026-12-02.
            // Parsed only to suppress optional public/listen layers for old configs;
            // localhost service proxying remains always enabled.
            enabled: z
              .boolean()
              .optional()
              .describe(
                "Compatibility shim. false suppresses optional service proxy listen/public layers only; localhost proxying remains enabled.",
              ),
            listen: z
              .string()
              .optional()
              .describe(
                "Optional service-only listener address. Presence enables the standalone service proxy listener.",
              ),
            publicBaseUrl: z
              .url()
              .optional()
              .describe("Optional public base URL for service host aliases."),
          })
          .strict()
          .optional(),
        auth: DaemonAuthSchema.optional(),
      })
      .strict()
      .transform(({ allowedHosts, ...daemon }) => {
        const hostnames = daemon.hostnames ?? allowedHosts;
        return hostnames === undefined ? daemon : { ...daemon, hostnames };
      })
      .optional(),

    app: z
      .object({
        baseUrl: z.string().optional(),
      })
      .strict()
      .optional(),

    tailnet: z
      .object({
        host: z.string().optional(),
        stateDir: z.string().optional(),
        hostname: z.string().optional(),
      })
      .strict()
      .optional(),

    providers: ProvidersSchema.optional(),
    // Plugins persist at the top level, matching upstream's config layout.
    builtinPlugins: BuiltinPluginConfigSchema.optional(),
    pluginsEnabled: z.boolean().optional(),
    plugins: z.record(PluginIdSchema, PluginSourceSchema).optional(),
    worktrees: WorktreesConfigSchema.optional(),
    agents: z
      .object({
        providers: z.preprocess(normalizeAgentProviders, ProviderOverridesSchema).optional(),
        metadataGeneration: AgentMetadataGenerationSchema.optional(),
      })
      .strict()
      .optional(),
    features: z
      .object({
        dictation: FeatureDictationSchema.optional(),
        voiceMode: FeatureVoiceModeSchema.optional(),
        webUi: FeatureWebUiSchema.optional(),
      })
      .strict()
      .optional(),

    log: LogConfigSchema.optional(),
  })
  .strict();

type PersistedConfigSchemaOutput = z.infer<typeof PersistedConfigSchema>;

export type PersistedConfig = Omit<PersistedConfigSchemaOutput, "agents"> & {
  agents?: Omit<NonNullable<PersistedConfigSchemaOutput["agents"]>, "providers"> & {
    providers?: AgentProviderRuntimeSettingsMap;
  };
};

const CONFIG_FILENAME = "config.json";
const DEFAULT_PERSISTED_CONFIG = PersistedConfigSchema.parse({
  version: 1,
  daemon: {
    listen: `127.0.0.1:${DEFAULT_JAGENTDESK_DAEMON_PORT}`,
    cors: {
      allowedOrigins: [],
    },
  },
}) as PersistedConfig;

interface LoggerLike {
  child(bindings: Record<string, unknown>): LoggerLike;
  info(...args: unknown[]): void;
  warn?(...args: unknown[]): void;
}

function getConfigPath(jagentdeskHome: string): string {
  return path.join(jagentdeskHome, CONFIG_FILENAME);
}

function getLogger(logger: LoggerLike | undefined): LoggerLike | undefined {
  return logger?.child({ module: "config" });
}

function isConfigRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function configRecord(value: unknown): Record<string, unknown> | undefined {
  return isConfigRecord(value) ? value : undefined;
}

// COMPAT(speechProviderConfig): added in v0.12.0, remove after 2027-04-26.
// Fold shared credentials once at the file boundary; consumers see only the strict
// per-site shape. Never include credential values in diagnostics.
function normalizeSpeechProviderConfig(parsed: unknown, logger?: LoggerLike): unknown {
  if (!isConfigRecord(parsed)) return parsed;
  const root = structuredClone(parsed);
  const providers = configRecord(root.providers);
  const legacy = configRecord(providers?.openai);
  const features = configRecord(root.features);
  const foldedKeys = new Set<string>();
  for (const [feature, kind] of [
    ["dictation", "stt"],
    ["voiceMode", "stt"],
    ["voiceMode", "tts"],
  ] as const) {
    const site = configRecord(configRecord(features?.[feature])?.[kind]);
    if (site) normalizeSpeechSite(site, kind, legacy, foldedKeys);
  }
  if (legacy) warnDiscardedSpeechKeys(legacy, foldedKeys, logger);
  if (providers) {
    delete providers.openai;
    const local = configRecord(providers.local);
    if (local) delete local.autoDownload;
  }
  return root;
}

function normalizeSpeechSite(
  site: Record<string, unknown>,
  kind: "stt" | "tts",
  legacy: Record<string, unknown> | undefined,
  foldedKeys: Set<string>,
) {
  site.provider =
    typeof site.provider === "string"
      ? site.provider.trim().toLowerCase()
      : (site.provider ?? "local");
  if (kind === "stt" && site.provider === "local") {
    delete site.confidenceThreshold;
  }
  if (kind === "tts") {
    if (site.provider === "local") delete site.voice;
    if (site.provider === "openai") {
      delete site.speakerId;
      delete site.speed;
    }
  }
  if (site.provider !== "openai" || !legacy) return;
  const endpoint = configRecord(legacy[kind]);
  for (const field of ["apiKey", "baseUrl"] as const) {
    if (site[field] !== undefined) continue;
    if (endpoint?.[field] !== undefined) {
      site[field] = endpoint[field];
      foldedKeys.add(`providers.openai.${kind}.${field}`);
    } else if (legacy[field] !== undefined) {
      site[field] = legacy[field];
      foldedKeys.add(`providers.openai.${field}`);
    }
  }
}

function warnDiscardedSpeechKeys(
  legacy: Record<string, unknown>,
  foldedKeys: Set<string>,
  logger?: LoggerLike,
) {
  const keys = [
    ["providers.openai.apiKey", legacy.apiKey],
    ...["stt", "tts"].map((kind) => [
      `providers.openai.${kind}.apiKey`,
      configRecord(legacy[kind])?.apiKey,
    ]),
  ] as const;
  for (const [keyPath, key] of keys) {
    if (key && typeof keyPath === "string" && !foldedKeys.has(keyPath)) {
      const message = `Dropped ${keyPath}: no use site in config.json selects OpenAI; re-enter it when selecting OpenAI.`;
      if (logger?.warn) logger.warn(message);
      else console.warn(message);
    }
  }
}

export function loadPersistedConfig(jagentdeskHome: string, logger?: LoggerLike): PersistedConfig {
  const log = getLogger(logger);
  const configPath = getConfigPath(jagentdeskHome);

  if (!existsSync(configPath)) {
    try {
      writePrivateFileAtomicSync(
        configPath,
        JSON.stringify(DEFAULT_PERSISTED_CONFIG, null, 2) + "\n",
      );
      log?.info(`Initialized config file at ${configPath}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`[Config] Failed to initialize ${configPath}: ${message}`, { cause: err });
    }
  }

  let raw: string;
  try {
    ensurePrivateFile(configPath);
    raw = readFileSync(configPath, "utf-8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`[Config] Failed to read ${configPath}: ${message}`, {
      cause: err,
    });
  }

  let parsed: unknown;
  try {
    parsed = parseConfigText(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`[Config] Invalid JSON in ${configPath}: ${message}`, {
      cause: err,
    });
  }

  const result = PersistedConfigSchema.safeParse(normalizeSpeechProviderConfig(parsed, log));
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`[Config] Invalid config in ${configPath}:\n${issues}`);
  }

  log?.info(`Loaded from ${configPath}`);
  return result.data as PersistedConfig;
}

/** Editors such as Windows Notepad save UTF-8 with a byte order mark, which JSON.parse rejects. */
function parseConfigText(raw: string): unknown {
  return JSON.parse(raw.replace(/^\uFEFF/, ""));
}

export function savePersistedConfig(
  jagentdeskHome: string,
  config: PersistedConfig,
  logger?: LoggerLike,
): void {
  const log = getLogger(logger);
  const configPath = getConfigPath(jagentdeskHome);

  const result = PersistedConfigSchema.safeParse(config);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`[Config] Invalid config to save:\n${issues}`);
  }

  try {
    writePrivateFileAtomicSync(configPath, JSON.stringify(result.data, null, 2) + "\n");
    log?.info(`Saved to ${configPath}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`[Config] Failed to write ${configPath}: ${message}`, {
      cause: err,
    });
  }
}
