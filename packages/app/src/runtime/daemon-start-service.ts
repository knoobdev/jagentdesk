import { startDesktopDaemon, type DesktopDaemonStatus } from "@/desktop/daemon/desktop-daemon";
import { connectionFromListen } from "@/types/host-connection";
import type { ConnectionMode } from "@/tailscale";
import type { HostRuntimeStore } from "@/runtime/host-runtime";

export type DaemonStartResult = { ok: true } | { ok: false; error: string };
export type DaemonStartCondition = boolean | (() => boolean | Promise<boolean>);

export interface StartDaemonIfEnabledInput {
  shouldStart: DaemonStartCondition;
}

type DaemonConnectionStore = Pick<HostRuntimeStore, "upsertConnectionFromListen"> &
  Partial<Pick<HostRuntimeStore, "upsertTailnetConnection">>;

export interface DaemonStartServiceDeps {
  store: DaemonConnectionStore;
  startDesktopDaemon?: () => Promise<DesktopDaemonStatus>;
  getConnectionMode?: () => Promise<ConnectionMode | null>;
}

export async function upsertDesktopDaemonConnection(
  store: DaemonConnectionStore,
  daemon: DesktopDaemonStatus,
  connectionMode: ConnectionMode | null = "local",
): Promise<DaemonStartResult> {
  const serverId = daemon.serverId.trim();
  if (!serverId) {
    return { ok: false, error: "Desktop daemon did not return a server id." };
  }

  if (connectionMode === null) {
    // First-run desktop startup must not create a localhost host before the
    // user chooses Local or authenticates Tailscale.
    return { ok: true };
  }

  if (connectionMode === "tailscale") {
    const tailnetAddress = daemon.tailnetAddress?.trim() ?? "";
    const daemonPublicKeyB64 = daemon.daemonPublicKeyB64?.trim() ?? "";
    if (!daemon.tailscaleConnected || !tailnetAddress || !daemonPublicKeyB64) {
      // The daemon can be running while the user is still on the Tailscale
      // login screen. That is not a startup failure and must not produce a
      // fake Local fallback.
      return { ok: true };
    }
    if (!store.upsertTailnetConnection) {
      return { ok: false, error: "Host runtime cannot store a Tailscale connection." };
    }
    await store.upsertTailnetConnection({
      serverId,
      tailnetAddress,
      useTls: false,
      daemonPublicKeyB64,
      label: daemon.hostname ?? undefined,
    });
    return { ok: true };
  }

  const listenAddress = daemon.listen?.trim() ?? "";
  if (!listenAddress) {
    return { ok: false, error: "Desktop daemon did not return a listen address." };
  }
  if (!connectionFromListen(listenAddress)) {
    return {
      ok: false,
      error: `Desktop daemon returned an unsupported listen address: ${listenAddress}`,
    };
  }
  await store.upsertConnectionFromListen({
    listenAddress,
    serverId,
    hostname: daemon.hostname,
  });
  return { ok: true };
}

export class DaemonStartService {
  private readonly store: DaemonConnectionStore;
  private readonly invokeStartDesktopDaemon: () => Promise<DesktopDaemonStatus>;
  private readonly resolveConnectionMode: () => Promise<ConnectionMode | null>;
  private readonly listeners = new Set<() => void>();
  private lastError: string | null = null;
  private inFlightCount = 0;

  constructor(deps: DaemonStartServiceDeps) {
    this.store = deps.store;
    this.invokeStartDesktopDaemon = deps.startDesktopDaemon ?? startDesktopDaemon;
    // Unit-test callers historically modelled the pre-Tailscale local daemon;
    // production wiring passes the persisted mode explicitly.
    this.resolveConnectionMode = deps.getConnectionMode ?? (async () => "local");
  }

  async start(): Promise<DaemonStartResult> {
    return this.startIfEnabled({ shouldStart: true });
  }

  async startIfEnabled(input: StartDaemonIfEnabledInput): Promise<DaemonStartResult> {
    // Settings evaluation is part of startup. Publish the running state before
    // its first await so restored app chrome cannot appear between these phases.
    this.beginRequest();
    try {
      let shouldStart: boolean;
      try {
        shouldStart =
          typeof input.shouldStart === "boolean" ? input.shouldStart : await input.shouldStart();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return this.fail(`Failed to evaluate desktop daemon settings: ${message}`);
      }

      if (!shouldStart) {
        return { ok: true };
      }

      const daemon = await this.invokeStartDesktopDaemon();
      const result = await upsertDesktopDaemonConnection(
        this.store,
        daemon,
        await this.resolveConnectionMode(),
      );
      return result.ok ? result : this.fail(result.error);
    } catch (error) {
      return this.fail(error instanceof Error ? error.message : String(error));
    } finally {
      this.endRequest();
    }
  }

  getLastError(): string | null {
    return this.lastError;
  }

  isRunning(): boolean {
    return this.inFlightCount > 0;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private fail(message: string): DaemonStartResult {
    this.setLastError(message);
    return { ok: false, error: message };
  }

  private setLastError(value: string | null): void {
    if (this.lastError === value) {
      return;
    }
    this.lastError = value;
    this.notify();
  }

  private beginRequest(): void {
    const becameRunning = this.inFlightCount === 0;
    this.inFlightCount += 1;
    const errorChanged = this.lastError !== null;
    this.lastError = null;
    if (becameRunning || errorChanged) {
      this.notify();
    }
  }

  private endRequest(): void {
    this.inFlightCount = Math.max(0, this.inFlightCount - 1);
    if (this.inFlightCount === 0) {
      this.notify();
    }
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

let singletonDaemonStartService: DaemonStartService | null = null;
const DAEMON_START_SERVICE_GLOBAL_KEY = "__jagentdeskDaemonStartService";

type DaemonStartServiceGlobal = typeof globalThis & {
  [DAEMON_START_SERVICE_GLOBAL_KEY]?: DaemonStartService;
};

export function getDaemonStartService(deps: DaemonStartServiceDeps): DaemonStartService {
  if (singletonDaemonStartService) {
    return singletonDaemonStartService;
  }

  const runtimeGlobal = globalThis as DaemonStartServiceGlobal;
  if (runtimeGlobal[DAEMON_START_SERVICE_GLOBAL_KEY]) {
    singletonDaemonStartService = runtimeGlobal[DAEMON_START_SERVICE_GLOBAL_KEY] ?? null;
    if (singletonDaemonStartService) {
      return singletonDaemonStartService;
    }
  }

  singletonDaemonStartService = new DaemonStartService(deps);
  runtimeGlobal[DAEMON_START_SERVICE_GLOBAL_KEY] = singletonDaemonStartService;
  return singletonDaemonStartService;
}
