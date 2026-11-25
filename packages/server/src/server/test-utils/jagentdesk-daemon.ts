import { BuiltinPluginLoader } from "../plugins/builtin/index.js";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rm } from "node:fs/promises";

import pino from "pino";
import {
  createJAgentDeskDaemon,
  type JAgentDeskDaemonConfig,
  type JAgentDeskOpenAIConfig,
  type JAgentDeskSpeechConfig,
} from "../bootstrap.js";
import type { AgentClient, AgentProvider } from "../agent/agent-sdk-types.js";
import { createTestAgentClients } from "./fake-agent-client.js";
import type { PushNotificationSender } from "../push/notifications.js";

interface TestJAgentDeskDaemonOptions {
  relay?: { endpoint: string; useTls: boolean };
  slackApiBaseUrl?: string;
  hostCapabilities?: import("../host-capabilities/service.js").HostCapabilityService;
  botsTriggerSource?: import("../bots/service.js").BotTriggerSource;
  sessionShareTunnelManager?: import("../tunnels/tunnel-manager.js").TunnelManager;
  builtinPlugins?: BuiltinPluginLoader;
  daemonVersion?: string;
  desktopManaged?: boolean;
  downloadTokenTtlMs?: number;
  corsAllowedOrigins?: string[];
  listen?: string;
  listenPort?: number;
  logger?: Parameters<typeof createJAgentDeskDaemon>[1];
  mcpEnabled?: boolean;
  mcpDebug?: boolean;
  sessionSharingEnabled?: boolean;
  pluginsEnabled?: JAgentDeskDaemonConfig["pluginsEnabled"];
  plugins?: JAgentDeskDaemonConfig["plugins"];
  isDev?: boolean;
  daemonStatusRpcCapability?: boolean;
  agentClients?: Partial<Record<AgentProvider, AgentClient>>;
  providerOverrides?: JAgentDeskDaemonConfig["providerOverrides"];
  jagentdeskHomeRoot?: string;
  staticDir?: string;
  cleanup?: boolean;
  openai?: JAgentDeskOpenAIConfig;
  // localModelsDir defaults to the local provider's modelsDir, then to a dir under jagentdeskHome.
  speech?: Omit<JAgentDeskSpeechConfig, "localModelsDir"> & { localModelsDir?: string };
  voiceLlmProvider?: JAgentDeskDaemonConfig["voiceLlmProvider"];
  voiceLlmProviderExplicit?: boolean;
  voiceLlmModel?: string | null;
  dictationFinalTimeoutMs?: number;
  auth?: JAgentDeskDaemonConfig["auth"];
  pushNotificationSender?: PushNotificationSender;
  serviceProxy?: JAgentDeskDaemonConfig["serviceProxy"];
  webUi?: JAgentDeskDaemonConfig["webUi"];
  trustedProxies?: JAgentDeskDaemonConfig["trustedProxies"];
}

export interface TestJAgentDeskDaemon {
  config: JAgentDeskDaemonConfig;
  daemon: Awaited<ReturnType<typeof createJAgentDeskDaemon>>;
  port: number;
  jagentdeskHome: string;
  staticDir: string;
  close: () => Promise<void>;
}

const TEST_DAEMON_START_TIMEOUT_MS = 20_000;

async function startDaemonWithTimeout(
  daemon: Awaited<ReturnType<typeof createJAgentDeskDaemon>>,
  timeoutMs: number,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeoutHandle = setTimeout(() => {
      const timeoutError = new Error(
        `Timed out starting test daemon after ${timeoutMs}ms`,
      ) as Error & { code?: string };
      timeoutError.code = "TEST_DAEMON_START_TIMEOUT";
      reject(timeoutError);
    }, timeoutMs);

    daemon.start().then(
      () => {
        clearTimeout(timeoutHandle);
        resolve();
        return;
      },
      (error) => {
        clearTimeout(timeoutHandle);
        reject(error);
      },
    );
  });
}

export async function createTestJAgentDeskDaemon(
  options: TestJAgentDeskDaemonOptions = {},
): Promise<TestJAgentDeskDaemon> {
  const maxAttempts = 8;
  let lastError: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const { config, jagentdeskHomeRoot, jagentdeskHome, staticDir, createdDirs } =
      await prepareTestDaemonConfig(options);
    const logger = options.logger ?? pino({ level: "silent" });
    const daemon = await createJAgentDeskDaemon(config, logger, {
      hostCapabilities: options.hostCapabilities,
      botsTriggerSource: options.botsTriggerSource,
      slackApiBaseUrl: options.slackApiBaseUrl,
      sessionShareTunnelManager: options.sessionShareTunnelManager,
      builtinPlugins: options.builtinPlugins ?? new BuiltinPluginLoader(undefined, []),
      serverFeatureOverrides: {
        daemonStatusRpc: options.daemonStatusRpcCapability,
      },
    });
    try {
      await startDaemonWithTimeout(daemon, TEST_DAEMON_START_TIMEOUT_MS);
      const listenTarget = daemon.getListenTarget();
      if (!listenTarget || listenTarget.type !== "tcp") {
        throw new Error("Test daemon did not expose a bound TCP listen target");
      }

      const close = async (): Promise<void> => {
        await daemon.stop().catch(() => undefined);
        await daemon.agentManager.flush().catch(() => undefined);
        if (options.cleanup ?? true) {
          await new Promise((r) => setTimeout(r, 50));
          await removeDirs([jagentdeskHomeRoot, staticDir]);
        }
      };

      return {
        config,
        daemon,
        port: listenTarget.port,
        jagentdeskHome,
        staticDir,
        close,
      };
    } catch (error) {
      lastError = error;
      await daemon.stop().catch(() => undefined);
      // A failed attempt removes only what it created: a caller-supplied home keeps its serverId.
      await removeDirs(createdDirs);

      if (
        (!isAddressInUseError(error) && !isStartupTimeoutError(error)) ||
        attempt === maxAttempts - 1
      ) {
        throw error;
      }
    }
  }

  throw lastError ?? new Error("Failed to start test daemon");
}

interface PreparedTestDaemonConfig {
  config: JAgentDeskDaemonConfig;
  jagentdeskHomeRoot: string;
  jagentdeskHome: string;
  staticDir: string;
  createdDirs: string[];
}

async function removeDirs(dirs: string[]): Promise<void> {
  await Promise.all(
    dirs.map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })),
  );
}

async function createTempDir(prefix: string, createdDirs: string[]): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  createdDirs.push(dir);
  return dir;
}

async function prepareTestDaemonConfig(
  options: TestJAgentDeskDaemonOptions,
): Promise<PreparedTestDaemonConfig> {
  const createdDirs: string[] = [];
  const jagentdeskHomeRoot =
    options.jagentdeskHomeRoot ?? (await createTempDir("jagentdesk-home-", createdDirs));
  const jagentdeskHome = path.join(jagentdeskHomeRoot, ".jagentdesk");
  await mkdir(jagentdeskHome, { recursive: true });
  const staticDir = options.staticDir ?? (await createTempDir("jagentdesk-static-", createdDirs));
  const listenHost = options.listen ?? "127.0.0.1";
  const listenPort = options.listenPort ?? 0;
  const config: JAgentDeskDaemonConfig = {
    listen: `${listenHost}:${listenPort}`,
    jagentdeskHome,
    daemonVersion: options.daemonVersion,
    desktopManaged: options.desktopManaged,
    corsAllowedOrigins: options.corsAllowedOrigins ?? [],
    hostnames: true,
    mcpEnabled: options.mcpEnabled ?? true,
    relayEnabled: Boolean(options.relay),
    relayEndpoint: options.relay?.endpoint,
    relayUseTls: options.relay?.useTls,
    staticDir,
    mcpDebug: options.mcpDebug ?? false,
    sessionSharingEnabled: options.sessionSharingEnabled,
    pluginsEnabled: options.pluginsEnabled,
    plugins: options.plugins,
    isDev: options.isDev,
    agentClients: options.agentClients ?? createTestAgentClients(),
    providerOverrides: options.providerOverrides,
    agentStoragePath: path.join(jagentdeskHome, "agents"),
    appBaseUrl: "jagentdesk://app",
    auth: options.auth,
    pushNotificationSender: options.pushNotificationSender,
    serviceProxy: options.serviceProxy,
    webUi: options.webUi,
    trustedProxies: options.trustedProxies,
    openai: options.openai,
    speech: options.speech
      ? {
          ...options.speech,
          localModelsDir:
            options.speech.localModelsDir ??
            options.speech.local?.modelsDir ??
            path.join(jagentdeskHome, "models", "local-speech"),
        }
      : undefined,
    voiceLlmProvider: options.voiceLlmProvider ?? null,
    voiceLlmProviderExplicit: options.voiceLlmProviderExplicit ?? false,
    voiceLlmModel: options.voiceLlmModel ?? null,
    dictationFinalTimeoutMs: options.dictationFinalTimeoutMs,
    downloadTokenTtlMs: options.downloadTokenTtlMs,
  };
  return { config, jagentdeskHomeRoot, jagentdeskHome, staticDir, createdDirs };
}

function isAddressInUseError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const record = error as { code?: string };
  return record.code === "EADDRINUSE";
}

function isStartupTimeoutError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const record = error as { code?: string };
  return record.code === "TEST_DAEMON_START_TIMEOUT";
}
