import { type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import path from "node:path";
import { app, ipcMain, powerMonitor, shell } from "electron";
import log from "electron-log/main";
import {
  exportDevicePublicKey,
  exportDeviceSecretKey,
  generateDeviceKeyPair,
  importDevicePublicKey,
  importDeviceSecretKey,
  resolveJAgentDeskHome,
  signNonce as signDeviceNonce,
  spawnProcess,
  type DeviceKeyPair,
} from "@jagentdesk/server";
import {
  copyAttachmentFileToManagedStorage,
  deleteManagedAttachmentFile,
  garbageCollectManagedAttachmentFiles,
  readManagedFileBase64,
  writeAttachmentBase64,
  writeAttachmentBytes,
} from "../features/attachments.js";
import {
  getBundledCliShimPath,
  getCliInstallStatus,
  installCli,
} from "../integrations/cli-install/index.js";
import { createSkillsCommandHandlers, getSkillsController } from "../integrations/skills/index.js";
import {
  openLocalTransportSession,
  sendLocalTransportMessage,
  closeLocalTransportSession,
} from "./local-transport.js";
import { createNodeEntrypointInvocation, resolveDaemonRunnerEntrypoint } from "./runtime-paths.js";
import { runExternalCliJsonCommand, runExternalCliTextCommand } from "./cli/external.js";
import {
  createDesktopSettingsCommandHandlers,
  type DesktopCommandHandler,
} from "../settings/desktop-settings-commands.js";
import type { DesktopSettings } from "../settings/desktop-settings.js";
import { getDesktopSettingsStore } from "../settings/desktop-settings-electron.js";
import { isRunningUnderARM64Translation } from "../system/arm64-translation.js";
import { getDesktopAppLogs } from "../diagnostics/app-logs.js";
import { tailFile } from "../diagnostics/tail-file.js";

const DAEMON_LOG_FILENAME = "daemon.log";
const STARTUP_POLL_INTERVAL_MS = 200;
const STARTUP_READY_TIMEOUT_MS = 30_000;
const DETACHED_STARTUP_GRACE_MS = 1200;
const DAEMON_HEALTH_TIMEOUT_MS = 250;
const TAILSCALE_LOGIN_URL_TIMEOUT_MS = 90_000;
const TAILSCALE_STATUS_FRESHNESS_MS = 15_000;

// Interactive login is intentionally a background operation. Keep one
// monitor per desktop process so repeated taps cannot stop/start the daemon
// repeatedly while the browser login is still being prepared.
let interactiveTailscaleLoginMonitor: Promise<void> | null = null;
let interactiveTailscaleLoginStarting = false;

type DesktopDaemonState = "starting" | "running" | "stopped" | "errored";
const DESKTOP_DAEMON_STOP_REASON_VALUES = [
  "manual_ipc",
  "settings",
  "host_remove",
  "quit",
  "version_mismatch",
  "restart",
] as const;
export type DesktopDaemonStopReason = (typeof DESKTOP_DAEMON_STOP_REASON_VALUES)[number];

const DESKTOP_DAEMON_STOP_REASONS = new Set<string>(DESKTOP_DAEMON_STOP_REASON_VALUES);
const DEFAULT_DESKTOP_DAEMON_STOP_REASON: DesktopDaemonStopReason = "manual_ipc";

export interface DesktopDaemonStatus {
  serverId: string;
  status: DesktopDaemonState;
  listen: string | null;
  hostname: string | null;
  pid: number | null;
  home: string;
  version: string | null;
  desktopManaged: boolean;
  error: string | null;
  healthy?: boolean;
  tailnetAddress?: string | null;
  tailnetProxyAddress?: string | null;
  daemonPublicKeyB64?: string | null;
  tailscaleConnected?: boolean;
  /** Present for daemons started by a current desktop build. */
  tailscaleEnabled?: boolean;
}

interface DesktopDaemonLogs {
  logPath: string;
  contents: string;
}

function parseDesktopDaemonStopReason(
  args: Record<string, unknown> | undefined,
): DesktopDaemonStopReason {
  const reason = args?.reason;
  if (typeof reason === "string" && DESKTOP_DAEMON_STOP_REASONS.has(reason)) {
    return reason as DesktopDaemonStopReason;
  }
  return DEFAULT_DESKTOP_DAEMON_STOP_REASON;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function getJAgentDeskHome(): string {
  return resolveJAgentDeskHome(process.env);
}

function getManagedDaemonListen(): string {
  return process.env.JAGENTDESK_LISTEN?.trim() || "127.0.0.1:6768";
}

/**
 * Keep the app-owned persisted daemon config aligned with the endpoint that
 * the desktop actually starts. Older installs can still have a 6767 entry in
 * config.json even though JAgentDesk owns 6768; the CLI intentionally ignores
 * inherited listen env overrides for status, so leaving the stale value makes
 * a healthy managed daemon look stopped to the renderer.
 */
function synchronizeManagedDaemonConfig(): void {
  const home = getJAgentDeskHome();
  const listen = getManagedDaemonListen();
  const configPath = path.join(home, "config.json");

  mkdirSync(home, { recursive: true });

  let config: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf8")) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      config = parsed as Record<string, unknown>;
    }
  } catch {
    // A missing or invalid config is rebuilt with the canonical managed port.
  }

  const currentDaemon = config.daemon;
  const daemonConfig =
    currentDaemon && typeof currentDaemon === "object" && !Array.isArray(currentDaemon)
      ? (currentDaemon as Record<string, unknown>)
      : {};

  if (daemonConfig.listen === listen && config.version !== undefined) {
    return;
  }

  writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        ...config,
        version: config.version ?? 1,
        daemon: { ...daemonConfig, listen },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

interface TailscaleStatusFile {
  connected?: boolean;
  host?: string | null;
  loginUrl?: string | null;
  port?: number | null;
  tailnetProxyAddress?: string | null;
  daemonPublicKeyB64?: string | null;
  enabled?: boolean;
  updatedAt?: number;
}

interface StoredDesktopDeviceKeyPair {
  v: 1;
  publicKeyB64: string;
  secretKeyB64: string;
}

const DESKTOP_DEVICE_KEYPAIR_FILENAME = "desktop-device-keypair.json";
let desktopDeviceKeyPair: DeviceKeyPair | null = null;

function readTailscaleStatusFile(): TailscaleStatusFile | null {
  try {
    const filePath = path.join(getJAgentDeskHome(), "tailscale-status.json");
    if (!existsSync(filePath)) return null;
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as TailscaleStatusFile;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function getDesktopDeviceKeyPair(): DeviceKeyPair {
  if (desktopDeviceKeyPair) return desktopDeviceKeyPair;

  const home = getJAgentDeskHome();
  const filePath = path.join(home, DESKTOP_DEVICE_KEYPAIR_FILENAME);
  try {
    const stored = JSON.parse(readFileSync(filePath, "utf8")) as StoredDesktopDeviceKeyPair;
    if (stored?.v === 1 && stored.publicKeyB64 && stored.secretKeyB64) {
      desktopDeviceKeyPair = {
        publicKey: importDevicePublicKey(stored.publicKeyB64),
        secretKey: importDeviceSecretKey(stored.secretKeyB64),
      };
      chmodSync(filePath, 0o600);
      return desktopDeviceKeyPair;
    }
  } catch {
    // Generate and replace an invalid or missing owner key below.
  }

  const generated = generateDeviceKeyPair();
  mkdirSync(home, { recursive: true });
  writeFileSync(
    filePath,
    JSON.stringify(
      {
        v: 1,
        publicKeyB64: exportDevicePublicKey(generated.publicKey),
        secretKeyB64: exportDeviceSecretKey(generated.secretKey),
      } satisfies StoredDesktopDeviceKeyPair,
      null,
      2,
    ) + "\n",
    { mode: 0o600 },
  );
  chmodSync(filePath, 0o600);
  desktopDeviceKeyPair = generated;
  return generated;
}

function resolveTailnetAddress(status: TailscaleStatusFile | null): string | null {
  const host = status?.host?.trim() ?? "";
  const port = status?.port;
  if (!host || typeof port !== "number" || !Number.isInteger(port) || port <= 0) {
    return null;
  }
  return host.includes(":") && !host.startsWith("[") ? `[${host}]:${port}` : `${host}:${port}`;
}

function probeAppOwnedDaemonHealth(listen: string | null): Promise<boolean> {
  const value = listen?.trim() ?? "";
  if (!value) return Promise.resolve(false);

  let url: URL;
  try {
    url = new URL(`http://${value}/api/health`);
  } catch {
    return Promise.resolve(false);
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (hostname !== "127.0.0.1" && hostname !== "localhost" && hostname !== "::1") {
    return Promise.resolve(false);
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (healthy: boolean) => {
      if (settled) return;
      settled = true;
      resolve(healthy);
    };
    const request = httpRequest(
      url,
      { method: "GET", timeout: DAEMON_HEALTH_TIMEOUT_MS },
      (response) => {
        response.resume();
        finish(response.statusCode === 200);
      },
    );
    request.once("timeout", () => {
      request.destroy();
      finish(false);
    });
    request.once("error", () => finish(false));
    request.end();
  });
}

function readAppOwnedDaemonStatus(listen: string | null): Promise<Record<string, unknown> | null> {
  const value = listen?.trim() ?? "";
  if (!value) return Promise.resolve(null);

  let url: URL;
  try {
    url = new URL(`http://${value}/api/status`);
  } catch {
    return Promise.resolve(null);
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (hostname !== "127.0.0.1" && hostname !== "localhost" && hostname !== "::1") {
    return Promise.resolve(null);
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (status: Record<string, unknown> | null) => {
      if (settled) return;
      settled = true;
      resolve(status);
    };
    const request = httpRequest(
      url,
      { method: "GET", timeout: DAEMON_HEALTH_TIMEOUT_MS },
      (response) => {
        if (typeof response.on !== "function" || typeof response.setEncoding !== "function") {
          response.resume();
          finish(null);
          return;
        }
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          body += chunk;
        });
        response.on("end", () => {
          if (response.statusCode !== 200) {
            finish(null);
            return;
          }
          try {
            const parsed = JSON.parse(body) as unknown;
            finish(
              parsed && typeof parsed === "object" && !Array.isArray(parsed)
                ? (parsed as Record<string, unknown>)
                : null,
            );
          } catch {
            finish(null);
          }
        });
      },
    );
    request.once("timeout", () => {
      request.destroy();
      finish(null);
    });
    request.once("error", () => finish(null));
    request.end();
  });
}

function logFilePath(): string {
  return path.join(getJAgentDeskHome(), DAEMON_LOG_FILENAME);
}

interface ManagedDaemonPidLock {
  pid?: unknown;
  desktopManaged?: unknown;
}

function readManagedDaemonPidSync(): number | null {
  try {
    const lock = JSON.parse(
      readFileSync(path.join(getJAgentDeskHome(), "jagentdesk.pid"), "utf8"),
    ) as ManagedDaemonPidLock;
    if (
      lock.desktopManaged !== true ||
      typeof lock.pid !== "number" ||
      !Number.isInteger(lock.pid) ||
      lock.pid <= 1
    ) {
      return null;
    }
    return lock.pid;
  } catch {
    return null;
  }
}

export function isDesktopManagedDaemonRunningSync(): boolean {
  const pid = readManagedDaemonPidSync();
  return pid !== null && isProcessRunning(pid);
}

function summarizeDesktopDaemonStatus(status: DesktopDaemonStatus): Record<string, unknown> {
  return {
    status: status.status,
    pid: status.pid,
    listen: status.listen,
    serverId: status.serverId || null,
    version: status.version,
    desktopManaged: status.desktopManaged,
    error: status.error,
  };
}

const DESKTOP_DAEMON_STOP_CLI_ARGS = [
  "daemon",
  "stop",
  "--json",
  "--timeout",
  "5",
  "--force",
  "--kill-timeout",
  "5",
];

const DIRECT_STOP_TIMEOUT_MS = 10_000;

async function stopManagedDaemonByOwnerPid(
  reason: DesktopDaemonStopReason,
): Promise<unknown | null> {
  const pid = readManagedDaemonPidSync();
  if (pid === null || !isProcessRunning(pid)) {
    return null;
  }

  logDesktopDaemonLifecycle("stopping managed daemon through owner PID", { reason, ownerPid: pid });
  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    if (!isProcessRunning(pid)) {
      return { action: "stopped", reason: "owner_pid_signal", pid };
    }
    throw error;
  }

  const deadline = Date.now() + DIRECT_STOP_TIMEOUT_MS;
  while (isProcessRunning(pid) && Date.now() < deadline) {
    await sleep(100);
  }

  if (isProcessRunning(pid)) {
    logDesktopDaemonLifecycle("managed daemon did not stop after SIGTERM; sending SIGKILL", {
      reason,
      ownerPid: pid,
    });
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // The process may have exited between the liveness check and SIGKILL.
    }
    while (isProcessRunning(pid) && Date.now() < deadline + 3_000) {
      await sleep(100);
    }
  }

  if (isProcessRunning(pid)) {
    throw new Error(`Managed daemon owner PID ${pid} did not stop.`);
  }

  return { action: "stopped", reason: "owner_pid_signal", pid };
}

async function runDesktopDaemonStopViaCli({
  reason,
  statusBefore,
  resolveStatusAfter = false,
}: {
  reason: DesktopDaemonStopReason;
  statusBefore?: DesktopDaemonStatus | null;
  resolveStatusAfter?: boolean;
}): Promise<{
  cliResult: unknown;
  statusAfter: DesktopDaemonStatus | null;
}> {
  logDesktopDaemonLifecycle("desktop daemon stop requested", {
    reason,
    statusBefore: statusBefore ? summarizeDesktopDaemonStatus(statusBefore) : null,
  });

  // The bundled CLI is a fallback for legacy/untracked daemons. For the
  // app-owned daemon, signal the supervisor directly: spawning another
  // Electron/Node helper while the worker is booting can block for seconds and
  // was the source of the quit/startup stalls seen on macOS.
  const directResult = await stopManagedDaemonByOwnerPid(reason);
  const cliResult = directResult ?? (await runExternalCliJsonCommand(DESKTOP_DAEMON_STOP_CLI_ARGS));
  const statusAfter = resolveStatusAfter ? await resolveDesktopDaemonStatus() : null;

  logDesktopDaemonLifecycle("desktop daemon stop completed", {
    reason,
    cliResult,
    statusAfter: statusAfter ? summarizeDesktopDaemonStatus(statusAfter) : null,
  });

  return { cliResult, statusAfter };
}

export async function stopDesktopDaemonViaCli(
  reason: DesktopDaemonStopReason = DEFAULT_DESKTOP_DAEMON_STOP_REASON,
): Promise<void> {
  await runDesktopDaemonStopViaCli({ reason });
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (typeof err === "object" && err !== null && "code" in err && err.code === "EPERM") {
      return true;
    }
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function logDesktopDaemonLifecycle(message: string, details?: Record<string, unknown>): void {
  log.info("[desktop daemon]", message, {
    pid: process.pid,
    ...details,
  });
}

function resolveDesktopAppVersion(): string {
  if (app.isPackaged) {
    return app.getVersion();
  }

  try {
    const packageJsonPath = path.join(__dirname, "..", "..", "package.json");
    const pkg = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as {
      version?: unknown;
    };
    if (typeof pkg.version === "string" && pkg.version.trim().length > 0) {
      return pkg.version.trim();
    }
  } catch {
    // Fall back to Electron's default version if the package metadata is unavailable.
  }

  return app.getVersion();
}

// ---------------------------------------------------------------------------
// Daemon lifecycle
// ---------------------------------------------------------------------------

interface DesktopDaemonStatusFacts {
  status: DesktopDaemonState;
  hasLocalProcess: boolean;
  ownsDaemon: boolean;
  appOwnedHealth: boolean;
  tailscaleStatus: TailscaleStatusFile | null;
  tailscaleConnected: boolean;
}

async function resolveDesktopDaemonStatusFacts(
  payload: Record<string, unknown>,
  expectedListen: string,
): Promise<DesktopDaemonStatusFacts> {
  const localDaemon = typeof payload.localDaemon === "string" ? payload.localDaemon : "stopped";
  const connectedDaemon =
    typeof payload.connectedDaemon === "string" ? payload.connectedDaemon : "not_probed";
  const hasLocalProcess = localDaemon === "running" || localDaemon === "unresponsive";
  const ownsDaemon = payload.desktopManaged === true && payload.listen === expectedListen;
  const appOwnedHealth = ownsDaemon
    ? await probeAppOwnedDaemonHealth(typeof payload.listen === "string" ? payload.listen : null)
    : false;
  const apiReachable = connectedDaemon === "reachable";
  let status: DesktopDaemonState = "stopped";
  if (ownsDaemon && (apiReachable || localDaemon === "running")) {
    status = "running";
  } else if (ownsDaemon && localDaemon === "unresponsive") {
    status = "errored";
  }
  const tailscaleStatus = readTailscaleStatusFile();
  const tailscaleConnected =
    status === "running" && appOwnedHealth && tailscaleStatus?.connected === true;

  return {
    status,
    hasLocalProcess,
    ownsDaemon,
    appOwnedHealth,
    tailscaleStatus,
    tailscaleConnected,
  };
}

function buildDesktopDaemonStatus(
  payload: Record<string, unknown>,
  home: string,
  facts: DesktopDaemonStatusFacts,
): DesktopDaemonStatus {
  return {
    serverId: typeof payload.serverId === "string" ? payload.serverId : "",
    status: facts.status,
    listen: facts.ownsDaemon && typeof payload.listen === "string" ? payload.listen : null,
    hostname:
      facts.status === "running" && typeof payload.hostname === "string" ? payload.hostname : null,
    pid: facts.hasLocalProcess && typeof payload.pid === "number" ? payload.pid : null,
    home,
    version: typeof payload.daemonVersion === "string" ? payload.daemonVersion : null,
    desktopManaged: facts.ownsDaemon,
    error: null,
    healthy: facts.appOwnedHealth,
    tailnetAddress: facts.tailscaleConnected ? resolveTailnetAddress(facts.tailscaleStatus) : null,
    tailnetProxyAddress: facts.tailscaleConnected
      ? (facts.tailscaleStatus?.tailnetProxyAddress ?? null)
      : null,
    daemonPublicKeyB64: facts.tailscaleStatus?.daemonPublicKeyB64 ?? null,
    tailscaleConnected: facts.tailscaleConnected,
    ...(facts.tailscaleStatus?.enabled !== undefined
      ? { tailscaleEnabled: facts.tailscaleStatus.enabled }
      : {}),
  };
}

function stoppedDesktopDaemonStatus(
  home: string,
  error: string | null = null,
): DesktopDaemonStatus {
  return {
    serverId: "",
    status: "stopped",
    listen: null,
    hostname: null,
    pid: null,
    home,
    version: null,
    desktopManaged: false,
    error,
    healthy: false,
    tailnetAddress: null,
    tailnetProxyAddress: null,
    daemonPublicKeyB64: null,
    tailscaleConnected: false,
  };
}

async function resolveDesktopDaemonStatusUnshared(): Promise<DesktopDaemonStatus> {
  const home = getJAgentDeskHome();
  const expectedListen = getManagedDaemonListen();
  const managedProcessRunning = isDesktopManagedDaemonRunningSync();
  const appOwnedHealth = await probeAppOwnedDaemonHealth(expectedListen);

  if (managedProcessRunning && !appOwnedHealth) {
    // A live supervisor may still be constructing the worker HTTP server. Do
    // not invoke the external CLI here; that command talks to the same cold
    // runtime and can block the renderer for its full timeout.
    return buildStartingDesktopDaemonStatus();
  }

  if (managedProcessRunning && appOwnedHealth) {
    const directStatus = await readAppOwnedDaemonStatus(expectedListen);
    if (directStatus) {
      const directPayload = {
        ...directStatus,
        daemonVersion: directStatus.version,
        localDaemon: "running",
        connectedDaemon: "reachable",
        desktopManaged: true,
        pid: readManagedDaemonPidSync(),
      };
      const facts = await resolveDesktopDaemonStatusFacts(directPayload, expectedListen);
      return buildDesktopDaemonStatus(directPayload, home, facts);
    }
  }

  // A cold start should not spawn the external CLI just to discover that the
  // app-owned port is closed. The CLI is still used whenever the endpoint or
  // managed process exists, which preserves stale-daemon/version detection.
  if (!managedProcessRunning && !appOwnedHealth) {
    return stoppedDesktopDaemonStatus(home);
  }

  try {
    const payload = (await runExternalCliJsonCommand(["daemon", "status", "--json"])) as Record<
      string,
      unknown
    >;
    const facts = await resolveDesktopDaemonStatusFacts(payload, expectedListen);
    return buildDesktopDaemonStatus(payload, home, facts);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logDesktopDaemonLifecycle("resolveStatus CLI command failed", { error: errorMessage });
    return stoppedDesktopDaemonStatus(home, errorMessage);
  }
}

let desktopDaemonStatusInFlight: Promise<DesktopDaemonStatus> | null = null;

export function resolveDesktopDaemonStatus(): Promise<DesktopDaemonStatus> {
  if (desktopDaemonStatusInFlight) {
    return desktopDaemonStatusInFlight;
  }

  const operation = resolveDesktopDaemonStatusUnshared();
  const trackedOperation = operation.finally(() => {
    if (desktopDaemonStatusInFlight === trackedOperation) {
      desktopDaemonStatusInFlight = null;
    }
  });
  desktopDaemonStatusInFlight = trackedOperation;
  return trackedOperation;
}

function normalizeVersion(version: string | null): string | null {
  const trimmed = version?.trim();
  if (!trimmed) return null;
  return trimmed.replace(/^v/i, "");
}

function shouldRestartForVersion(current: DesktopDaemonStatus): boolean {
  if (!current.desktopManaged) return false;
  const appVersion = normalizeVersion(resolveDesktopAppVersion());
  const daemonVersion = normalizeVersion(current.version);
  return Boolean(appVersion && daemonVersion && appVersion !== daemonVersion);
}

function assertBuiltInDaemonManagementEnabled(settings: DesktopSettings): void {
  if (!settings.daemon.manageBuiltInDaemon) {
    throw new Error("Built-in daemon management is disabled.");
  }
}

function buildStartupFailureError(result: {
  code: number | null;
  signal: string | null;
  error?: Error;
}): Error {
  const reason = result.error
    ? result.error.message
    : `exit code ${result.code ?? "unknown"}${result.signal ? ` (${result.signal})` : ""}`;
  const parts = [`Daemon failed to start: ${reason}`];
  const logs = tailFile(logFilePath(), 15);
  if (logs) parts.push(`Recent logs (${logFilePath()}):\n${logs}`);
  return new Error(parts.join("\n\n"));
}

async function waitForDetachedStartup(child: ChildProcess): Promise<void> {
  type GraceResult =
    | { exitedEarly: false }
    | { exitedEarly: true; code: number | null; signal: string | null; error?: Error };

  const result = await new Promise<GraceResult>((resolve) => {
    let settled = false;
    const finish = (value: GraceResult) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const timer = setTimeout(() => finish({ exitedEarly: false }), DETACHED_STARTUP_GRACE_MS);

    child.once("error", (error) => {
      clearTimeout(timer);
      finish({ exitedEarly: true, code: null, signal: null, error });
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      finish({ exitedEarly: true, code, signal });
    });
  });

  logDesktopDaemonLifecycle("detached startup grace period completed", {
    childPid: child.pid ?? null,
    exitedEarly: result.exitedEarly,
    ...(result.exitedEarly
      ? {
          exitCode: result.code,
          signal: result.signal,
          error: result.error?.message ?? null,
        }
      : {}),
  });

  if (result.exitedEarly) {
    throw buildStartupFailureError(result);
  }
}

function buildDaemonBaseEnv(
  useSavedTailscaleAuthKey: boolean,
  enableTailscale: boolean,
): NodeJS.ProcessEnv {
  const baseEnv = { ...process.env };
  if (!useSavedTailscaleAuthKey || !enableTailscale) {
    // Do not let a launcher-provided key bypass the explicit interactive-login
    // action either. The auth-key action is the only path allowed to use it.
    delete baseEnv.JAGENTDESK_TAILSCALE_AUTH_KEY;
  }
  return baseEnv;
}

async function resolveDaemonTailscaleAuthKey(
  useSavedTailscaleAuthKey: boolean,
): Promise<string | null> {
  if (!useSavedTailscaleAuthKey) return null;
  return await getDesktopSettingsStore().getTailscaleAuthKey();
}

function readFreshTailscaleStatusFile(
  statusFile: string,
  notBeforeMs: number,
): TailscaleStatusFile | null {
  if (!existsSync(statusFile)) return null;
  try {
    const status = JSON.parse(readFileSync(statusFile, "utf8")) as TailscaleStatusFile;
    if (typeof status.updatedAt === "number" && status.updatedAt < notBeforeMs) return null;
    return status;
  } catch {
    // The bridge may be replacing the status file. The next poll will retry.
    return null;
  }
}

function isFreshTailscaleStatus(status: TailscaleStatusFile | null): boolean {
  return (
    typeof status?.updatedAt === "number" &&
    Date.now() - status.updatedAt <= TAILSCALE_STATUS_FRESHNESS_MS
  );
}

function isTailscaleLoginUrl(value: string | null | undefined): value is string {
  return typeof value === "string" && value.startsWith("https://login.tailscale.com/");
}

function openTailscaleLoginUrl(url: string): void {
  logDesktopDaemonLifecycle("opening Tailscale login URL", { url });
  // LaunchServices can take an unpredictable amount of time while the system
  // browser is starting. The IPC action must resolve after dispatching the URL,
  // not after the browser process finishes its own startup.
  void shell.openExternal(url).catch((error) => {
    logDesktopDaemonLifecycle("failed to open Tailscale login URL", {
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

async function pollForRunningDaemon(): Promise<DesktopDaemonStatus> {
  const startedAt = Date.now();
  let attempt = 0;
  while (Date.now() - startedAt < STARTUP_READY_TIMEOUT_MS) {
    attempt += 1;
    const healthy = await probeAppOwnedDaemonHealth(getManagedDaemonListen());
    if (attempt === 1 || attempt % 10 === 0) {
      logDesktopDaemonLifecycle("polling daemon health after detached start", {
        attempt,
        healthy,
        elapsedMs: Date.now() - startedAt,
      });
    }
    if (healthy) {
      // Resolve the full identity exactly once after the local server is ready.
      // The previous implementation spawned the external CLI on every 200 ms
      // attempt, multiplying startup latency and creating status races.
      return await resolveDesktopDaemonStatus();
    }
    await sleep(STARTUP_POLL_INTERVAL_MS);
  }

  logDesktopDaemonLifecycle("daemon health did not become ready before timeout", {
    timeoutMs: STARTUP_READY_TIMEOUT_MS,
  });
  return await resolveDesktopDaemonStatus();
}

function buildStartingDesktopDaemonStatus(): DesktopDaemonStatus {
  return {
    serverId: "",
    status: "starting",
    listen: getManagedDaemonListen(),
    hostname: null,
    pid: null,
    home: getJAgentDeskHome(),
    version: resolveDesktopAppVersion(),
    desktopManaged: true,
    error: null,
    healthy: false,
    tailnetAddress: null,
    tailnetProxyAddress: null,
    daemonPublicKeyB64: null,
    tailscaleConnected: false,
  };
}

function waitForDaemonStartup(waitForReady: boolean): Promise<DesktopDaemonStatus> {
  return waitForReady
    ? pollForRunningDaemon()
    : Promise.resolve(buildStartingDesktopDaemonStatus());
}

async function reuseOrRestartRunningDaemon(
  current: DesktopDaemonStatus,
  enableTailscale: boolean,
): Promise<DesktopDaemonStatus | null> {
  if (current.status !== "running") return null;
  const transportModeMismatch = enableTailscale
    ? current.tailscaleEnabled === false
    : current.tailscaleEnabled !== false;
  if (transportModeMismatch) {
    logDesktopDaemonLifecycle("daemon transport mode changed, restarting", {
      previousTailscaleEnabled: current.tailscaleEnabled ?? null,
      nextTailscaleEnabled: enableTailscale,
    });
    await stopDesktopDaemon("restart");
    return null;
  }
  if (!shouldRestartForVersion(current)) return current;

  logDesktopDaemonLifecycle("daemon version mismatch, restarting", {
    appVersion: normalizeVersion(resolveDesktopAppVersion()),
    daemonVersion: normalizeVersion(current.version),
  });
  await stopDesktopDaemon("version_mismatch");
  return null;
}

interface StartDaemonOptions {
  /** Interactive login must not silently consume a previously saved auth key. */
  useSavedTailscaleAuthKey?: boolean;
  /** Interactive login only needs the bridge status file, not full daemon readiness. */
  waitForReady?: boolean;
  /** The bridge is opt-in for the managed daemon; Local and first-run disable it. */
  enableTailscale?: boolean;
  /** A caller that has just stopped the daemon can skip a second CLI status probe. */
  initialStatus?: DesktopDaemonStatus;
}

interface SpawnDaemonOptions {
  current: DesktopDaemonStatus;
  useSavedTailscaleAuthKey: boolean;
  waitForReady: boolean;
  enableTailscale: boolean;
}

async function spawnDetachedDaemon({
  current,
  useSavedTailscaleAuthKey,
  waitForReady,
  enableTailscale,
}: SpawnDaemonOptions): Promise<DesktopDaemonStatus> {
  const daemonRunner = resolveDaemonRunnerEntrypoint();
  const reclaimStalePidLock =
    current.status === "errored" && current.desktopManaged && current.error === null;
  const invocation = createNodeEntrypointInvocation({
    entrypoint: daemonRunner,
    argvMode: "node-script",
    args: reclaimStalePidLock ? ["--reclaim-stale-pid-lock"] : [],
    baseEnv: buildDaemonBaseEnv(useSavedTailscaleAuthKey, enableTailscale),
  });
  const tailscaleAuthKey = enableTailscale
    ? await resolveDaemonTailscaleAuthKey(useSavedTailscaleAuthKey)
    : null;
  const desktopDevice = getDesktopDeviceKeyPair();

  logDesktopDaemonLifecycle("starting detached daemon", {
    appIsPackaged: app.isPackaged,
    daemonRunnerEntry: daemonRunner.entryPath,
    daemonRunnerExecArgv: daemonRunner.execArgv,
    command: invocation.command,
    args: invocation.args,
    electronRunAsNode: invocation.env.ELECTRON_RUN_AS_NODE ?? null,
    parentExecPath: process.execPath,
    parentElectronRunAsNode: process.env.ELECTRON_RUN_AS_NODE ?? null,
    electronVersion: process.versions.electron ?? null,
    nodeVersion: process.versions.node,
    platform: process.platform,
    arch: process.arch,
  });

  const child: ChildProcess = spawnProcess(invocation.command, invocation.args, {
    detached: true,
    envMode: "internal",
    env: invocation.env,
    envOverlay: {
      JAGENTDESK_DESKTOP_MANAGED: "1",
      JAGENTDESK_CLI: getBundledCliShimPath(),
      JAGENTDESK_WEB_UI_ENABLED: "false",
      // Pass the app-owned runtime boundary explicitly through the supervisor.
      // LaunchServices/ Electron helper processes do not reliably inherit
      // launcher-set variables, and falling back here would attach to JAgentDesk's
      // legacy 6767 daemon instead of starting JAgentDesk on 6768.
      JAGENTDESK_HOME: getJAgentDeskHome(),
      JAGENTDESK_LISTEN: process.env.JAGENTDESK_LISTEN ?? "127.0.0.1:6768",
      JAGENTDESK_TAILSCALE_ENABLED: enableTailscale ? "1" : "0",
      JAGENTDESK_TAILSCALE_INTERACTIVE: enableTailscale ? "1" : "0",
      // The renderer's desktop client uses this loopback ingress to traverse
      // the same tailnet-tagged and signed daemon path as a mobile client.
      // The daemon still exposes the real tailnet listener on 6768.
      JAGENTDESK_TAILSCALE_PROXY_PORT: process.env.JAGENTDESK_TAILSCALE_PROXY_PORT ?? "55750",
      JAGENTDESK_DESKTOP_DEVICE_PUBLIC_KEY: exportDevicePublicKey(desktopDevice.publicKey),
      ...(tailscaleAuthKey ? { JAGENTDESK_TAILSCALE_AUTH_KEY: tailscaleAuthKey } : {}),
    },
    stdio: ["ignore", "ignore", "ignore"],
  });

  logDesktopDaemonLifecycle("detached spawn returned", {
    childPid: child.pid ?? null,
    spawnfile: child.spawnfile,
    spawnargs: child.spawnargs,
  });

  child.unref();
  await waitForDetachedStartup(child);
  return waitForDaemonStartup(waitForReady);
}

async function startDaemon({
  useSavedTailscaleAuthKey = true,
  waitForReady = true,
  enableTailscale = true,
  initialStatus,
}: StartDaemonOptions = {}): Promise<DesktopDaemonStatus> {
  assertBuiltInDaemonManagementEnabled(await getDesktopSettingsStore().get());
  synchronizeManagedDaemonConfig();

  const current = initialStatus ?? (await resolveDesktopDaemonStatus());
  logDesktopDaemonLifecycle("initial status check before start", {
    status: current.status,
    pid: current.pid,
    listen: current.listen,
    serverId: current.serverId || null,
    error: current.error,
    desktopManaged: current.desktopManaged,
  });
  const reusableDaemon = await reuseOrRestartRunningDaemon(current, enableTailscale);
  if (reusableDaemon) return reusableDaemon;

  if (current.status === "starting" && current.desktopManaged) {
    // A supervisor can be alive while its worker is still bootstrapping. Do
    // not create a second supervisor for the same PID lock.
    return waitForDaemonStartup(waitForReady);
  }

  return await spawnDetachedDaemon({
    current,
    useSavedTailscaleAuthKey,
    waitForReady,
    enableTailscale,
  });
}

async function stopConflictingDaemonForInteractiveLogin(): Promise<void> {
  let payload: Record<string, unknown>;
  try {
    payload = (await runExternalCliJsonCommand(["daemon", "status", "--json"])) as Record<
      string,
      unknown
    >;
  } catch {
    return;
  }

  const localDaemon = payload.localDaemon;
  const isRunning = localDaemon === "running" || localDaemon === "unresponsive";
  const sameHome = payload.home === getJAgentDeskHome();
  const sameListen = payload.listen === getManagedDaemonListen();
  const isForeignOwner = payload.desktopManaged !== true;

  // A dev CLI daemon can be left running in the same app-owned home. It is
  // safe to replace that process here: otherwise the desktop cannot start the
  // interactive tsnet bridge and the button appears to do nothing. Never touch
  // a daemon from another home, port, or desktop-managed owner.
  if (!isRunning || !sameHome || !sameListen || !isForeignOwner) {
    return;
  }

  await runDesktopDaemonStopViaCli({ reason: "restart" });
}

export async function stopDesktopDaemon(
  reason: DesktopDaemonStopReason = DEFAULT_DESKTOP_DAEMON_STOP_REASON,
): Promise<DesktopDaemonStatus> {
  const status = await resolveDesktopDaemonStatus();
  if (status.status !== "running" && !(status.status === "starting" && status.desktopManaged)) {
    logDesktopDaemonLifecycle("desktop daemon stop skipped", {
      reason,
      statusBefore: summarizeDesktopDaemonStatus(status),
    });
    return status;
  }

  const { statusAfter } = await runDesktopDaemonStopViaCli({
    reason,
    statusBefore: status,
    resolveStatusAfter: true,
  });
  return statusAfter ?? (await resolveDesktopDaemonStatus());
}

async function restartDaemon(
  enableTailscale = true,
  waitForReady = true,
): Promise<DesktopDaemonStatus> {
  assertBuiltInDaemonManagementEnabled(await getDesktopSettingsStore().get());
  await stopDesktopDaemon("restart");
  return startDaemon({ enableTailscale, waitForReady });
}

function getDaemonLogs(): DesktopDaemonLogs {
  const logPath = logFilePath();
  return {
    logPath,
    contents: tailFile(logPath, 100),
  };
}

async function getCliDaemonStatus(): Promise<string> {
  return await runExternalCliTextCommand(["daemon", "status"]);
}

interface InteractiveTailscaleLoginResult {
  started: boolean;
  connected: boolean;
}

async function resolveRunningInteractiveTailscaleLogin(
  existingStatus: TailscaleStatusFile | null,
  appOwnedHealth: boolean,
): Promise<InteractiveTailscaleLoginResult | null> {
  if (existingStatus?.enabled !== false && existingStatus?.connected === true && appOwnedHealth) {
    return { started: false, connected: true };
  }

  if (isTailscaleLoginUrl(existingStatus?.loginUrl) && isFreshTailscaleStatus(existingStatus)) {
    openTailscaleLoginUrl(existingStatus.loginUrl);
    return { started: false, connected: false };
  }

  // An existing daemon may have been started with the saved auth-key path.
  // Restart this explicit interactive action without that key so the embedded
  // bridge produces the browser login URL.
  await runDesktopDaemonStopViaCli({ reason: "restart" });
  return null;
}

async function waitForInteractiveTailscaleLogin(
  statusFile: string,
  startupStartedAt: number,
): Promise<InteractiveTailscaleLoginResult> {
  const deadline = startupStartedAt + TAILSCALE_LOGIN_URL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const status = readFreshTailscaleStatusFile(statusFile, startupStartedAt);
    if (status?.connected === true && (await probeAppOwnedDaemonHealth(getManagedDaemonListen()))) {
      return { started: false, connected: true };
    }
    if (isTailscaleLoginUrl(status?.loginUrl)) {
      openTailscaleLoginUrl(status.loginUrl);
      return { started: true, connected: false };
    }
    await sleep(Math.min(250, Math.max(1, deadline - Date.now())));
  }
  throw new Error(
    `JAgentDesk could not obtain a Tailscale authentication URL within ${TAILSCALE_LOGIN_URL_TIMEOUT_MS / 1000} seconds. Check the daemon status or use an auth key.`,
  );
}

async function startInteractiveTailscaleLogin(): Promise<InteractiveTailscaleLoginResult> {
  if (interactiveTailscaleLoginMonitor || interactiveTailscaleLoginStarting) {
    return { started: true, connected: false };
  }

  interactiveTailscaleLoginStarting = true;

  try {
    const statusFile = path.join(getJAgentDeskHome(), "tailscale-status.json");
    const existingStatus = readTailscaleStatusFile();
    const managedProcessRunning = isDesktopManagedDaemonRunningSync();
    const appOwnedHealth = await probeAppOwnedDaemonHealth(getManagedDaemonListen());
    const daemonIsRunning = managedProcessRunning || appOwnedHealth;

    logDesktopDaemonLifecycle("interactive Tailscale login requested", {
      managedProcessRunning,
      appOwnedHealth,
      existingStatus: existingStatus
        ? {
            connected: existingStatus.connected ?? false,
            enabled: existingStatus.enabled ?? null,
            hasLoginUrl: isTailscaleLoginUrl(existingStatus.loginUrl),
          }
        : null,
    });

    if (existingStatus?.enabled !== false && existingStatus?.connected === true && appOwnedHealth) {
      return { started: false, connected: true };
    }

    if (isTailscaleLoginUrl(existingStatus?.loginUrl) && isFreshTailscaleStatus(existingStatus)) {
      openTailscaleLoginUrl(existingStatus.loginUrl);
      return { started: false, connected: false };
    }

    const operation = startInteractiveTailscaleLoginOperation({
      daemonIsRunning,
      appOwnedHealth,
      existingStatus,
      statusFile,
    })
      .then(() => undefined)
      .catch((error) => {
        logDesktopDaemonLifecycle("interactive Tailscale login monitor failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        if (interactiveTailscaleLoginMonitor === operation) {
          interactiveTailscaleLoginMonitor = null;
        }
      });
    interactiveTailscaleLoginMonitor = operation;

    // Stop/restart and URL discovery run in the monitor. Returning now keeps
    // the renderer responsive even if an old supervisor takes time to exit.
    return { started: true, connected: false };
  } finally {
    interactiveTailscaleLoginStarting = false;
  }
}

async function startInteractiveTailscaleLoginOperation(input: {
  daemonIsRunning: boolean;
  appOwnedHealth: boolean;
  existingStatus: TailscaleStatusFile | null;
  statusFile: string;
}): Promise<InteractiveTailscaleLoginResult> {
  const { daemonIsRunning, appOwnedHealth, existingStatus, statusFile } = input;

  if (daemonIsRunning) {
    const existingResult = await resolveRunningInteractiveTailscaleLogin(
      existingStatus,
      appOwnedHealth,
    );
    if (existingResult) return existingResult;
  } else if (!app.isPackaged) {
    // In development, the CLI daemon can still occupy this app-owned home/port.
    // Replace only that exact same-home process; never touch a daemon belonging
    // to another installation.
    await stopConflictingDaemonForInteractiveLogin();
  }

  // This path is only reached when the daemon is not already connected and no
  // fresh login URL exists. A persisted tsnet node identity in the state dir is
  // reused by srv.Up() and, if it is no longer reachable on the control plane,
  // tsnet never emits a login URL — so the browser never opens and the flow
  // times out ("did not finish in time"). Remove the persisted state so the
  // restart starts an unauthenticated node that issues a fresh browser URL.
  wipeTailscaleStateForFreshLogin();

  const startupStartedAt = Date.now();
  await startDaemon({
    useSavedTailscaleAuthKey: false,
    waitForReady: false,
    enableTailscale: true,
    initialStatus: stoppedDesktopDaemonStatus(getJAgentDeskHome()),
  });

  return await waitForInteractiveTailscaleLogin(statusFile, startupStartedAt);
}

function wipeTailscaleStateForFreshLogin(): void {
  const stateDir = path.join(getJAgentDeskHome(), "tailscale");
  try {
    rmSync(stateDir, { recursive: true, force: true });
  } catch (error) {
    logDesktopDaemonLifecycle("failed to wipe Tailscale state for fresh login", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

// ---------------------------------------------------------------------------
// IPC registration
// ---------------------------------------------------------------------------

export function createDaemonCommandHandlers(): Record<string, DesktopCommandHandler> {
  return {
    ...createDesktopSettingsCommandHandlers({ settingsStore: getDesktopSettingsStore() }),
    desktop_get_runtime_info: () => ({
      appVersion: resolveDesktopAppVersion(),
      runningUnderARM64Translation: isRunningUnderARM64Translation(),
    }),
    desktop_daemon_status: () => resolveDesktopDaemonStatus(),
    desktop_tailscale_status: async () => {
      try {
        // A status file can outlive a force-quit. Never expose a stale
        // connected state to the renderer when the app-owned daemon is no
        // longer alive; this is what previously produced the misleading
        // "connection is not healthy" state after a restart.
        if (!isDesktopManagedDaemonRunningSync()) {
          return {
            connected: false,
            tailnet: null,
            daemonStatus: "stopped",
            healthy: false,
            tailnetProxyAddress: null,
            devicePublicKeyB64: exportDevicePublicKey(getDesktopDeviceKeyPair().publicKey),
          };
        }
        const status = readTailscaleStatusFile();
        if (status) {
          // This endpoint is polled by the login screen while the user is in
          // the browser. Avoid spawning the CLI on every poll; the managed PID
          // plus the local health endpoint are enough to reject stale status
          // files and keep the readiness check responsive.
          const healthy = await probeAppOwnedDaemonHealth(getManagedDaemonListen());
          return {
            connected: status.connected === true && healthy,
            tailnet: status.host ?? null,
            loginUrl: status.loginUrl ?? null,
            daemonStatus: healthy ? "running" : "starting",
            healthy,
            tailnetAddress: resolveTailnetAddress(status),
            tailnetProxyAddress: status.tailnetProxyAddress ?? null,
            daemonPublicKeyB64: status.daemonPublicKeyB64 ?? null,
            // The renderer uses this key to identify the desktop device in the
            // signed tailnet hello. The daemon key above is a different
            // identity and must never be advertised as the device key.
            devicePublicKeyB64: exportDevicePublicKey(getDesktopDeviceKeyPair().publicKey),
          };
        }
        return {
          // No status file means the JAgentDesk bridge is not running. Do not
          // fall back to a foreign daemon's CLI status (JAgentDesk can be live on
          // 6767 while JAgentDesk is completely offline).
          connected: false,
          tailnet: null,
          daemonStatus: "stopped",
          healthy: false,
          tailnetProxyAddress: null,
          devicePublicKeyB64: exportDevicePublicKey(getDesktopDeviceKeyPair().publicKey),
        };
      } catch (error) {
        return {
          connected: false,
          tailnet: null,
          daemonStatus: "unknown",
          healthy: false,
          tailnetProxyAddress: null,
          devicePublicKeyB64: exportDevicePublicKey(getDesktopDeviceKeyPair().publicKey),
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
    desktop_tailscale_device_public_key: () =>
      exportDevicePublicKey(getDesktopDeviceKeyPair().publicKey),
    desktop_tailscale_sign_nonce: (args) => {
      const nonce = typeof args?.nonce === "string" ? args.nonce : "";
      if (!nonce) throw new Error("A Tailscale challenge nonce is required.");
      return signDeviceNonce(getDesktopDeviceKeyPair(), nonce);
    },
    start_tailscale_login: startInteractiveTailscaleLogin,
    start_desktop_daemon: (args) =>
      startDaemon({
        enableTailscale: args?.enableTailscale !== false,
        waitForReady: args?.waitForReady !== false,
      }),
    stop_desktop_daemon: (args) => stopDesktopDaemon(parseDesktopDaemonStopReason(args)),
    restart_desktop_daemon: (args) =>
      restartDaemon(args?.enableTailscale !== false, args?.waitForReady !== false),
    desktop_daemon_logs: () => getDaemonLogs(),
    desktop_app_logs: () => getDesktopAppLogs(),
    desktop_get_system_idle_time: () => powerMonitor.getSystemIdleTime() * 1000,
    cli_daemon_status: () => getCliDaemonStatus(),
    write_attachment_base64: (args) => writeAttachmentBase64(args ?? {}),
    write_attachment_bytes: (args) => writeAttachmentBytes(args ?? {}),
    copy_attachment_file: (args) => copyAttachmentFileToManagedStorage(args ?? {}),
    read_file_base64: (args) => readManagedFileBase64(args ?? {}),
    delete_attachment_file: (args) => deleteManagedAttachmentFile(args ?? {}),
    garbage_collect_attachment_files: (args) => garbageCollectManagedAttachmentFiles(args ?? {}),
    open_local_daemon_transport: async (args) => {
      const target = args as { transportType: "socket" | "pipe"; transportPath: string };
      return await openLocalTransportSession(target);
    },
    send_local_daemon_transport_message: async (args) => {
      await sendLocalTransportMessage(
        args as { sessionId: string; text?: string; binaryBase64?: string },
      );
    },
    close_local_daemon_transport: (args) => {
      const sessionId =
        typeof args === "object" && args !== null && "sessionId" in args
          ? (args as { sessionId: string }).sessionId
          : "";
      if (sessionId) closeLocalTransportSession(sessionId);
    },
    install_cli: () => installCli(),
    get_cli_install_status: () => getCliInstallStatus(),
    ...createSkillsCommandHandlers({ controller: getSkillsController() }),
  };
}

export function registerDaemonManager(): void {
  const handlers = createDaemonCommandHandlers();

  ipcMain.handle(
    "jagentdesk:invoke",
    async (_event, command: string, args?: Record<string, unknown>) => {
      const handler = handlers[command];
      if (!handler) {
        throw new Error(`Unknown desktop command: ${command}`);
      }
      return await handler(args);
    },
  );
}
