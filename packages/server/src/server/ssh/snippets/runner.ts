import { StringDecoder } from "node:string_decoder";
import type { ClientChannel } from "ssh2";
import type {
  SshSnippetOutputChunk,
  SshSnippetOutputEvent,
  SshSnippetOutputStream,
  SshSnippetRun,
  SshSnippetRunError,
  SshSnippetRunSummary,
  SshSnippetRunTarget,
  SshSnippetStateEvent,
  SshSnippetTargetStatus,
} from "@jagentdesk/protocol/ssh/snippets-schemas";
import type { AcquireSshClient, SshClientLease } from "../ssh-client-lease.js";
import { newSshId } from "./secure-file.js";

export const SNIPPET_OUTPUT_CAP_BYTES = 1024 * 1024;
export const SNIPPET_RUNS_KEPT = 20;
const STOP_GRACE_MS = 3000;

export type SnippetRunEvent = SshSnippetOutputEvent | SshSnippetStateEvent;

export interface SnippetRunStart {
  snippetId: string | null;
  label: string;
  script: string;
  serverIds: readonly string[];
  timeoutMs?: number;
}

interface TargetExecution {
  status: SshSnippetTargetStatus;
  output: SshSnippetOutputChunk[];
  outputBytes: number;
  lease: SshClientLease | null;
  stop: (() => void) | null;
  cancelRequested: boolean;
  timedOut: boolean;
  done: Promise<void>;
}

interface RunExecution {
  runId: string;
  snippetId: string | null;
  label: string;
  script: string;
  startedAtMs: number;
  finishedAtMs: number | null;
  targets: Map<string, TargetExecution>;
  done: Promise<void>;
}

export class SnippetRunNotFoundError extends Error {
  constructor(readonly runId: string) {
    super(`snippet run ${runId} not found`);
  }
}

function errorCode(error: unknown, fallback: string): string {
  if (error instanceof Error && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  return fallback;
}

function toRunError(error: unknown, fallback: string): SshSnippetRunError {
  return {
    code: errorCode(error, fallback),
    message: error instanceof Error ? error.message : String(error),
  };
}

function openExec(lease: SshClientLease, script: string): Promise<ClientChannel> {
  return new Promise((resolve, reject) => {
    lease.client.exec(script, (error, stream) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(stream);
    });
  });
}

function snapshotTarget(target: TargetExecution): SshSnippetRunTarget {
  return { ...target.status, output: target.output.map(copyChunk) };
}

function copyChunk(chunk: SshSnippetOutputChunk): SshSnippetOutputChunk {
  return { stream: chunk.stream, text: chunk.text };
}

function statusOf(target: TargetExecution): SshSnippetTargetStatus {
  return target.status;
}

function isFinished(status: SshSnippetTargetStatus): boolean {
  return status.state === "exited" || status.state === "failed" || status.state === "cancelled";
}

/**
 * Runs one script on many servers in parallel, one `exec` channel per server (spec 25.7
 * "run on many servers"). Output and state stream to `emit`; the last runs stay in
 * memory so a client that opens the results later still sees everything.
 */
export class SnippetRunner {
  private readonly runs = new Map<string, RunExecution>();

  constructor(
    private readonly options: {
      acquire: AcquireSshClient;
      emit: (event: SnippetRunEvent) => void;
      now: () => number;
      outputCapBytes?: number;
    },
  ) {}

  start(params: SnippetRunStart): SshSnippetRun {
    const runId = newSshId("run");
    const startedAtMs = this.options.now();
    const targets = new Map<string, TargetExecution>();
    const run: RunExecution = {
      runId,
      snippetId: params.snippetId,
      label: params.label,
      script: params.script,
      startedAtMs,
      finishedAtMs: null,
      targets,
      done: Promise.resolve(),
    };
    for (const serverId of new Set(params.serverIds)) {
      const target: TargetExecution = {
        status: {
          serverId,
          state: "connecting",
          exitCode: null,
          signal: null,
          error: null,
          startedAtMs,
          finishedAtMs: null,
          truncated: false,
        },
        output: [],
        outputBytes: 0,
        lease: null,
        stop: null,
        cancelRequested: false,
        timedOut: false,
        done: Promise.resolve(),
      };
      targets.set(serverId, target);
    }
    this.runs.set(runId, run);
    this.prune();
    for (const target of targets.values()) {
      target.done = this.execute(run, target, params.timeoutMs);
    }
    run.done = this.settleRun(run);
    return this.snapshot(run);
  }

  private async settleRun(run: RunExecution): Promise<void> {
    await Promise.all([...run.targets.values()].map((target) => target.done));
    run.finishedAtMs = this.options.now();
  }

  get(runId: string): SshSnippetRun | null {
    const run = this.runs.get(runId);
    return run ? this.snapshot(run) : null;
  }

  list(): SshSnippetRunSummary[] {
    return [...this.runs.values()].toReversed().map((run) => ({
      runId: run.runId,
      snippetId: run.snippetId,
      label: run.label,
      script: run.script,
      startedAtMs: run.startedAtMs,
      finishedAtMs: run.finishedAtMs,
      targets: [...run.targets.values()].map(statusOf),
    }));
  }

  /** Resolves once every target of the run finished; returns the final snapshot. */
  async wait(runId: string): Promise<SshSnippetRun> {
    const run = this.runs.get(runId);
    if (!run) throw new SnippetRunNotFoundError(runId);
    await run.done;
    return this.snapshot(run);
  }

  cancel(runId: string, serverId?: string): void {
    const run = this.runs.get(runId);
    if (!run) throw new SnippetRunNotFoundError(runId);
    for (const target of run.targets.values()) {
      if (serverId && target.status.serverId !== serverId) continue;
      if (isFinished(target.status)) continue;
      target.cancelRequested = true;
      target.stop?.();
    }
  }

  /** Closes every channel still open (daemon shutdown). */
  async dispose(): Promise<void> {
    for (const run of this.runs.values()) this.cancel(run.runId);
    await Promise.all([...this.runs.values()].map((run) => run.done));
  }

  private async execute(
    run: RunExecution,
    target: TargetExecution,
    timeoutMs: number | undefined,
  ): Promise<void> {
    this.emitState(run, target);
    let lease: SshClientLease;
    try {
      lease = await this.options.acquire(target.status.serverId);
    } catch (error) {
      this.finish(run, target, { state: "failed", error: toRunError(error, "connect_failed") });
      return;
    }
    target.lease = lease;
    if (target.cancelRequested) {
      this.finish(run, target, { state: "cancelled" });
      return;
    }
    let channel: ClientChannel;
    try {
      channel = await openExec(lease, run.script);
    } catch (error) {
      this.finish(run, target, { state: "failed", error: toRunError(error, "exec_failed") });
      return;
    }
    target.status = { ...target.status, state: "running" };
    this.emitState(run, target);

    await this.stream(run, target, { lease, channel, timeoutMs });
  }

  private async stream(
    run: RunExecution,
    target: TargetExecution,
    params: { lease: SshClientLease; channel: ClientChannel; timeoutMs: number | undefined },
  ): Promise<void> {
    const { lease, channel, timeoutMs } = params;
    let exitCode: number | null = null;
    let signal: string | null = null;
    let settled = false;
    let markDone: () => void = () => undefined;
    const done = new Promise<void>((resolve) => {
      markDone = resolve;
    });
    const stdout = new StringDecoder("utf8");
    const stderr = new StringDecoder("utf8");
    let graceTimer: NodeJS.Timeout | null = null;
    let timeoutTimer: NodeJS.Timeout | null = null;
    const settle = () => {
      if (settled) return;
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (graceTimer) clearTimeout(graceTimer);
      lease.client.removeListener("close", settle);
      markDone();
    };
    const stop = () => {
      channel.signal("KILL");
      channel.close();
      // A server that ignores signal requests keeps the channel open until the
      // command ends on its own; the target settles locally after a grace period.
      graceTimer = setTimeout(settle, STOP_GRACE_MS);
    };
    target.stop = stop;
    if (timeoutMs !== undefined) {
      timeoutTimer = setTimeout(() => {
        target.timedOut = true;
        stop();
      }, timeoutMs);
    }
    channel.on("data", (data: Buffer) => this.append(run, target, "stdout", stdout.write(data)));
    channel.stderr.on("data", (data: Buffer) =>
      this.append(run, target, "stderr", stderr.write(data)),
    );
    channel.on("exit", (code: number | null, signalName?: string) => {
      exitCode = typeof code === "number" ? code : null;
      signal = signalName ?? null;
    });
    channel.on("close", settle);
    lease.client.once("close", settle);
    if (target.cancelRequested) stop();
    await done;

    this.append(run, target, "stdout", stdout.end());
    this.append(run, target, "stderr", stderr.end());
    if (target.timedOut) {
      this.finish(run, target, {
        state: "failed",
        error: { code: "timeout", message: `Timed out after ${timeoutMs} ms` },
      });
    } else if (target.cancelRequested) {
      this.finish(run, target, { state: "cancelled" });
    } else if (exitCode === null && signal === null) {
      this.finish(run, target, {
        state: "failed",
        error: { code: "connection_lost", message: "The connection closed before the exit" },
      });
    } else {
      this.finish(run, target, { state: "exited", exitCode, signal });
    }
  }

  private append(
    run: RunExecution,
    target: TargetExecution,
    stream: SshSnippetOutputStream,
    text: string,
  ): void {
    if (text === "" || target.status.truncated) return;
    const cap = this.options.outputCapBytes ?? SNIPPET_OUTPUT_CAP_BYTES;
    const bytes = Buffer.byteLength(text);
    if (target.outputBytes + bytes > cap) {
      target.status = { ...target.status, truncated: true };
      this.emitState(run, target);
      return;
    }
    target.outputBytes += bytes;
    const last = target.output.at(-1);
    if (last && last.stream === stream) {
      last.text += text;
    } else {
      target.output.push({ stream, text });
    }
    this.options.emit({
      type: "ssh.snippet.output",
      runId: run.runId,
      serverId: target.status.serverId,
      stream,
      text,
    });
  }

  private finish(
    run: RunExecution,
    target: TargetExecution,
    result: Pick<SshSnippetTargetStatus, "state"> &
      Partial<Pick<SshSnippetTargetStatus, "exitCode" | "signal" | "error">>,
  ): void {
    target.status = {
      ...target.status,
      ...result,
      finishedAtMs: this.options.now(),
    };
    target.stop = null;
    target.lease?.release();
    target.lease = null;
    this.emitState(run, target);
  }

  private emitState(run: RunExecution, target: TargetExecution): void {
    this.options.emit({
      type: "ssh.snippet.state",
      runId: run.runId,
      target: { ...target.status },
    });
  }

  private snapshot(run: RunExecution): SshSnippetRun {
    return {
      runId: run.runId,
      snippetId: run.snippetId,
      label: run.label,
      script: run.script,
      startedAtMs: run.startedAtMs,
      finishedAtMs: run.finishedAtMs,
      targets: [...run.targets.values()].map(snapshotTarget),
    };
  }

  private prune(): void {
    const finished = [...this.runs.values()].filter((run) => run.finishedAtMs !== null);
    const excess = this.runs.size - SNIPPET_RUNS_KEPT;
    for (const run of finished.slice(0, Math.max(0, excess))) this.runs.delete(run.runId);
  }
}
