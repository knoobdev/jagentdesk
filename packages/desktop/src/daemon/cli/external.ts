import { spawnProcess } from "@jagentdesk/server";
import log from "electron-log/main";
import type { NodeEntrypointInvocation } from "../node-entrypoint-launcher.js";
import { createNodeEntrypointInvocation } from "../runtime-paths.js";
import { resolveExternalCliEntrypoint } from "./entrypoints.js";

function createExternalCliInvocation(args: string[]): NodeEntrypointInvocation {
  return createNodeEntrypointInvocation({
    entrypoint: resolveExternalCliEntrypoint(),
    argvMode: "node-script",
    args,
    baseEnv: process.env,
  });
}

// JAgentDesk keeps a short budget so a wedged CLI cannot stall desktop startup or the
// Tailscale login screen (see 7d652ce73); upstream uses 15 s.
const DEFAULT_EXTERNAL_CLI_TIMEOUT_MS = 8_000;
const EXTERNAL_CLI_KILL_GRACE_MS = 2_000;

function spawnExternalCli(
  invocation: NodeEntrypointInvocation,
  args: string[],
  timeoutMs = DEFAULT_EXTERNAL_CLI_TIMEOUT_MS,
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(invocation.command, invocation.args, {
      envMode: "internal",
      env: invocation.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | null = null;

    const cleanupTimers = () => {
      clearTimeout(timeoutTimer);
      if (killTimer !== null) {
        clearTimeout(killTimer);
        killTimer = null;
      }
    };

    const timeoutTimer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      log.warn("[desktop external-cli]", "CLI command timed out", {
        args,
        timeoutMs,
        command: invocation.command,
        stdout: stdout.trim().slice(0, 500),
        stderr: stderr.trim().slice(0, 500),
      });
      try {
        child.kill("SIGTERM");
      } catch {
        // Ignore kill failures if the process already exited.
      }
      killTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // Ignore kill failures if the process already exited.
        }
      }, EXTERNAL_CLI_KILL_GRACE_MS);
      killTimer.unref?.();
      reject(new Error(`CLI command timed out after ${timeoutMs}ms: ${args.join(" ")}`));
    }, timeoutMs);

    child.stdout!.on("data", (data: Buffer) => {
      stdout += data.toString();
    });
    child.stderr!.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanupTimers();
      reject(error);
    });
    child.on("close", (exitCode) => {
      if (settled) {
        cleanupTimers();
        return;
      }
      settled = true;
      cleanupTimers();
      resolve({ stdout, stderr, exitCode });
    });
  });
}

function externalCliFailureMessage(
  exitCode: number | null,
  stdout: string,
  stderr: string,
): string {
  if (stderr.length > 0) {
    return stderr;
  }

  return `CLI command failed with exit code ${exitCode}${stdout.length > 0 ? `\nstdout: ${stdout.slice(0, 200)}` : ""}`;
}

export async function runExternalCliTextCommand(args: string[]): Promise<string> {
  const invocation = createExternalCliInvocation(args);
  const result = await spawnExternalCli(invocation, args);

  if (result.exitCode !== 0) {
    const stderr = result.stderr.trim();
    const stdout = result.stdout.trim();
    log.warn("[desktop external-cli]", "CLI text command failed", {
      args,
      exitCode: result.exitCode,
      stdout: stdout.slice(0, 500),
      stderr: stderr.slice(0, 500),
    });
    throw new Error(externalCliFailureMessage(result.exitCode, stdout, stderr));
  }

  return result.stdout.trimEnd();
}

export async function runExternalCliJsonCommand(args: string[]): Promise<unknown> {
  const invocation = createExternalCliInvocation(args);
  const result = await spawnExternalCli(invocation, args);

  if (result.exitCode !== 0) {
    const stderr = result.stderr.trim();
    const stdout = result.stdout.trim();
    log.warn("[desktop external-cli]", "CLI JSON command failed", {
      args,
      exitCode: result.exitCode,
      stdout: stdout.slice(0, 500),
      stderr: stderr.slice(0, 500),
      command: invocation.command,
    });
    throw new Error(externalCliFailureMessage(result.exitCode, stdout, stderr));
  }

  const stdout = result.stdout.trim();
  if (stdout.length === 0) {
    log.warn("[desktop external-cli]", "CLI command produced no output", { args });
    throw new Error("CLI command did not produce JSON output.");
  }

  const jsonStart = stdout.search(/[{[]/);
  if (jsonStart < 0) {
    log.warn("[desktop external-cli]", "CLI command output contained no JSON", {
      args,
      stdout: stdout.slice(0, 500),
    });
    throw new Error(`CLI command output contained no JSON. Output: ${stdout.slice(0, 200)}`);
  }

  try {
    return JSON.parse(stdout.slice(jsonStart)) as unknown;
  } catch (error) {
    throw new Error(
      `CLI command returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}
