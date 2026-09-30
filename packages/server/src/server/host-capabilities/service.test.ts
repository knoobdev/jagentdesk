import path from "node:path";
import { describe, expect, it } from "vitest";
import { createTestLogger } from "../../test-utils/test-logger.js";
import {
  androidEmulatorSupported,
  HostCapabilityService,
  type CommandRunner,
  type HostEnvironment,
} from "./service.js";

interface Result {
  ok: boolean;
  stdout: string;
  stderr: string;
}

function runner(
  installed: Record<string, string>,
  results: Record<string, Result>,
): CommandRunner & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    find: async (name) => installed[name] ?? null,
    run: async (command, args) => {
      const key = `${command} ${args.join(" ")}`;
      calls.push(key);
      return results[key] ?? { ok: false, stdout: "", stderr: "" };
    },
  };
}

function host(overrides: Partial<HostEnvironment> & { files?: string[] }): HostEnvironment {
  const files = new Set(overrides.files ?? []);
  return {
    platform: "darwin",
    arch: "arm64",
    env: {},
    homeDir: "/home/user",
    jagentdeskHome: "/home/user/.jagentdesk",
    exists: (target) => files.has(target),
    ...overrides,
  };
}

function service(env: HostEnvironment, commands: CommandRunner) {
  return new HostCapabilityService({
    jagentdeskHome: env.jagentdeskHome,
    logger: createTestLogger(),
    host: env,
    runner: commands,
  });
}

describe("HostCapabilityService", () => {
  it("marks macOS-only capabilities unsupported on Windows and offers installable tools", async () => {
    const caps = await service(
      host({ platform: "win32", arch: "x64", homeDir: "C:\\Users\\user" }),
      runner({}, {}),
    ).refresh();
    expect(caps.iosSimulators?.state).toBe("unsupported_os");
    expect(caps.proxySystemCapture?.state).toBe("unsupported_os");
    expect(caps.androidDevices).toMatchObject({
      state: "missing_tool",
      installable: ["android-sdk"],
    });
    expect(caps.forgeGh).toMatchObject({ state: "missing_tool", installable: ["gh"] });
    expect(caps.docker?.state).toBe("missing_tool");
  });

  it("reports Android unsupported where no emulator build exists", async () => {
    expect(androidEmulatorSupported("linux", "arm64")).toBe(false);
    expect(androidEmulatorSupported("win32", "arm64")).toBe(false);
    expect(androidEmulatorSupported("darwin", "arm64")).toBe(true);
    const caps = await service(
      host({ platform: "linux", arch: "arm64" }),
      runner({}, {}),
    ).refresh();
    expect(caps.androidDevices?.state).toBe("unsupported_os");
  });

  it("finds an Android SDK from ANDROID_HOME", async () => {
    const sdk = "/opt/android";
    const adb = path.join(sdk, "platform-tools", "adb");
    const env = host({
      platform: "linux",
      arch: "x64",
      env: { ANDROID_HOME: sdk },
      files: [adb, path.join(sdk, "emulator", "emulator")],
    });
    const caps = await service(
      env,
      runner(
        {},
        {
          [`${adb} version`]: {
            ok: true,
            stdout: "Android Debug Bridge version 1.0.41\nVersion 37.0.1",
            stderr: "",
          },
        },
      ),
    ).refresh();
    expect(caps.androidDevices).toMatchObject({ state: "available", version: "1.0.41" });
  });

  it("tells a stopped Docker engine apart from a missing one", async () => {
    const caps = await service(host({}), runner({ docker: "/usr/local/bin/docker" }, {})).refresh();
    expect(caps.docker?.state).toBe("not_running");
  });

  it("requires Java 17 or newer", async () => {
    const old = await service(
      host({}),
      runner(
        { java: "/usr/bin/java" },
        { "/usr/bin/java -version": { ok: true, stdout: "", stderr: 'java version "11.0.2"' } },
      ),
    ).refresh();
    expect(old.java).toMatchObject({ state: "missing_tool", installable: ["java"] });
    const current = await service(
      host({}),
      runner(
        { java: "/usr/bin/java" },
        { "/usr/bin/java -version": { ok: true, stdout: "", stderr: 'openjdk version "17.0.12"' } },
      ),
    ).refresh();
    expect(current.java).toMatchObject({ state: "available", version: "17.0.12" });
  });

  it("notifies listeners only when capabilities change", async () => {
    const commands = runner({}, {});
    const probe = service(host({}), commands);
    const seen: number[] = [];
    probe.onChange(() => seen.push(1));
    await probe.refresh();
    await probe.refresh();
    expect(seen).toHaveLength(1);
  });
});
