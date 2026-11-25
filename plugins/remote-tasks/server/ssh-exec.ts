import type { Client, ClientChannel } from "ssh2";
import { runUnderSh } from "./remote-scripts.js";

export interface RemoteExecResult {
  stdout: Buffer;
  stderr: Buffer;
  /** Exit status from the channel's exit event; null when the channel closed without one. */
  exitCode: number | null;
}

/**
 * Opens an exec channel with the exit listener registered inside the ssh2 callback: ssh2 emits
 * `exit` while parsing its socket buffer, so a listener added after `await` misses it. The command
 * is wrapped to run under /bin/sh regardless of the user's login shell (see runUnderSh).
 */
export function openExecChannel(client: Client, command: string): Promise<ClientChannel> {
  return new Promise((resolve, reject) => {
    client.exec(runUnderSh(command), (error, stream) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(stream);
    });
  });
}

/**
 * Runs one command on an exec channel and collects stdout bytes. stdin bytes go over the channel
 * (never interpolated into the command line). Rejects on channel errors and on timeout. The
 * command is wrapped to run under /bin/sh regardless of the user's login shell (see runUnderSh).
 */
export function execCollect(
  client: Client,
  command: string,
  options?: { stdin?: Buffer; timeoutMs?: number },
): Promise<RemoteExecResult> {
  const timeoutMs = options?.timeoutMs ?? 30_000;
  return new Promise((resolve, reject) => {
    let settled = false;
    let exitCode: number | null = null;
    let timer: NodeJS.Timeout | null = null;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn();
    };
    client.exec(runUnderSh(command), (error, stream) => {
      if (error) {
        settle(() => reject(error));
        return;
      }
      const chunks: Buffer[] = [];
      const errChunks: Buffer[] = [];
      timer = setTimeout(() => {
        settle(() => reject(new Error(`remote exec timed out after ${timeoutMs} ms`)));
        stream.close();
      }, timeoutMs);
      stream.on("data", (data: Buffer) => chunks.push(data));
      stream.stderr.on("data", (data: Buffer) => errChunks.push(data));
      stream.on("exit", (code: number | null) => {
        exitCode = typeof code === "number" ? code : null;
      });
      stream.on("error", (streamError: Error) => settle(() => reject(streamError)));
      stream.on("close", () =>
        settle(() =>
          resolve({
            stdout: Buffer.concat(chunks),
            stderr: Buffer.concat(errChunks),
            exitCode,
          }),
        ),
      );
      if (options?.stdin && options.stdin.length > 0) stream.write(options.stdin);
      stream.end();
    });
  });
}
