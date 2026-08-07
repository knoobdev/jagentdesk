import { describe, expect, it } from "vitest";

import { DEFAULT_DESKTOP_SETTINGS } from "../settings/desktop-settings";
import {
  createQuitLifecycle,
  shouldStopDesktopManagedDaemonOnQuit,
  stopDesktopManagedDaemonOnQuitIfNeeded,
} from "./quit-lifecycle";

const SETTINGS_STOP_ON_QUIT = DEFAULT_DESKTOP_SETTINGS;
const SETTINGS_KEEP_RUNNING = {
  ...DEFAULT_DESKTOP_SETTINGS,
  daemon: {
    ...DEFAULT_DESKTOP_SETTINGS.daemon,
    keepRunningAfterQuit: true,
  },
};

function waitForQuitLifecycle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe("quit-lifecycle", () => {
  it("stops by default and only keeps running when keepRunningAfterQuit is enabled", () => {
    expect(shouldStopDesktopManagedDaemonOnQuit(SETTINGS_STOP_ON_QUIT)).toBe(true);
    expect(shouldStopDesktopManagedDaemonOnQuit(SETTINGS_KEEP_RUNNING)).toBe(false);
  });

  it("short-circuits without inspecting the daemon when keep-running is on", async () => {
    const events: string[] = [];
    const stopped = await stopDesktopManagedDaemonOnQuitIfNeeded({
      settingsStore: { get: async () => SETTINGS_KEEP_RUNNING },
      isDesktopManagedDaemonRunning: () => {
        events.push("inspect");
        return true;
      },
      stopDaemon: async () => events.push("stop"),
      showShutdownFeedback: () => events.push("feedback"),
    });

    expect(stopped).toBe(false);
    expect(events).toEqual([]);
  });

  it("shows feedback then stops a running desktop-managed daemon", async () => {
    const events: string[] = [];
    const stopped = await stopDesktopManagedDaemonOnQuitIfNeeded({
      settingsStore: { get: async () => SETTINGS_STOP_ON_QUIT },
      isDesktopManagedDaemonRunning: () => true,
      stopDaemon: async () => events.push("stop"),
      showShutdownFeedback: () => events.push("feedback"),
    });

    expect(stopped).toBe(true);
    expect(events).toEqual(["feedback", "stop"]);
  });

  it("stops the daemon before exiting and ignores a repeated quit event", async () => {
    const events: string[] = [];
    const lifecycle = createQuitLifecycle({
      app: { exit: (code) => events.push(`exit:${code}`) },
      closeTransportSessions: () => events.push("close-transports"),
      stopDesktopManagedDaemonIfNeeded: async () => {
        events.push("stop-daemon");
        return true;
      },
      onStopError: () => events.push("stop-error"),
    });

    const preventDefault = () => events.push("prevent-default");
    lifecycle.handleBeforeQuit({ preventDefault });
    lifecycle.handleBeforeQuit({ preventDefault });
    await waitForQuitLifecycle();

    expect(events).toEqual([
      "close-transports",
      "prevent-default",
      "stop-daemon",
      "close-transports",
      "exit:0",
    ]);
  });
});
