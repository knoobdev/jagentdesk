import { spawn } from "node:child_process";

/** How sideload runs host tools (go-ios, adb, zsign): a port so tests drive it in memory. */

export interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  timeoutMs: number;
  onStdoutLine?: (line: string) => void;
  onStderrLine?: (line: string) => void;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
}

export type RunProcess = (
  command: string,
  args: readonly string[],
  options: RunOptions,
) => Promise<ProcessResult>;

export class ProcessStartError extends Error {
  constructor(
    readonly command: string,
    message: string,
  ) {
    super(message);
    this.name = "ProcessStartError";
  }
}

function lineSplitter(onLine: ((line: string) => void) | undefined): (chunk: string) => void {
  let pending = "";
  return (chunk) => {
    if (!onLine) return;
    pending += chunk;
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? "";
    for (const line of lines) onLine(line);
  };
}

export const runProcess: RunProcess = (command, args, options) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      stdio: ["ignore", "pipe", "pipe"],
      env: options.env ?? process.env,
      signal: options.signal,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    const stdoutLines = lineSplitter(options.onStdoutLine);
    const stderrLines = lineSplitter(options.onStderrLine);
    const timer = setTimeout(() => child.kill("SIGTERM"), options.timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      stdoutLines(chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      stderrLines(chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new ProcessStartError(command, error.message));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
