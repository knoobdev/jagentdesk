import type {
  ServerEnvironment,
  SshEnvironmentErrorCode,
} from "@jagentdesk/protocol/ssh/environment-schemas";
import type { AcquireSshClient } from "../ssh-client-lease.js";
import {
  ENVIRONMENT_DETECT_SCRIPT,
  EnvironmentReportError,
  parseEnvironmentReport,
} from "./detect.js";
import type { EnvironmentStore } from "./store.js";
import { RemoteExecChannelError, runRemoteCommand } from "./remote-exec.js";

const DETECT_TIMEOUT_MS = 30_000;
const DETECT_MAX_OUTPUT_BYTES = 256 * 1024;

export class EnvironmentDetectError extends Error {
  constructor(
    readonly code: SshEnvironmentErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "EnvironmentDetectError";
  }
}

export interface SshEnvironmentServiceOptions {
  acquire: AcquireSshClient;
  store: EnvironmentStore;
  /** Per-server switch for detection on connect (off for MaxSessions=1 servers, network gear). */
  isAutoDetectEnabled: (serverId: string) => boolean;
  now?: () => number;
}

export interface DetectOptions {
  /** Re-run even when an environment is cached ("Re-detect"). */
  force: boolean;
}

/**
 * Detects and caches each server's `ServerEnvironment` (spec 25.10): one exec channel running
 * one script. Concurrent requests for the same server share one run.
 */
export class SshEnvironmentService {
  private readonly inFlight = new Map<string, Promise<ServerEnvironment>>();
  private readonly now: () => number;

  constructor(private readonly options: SshEnvironmentServiceOptions) {
    this.now = options.now ?? Date.now;
  }

  get(serverId: string): ServerEnvironment | null {
    return this.options.store.read(serverId);
  }

  async detect(serverId: string, options: DetectOptions): Promise<ServerEnvironment> {
    const cached = this.options.store.read(serverId);
    if (cached && !options.force) return cached;
    const running = this.inFlight.get(serverId);
    if (running) return running;
    const run = this.run(serverId).finally(() => this.inFlight.delete(serverId));
    this.inFlight.set(serverId, run);
    return run;
  }

  /** Call after S1 reports a server connected; re-detects unless the server turned it off. */
  async onConnected(serverId: string): Promise<ServerEnvironment | null> {
    if (!this.options.isAutoDetectEnabled(serverId)) return null;
    return this.detect(serverId, { force: true });
  }

  /** Call when a server is deleted. */
  forget(serverId: string): void {
    this.options.store.remove(serverId);
  }

  private async run(serverId: string): Promise<ServerEnvironment> {
    const lease = await this.options.acquire(serverId).catch((error: unknown) => {
      throw new EnvironmentDetectError("connect_failed", errorMessage(error), { cause: error });
    });
    try {
      const result = await runRemoteCommand(lease.client, {
        command: "sh -s",
        stdin: ENVIRONMENT_DETECT_SCRIPT,
        timeoutMs: DETECT_TIMEOUT_MS,
        maxBytesPerStream: DETECT_MAX_OUTPUT_BYTES,
      });
      if (result.timedOut) {
        throw new EnvironmentDetectError("timed_out", "environment detection timed out");
      }
      const environment = parseEnvironmentReport({
        serverId,
        output: result.stdout,
        detectedAtMs: this.now(),
      });
      this.options.store.write(environment);
      return environment;
    } catch (error) {
      if (error instanceof RemoteExecChannelError) {
        throw new EnvironmentDetectError("channel_refused", error.message, { cause: error });
      }
      if (error instanceof EnvironmentReportError) {
        throw new EnvironmentDetectError("unparseable", error.message, { cause: error });
      }
      throw error;
    } finally {
      lease.release();
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
