import { EventEmitter } from "node:events";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_DESKTOP_SETTINGS } from "../settings/desktop-settings";
import { getBundledCliShimPath } from "../integrations/cli-install";
import { createDaemonCommandHandlers } from "./daemon-manager";

const mocks = vi.hoisted(() => ({
  jagentdeskHome: "/tmp/jagentdesk-desktop-daemon-manager-test-home",
  settings: {
    daemon: {
      manageBuiltInDaemon: true,
      keepRunningAfterQuit: true,
    },
  },
  runExternalCliJsonCommand: vi.fn(),
  runExternalCliTextCommand: vi.fn(),
  shellOpenExternal: vi.fn(),
  createNodeEntrypointInvocation: vi.fn(() => ({
    command: "node",
    args: [],
    env: {},
  })),
  spawnProcess: vi.fn(),
  logInfo: vi.fn(),
  logError: vi.fn(),
  appLogPath: "/tmp/jagentdesk-desktop-daemon-manager-test-main.log",
  getElectronLogFile: vi.fn(),
}));

vi.mock("electron", () => ({
  app: {
    getPath: vi.fn(() => "/tmp/jagentdesk-user-data"),
    getVersion: vi.fn(() => "1.2.3"),
    isPackaged: true,
  },
  ipcMain: { handle: vi.fn() },
  powerMonitor: { getSystemIdleTime: vi.fn(() => 0) },
  shell: { openExternal: mocks.shellOpenExternal },
}));

vi.mock("electron-log/main", () => ({
  default: {
    info: mocks.logInfo,
    error: mocks.logError,
    transports: {
      file: {
        getFile: mocks.getElectronLogFile,
      },
    },
  },
}));

vi.mock("@jagentdesk/server", () => ({
  resolveJAgentDeskHome: vi.fn(() => mocks.jagentdeskHome),
  spawnProcess: mocks.spawnProcess,
  generateDeviceKeyPair: vi.fn(() => ({
    publicKey: new Uint8Array(32),
    secretKey: new Uint8Array(64),
  })),
  exportDevicePublicKey: vi.fn(() => "desktop-public-key"),
  exportDeviceSecretKey: vi.fn(() => "desktop-secret-key"),
  importDevicePublicKey: vi.fn(() => new Uint8Array(32)),
  importDeviceSecretKey: vi.fn(() => new Uint8Array(64)),
  signNonce: vi.fn(() => "desktop-signature"),
}));

vi.mock("../settings/desktop-settings-electron.js", () => ({
  getDesktopSettingsStore: () => ({
    get: async () => mocks.settings,
    getTailscaleAuthKey: async () => null,
    patch: vi.fn(),
    migrateLegacyRendererSettings: vi.fn(),
  }),
}));

vi.mock("./runtime-paths.js", () => ({
  createNodeEntrypointInvocation: mocks.createNodeEntrypointInvocation,
  resolveDaemonRunnerEntrypoint: vi.fn(() => ({
    entryPath: "/tmp/daemon.js",
    execArgv: [],
  })),
}));

vi.mock("./cli/external.js", () => ({
  runExternalCliJsonCommand: mocks.runExternalCliJsonCommand,
  runExternalCliTextCommand: mocks.runExternalCliTextCommand,
}));

function desktopSettingsWithManagement(enabled: boolean) {
  return {
    ...DEFAULT_DESKTOP_SETTINGS,
    daemon: {
      ...DEFAULT_DESKTOP_SETTINGS.daemon,
      manageBuiltInDaemon: enabled,
    },
  };
}

type MockChildProcess = EventEmitter & {
  pid: number;
  spawnfile: string;
  spawnargs: string[];
  unref: ReturnType<typeof vi.fn>;
};

function createMockChildProcess(): MockChildProcess {
  const child = new EventEmitter() as MockChildProcess;
  child.pid = 1234;
  child.spawnfile = "node";
  child.spawnargs = ["node", "daemon.js"];
  child.unref = vi.fn();
  return child;
}

function scheduleFailedStartup(child: MockChildProcess): void {
  setImmediate(() => {
    child.emit("exit", 1, null);
  });
}

describe("daemon-manager commands", () => {
  beforeEach(() => {
    mocks.settings = DEFAULT_DESKTOP_SETTINGS;
    mocks.runExternalCliJsonCommand.mockReset();
    mocks.runExternalCliTextCommand.mockReset();
    mocks.shellOpenExternal.mockReset();
    mocks.shellOpenExternal.mockResolvedValue(undefined);
    mocks.createNodeEntrypointInvocation.mockReset();
    mocks.createNodeEntrypointInvocation.mockReturnValue({ command: "node", args: [], env: {} });
    mocks.spawnProcess.mockReset();
    mocks.logInfo.mockReset();
    mocks.logError.mockReset();
    mocks.getElectronLogFile.mockReset();
    mocks.getElectronLogFile.mockReturnValue({ path: mocks.appLogPath });
    rmSync(mocks.jagentdeskHome, { recursive: true, force: true });
    rmSync(mocks.appLogPath, { force: true });
  });

  afterEach(() => {
    rmSync(mocks.jagentdeskHome, { recursive: true, force: true });
    rmSync(mocks.appLogPath, { force: true });
  });

  it("refuses start and restart while built-in daemon management is disabled", async () => {
    mocks.settings = desktopSettingsWithManagement(false);
    const handlers = createDaemonCommandHandlers();

    await expect(handlers.start_desktop_daemon()).rejects.toThrow(
      "Built-in daemon management is disabled.",
    );
    await expect(handlers.restart_desktop_daemon()).rejects.toThrow(
      "Built-in daemon management is disabled.",
    );

    expect(mocks.runExternalCliJsonCommand).not.toHaveBeenCalled();
    expect(mocks.spawnProcess).not.toHaveBeenCalled();
  });

  it("keeps stop callable while built-in daemon management is disabled", async () => {
    mocks.settings = desktopSettingsWithManagement(false);
    mocks.runExternalCliJsonCommand.mockResolvedValue({
      localDaemon: "stopped",
      serverId: "",
    });
    const handlers = createDaemonCommandHandlers();

    await expect(handlers.stop_desktop_daemon()).resolves.toEqual({
      serverId: "",
      status: "stopped",
      listen: null,
      hostname: null,
      pid: null,
      home: mocks.jagentdeskHome,
      version: null,
      desktopManaged: false,
      error: null,
      healthy: false,
      tailnetAddress: null,
      tailnetProxyAddress: null,
      daemonPublicKeyB64: null,
      tailscaleConnected: false,
    });

    expect(mocks.runExternalCliJsonCommand).toHaveBeenCalledWith(["daemon", "status", "--json"]);
  });

  it("routes running desktop daemon stops through external CLI daemon stop", async () => {
    mocks.runExternalCliJsonCommand
      .mockResolvedValueOnce({
        localDaemon: "running",
        serverId: "server-1",
        pid: 4242,
        listen: "127.0.0.1:6768",
        desktopManaged: true,
      })
      .mockResolvedValueOnce({ action: "stopped" })
      .mockResolvedValueOnce({
        localDaemon: "stopped",
        serverId: "",
      });
    const handlers = createDaemonCommandHandlers();

    await expect(handlers.stop_desktop_daemon()).resolves.toEqual({
      serverId: "",
      status: "stopped",
      listen: null,
      hostname: null,
      pid: null,
      home: mocks.jagentdeskHome,
      version: null,
      desktopManaged: false,
      error: null,
      healthy: false,
      tailnetAddress: null,
      tailnetProxyAddress: null,
      daemonPublicKeyB64: null,
      tailscaleConnected: false,
    });

    expect(mocks.runExternalCliJsonCommand).toHaveBeenNthCalledWith(1, [
      "daemon",
      "status",
      "--json",
    ]);
    expect(mocks.runExternalCliJsonCommand).toHaveBeenNthCalledWith(2, [
      "daemon",
      "stop",
      "--json",
      "--timeout",
      "5",
      "--force",
      "--kill-timeout",
      "5",
    ]);
    expect(mocks.runExternalCliJsonCommand).toHaveBeenNthCalledWith(3, [
      "daemon",
      "status",
      "--json",
    ]);
    expect(mocks.logInfo).toHaveBeenCalledWith(
      "[desktop daemon]",
      "desktop daemon stop requested",
      expect.objectContaining({
        reason: "manual_ipc",
        statusBefore: expect.objectContaining({
          status: "running",
          pid: 4242,
          serverId: "server-1",
          desktopManaged: true,
        }),
      }),
    );
    expect(mocks.logInfo).toHaveBeenCalledWith(
      "[desktop daemon]",
      "desktop daemon stop completed",
      expect.objectContaining({
        reason: "manual_ipc",
        cliResult: { action: "stopped" },
        statusAfter: expect.objectContaining({
          status: "stopped",
          serverId: null,
        }),
      }),
    );
  });

  it("routes stale reachable desktop daemon stops through external CLI daemon stop", async () => {
    mocks.runExternalCliJsonCommand
      .mockResolvedValueOnce({
        localDaemon: "stale_pid",
        connectedDaemon: "reachable",
        serverId: "server-1",
        pid: 7675,
        listen: "127.0.0.1:6768",
        daemonVersion: "1.2.2",
        desktopManaged: true,
      })
      .mockResolvedValueOnce({ action: "stopped" })
      .mockResolvedValueOnce({
        localDaemon: "stopped",
        connectedDaemon: "unreachable",
        serverId: "",
      });
    const handlers = createDaemonCommandHandlers();

    await expect(handlers.stop_desktop_daemon()).resolves.toEqual({
      serverId: "",
      status: "stopped",
      listen: null,
      hostname: null,
      pid: null,
      home: mocks.jagentdeskHome,
      version: null,
      desktopManaged: false,
      error: null,
      healthy: false,
      tailnetAddress: null,
      tailnetProxyAddress: null,
      daemonPublicKeyB64: null,
      tailscaleConnected: false,
    });

    expect(mocks.runExternalCliJsonCommand).toHaveBeenNthCalledWith(2, [
      "daemon",
      "stop",
      "--json",
      "--timeout",
      "5",
      "--force",
      "--kill-timeout",
      "5",
    ]);
  });

  it("records the renderer stop reason when stopping the desktop daemon", async () => {
    mocks.runExternalCliJsonCommand
      .mockResolvedValueOnce({
        localDaemon: "running",
        serverId: "server-1",
        pid: 4242,
        listen: "127.0.0.1:6768",
        desktopManaged: true,
      })
      .mockResolvedValueOnce({ action: "stopped", reason: "lifecycle_shutdown_rpc" })
      .mockResolvedValueOnce({
        localDaemon: "stopped",
        serverId: "",
      });
    const handlers = createDaemonCommandHandlers();

    await handlers.stop_desktop_daemon({ reason: "host_remove" });

    expect(mocks.logInfo).toHaveBeenCalledWith(
      "[desktop daemon]",
      "desktop daemon stop requested",
      expect.objectContaining({ reason: "host_remove" }),
    );
    expect(mocks.logInfo).toHaveBeenCalledWith(
      "[desktop daemon]",
      "desktop daemon stop completed",
      expect.objectContaining({
        reason: "host_remove",
        cliResult: { action: "stopped", reason: "lifecycle_shutdown_rpc" },
      }),
    );
  });

  it("uses a stale reachable desktop daemon when the version matches", async () => {
    mocks.runExternalCliJsonCommand.mockResolvedValue({
      localDaemon: "stale_pid",
      connectedDaemon: "reachable",
      serverId: "server-1",
      pid: 7675,
      listen: "127.0.0.1:6768",
      hostname: "dev-host",
      daemonVersion: "1.2.3",
      desktopManaged: true,
    });
    const handlers = createDaemonCommandHandlers();

    await expect(handlers.start_desktop_daemon()).resolves.toEqual({
      serverId: "server-1",
      status: "running",
      listen: "127.0.0.1:6768",
      hostname: "dev-host",
      pid: null,
      home: mocks.jagentdeskHome,
      version: "1.2.3",
      desktopManaged: true,
      error: null,
      healthy: true,
      tailnetAddress: null,
      tailnetProxyAddress: null,
      daemonPublicKeyB64: null,
      tailscaleConnected: false,
    });

    expect(mocks.spawnProcess).not.toHaveBeenCalled();
  });

  it("restarts a stale reachable desktop daemon when the version differs", async () => {
    mocks.runExternalCliJsonCommand
      .mockResolvedValueOnce({
        localDaemon: "stale_pid",
        connectedDaemon: "reachable",
        serverId: "server-1",
        pid: 7675,
        listen: "127.0.0.1:6768",
        hostname: "dev-host",
        daemonVersion: "1.2.2",
        desktopManaged: true,
      })
      .mockResolvedValueOnce({
        localDaemon: "stale_pid",
        connectedDaemon: "reachable",
        serverId: "server-1",
        pid: 7675,
        listen: "127.0.0.1:6768",
        daemonVersion: "1.2.2",
        desktopManaged: true,
      })
      .mockResolvedValueOnce({ action: "stopped" })
      .mockResolvedValueOnce({
        localDaemon: "stopped",
        connectedDaemon: "unreachable",
        serverId: "",
      })
      .mockResolvedValueOnce({
        localDaemon: "running",
        connectedDaemon: "reachable",
        serverId: "server-2",
        pid: 8888,
        listen: "127.0.0.1:6768",
        hostname: "dev-host",
        daemonVersion: "1.2.3",
        desktopManaged: true,
      });
    mocks.spawnProcess.mockReturnValue(createMockChildProcess());
    const handlers = createDaemonCommandHandlers();

    await expect(handlers.start_desktop_daemon()).resolves.toEqual({
      serverId: "server-2",
      status: "running",
      listen: "127.0.0.1:6768",
      hostname: "dev-host",
      pid: 8888,
      home: mocks.jagentdeskHome,
      version: "1.2.3",
      desktopManaged: true,
      error: null,
      healthy: true,
      tailnetAddress: null,
      tailnetProxyAddress: null,
      daemonPublicKeyB64: null,
      tailscaleConnected: false,
    });

    expect(mocks.runExternalCliJsonCommand).toHaveBeenNthCalledWith(3, [
      "daemon",
      "stop",
      "--json",
      "--timeout",
      "5",
      "--force",
      "--kill-timeout",
      "5",
    ]);
    expect(mocks.spawnProcess).toHaveBeenCalled();
  });

  it("starts the managed daemon detached from desktop stdio and reports daemon log failures", async () => {
    mkdirSync(mocks.jagentdeskHome, { recursive: true });
    writeFileSync(
      `${mocks.jagentdeskHome}/daemon.log`,
      ["old log line", "recent daemon failure"].join("\n"),
    );
    mocks.runExternalCliJsonCommand.mockResolvedValue({
      localDaemon: "stopped",
      connectedDaemon: "unreachable",
      serverId: "",
    });
    mocks.spawnProcess.mockImplementation(() => {
      const child = createMockChildProcess();
      scheduleFailedStartup(child);
      return child;
    });
    const handlers = createDaemonCommandHandlers();

    let thrown: Error | null = null;
    try {
      await handlers.start_desktop_daemon();
    } catch (error) {
      thrown = error instanceof Error ? error : new Error(String(error));
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = thrown?.message ?? "";
    const recentLogsLabel = message.match(/Recent logs \(([^)]*)\):/)?.[1];
    expect(message).toContain("Daemon failed to start: exit code 1");
    expect(recentLogsLabel?.split(/[\\/]/).at(-1)).toBe("daemon.log");
    expect(message).toContain("recent daemon failure");
    expect(mocks.createNodeEntrypointInvocation).toHaveBeenCalledWith(
      expect.objectContaining({ args: [] }),
    );
    expect(mocks.spawnProcess).toHaveBeenCalledWith(
      "node",
      [],
      expect.objectContaining({
        detached: true,
        stdio: ["ignore", "ignore", "ignore"],
        envOverlay: expect.objectContaining({
          JAGENTDESK_CLI: getBundledCliShimPath(),
          JAGENTDESK_WEB_UI_ENABLED: "false",
        }),
      }),
    );
  });

  it("passes stale lock reclaim only after a live desktop daemon is confirmed unresponsive", async () => {
    mocks.runExternalCliJsonCommand.mockResolvedValue({
      localDaemon: "unresponsive",
      connectedDaemon: "unreachable",
      serverId: "",
      pid: 7675,
      listen: "127.0.0.1:6768",
      desktopManaged: true,
    });
    mocks.spawnProcess.mockImplementation(() => {
      const child = createMockChildProcess();
      scheduleFailedStartup(child);
      return child;
    });

    await expect(createDaemonCommandHandlers().start_desktop_daemon()).rejects.toThrow(
      "Daemon failed to start: exit code 1",
    );

    expect(mocks.createNodeEntrypointInvocation).toHaveBeenCalledWith(
      expect.objectContaining({ args: ["--reclaim-stale-pid-lock"] }),
    );
  });

  it("does not pass stale lock reclaim when the status command fails", async () => {
    mocks.runExternalCliJsonCommand.mockRejectedValue(new Error("status command failed"));
    mocks.spawnProcess.mockImplementation(() => {
      const child = createMockChildProcess();
      scheduleFailedStartup(child);
      return child;
    });

    await expect(createDaemonCommandHandlers().start_desktop_daemon()).rejects.toThrow(
      "Daemon failed to start: exit code 1",
    );

    expect(mocks.createNodeEntrypointInvocation).toHaveBeenCalledWith(
      expect.objectContaining({ args: [] }),
    );
  });

  it("opens the Tailscale login URL through the system browser", async () => {
    mkdirSync(mocks.jagentdeskHome, { recursive: true });
    writeFileSync(
      `${mocks.jagentdeskHome}/tailscale-status.json`,
      JSON.stringify({
        connected: false,
        loginUrl: "https://login.tailscale.com/a/test-login",
        updatedAt: Date.now(),
      }),
    );
    mocks.runExternalCliJsonCommand.mockResolvedValue({
      localDaemon: "running",
      connectedDaemon: "reachable",
      serverId: "server-1",
      pid: 4242,
      listen: "127.0.0.1:6768",
      daemonVersion: "1.2.3",
      desktopManaged: true,
    });

    const handlers = createDaemonCommandHandlers();

    await expect(handlers.start_tailscale_login()).resolves.toEqual({
      started: false,
      connected: false,
    });
    expect(mocks.shellOpenExternal).toHaveBeenCalledWith(
      "https://login.tailscale.com/a/test-login",
    );
  });

  it("returns the Electron main-process log tail from electron-log", () => {
    writeFileSync(
      mocks.appLogPath,
      Array.from({ length: 105 }, (_value, index) => `main log line ${index + 1}`).join("\n"),
    );
    const handlers = createDaemonCommandHandlers();

    expect(handlers.desktop_app_logs()).toEqual({
      logPath: mocks.appLogPath,
      contents: Array.from({ length: 100 }, (_value, index) => `main log line ${index + 6}`).join(
        "\n",
      ),
    });
  });
});
