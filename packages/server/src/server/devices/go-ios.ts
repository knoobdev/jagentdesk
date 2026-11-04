import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import type pino from "pino";
import { findExecutable } from "../../executable-resolution/executable-resolution.js";
import { execCommand, spawnProcess } from "../../utils/spawn.js";

// go-ios (MIT, github.com/danielpaulus/go-ios) drives iPhones and iPads on macOS, Linux and
// Windows through the system usbmuxd. The desktop app bundles the pinned release per OS
// (packages/desktop/scripts/fetch-go-ios.mjs); other installs use the host-tools installer.
export const GO_IOS_VERSION = "1.3.2";

// Every go-ios helper that listens (the iOS 17+ tunnel agent) binds here (ADR-0033 decision 3).
const LOOPBACK_ARGS = ["--tunnel-info-host=127.0.0.1"];

export async function resolveGoIos(jagentdeskHome: string): Promise<string | null> {
  const exe = process.platform === "win32" ? "ios.exe" : "ios";
  // The desktop app sets JAGENTDESK_GO_IOS_BIN to the copy it bundles (packages/desktop/src/main.ts).
  const bundled = process.env.JAGENTDESK_GO_IOS_BIN;
  const candidates = [
    ...(bundled ? [bundled] : []),
    path.join(jagentdeskHome, "tools", "bin", exe),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  const onPath = await findExecutable("ios");
  if (!onPath) return null;
  // Another `ios` on PATH is not go-ios unless `ios version` prints its JSON banner.
  const banner = await execCommand(onPath, ["version"], { timeout: 5_000 }).catch(() => null);
  return banner && /"version"/.test(banner.stdout) ? onPath : null;
}

export interface GoIosDevice {
  udid: string;
  productName: string;
  productType: string;
  productVersion: string;
  connectionType: string;
}

// go-ios writes JSON results on stdout and slog lines (also JSON) on stderr; a result is the last
// stdout line that parses.
export function lastJson(stdout: string): unknown {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(lines[index]);
    } catch {
      continue;
    }
  }
  return null;
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

// `ios list --details` → {"deviceList":[{"Udid","ProductName","ProductType","ProductVersion",
// "ConnectionType"}]} (main.go outputDetailedList @ v1.3.2).
export function parseGoIosList(stdout: string): GoIosDevice[] {
  const parsed = lastJson(stdout);
  if (!parsed || typeof parsed !== "object" || !("deviceList" in parsed)) return [];
  const list = (parsed as { deviceList: unknown }).deviceList;
  if (!Array.isArray(list)) return [];
  const devices: GoIosDevice[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const udid = stringField(record, "Udid");
    if (!udid) continue;
    devices.push({
      udid,
      productName: stringField(record, "ProductName"),
      productType: stringField(record, "ProductType"),
      productVersion: stringField(record, "ProductVersion"),
      connectionType: stringField(record, "ConnectionType"),
    });
  }
  return devices;
}

// Spec 27.1 / ADR-0033 decision 4: only devices on a cable are controllable. usbmuxd also reports
// devices it sees over Wi-Fi sync (`ConnectionType: "Network"`); those are left out, and a device
// on both cable and Wi-Fi keeps only its USB entry.
export function cabledIosDevices(devices: readonly GoIosDevice[]): GoIosDevice[] {
  const seen = new Set<string>();
  const cabled: GoIosDevice[] = [];
  for (const device of devices) {
    if (device.connectionType === "Network" || seen.has(device.udid)) continue;
    seen.add(device.udid);
    cabled.push(device);
  }
  return cabled;
}

// `ios apps --list`: "<bundle id> <name> <version>" per line.
export function parseGoIosAppList(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/)[0] ?? "")
    .filter((bundleId) => bundleId.includes("."));
}

export class GoIosCommandError extends Error {
  constructor(
    readonly args: readonly string[],
    readonly output: string,
  ) {
    super(output || `ios ${args.join(" ")} failed`);
    this.name = "GoIosCommandError";
  }
}

export class GoIos {
  constructor(
    readonly binary: string,
    private readonly logger: pino.Logger,
  ) {}

  async run(args: string[], timeoutMs = 30_000): Promise<string> {
    const fullArgs = [...args, ...LOOPBACK_ARGS];
    this.logger.debug({ args: fullArgs }, "go-ios.exec");
    try {
      const result = await execCommand(this.binary, fullArgs, {
        timeout: timeoutMs,
        maxBuffer: 32 * 1024 * 1024,
      });
      return result.stdout;
    } catch (error) {
      const failure = error as { stderr?: unknown; stdout?: unknown; message?: unknown };
      const output = [failure.stderr, failure.stdout, failure.message]
        .filter((part): part is string => typeof part === "string" && part.trim() !== "")
        .join("\n");
      throw new GoIosCommandError(fullArgs, output.trim());
    }
  }

  spawn(args: string[]): ChildProcess {
    const fullArgs = [...args, ...LOOPBACK_ARGS];
    this.logger.debug({ args: fullArgs }, "go-ios.spawn");
    return spawnProcess(this.binary, fullArgs, { stdio: ["ignore", "pipe", "pipe"] });
  }

  async list(): Promise<GoIosDevice[]> {
    return parseGoIosList(await this.run(["list", "--details"], 15_000));
  }

  // Lockdown values; throws GoIosCommandError whose output tells pairing/lock failures apart.
  async info(udid: string): Promise<Record<string, unknown>> {
    const parsed = lastJson(await this.run(["info", "lockdown", `--udid=${udid}`], 15_000));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  }

  // iOS 16+: lockdown domain com.apple.security.mac.amfi, key DeveloperModeStatus.
  async developerMode(udid: string): Promise<boolean | null> {
    const out = await this.run(
      [
        "lockdown",
        "get",
        "DeveloperModeStatus",
        "--domain=com.apple.security.mac.amfi",
        `--udid=${udid}`,
      ],
      15_000,
    );
    const parsed = lastJson(out);
    return typeof parsed === "boolean" ? parsed : null;
  }

  async userApps(udid: string): Promise<string[]> {
    return parseGoIosAppList(await this.run(["apps", "--list", `--udid=${udid}`], 30_000));
  }

  async install(udid: string, appPath: string): Promise<void> {
    await this.run(["install", `--path=${appPath}`, `--udid=${udid}`], 600_000);
  }

  async launch(udid: string, bundleId: string, killExisting: boolean): Promise<void> {
    const args = ["launch", bundleId, `--udid=${udid}`];
    if (killExisting) args.push("--kill-existing");
    await this.run(args, 60_000);
  }

  async kill(udid: string, bundleId: string): Promise<void> {
    await this.run(["kill", bundleId, `--udid=${udid}`], 30_000);
  }

  syslog(udid: string): ChildProcess {
    return this.spawn(["syslog", "--nojson", `--udid=${udid}`]);
  }

  // iOS 17+: a userspace tunnel (no root); the agent's info API listens on 127.0.0.1 only.
  tunnel(): ChildProcess {
    return this.spawn(["tunnel", "start", "--userspace"]);
  }

  // Launches the signed WebDriverAgent runner via testmanagerd; WDA then listens on the device's
  // 8100 (HTTP) and 9100 (MJPEG). Nothing listens on the host: the daemon forwards those ports
  // itself on 127.0.0.1 (usbmux.ts), never `ios forward`/`ios ui run`, which bind 0.0.0.0.
  runWda(udid: string, bundleId: string): ChildProcess {
    return this.spawn([
      "runwda",
      `--bundleid=${bundleId}`,
      `--testrunnerbundleid=${bundleId}`,
      "--xctestconfig=WebDriverAgentRunner.xctest",
      "--env=USE_PORT=8100",
      "--env=MJPEG_SERVER_PORT=9100",
      `--udid=${udid}`,
    ]);
  }
}
