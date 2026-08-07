import { type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
const STARTUP_POLL_MAX_ATTEMPTS = 150;
const DETACHED_STARTUP_GRACE_MS = 1200;

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

/**
 * Keep the app-owned persisted daemon config aligned with the endpoint that
 * the desktop actually starts. Older installs can still have a 6767 entry in
 * config.json even though JAgentDesk owns 6768; the CLI intentionally ignores
 * inherited listen env overrides for status, so leaving the stale value makes
 * a healthy managed daemon look stopped to the renderer.
 */
function synchronizeManagedDaemonConfig(): void {
  const home = getJAgentDeskHome();
  const listen = process.env.JAGENTDESK_LISTEN?.trim() || "127.0.0.1:6768";
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
    const request = httpRequest(url, { method: "GET", timeout: 1_000 }, (response) => {
      response.resume();
      finish(response.statusCode === 200);
    });
    request.once("timeout", () => {
      request.destroy();
      finish(false);
    });
    request.once("error", () => finish(false));
    request.end();
  });
}

function logFilePath(): string {
  return path.join(getJAgentDeskHome(), DAEMON_LOG_FILENAME);
}

export function isDesktopManagedDaemonRunningSync(): boolean {
  try {
    const raw = readFileSync(path.join(getJAgentDeskHome(), "jagentdesk.pid"), "utf-8");
    const lock = JSON.parse(raw) as { pid?: unknown; desktopManaged?: unknown };
    if (lock.desktopManaged !== true) return false;
    if (typeof lock.pid !== "number" || !Number.isInteger(lock.pid)) return false;
    return isProcessRunning(lock.pid);
  } catch {
    return false;
  }
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

  const cliResult = await runExternalCliJsonCommand(DESKTOP_DAEMON_STOP_CLI_ARGS);
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

export async function resolveDesktopDaemonStatus(): Promise<DesktopDaemonStatus> {
  const home = getJAgentDeskHome();
  const expectedListen = process.env.JAGENTDESK_LISTEN?.trim() || "127.0.0.1:6768";

  try {
    const payload = (await runExternalCliJsonCommand(["daemon", "status", "--json"])) as Record<
      string,
      unknown
    >;
    const localDaemon = typeof payload.localDaemon === "string" ? payload.localDaemon : "stopped";
    const connectedDaemon =
      typeof payload.connectedDaemon === "string" ? payload.connectedDaemon : "not_probed";
    const hasRunningLocalProcess = localDaemon === "running";
    const hasLocalProcess = hasRunningLocalProcess || localDaemon === "unresponsive";
    const desktopManaged = payload.desktopManaged === true;
    const apiReachable = connectedDaemon === "reachable";
    // A reachable daemon without our desktop-managed PID marker belongs to
    // another installation (for example JAgentDesk on its legacy 6767 port). It
    // must never be treated as JAgentDesk's daemon or health source.
    // The desktop must never adopt a daemon merely because it advertises the
    // managed flag: an older JAgentDesk process can expose the same compatibility
    // field. The isolated JAgentDesk port is part of the ownership boundary.
    const ownsDaemon = desktopManaged && payload.listen === expectedListen;
    const appOwnedHealth = ownsDaemon
      ? await probeAppOwnedDaemonHealth(typeof payload.listen === "string" ? payload.listen : null)
      : false;
    let status: DesktopDaemonState = "stopped";
    if (ownsDaemon && (apiReachable || hasRunningLocalProcess)) {
      status = "running";
    } else if (ownsDaemon && localDaemon === "unresponsive") {
      status = "errored";
    }
    const tailscaleStatus = readTailscaleStatusFile();
    const tailscaleConnected =
      status === "running" && appOwnedHealth && tailscaleStatus?.connected === true;

    return {
      serverId: typeof payload.serverId === "string" ? payload.serverId : "",
      status,
      listen: ownsDaemon && typeof payload.listen === "string" ? payload.listen : null,
      hostname:
        status === "running" && typeof payload.hostname === "string" ? payload.hostname : null,
      pid: hasLocalProcess && typeof payload.pid === "number" ? payload.pid : null,
      home,
      version: typeof payload.daemonVersion === "string" ? payload.daemonVersion : null,
      desktopManaged: ownsDaemon,
      error: null,
      healthy: appOwnedHealth,
      tailnetAddress: tailscaleConnected ? resolveTailnetAddress(tailscaleStatus) : null,
      tailnetProxyAddress: tailscaleConnected
        ? (tailscaleStatus?.tailnetProxyAddress ?? null)
        : null,
      daemonPublicKeyB64: tailscaleStatus?.daemonPublicKeyB64 ?? null,
      tailscaleConnected,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logDesktopDaemonLifecycle("resolveStatus CLI command failed", { error: errorMessage });
    return {
      serverId: "",
      status: "stopped",
      listen: null,
      hostname: null,
      pid: null,
      home,
      version: null,
      desktopManaged: false,
      error: errorMessage,
      healthy: false,
      tailnetAddress: null,
      tailnetProxyAddress: null,
      daemonPublicKeyB64: null,
      tailscaleConnected: false,
    };
  }
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

async function pollForRunningDaemon(): Promise<DesktopDaemonStatus> {
  async function poll(attempt: number): Promise<DesktopDaemonStatus> {
    if (attempt >= STARTUP_POLL_MAX_ATTEMPTS) return resolveDesktopDaemonStatus();
    const status = await resolveDesktopDaemonStatus();
    if (attempt === 0 || attempt === STARTUP_POLL_MAX_ATTEMPTS - 1 || attempt % 10 === 9) {
      logDesktopDaemonLifecycle("polling daemon status after detached start", {
        attempt: attempt + 1,
        status: status.status,
        pid: status.pid,
        listen: status.listen,
        serverId: status.serverId || null,
      });
    }
    if (status.status === "running" && status.serverId && status.listen) return status;
    await sleep(STARTUP_POLL_INTERVAL_MS);
    return poll(attempt + 1);
  }
  return poll(0);
}

async function startDaemon(): Promise<DesktopDaemonStatus> {
  assertBuiltInDaemonManagementEnabled(await getDesktopSettingsStore().get());
  synchronizeManagedDaemonConfig();

  const current = await resolveDesktopDaemonStatus();
  logDesktopDaemonLifecycle("initial status check before start", {
    status: current.status,
    pid: current.pid,
    listen: current.listen,
    serverId: current.serverId || null,
    error: current.error,
    desktopManaged: current.desktopManaged,
  });
  if (current.status === "running") {
    if (shouldRestartForVersion(current)) {
      logDesktopDaemonLifecycle("daemon version mismatch, restarting", {
        appVersion: normalizeVersion(resolveDesktopAppVersion()),
        daemonVersion: normalizeVersion(current.version),
      });
      await stopDesktopDaemon("version_mismatch");
    } else {
      return current;
    }
  }

  const daemonRunner = resolveDaemonRunnerEntrypoint();
  const reclaimStalePidLock =
    current.status === "errored" && current.desktopManaged && current.error === null;
  const invocation = createNodeEntrypointInvocation({
    entrypoint: daemonRunner,
    argvMode: "node-script",
    args: reclaimStalePidLock ? ["--reclaim-stale-pid-lock"] : [],
    baseEnv: process.env,
  });
  const tailscaleAuthKey = await getDesktopSettingsStore().getTailscaleAuthKey();
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
      JAGENTDESK_TAILSCALE_INTERACTIVE: "1",
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

  return pollForRunningDaemon();
}

export async function stopDesktopDaemon(
  reason: DesktopDaemonStopReason = DEFAULT_DESKTOP_DAEMON_STOP_REASON,
): Promise<DesktopDaemonStatus> {
  const status = await resolveDesktopDaemonStatus();
  if (status.status !== "running") {
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

async function restartDaemon(): Promise<DesktopDaemonStatus> {
  assertBuiltInDaemonManagementEnabled(await getDesktopSettingsStore().get());
  await stopDesktopDaemon("restart");
  return startDaemon();
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
          const daemonStatus = await resolveDesktopDaemonStatus();
          const healthy = daemonStatus.status === "running" && daemonStatus.healthy === true;
          return {
            connected: status.connected === true && healthy,
            tailnet: status.host ?? null,
            loginUrl: status.loginUrl ?? null,
            daemonStatus: daemonStatus.status,
            healthy,
            tailnetAddress: resolveTailnetAddress(status),
            tailnetProxyAddress: status.tailnetProxyAddress ?? null,
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
    start_tailscale_login: async () => {
      const statusFile = path.join(getJAgentDeskHome(), "tailscale-status.json");
      // The login gate is allowed to be the first screen. Ensure the
      // app-owned daemon is running before waiting for the embedded tsnet
      // bridge to publish its real auth URL; otherwise a fresh install waited
      // 15 seconds against a file that did not exist and reported a false
      // failure.
      const daemonStatus = await resolveDesktopDaemonStatus();
      if (daemonStatus.status !== "running") {
        await startDaemon();
      }

      for (let attempt = 0; attempt < 60; attempt += 1) {
        if (existsSync(statusFile)) {
          try {
            const status = JSON.parse(readFileSync(statusFile, "utf8")) as {
              connected?: boolean;
              loginUrl?: string | null;
            };
            if (status.connected === true) {
              const daemonHealth = await resolveDesktopDaemonStatus();
              if (daemonHealth.status === "running" && daemonHealth.healthy === true) {
                return { started: false, connected: true };
              }
            }
            if (status.loginUrl) {
              await shell.openExternal(status.loginUrl);
              return { started: true, connected: false };
            }
          } catch {
            // The bridge may be replacing the status file. Keep polling until
            // a complete status record is available.
          }
        }
        await sleep(500);
      }
      throw new Error(
        "JAgentDesk could not obtain a Tailscale authentication URL. Check the daemon status or use an auth key.",
      );
    },
    start_desktop_daemon: () => startDaemon(),
    stop_desktop_daemon: (args) => stopDesktopDaemon(parseDesktopDaemonStopReason(args)),
    restart_desktop_daemon: () => restartDaemon(),
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
