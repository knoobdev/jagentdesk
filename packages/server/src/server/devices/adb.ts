import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type pino from "pino";
import { findExecutable } from "../../executable-resolution/executable-resolution.js";
import { execCommand, spawnProcess } from "../../utils/spawn.js";
import { androidSdkCandidates } from "../host-capabilities/service.js";

// The host's own adb (spec 27.1): the Android SDK license forbids redistributing it, so the daemon
// only ever finds one the user installed.

export class AdbForbiddenCommandError extends Error {
  constructor(readonly subcommand: string) {
    super(`adb ${subcommand} is not allowed: it opens an unencrypted adb port on the network`);
    this.name = "AdbForbiddenCommandError";
  }
}

// ADR-0033 decision 4: Wi-Fi only through wireless debugging (TLS, pairing code). `adb tcpip`
// and `adb usb` (its undo) are refused at the one place every adb call goes through.
const FORBIDDEN_SUBCOMMANDS = new Set(["tcpip"]);

function adbSubcommand(args: readonly string[]): string | null {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "-s" || arg === "-t" || arg === "-H" || arg === "-P" || arg === "-L") {
      index += 1;
      continue;
    }
    if (arg.startsWith("-")) continue;
    return arg;
  }
  return null;
}

export function assertAllowedAdbArgs(args: readonly string[]): void {
  const subcommand = adbSubcommand(args);
  if (subcommand && FORBIDDEN_SUBCOMMANDS.has(subcommand)) {
    throw new AdbForbiddenCommandError(subcommand);
  }
}

export type AdbDeviceState = "device" | "unauthorized" | "offline" | "no_permissions" | "other";

export interface AdbDeviceEntry {
  serial: string;
  state: AdbDeviceState;
  model: string | null;
  usb: boolean;
}

function parseState(raw: string): AdbDeviceState {
  if (raw === "device" || raw === "unauthorized" || raw === "offline") return raw;
  if (raw === "no") return "no_permissions"; // "no permissions (…udev…)"
  return "other";
}

// `adb devices -l`:
//   List of devices attached
//   emulator-5554  device product:sdk_gphone64_arm64 model:sdk_gphone64_arm64 device:emu64a transport_id:1
//   R58M123ABC     unauthorized usb:1-1 transport_id:2
export function parseAdbDevices(stdout: string): AdbDeviceEntry[] {
  const entries: AdbDeviceEntry[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("List of devices") || trimmed.startsWith("*")) continue;
    const [serial, rawState, ...rest] = trimmed.split(/\s+/);
    if (!serial || !rawState) continue;
    const fields = new Map<string, string>();
    for (const part of rest) {
      const sep = part.indexOf(":");
      if (sep > 0) fields.set(part.slice(0, sep), part.slice(sep + 1));
    }
    entries.push({
      serial,
      state: parseState(rawState),
      model: fields.get("model")?.replace(/_/g, " ") ?? null,
      usb: fields.has("usb"),
    });
  }
  return entries;
}

// `getprop` prints `[key]: [value]` per line.
export function parseGetprop(stdout: string): Map<string, string> {
  const props = new Map<string, string>();
  for (const match of stdout.matchAll(/^\[([^\]]+)\]: \[([^\]]*)\]$/gm)) {
    props.set(match[1], match[2]);
  }
  return props;
}

// Wireless-debugging devices show up as `<ip>:<port>` or as the mDNS service name
// `adb-<guid>._adb-tls-connect._tcp`; everything else is cabled.
export function isWifiSerial(serial: string): boolean {
  return (
    /^[\d.]+:\d+$/.test(serial) ||
    /^\[?[0-9a-f:]+\]?:\d+$/i.test(serial) ||
    serial.includes("._adb-tls-connect._tcp")
  );
}

// POSIX single-quote one argument for `adb shell`, which hands the joined line to the device's sh.
export function shellQuote(arg: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

export async function resolveAdbPath(jagentdeskHome: string): Promise<string | null> {
  const exe = process.platform === "win32" ? "adb.exe" : "adb";
  const roots = androidSdkCandidates({
    platform: process.platform,
    arch: process.arch,
    env: process.env,
    homeDir: os.homedir(),
    jagentdeskHome,
    exists: existsSync,
  });
  for (const root of roots) {
    const candidate = path.join(root, "platform-tools", exe);
    if (existsSync(candidate)) return candidate;
  }
  return findExecutable("adb");
}

export class AdbCommandError extends Error {
  constructor(
    readonly args: readonly string[],
    readonly stderr: string,
  ) {
    super(stderr || `adb ${args.join(" ")} failed`);
    this.name = "AdbCommandError";
  }
}

export class Adb {
  constructor(
    readonly binary: string,
    private readonly logger: pino.Logger,
  ) {}

  async run(args: string[], timeoutMs = 30_000): Promise<string> {
    assertAllowedAdbArgs(args);
    this.logger.debug({ args }, "adb.exec");
    try {
      const result = await execCommand(this.binary, args, {
        timeout: timeoutMs,
        maxBuffer: 32 * 1024 * 1024,
      });
      return result.stdout;
    } catch (error) {
      const failure = error as { stderr?: unknown; stdout?: unknown; message?: unknown };
      const stderr = typeof failure.stderr === "string" ? failure.stderr.trim() : "";
      const stdout = typeof failure.stdout === "string" ? failure.stdout.trim() : "";
      const message = typeof failure.message === "string" ? failure.message : "";
      throw new AdbCommandError(args, stderr || stdout || message);
    }
  }

  // Binary stdout (screencap, cat of a dump file).
  runBuffer(args: string[], timeoutMs = 30_000): Promise<Buffer> {
    assertAllowedAdbArgs(args);
    this.logger.debug({ args }, "adb.exec");
    return new Promise((resolve, reject) => {
      const child = spawnProcess(this.binary, args, { stdio: ["ignore", "pipe", "pipe"] });
      const chunks: Buffer[] = [];
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill();
        reject(new AdbCommandError(args, "timed out"));
      }, timeoutMs);
      child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(Buffer.concat(chunks));
        else reject(new AdbCommandError(args, stderr.trim()));
      });
    });
  }

  spawn(args: string[]): ChildProcess {
    assertAllowedAdbArgs(args);
    this.logger.debug({ args }, "adb.spawn");
    return spawnProcess(this.binary, args, { stdio: ["pipe", "pipe", "pipe"] });
  }

  async devices(): Promise<AdbDeviceEntry[]> {
    return parseAdbDevices(await this.run(["devices", "-l"], 10_000));
  }

  shell(serial: string, command: string[], timeoutMs?: number): Promise<string> {
    return this.run(["-s", serial, "shell", ...command.map(shellQuote)], timeoutMs);
  }
}
