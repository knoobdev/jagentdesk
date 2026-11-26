import {
  getDesktopDaemonStatus,
  startDesktopDaemon,
  type DesktopDaemonStartOptions,
  type DesktopDaemonStatus,
} from "@/desktop/daemon/desktop-daemon";
import { connectionFromListen } from "@/types/host-connection";
import type { TailnetMode } from "@/tailscale";
import type { HostRuntimeStore } from "@/runtime/host-runtime";
import { rememberDesktopSignedLocalHost } from "@/runtime/desktop-signed-local-hosts";

export type DaemonStartResult = { ok: true } | { ok: false; error: string };
export type DaemonStartCondition = boolean | (() => boolean | Promise<boolean>);

export interface StartDaemonIfEnabledInput {
  shouldStart: DaemonStartCondition;
  /** Registry hydration may run in parallel with daemon startup, but identity reconciliation waits for it. */
  storeReady?: Promise<void>;
}

type DaemonConnectionStore = Pick<HostRuntimeStore, "getHosts" | "upsertConnectionFromListen"> &
  Partial<Pick<HostRuntimeStore, "upsertTailnetConnection">>;

export interface DaemonStartServiceDeps {
  store: DaemonConnectionStore;
  startDesktopDaemon?: (options?: DesktopDaemonStartOptions) => Promise<DesktopDaemonStatus>;
  getDesktopDaemonStatus?: () => Promise<DesktopDaemonStatus>;
  getTailnetMode?: () => Promise<TailnetMode | null>;
}

/**
 * Registers the bundled desktop daemon (spec `05.2.5`, ADR-0056). The desktop
 * always reaches its own daemon over the loopback listen address — badge
 * "Local" — whether or not Tailscale is signed in, so a signed-out or offline
 * tailnet never locks the desktop out of its own host. When the daemon has
 * joined the tailnet (`"tailnet"` mode), its verified tailnet route is added
 * next to it.
 */
export async function upsertDesktopDaemonConnection(
  store: DaemonConnectionStore,
  daemon: DesktopDaemonStatus,
  tailnetMode: TailnetMode | null = "off",
): Promise<DaemonStartResult> {
  const serverId = daemon.serverId.trim();
  if (!serverId) {
    return { ok: false, error: "Desktop daemon did not return a server id." };
  }

  const localResult = await upsertDesktopLocalConnection(store, daemon, serverId);
  if (!localResult.ok || tailnetMode !== "tailnet") {
    return localResult;
  }

  const tailnetAddress = daemon.tailnetAddress?.trim() ?? "";
  const daemonPublicKeyB64 = daemon.daemonPublicKeyB64?.trim() ?? "";
  if (!daemon.tailscaleConnected || !tailnetAddress || !daemonPublicKeyB64) {
    // The daemon can be running while Tailscale is still signing in. That is
    // not a startup failure; the Local connection already serves the desktop.
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

async function upsertDesktopLocalConnection(
  store: DaemonConnectionStore,
  daemon: DesktopDaemonStatus,
  serverId: string,
): Promise<DaemonStartResult> {
  const existingHost = store.getHosts().find((host) => host.serverId === serverId);
  const listenAddress = daemon.listen?.trim() ?? "";
  if (!listenAddress) {
    // Tailscale sign-in reports the daemon without its listen address; the
    // Local connection was registered when the daemon started.
    return existingHost
      ? { ok: true }
      : { ok: false, error: "Desktop daemon did not return a listen address." };
  }
  const connection = connectionFromListen(listenAddress);
  if (!connection) {
    return {
      ok: false,
      error: `Desktop daemon returned an unsupported listen address: ${listenAddress}`,
    };
  }
  if (daemon.desktopManaged) {
    // This daemon got the desktop device key from the supervisor, so the Local
    // connection signs its hello (ADR-0010). Record it before the host exists
    // so the first connection is already signed.
    await rememberDesktopSignedLocalHost(serverId);
  }
  if (existingHost?.connections.some((existing) => existing.id === connection.id)) {
    // Already registered; re-upserting must not reorder the user's connections.
    return { ok: true };
  }
  // A v0.10.0 desktop in Tailscale mode saved only the tailnet route to its own
  // daemon. Adding the loopback route here keeps that install reachable while
  // the tailnet is signed out.
  await store.upsertConnectionFromListen({
    listenAddress,
    serverId,
    hostname: daemon.hostname,
  });
  return { ok: true };
}

export class DaemonStartService {
  private readonly store: DaemonConnectionStore;
  private readonly invokeStartDesktopDaemon: (
    options?: DesktopDaemonStartOptions,
  ) => Promise<DesktopDaemonStatus>;
  private readonly invokeGetDesktopDaemonStatus: () => Promise<DesktopDaemonStatus>;
  private readonly resolveTailnetMode: () => Promise<TailnetMode | null>;
  private readonly listeners = new Set<() => void>();
  private lastError: string | null = null;
  private inFlightCount = 0;
  private inFlightStart: Promise<DaemonStartResult> | null = null;

  constructor(deps: DaemonStartServiceDeps) {
    this.store = deps.store;
    this.invokeStartDesktopDaemon = deps.startDesktopDaemon ?? startDesktopDaemon;
    this.invokeGetDesktopDaemonStatus = deps.getDesktopDaemonStatus ?? getDesktopDaemonStatus;
    // Unit-test callers model a daemon without Tailscale; production wiring
    // passes the persisted mode explicitly.
    this.resolveTailnetMode = deps.getTailnetMode ?? (async () => "off");
  }

  async start(): Promise<DaemonStartResult> {
    return this.startIfEnabled({ shouldStart: true });
  }

  async startIfEnabled(input: StartDaemonIfEnabledInput): Promise<DaemonStartResult> {
    // React can re-run the bootstrap effect while the persisted connection mode
    // is hydrating. Share the operation so two renderer calls can never spawn
    // two managed daemon supervisors for the same desktop runtime.
    if (this.inFlightStart) {
      return this.inFlightStart;
    }

    const operation = this.runStartIfEnabled(input);
    const trackedOperation = operation.finally(() => {
      if (this.inFlightStart === trackedOperation) {
        this.inFlightStart = null;
      }
    });
    this.inFlightStart = trackedOperation;
    return trackedOperation;
  }

  private async runStartIfEnabled(input: StartDaemonIfEnabledInput): Promise<DaemonStartResult> {
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

      const tailnetMode = await this.resolveTailnetMode();
      const storeReady = input.storeReady ?? Promise.resolve();
      const daemon = await this.invokeStartDesktopDaemon({
        enableTailscale: tailnetMode === "tailnet",
        waitForReady: false,
      });
      if (daemon.status === "starting") {
        // The desktop renderer must not wait for a cold daemon bootstrap. The
        // daemon can take tens of seconds to initialize its registries and
        // Tailscale bridge; reconcile its identity after the first window is
        // already usable.
        void this.reconcileWhenReady(tailnetMode, storeReady);
        return { ok: true };
      }
      await storeReady;
      const result = await upsertDesktopDaemonConnection(this.store, daemon, tailnetMode);
      return result.ok ? result : this.fail(result.error);
    } catch (error) {
      return this.fail(error instanceof Error ? error.message : String(error));
    } finally {
      this.endRequest();
    }
  }

  private async reconcileWhenReady(
    tailnetMode: TailnetMode | null,
    storeReady: Promise<void>,
  ): Promise<void> {
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      try {
        const daemon = await this.invokeGetDesktopDaemonStatus();
        if (daemon.status === "running") {
          await storeReady;
          const result = await upsertDesktopDaemonConnection(this.store, daemon, tailnetMode);
          if (!result.ok) {
            this.fail(result.error);
          }
          return;
        }
        if (daemon.status === "errored" || daemon.status === "stopped") {
          this.fail(daemon.error ?? "The managed desktop daemon stopped during startup.");
          return;
        }
      } catch {
        // Keep polling. The status endpoint is expected to be unavailable
        // while the worker is still constructing its HTTP server.
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 500));
    }

    this.fail("The managed desktop daemon did not become ready within 120 seconds.");
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
