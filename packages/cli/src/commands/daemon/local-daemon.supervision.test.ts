import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  type DaemonLaunchRuntime,
  type DetachedDaemonProcess,
  resolveLocalDaemonState,
  startLocalDaemonDetached,
  startLocalDaemonForeground,
} from "./local-daemon.js";

type RecordedDaemonLaunch =
  | {
      mode: "detached";
      command: string;
      args: string[];
      options: Parameters<DaemonLaunchRuntime["spawnDetached"]>[2];
    }
  | {
      mode: "foreground";
      command: string;
      args: string[];
      options: Parameters<DaemonLaunchRuntime["spawnForeground"]>[2];
    };

class FakeDaemonProcess extends EventEmitter implements DetachedDaemonProcess {
  pid = 4242;
  wasUnreferenced = false;

  unref(): void {
    this.wasUnreferenced = true;
  }
}

class FakeDaemonRuntime implements DaemonLaunchRuntime {
  readonly recordedLaunches: RecordedDaemonLaunch[] = [];
  readonly daemonProcess = new FakeDaemonProcess();
  foregroundStatus = 0;
  runnerEntry = "/repo/packages/server/scripts/supervisor-entrypoint.ts";

  resolveRunnerEntry(): string {
    return this.runnerEntry;
  }

  resolveHome(env: NodeJS.ProcessEnv): string {
    return env.JAGENTDESK_HOME ?? "/tmp/jagentdesk";
  }

  spawnDetached(
    command: string,
    args: string[],
    options: Parameters<DaemonLaunchRuntime["spawnDetached"]>[2],
  ): DetachedDaemonProcess {
    this.recordedLaunches.push({ mode: "detached", command, args, options });
    return this.daemonProcess;
  }

  spawnForeground(
    command: string,
    args: string[],
    options: Parameters<DaemonLaunchRuntime["spawnForeground"]>[2],
  ) {
    this.recordedLaunches.push({ mode: "foreground", command, args, options });
    return { status: this.foregroundStatus, error: undefined };
  }
}

const tempRoots: string[] = [];

async function createJAgentDeskHome(config: unknown): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "jagentdesk-local-daemon-"));
  tempRoots.push(root);
  const jagentdeskHome = path.join(root, ".jagentdesk");
  await mkdir(jagentdeskHome, { recursive: true });
  await writeFile(path.join(jagentdeskHome, "config.json"), JSON.stringify(config, null, 2));
  return jagentdeskHome;
}

function expectSupervisorLaunch(argv: string[]): void {
  const joined = argv.join(" ");
  expect(joined).toContain("supervisor-entrypoint");
  expect(joined).not.toContain("src/server/index.ts");
  expect(joined).not.toContain("dist/server/server/index.js");
  expect(joined).not.toContain("src/server/daemon-worker.ts");
  expect(joined).not.toContain("dist/server/server/daemon-worker.js");
}

describe("local daemon launch supervision", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(async () => {
    await Promise.all(
      tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
    vi.restoreAllMocks();
  });

  test("foreground start spawns supervisor-entrypoint instead of server/index", async () => {
    const runtime = new FakeDaemonRuntime();

    const status = startLocalDaemonForeground({ home: "/tmp/jagentdesk-test" }, runtime);

    expect(status).toBe(0);
    expect(runtime.recordedLaunches.map((launch) => launch.mode)).toEqual(["foreground"]);
    const launch = runtime.recordedLaunches[0];
    expect(launch?.mode).toBe("foreground");
    expect(launch?.command).toBe(process.execPath);
    expectSupervisorLaunch(launch?.args ?? []);
  });

  test("detached start spawns supervisor-entrypoint instead of server/index", async () => {
    vi.useFakeTimers();
    const runtime = new FakeDaemonRuntime();

    const resultPromise = startLocalDaemonDetached(
      { home: "/tmp/jagentdesk-test", mcp: false },
      runtime,
    );
    await vi.advanceTimersByTimeAsync(1200);
    const result = await resultPromise;

    expect(result).toEqual({ pid: 4242, logPath: "/tmp/jagentdesk-test/daemon.log" });
    expect(runtime.daemonProcess.wasUnreferenced).toBe(true);
    expect(runtime.recordedLaunches.map((launch) => launch.mode)).toEqual(["detached"]);
    const launch = runtime.recordedLaunches[0];
    expect(launch?.mode).toBe("detached");
    expect(launch?.command).toBe(process.execPath);
    expectSupervisorLaunch(launch?.args ?? []);
    expect(launch?.args).toContain("--no-mcp");
  });

  test("web UI flag is passed to the supervised daemon", async () => {
    const runtime = new FakeDaemonRuntime();

    const status = startLocalDaemonForeground(
      {
        home: "/tmp/jagentdesk-test",
        webUi: true,
      },
      runtime,
    );

    expect(status).toBe(0);
    expect(runtime.recordedLaunches.map((launch) => launch.mode)).toEqual(["foreground"]);
    const launch = runtime.recordedLaunches[0];
    expect(launch?.mode).toBe("foreground");
    expect(launch?.args).toContain("--web-ui");
    expect(launch?.options?.env?.JAGENTDESK_WEB_UI_ENABLED).toBe("true");
  });

  test("no-web UI flag is passed to the supervised daemon", async () => {
    const runtime = new FakeDaemonRuntime();

    const status = startLocalDaemonForeground(
      {
        home: "/tmp/jagentdesk-test",
        webUi: false,
      },
      runtime,
    );

    expect(status).toBe(0);
    expect(runtime.recordedLaunches.map((launch) => launch.mode)).toEqual(["foreground"]);
    const launch = runtime.recordedLaunches[0];
    expect(launch?.mode).toBe("foreground");
    expect(launch?.args).toContain("--no-web-ui");
    expect(launch?.options?.env?.JAGENTDESK_WEB_UI_ENABLED).toBe("false");
  });

  test("local daemon state reads the tailnet host from the environment", async () => {
    const home = await createJAgentDeskHome({ version: 1, daemon: {} });
    const previous = process.env.JAGENTDESK_TAILNET_HOST;
    process.env.JAGENTDESK_TAILNET_HOST = "tailnet.test";
    try {
      const state = resolveLocalDaemonState({ home });
      expect(state.tailnetHost).toBe("tailnet.test");
    } finally {
      if (previous === undefined) {
        delete process.env.JAGENTDESK_TAILNET_HOST;
      } else {
        process.env.JAGENTDESK_TAILNET_HOST = previous;
      }
    }
  });
});
