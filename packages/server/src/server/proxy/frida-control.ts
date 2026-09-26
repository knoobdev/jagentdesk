import { type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execCommand, spawnProcess } from "../../utils/spawn.js";

// Frida-driven, app-agnostic TLS-unpinning for iOS Simulator apps under test. Uses the host `frida`
// CLI (shelled out, like SimFleet shells out to simctl/idb — avoids a native binding that would
// complicate packaging). On a simulator the app runs as a local host process, so we launch it via
// simctl (which prints its PID) and attach Frida to that PID with the generic unpinning script.
//
// Scope note: this bypasses pinning for whatever app is RUNNING on the simulator. It does not make
// App Store apps (device ARM + FairPlay) runnable on a simulator — that is an Apple constraint, not
// a Frida one. See docs/plans/active/burp-workbench-capture-design.md.

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
// In dist the .js scripts are copied alongside; in source they sit under frida-scripts/.
function genericUnpinScriptPath(): string {
  const candidates = [
    path.join(scriptDir, "frida-scripts", "generic-unpin.js"),
    path.join(
      scriptDir,
      "..",
      "..",
      "..",
      "src",
      "server",
      "proxy",
      "frida-scripts",
      "generic-unpin.js",
    ),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return candidates[0]!;
}

export interface FridaAvailability {
  frida: boolean;
  version: string | null;
  // How the daemon could auto-install Frida if it is missing (so the UI can offer a one-click fix
  // rather than a dead end). null = no Python installer found; the user installs Frida themselves.
  installer: "pipx" | "pip3" | "pip" | null;
}

async function hasCommand(cmd: string): Promise<boolean> {
  try {
    await execCommand(cmd, ["--version"], { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

export async function fridaAvailability(): Promise<FridaAvailability> {
  let version: string | null = null;
  let frida = false;
  try {
    const { stdout } = await execCommand("frida", ["--version"], { timeout: 10_000 });
    version = stdout.trim() || null;
    frida = true;
  } catch {
    frida = false;
  }
  let installer: FridaAvailability["installer"] = null;
  if (!frida) {
    if (await hasCommand("pipx")) installer = "pipx";
    else if (await hasCommand("pip3")) installer = "pip3";
    else if (await hasCommand("pip")) installer = "pip";
  }
  return { frida, version, installer };
}

// Guided auto-install of Frida (frida-tools) — the same "detect a missing CLI, offer to install it"
// pattern the Forge Hub uses for gh/glab. Returns the new availability. Best-effort: on a host with
// no Python package manager, this reports that the user must install Frida manually.
export async function installFrida(): Promise<{
  ok: boolean;
  log: string;
  availability: FridaAvailability;
}> {
  const before = await fridaAvailability();
  if (before.frida) return { ok: true, log: "frida already installed", availability: before };
  if (!before.installer) {
    return {
      ok: false,
      log: "No Python installer (pipx/pip3) found. Install Python 3, then: pipx install frida-tools",
      availability: before,
    };
  }
  const args =
    before.installer === "pipx" ? ["install", "frida-tools"] : ["install", "--user", "frida-tools"];
  let log = "";
  try {
    const { stdout, stderr } = await execCommand(before.installer, args, { timeout: 300_000 });
    log = `${stdout}\n${stderr}`.trim();
  } catch (err) {
    log = err instanceof Error ? err.message : String(err);
  }
  const after = await fridaAvailability();
  return { ok: after.frida, log, availability: after };
}

export interface UnpinHandle {
  pid: number;
  child: ChildProcess;
  stop: () => void;
}

// Launch the app on the simulator, then attach Frida with the generic unpinning script. Returns a
// handle whose stop() detaches Frida. Throws if Frida is unavailable or the app cannot be launched.
export async function launchAndUnpin(input: {
  udid: string;
  bundleId: string;
  extraScriptPaths?: string[];
}): Promise<UnpinHandle> {
  const avail = await fridaAvailability();
  if (!avail.frida) {
    throw new Error(
      "frida is not installed on this host (needed for TLS unpinning). Install: pipx install frida-tools",
    );
  }
  // simctl launch prints "<bundleId>: <pid>".
  const { stdout } = await execCommand("xcrun", ["simctl", "launch", input.udid, input.bundleId], {
    timeout: 60_000,
  });
  const pid = Number(stdout.trim().split(/\s+/).pop());
  if (!Number.isFinite(pid) || pid <= 0) {
    throw new Error(`could not determine launched PID for ${input.bundleId}: ${stdout.trim()}`);
  }
  const scripts = [genericUnpinScriptPath(), ...(input.extraScriptPaths ?? [])];
  const args = ["-p", String(pid), "--runtime=v8"];
  for (const s of scripts) args.push("-l", s);
  args.push("-q"); // quiet REPL; keep the process attached
  const child = spawnProcess("frida", args);
  return {
    pid,
    child,
    stop: () => {
      try {
        child.kill("SIGTERM");
      } catch {
        /* already gone */
      }
    },
  };
}

// Write a user-supplied Frida script (e.g. fetched from codeshare after review) to a temp file so it
// can be passed to `frida -l`. The caller is responsible for having shown it to the user first.
export function writeTempScript(contents: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-frida-"));
  const file = path.join(dir, "user-script.js");
  fs.writeFileSync(file, contents, "utf8");
  return file;
}
