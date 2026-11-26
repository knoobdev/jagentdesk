import type {
  DesktopDaemonStartOptions,
  DesktopDaemonStatus,
} from "@/desktop/daemon/desktop-daemon";
import type { TailnetMode } from "@/tailscale";

interface DesktopDaemonRestartStatus {
  desktopManaged: boolean;
  serverId: string;
}

interface DesktopDaemonRestartSettings {
  daemon: {
    manageBuiltInDaemon: boolean;
  };
}

export interface SettingsDaemonRestartDeps {
  getIsElectron: () => boolean;
  getDesktopDaemonStatus: () => Promise<DesktopDaemonRestartStatus>;
  getDesktopSettings: () => Promise<DesktopDaemonRestartSettings>;
  restartDesktopDaemon: (options?: DesktopDaemonStartOptions) => Promise<DesktopDaemonStatus>;
  getTailnetMode?: () => Promise<TailnetMode | null>;
  restartServer: (reason: string) => Promise<unknown>;
}

async function isLocalDesktopManagedDaemon(
  hostServerId: string,
  deps: SettingsDaemonRestartDeps,
): Promise<boolean> {
  if (!deps.getIsElectron()) {
    return false;
  }

  const desktopDaemonStatus = await deps.getDesktopDaemonStatus();
  if (!desktopDaemonStatus.desktopManaged) {
    return false;
  }

  const normalizedHostServerId = hostServerId.trim();
  const normalizedDesktopServerId = desktopDaemonStatus.serverId.trim();

  if (normalizedHostServerId.length === 0 || normalizedHostServerId !== normalizedDesktopServerId) {
    return false;
  }

  const desktopSettings = await deps.getDesktopSettings();
  return desktopSettings.daemon.manageBuiltInDaemon;
}

export async function restartDaemonFromSettings(
  hostServerId: string,
  reason: string,
  deps: SettingsDaemonRestartDeps,
): Promise<void> {
  if (await isLocalDesktopManagedDaemon(hostServerId, deps)) {
    const tailnetMode = await deps.getTailnetMode?.();
    await deps.restartDesktopDaemon({ enableTailscale: tailnetMode === "tailnet" });
    return;
  }

  await deps.restartServer(reason);
}
