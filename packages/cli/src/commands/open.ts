import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { spawnProcess } from "@jagentdesk/server";
import { buildAgentDeepLink, type AgentDeepLinkTarget } from "@jagentdesk/protocol/agent-deep-link";

function findDesktopApp(): string | null {
  if (process.platform === "darwin") {
    const candidates = [
      "/Applications/JAgentDesk.app",
      path.join(homedir(), "Applications", "JAgentDesk.app"),
    ];

    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        return candidate;
      }
    }

    return null;
  }

  if (process.platform === "linux") {
    const candidates = [
      "/usr/bin/JAgentDesk",
      "/opt/JAgentDesk/JAgentDesk",
      path.join(homedir(), "Applications", "JAgentDesk.AppImage"),
    ];

    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        return candidate;
      }
    }

    return null;
  }

  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA;
    if (!localAppData) {
      return null;
    }

    const candidate = path.join(localAppData, "Programs", "JAgentDesk", "JAgentDesk.exe");
    return existsSync(candidate) ? candidate : null;
  }

  return null;
}

function cleanEnvForDesktopLaunch(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  // The CLI runs via ELECTRON_RUN_AS_NODE=1. On Linux/Windows the spawned
  // desktop process inherits the env directly, so we must strip it or the
  // desktop app would start as a bare Node process instead of Electron.
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_NO_ATTACH_CONSOLE;
  delete env.JAGENTDESK_NODE_ENV;
  return env;
}

function spawnDetached(command: string, args: string[]): void {
  spawnProcess(command, args, {
    detached: true,
    stdio: "ignore",
    env: cleanEnvForDesktopLaunch(),
  }).unref();
}

function launchDesktop(args: string[]): void {
  if (process.env.JAGENTDESK_DESKTOP_CLI === "1") {
    throw new Error("Cannot open JAgentDesk Desktop while running in desktop CLI passthrough mode.");
  }

  const desktopApp = findDesktopApp();
  if (!desktopApp) {
    throw new Error("JAgentDesk desktop app not found. Install the JAgentDesk desktop app.");
  }

  if (process.platform === "darwin") {
    // -n forces a new instance even if the app is already running. The new
    // instance forwards its argv to the existing one through Electron's
    // single-instance lock. -g keeps the terminal in the foreground.
    spawnDetached("open", ["-n", "-g", "-a", desktopApp, "--args", ...args]);
    return;
  }

  spawnDetached(desktopApp, args);
}

export async function openDesktopWithProject(projectPath: string): Promise<void> {
  try {
    launchDesktop([projectPath]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}

export async function openDesktopWithAgent(target: AgentDeepLinkTarget): Promise<void> {
  launchDesktop([buildAgentDeepLink(target)]);
}
