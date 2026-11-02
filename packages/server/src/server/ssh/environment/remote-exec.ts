import type { Client, ClientChannel } from "ssh2";

export interface RemoteExecResult {
  stdout: string;
  stderr: string;
  /** null when the command was killed by a signal or the channel closed without a status. */
  exitCode: number | null;
  signal: string | null;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  timedOut: boolean;
}

export interface RemoteExecInput {
  command: string;
  /** Written to the command's stdin, then stdin is closed. */
  stdin?: string;
  timeoutMs: number;
  /** Bytes kept per stream; the rest is read and dropped so the remote never blocks. */
  maxBytesPerStream: number;
}

// The server refused to open the channel (MaxSessions reached, exec disabled, network gear).
export class RemoteExecChannelError extends Error {
  constructor(readonly cause: Error) {
    super(`server refused an exec channel: ${cause.message}`);
    this.name = "RemoteExecChannelError";
  }
}

interface ExitStatus {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
}

class CappedBuffer {
  private readonly chunks: Buffer[] = [];
  private size = 0;
  truncated = false;

  constructor(private readonly cap: number) {}

  push(chunk: Buffer): void {
    const room = this.cap - this.size;
    if (room <= 0) {
      this.truncated = true;
      return;
    }
    const kept = chunk.length > room ? chunk.subarray(0, room) : chunk;
    if (kept.length < chunk.length) this.truncated = true;
    this.chunks.push(kept);
    this.size += kept.length;
  }

  text(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

function openExec(client: Client, command: string): Promise<ClientChannel> {
  return new Promise((resolve, reject) => {
    client.exec(command, (error, channel) => {
      if (error) reject(new RemoteExecChannelError(error));
      else resolve(channel);
    });
  });
}

/** Runs one command on one `exec` channel and collects capped stdout/stderr. */
export async function runRemoteCommand(
  client: Client,
  input: RemoteExecInput,
): Promise<RemoteExecResult> {
  const channel = await openExec(client, input.command);
  const stdout = new CappedBuffer(input.maxBytesPerStream);
  const stderr = new CappedBuffer(input.maxBytesPerStream);
  channel.on("data", (chunk: Buffer) => stdout.push(chunk));
  channel.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  const closed = new Promise<ExitStatus>((resolve) => {
    channel.on("close", (code: number | null | undefined, signal: string | undefined) => {
      resolve({
        exitCode: typeof code === "number" ? code : null,
        signal: signal ?? null,
        timedOut: false,
      });
    });
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<ExitStatus>((resolve) => {
    timer = setTimeout(() => {
      // Not every sshd honours signal requests and OpenSSH acknowledges the close only once the
      // command exits, so answer now and let the channel wind down on its own.
      channel.signal("KILL");
      channel.close();
      resolve({ exitCode: null, signal: null, timedOut: true });
    }, input.timeoutMs);
  });
  if (input.stdin !== undefined) channel.end(input.stdin);
  else channel.end();
  const status = await Promise.race([closed, expired]);
  clearTimeout(timer);
  return {
    stdout: stdout.text(),
    stderr: stderr.text(),
    ...status,
    stdoutTruncated: stdout.truncated,
    stderrTruncated: stderr.truncated,
  };
}
