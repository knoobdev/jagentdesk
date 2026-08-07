import { DaemonClient } from "@jagentdesk/client/internal/daemon-client";
import type { DaemonClientConfig } from "@jagentdesk/client/internal/daemon-client";
import type {
  DirectPipeHostConnection,
  DirectSocketHostConnection,
  HostConnection,
  TailnetHostConnection,
} from "@/types/host-connection";
import { getOrCreateClientId } from "./client-id";
import { getTailscaleLoginAdapter } from "@/tailscale";
import { resolveAppVersion } from "./app-version";
import { buildDaemonWebSocketUrl } from "./daemon-endpoints";
import {
  buildLocalDaemonTransportUrl,
  createDesktopLocalDaemonTransportFactory,
} from "@/desktop/daemon/desktop-daemon-transport";
import { getMobileDeviceName } from "./device-identity";

export interface DaemonProbeClient {
  readonly lastError: string | null;
  connect(): Promise<void>;
  close(): Promise<void>;
  getLastServerInfoMessage(): { serverId: string; hostname: string | null } | null;
}

interface LocalTransportUrlInput {
  transportType: "socket" | "pipe";
  transportPath: string;
}

export interface DaemonConnectionDependencies<TClient extends DaemonProbeClient> {
  getClientId(): Promise<string>;
  resolveAppVersion(): string | null;
  createLocalTransportFactory(): DaemonClientConfig["transportFactory"] | null;
  buildLocalTransportUrl(input: LocalTransportUrlInput): string;
  createClient(config: DaemonClientConfig): TClient;
}

const defaultDaemonConnectionDependencies: DaemonConnectionDependencies<DaemonClient> = {
  getClientId: getOrCreateClientId,
  resolveAppVersion,
  createLocalTransportFactory: createDesktopLocalDaemonTransportFactory,
  buildLocalTransportUrl: buildLocalDaemonTransportUrl,
  createClient: (config) => new DaemonClient(config),
};

function normalizeNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function pickBestReason(reason: string | null, lastError: string | null): string {
  const genericReason =
    reason &&
    (reason.toLowerCase() === "transport error" || reason.toLowerCase() === "transport closed");
  const genericLastError =
    lastError &&
    (lastError.toLowerCase() === "transport error" ||
      lastError.toLowerCase() === "transport closed" ||
      lastError.toLowerCase() === "unable to connect");

  if (genericReason && lastError && !genericLastError) {
    return lastError;
  }
  if (reason) return reason;
  if (lastError) return lastError;
  return "Unable to connect";
}

function isIncorrectPasswordFailure(input: {
  config: DaemonClientConfig;
  reason: string | null;
  lastError: string | null;
}): boolean {
  if (!input.config.password) {
    return false;
  }
  const details = [input.reason, input.lastError].filter(Boolean).join("\n").toLowerCase();
  return (
    details.includes("401") ||
    details.includes("4001") ||
    details.includes("unauthorized") ||
    details.includes("code 1006")
  );
}

export class DaemonConnectionTestError extends Error {
  reason: string | null;
  lastError: string | null;

  constructor(message: string, details: { reason: string | null; lastError: string | null }) {
    super(message);
    this.name = "DaemonConnectionTestError";
    this.reason = details.reason;
    this.lastError = details.lastError;
  }
}

interface BuildClientOptions {
  capabilities?: DaemonClientConfig["capabilities"];
  pairingCodeProvider?: () => Promise<string>;
  connectTimeoutMs?: number;
}

type BaseDaemonClientConfig = Omit<DaemonClientConfig, "url">;

function buildLocalClientConfig(
  connection: DirectSocketHostConnection | DirectPipeHostConnection,
  base: BaseDaemonClientConfig,
  deps: Pick<DaemonConnectionDependencies<DaemonProbeClient>, "buildLocalTransportUrl">,
): DaemonClientConfig {
  return {
    ...base,
    url: deps.buildLocalTransportUrl({
      transportType: connection.type === "directSocket" ? "socket" : "pipe",
      transportPath: connection.path,
    }),
  };
}

async function buildTailnetClientConfig(
  connection: TailnetHostConnection,
  base: BaseDaemonClientConfig,
  options: BuildClientOptions | undefined,
): Promise<DaemonClientConfig> {
  const tailscaleAdapter = getTailscaleLoginAdapter();
  if (tailscaleAdapter.platform === "desktop") {
    const status = await tailscaleAdapter.getStatus();
    if (status.kind !== "connected") {
      throw new DaemonConnectionTestError("Tailscale connection is not ready", {
        reason: "Tailscale connection is not ready",
        lastError: null,
      });
    }
  }

  const proxyAddress = tailscaleAdapter.getProxyAddress?.(connection.tailnetAddress) ?? null;
  const signing = tailscaleAdapter.getDeviceSigningMaterial?.() ?? null;
  const deviceName =
    tailscaleAdapter.platform === "ios" || tailscaleAdapter.platform === "android"
      ? getMobileDeviceName()
      : undefined;
  const pairingCodeProvider = options?.pairingCodeProvider;
  // A normal host health check must never create a new pairing request. The
  // six-digit registration is only armed by the explicit mobile Pair verify
  // screen through pairingCodeProvider; otherwise a reconnecting desktop
  // probe could occupy the daemon's single pending request slot.
  const pairingRegistration =
    connection.daemonPublicKeyB64 && (pairingCodeProvider || connection.pairingCode)
      ? {
          daemonPublicKeyB64: connection.daemonPublicKeyB64,
          ...(deviceName ? { deviceName } : {}),
          ...(connection.pairingCode ? { pairingCode: connection.pairingCode } : {}),
          ...(pairingCodeProvider ? { pairingCodeProvider } : {}),
        }
      : null;
  return {
    ...base,
    url: buildDaemonWebSocketUrl(proxyAddress ?? connection.tailnetAddress, {
      useTls: connection.useTls ?? false,
    }),
    expectChallenge: true,
    ...(signing ? { deviceSigning: signing } : {}),
    ...(pairingRegistration ? { pairingRegistration } : {}),
  };
}

export async function buildClientConfig(
  connection: HostConnection,
  serverId?: string,
  options?: BuildClientOptions,
  deps: Pick<
    DaemonConnectionDependencies<DaemonProbeClient>,
    "getClientId" | "resolveAppVersion" | "createLocalTransportFactory" | "buildLocalTransportUrl"
  > = defaultDaemonConnectionDependencies,
): Promise<DaemonClientConfig> {
  const clientId = await deps.getClientId();
  const localTransportFactory = deps.createLocalTransportFactory();
  const base = {
    clientId,
    clientType: "mobile" as const,
    appVersion: deps.resolveAppVersion() ?? undefined,
    suppressSendErrors: true,
    reconnect: { enabled: false },
    ...(options?.capabilities ? { capabilities: options.capabilities } : {}),
    ...(options?.connectTimeoutMs ? { connectTimeoutMs: options.connectTimeoutMs } : {}),
    ...((connection.type === "directSocket" || connection.type === "directPipe") &&
    localTransportFactory
      ? { transportFactory: localTransportFactory }
      : {}),
  };

  if (connection.type === "directSocket" || connection.type === "directPipe") {
    return buildLocalClientConfig(connection, base, deps);
  }

  if (connection.type === "directTcp") {
    return {
      ...base,
      url: buildDaemonWebSocketUrl(connection.endpoint, { useTls: connection.useTls ?? false }),
      ...(connection.password ? { password: connection.password } : {}),
    };
  }

  return buildTailnetClientConfig(connection, base, options);
}

export function connectAndProbe(
  config: DaemonClientConfig,
  timeoutMs: number,
): Promise<{ client: DaemonClient; serverId: string; hostname: string | null }>;
export function connectAndProbe<TClient extends DaemonProbeClient>(
  config: DaemonClientConfig,
  timeoutMs: number,
  deps: Pick<DaemonConnectionDependencies<TClient>, "createClient">,
  signal?: AbortSignal,
): Promise<{ client: TClient; serverId: string; hostname: string | null }>;
export function connectAndProbe(
  config: DaemonClientConfig,
  timeoutMs: number,
  deps: Pick<
    DaemonConnectionDependencies<DaemonProbeClient>,
    "createClient"
  > = defaultDaemonConnectionDependencies,
  signal?: AbortSignal,
): Promise<{ client: DaemonProbeClient; serverId: string; hostname: string | null }> {
  const client = deps.createClient(config);

  return new Promise<{ client: DaemonProbeClient; serverId: string; hostname: string | null }>(
    (resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };
      const resolveOnce = (value: {
        client: DaemonProbeClient;
        serverId: string;
        hostname: string | null;
      }) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      };
      const rejectOnce = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const onAbort = () => {
        const reason = "Connection attempt cancelled";
        void client.close().catch(() => undefined);
        rejectOnce(
          new DaemonConnectionTestError(reason, {
            reason,
            lastError: client.lastError ?? null,
          }),
        );
      };

      timer = setTimeout(() => {
        void client.close().catch(() => undefined);
        rejectOnce(
          new DaemonConnectionTestError("Connection timed out", {
            reason: "Connection timed out",
            lastError: client.lastError ?? null,
          }),
        );
      }, timeoutMs);

      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });

      void client
        .connect()
        .then(() => {
          if (settled) return;
          const serverInfo = client.getLastServerInfoMessage();
          if (!serverInfo) {
            void client.close().catch(() => undefined);
            rejectOnce(
              new DaemonConnectionTestError("Missing server info message", {
                reason: "Missing server info message",
                lastError: client.lastError ?? null,
              }),
            );
            return;
          }
          resolveOnce({
            client,
            serverId: serverInfo.serverId,
            hostname: serverInfo.hostname,
          });
          return;
        })
        .catch((error) => {
          if (settled) return;
          const reason = normalizeNonEmptyString(
            error instanceof Error ? error.message : String(error),
          );
          const lastError = normalizeNonEmptyString(client.lastError);
          const message = isIncorrectPasswordFailure({ config, reason, lastError })
            ? "Incorrect password"
            : pickBestReason(reason, lastError);
          void client.close().catch(() => undefined);
          rejectOnce(new DaemonConnectionTestError(message, { reason, lastError }));
        });
    },
  );
}

interface ProbeOptions {
  serverId?: string;
  timeoutMs?: number;
  connectTimeoutMs?: number;
  capabilities?: DaemonClientConfig["capabilities"];
  pairingCodeProvider?: () => Promise<string>;
  signal?: AbortSignal;
}

function resolveTimeout(_connection: HostConnection, options?: ProbeOptions): number {
  if (options?.timeoutMs) return options.timeoutMs;
  return 6_000;
}

export function connectToDaemon(
  connection: HostConnection,
  options?: ProbeOptions,
): Promise<{ client: DaemonClient; serverId: string; hostname: string | null }>;
export function connectToDaemon<TClient extends DaemonProbeClient>(
  connection: HostConnection,
  options: ProbeOptions | undefined,
  deps: DaemonConnectionDependencies<TClient>,
): Promise<{ client: TClient; serverId: string; hostname: string | null }>;
export async function connectToDaemon(
  connection: HostConnection,
  options?: ProbeOptions,
  deps: DaemonConnectionDependencies<DaemonProbeClient> = defaultDaemonConnectionDependencies,
): Promise<{ client: DaemonProbeClient; serverId: string; hostname: string | null }> {
  const config = await buildClientConfig(connection, options?.serverId, options, deps);
  return connectAndProbe(config, resolveTimeout(connection, options), deps, options?.signal);
}
