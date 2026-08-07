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
  daemonVersion?: string;
  desktopManaged?: boolean;
  downloadTokenTtlMs?: number;
  corsAllowedOrigins?: string[];
  listen?: string;
  logger?: Parameters<typeof createJAgentDeskDaemon>[1];
  mcpEnabled?: boolean;
  mcpDebug?: boolean;
  isDev?: boolean;
  daemonStatusRpcCapability?: boolean;
  agentClients?: Partial<Record<AgentProvider, AgentClient>>;
  providerOverrides?: JAgentDeskDaemonConfig["providerOverrides"];
  jagentdeskHomeRoot?: string;
  staticDir?: string;
  cleanup?: boolean;
  openai?: JAgentDeskOpenAIConfig;
  speech?: JAgentDeskSpeechConfig;
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
    const { config, jagentdeskHomeRoot, jagentdeskHome, staticDir } = await prepareTestDaemonConfig(options);
    const logger = options.logger ?? pino({ level: "silent" });
    const daemon = await createJAgentDeskDaemon(config, logger, {
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
          await Promise.all([
            rm(jagentdeskHomeRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }),
            rm(staticDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }),
          ]);
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
      await Promise.all([
        rm(jagentdeskHomeRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }),
        rm(staticDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }),
      ]);

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
}

async function prepareTestDaemonConfig(
  options: TestJAgentDeskDaemonOptions,
): Promise<PreparedTestDaemonConfig> {
  const jagentdeskHomeRoot =
    options.jagentdeskHomeRoot ?? (await mkdtemp(path.join(os.tmpdir(), "jagentdesk-home-")));
  const jagentdeskHome = path.join(jagentdeskHomeRoot, ".jagentdesk");
  await mkdir(jagentdeskHome, { recursive: true });
  const staticDir = options.staticDir ?? (await mkdtemp(path.join(os.tmpdir(), "jagentdesk-static-")));
  const listenHost = options.listen ?? "127.0.0.1";
  const config: JAgentDeskDaemonConfig = {
    listen: `${listenHost}:0`,
    jagentdeskHome,
    daemonVersion: options.daemonVersion,
    desktopManaged: options.desktopManaged,
    corsAllowedOrigins: options.corsAllowedOrigins ?? [],
    hostnames: true,
    mcpEnabled: options.mcpEnabled ?? true,
    staticDir,
    mcpDebug: options.mcpDebug ?? false,
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
    speech: options.speech,
    voiceLlmProvider: options.voiceLlmProvider ?? null,
    voiceLlmProviderExplicit: options.voiceLlmProviderExplicit ?? false,
    voiceLlmModel: options.voiceLlmModel ?? null,
    dictationFinalTimeoutMs: options.dictationFinalTimeoutMs,
    downloadTokenTtlMs: options.downloadTokenTtlMs,
  };
  return { config, jagentdeskHomeRoot, jagentdeskHome, staticDir };
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
