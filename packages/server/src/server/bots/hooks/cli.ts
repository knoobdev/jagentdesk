import { spawn } from "node:child_process";

/** `gh` or `glab` run as the owner. `input` goes on stdin so secrets never reach argv. */
export type ForgeCli = (args: string[], input?: string) => Promise<string>;

export class ForgeCliError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
    readonly code: number | null,
  ) {
    super(message);
  }
  /** HTTP status `gh api` / `glab api` printed, when there was one. */
  get httpStatus(): number | undefined {
    const match = /\bHTTP (\d{3})\b/.exec(this.stderr) ?? /\b(\d{3}) [A-Z][a-z]+/.exec(this.stderr);
    return match ? Number(match[1]) : undefined;
  }
}

export function forgeCli(binary: "gh" | "glab", env: NodeJS.ProcessEnv = {}): ForgeCli {
  return (args, input) =>
    new Promise((resolve, reject) => {
      const child = spawn(binary, args, {
        env: {
          ...process.env,
          GH_PROMPT_DISABLED: "1",
          GLAB_NO_PROMPT: "1",
          NO_COLOR: "1",
          ...env,
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let size = 0;
      const timer = setTimeout(() => child.kill("SIGTERM"), 30_000);
      child.stdout.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size <= 4 * 1024 * 1024) out.push(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(new ForgeCliError(`${binary} could not start: ${error.message}`, "", null));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        const stdout = Buffer.concat(out).toString("utf8");
        const stderr = Buffer.concat(err).toString("utf8").slice(0, 4000);
        if (code === 0) resolve(stdout);
        // Only the CLI's own message: never the request body, which may hold a secret.
        else
          reject(
            new ForgeCliError(
              stderr.trim().split("\n").at(-1) || `${binary} exited ${code}`,
              `${stderr}\n${stdout.slice(0, 2000)}`,
              code,
            ),
          );
      });
      child.stdin.on("error", () => {});
      child.stdin.end(input ?? "");
    });
}
