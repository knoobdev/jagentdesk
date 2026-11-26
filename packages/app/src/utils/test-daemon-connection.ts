import { createHostPluginClientBundleStore } from "@/plugins/client-bundles";
import { createHostLogger } from "@/runtime/host-logger";
import {
  nativeWebSocketFactory,
  defaultWebSocketFactory,
} from "@jagentdesk/client/internal/daemon-client-transport";
import { isNative } from "@/constants/platform";
import { DaemonClient } from "@jagentdesk/client/internal/daemon-client";
import type {
  DaemonClientConfig,
  DaemonConnectStage,
} from "@jagentdesk/client/internal/daemon-client";
import type {
  DirectPipeHostConnection,
  DirectSocketHostConnection,
  HostConnection,
  TailnetHostConnection,
  RelayHostConnection,
} from "@/types/host-connection";
import { getRelayDeviceSigning, prepareRelayDeviceSigning } from "./relay-device-signing";
import { getOrCreateClientId } from "./client-id";
import { getTailscaleLoginAdapter } from "@/tailscale";
import { resolveAppVersion } from "./app-version";
import { buildDaemonWebSocketUrl, buildRelayWebSocketUrl } from "./daemon-endpoints";
import {
  buildLocalDaemonTransportUrl,
  createDesktopLocalDaemonTransportFactory,
} from "@/desktop/daemon/desktop-daemon-transport";
import { getMobileDeviceName } from "./device-identity";
import { directTcpClientConfig } from "@/runtime/direct-tcp-client-config";

export interface DaemonProbeClient {
  readonly lastError: string | null;
  /** How far the attempt got (`DaemonClient.connectStage`). */
  readonly connectStage?: DaemonConnectStage;
  connect(): Promise<void>;
  close(): Promise<void>;
  getLastServerInfoMessage(): { serverId: string; hostname: string | null } | null;
}

interface LocalTransportUrlInput {
  transportType: "socket" | "pipe";
  transportPath: string;
}

export interface DaemonConnectionDependencies<TClient extends DaemonProbeClient> {
  createLogger: typeof createHostLogger;
  getClientId(): Promise<string>;
  resolveAppVersion(): string | null;
  createLocalTransportFactory(): DaemonClientConfig["transportFactory"] | null;
  buildLocalTransportUrl(input: LocalTransportUrlInput): string;
  createClient(config: DaemonClientConfig): TClient;
}

const defaultDaemonConnectionDependencies: DaemonConnectionDependencies<DaemonClient> = {
  createLogger: createHostLogger,
  getClientId: async () => {
    await prepareRelayDeviceSigning().catch(() => undefined);
    return getOrCreateClientId();
  },
  resolveAppVersion,
  createLocalTransportFactory: createDesktopLocalDaemonTransportFactory,
  buildLocalTransportUrl: buildLocalDaemonTransportUrl,
  createClient: (config) =>
    new DaemonClient({
      ...config,
      createPluginClientBundleStore: createHostPluginClientBundleStore,
    }),
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

const TIMEOUT_STAGE_MESSAGES: Record<DaemonConnectStage, string> = {
  connecting: "Connection timed out before the connection to the host opened.",
  opened: "Connection timed out: the host did not ask this device to sign in.",
  challenged: "Connection timed out: this device did not answer the host's sign-in challenge.",
  signing: "Connection timed out while this device's key was signing in.",
  hello_sent: "Connection timed out waiting for the host to accept this device.",
};

/** Says where a timed-out attempt stopped, and the error behind it when there was one. */
export function describeConnectTimeout(client: {
  connectStage?: DaemonConnectStage;
  lastError: string | null;
}): string {
  const stage = client.connectStage ? TIMEOUT_STAGE_MESSAGES[client.connectStage] : null;
  const lastError = normalizeNonEmptyString(client.lastError);
  const base = stage ?? "Connection timed out";
  return lastError && lastError !== "Connection timed out" ? `${base} (${lastError})` : base;
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

function requireServerId(serverId: string | undefined): string {
  if (!serverId) throw new Error("serverId is required for relay connections");
  return serverId;
}

function buildPairingRegistration(
  connection: TailnetHostConnection | RelayHostConnection,
  options: BuildClientOptions | undefined,
  platform: string,
) {
  const deviceName =
    platform === "ios" || platform === "android" ? getMobileDeviceName() : undefined;
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

  return pairingRegistration;
}

async function buildTailnetClientConfig(
  connection: TailnetHostConnection | RelayHostConnection,
  serverId: string | undefined,
  base: BaseDaemonClientConfig,
  options: BuildClientOptions | undefined,
): Promise<DaemonClientConfig> {
  const tailscaleAdapter = getTailscaleLoginAdapter();
  if (connection.type === "tailnet" && tailscaleAdapter.platform === "desktop") {
    const status = await tailscaleAdapter.getStatus();
    if (status.kind !== "connected") {
      throw new DaemonConnectionTestError("Tailscale connection is not ready", {
        reason: "Tailscale connection is not ready",
        lastError: null,
      });
    }
  }

  const proxyAddress =
    connection.type === "tailnet"
      ? (tailscaleAdapter.getProxyAddress?.(connection.tailnetAddress) ?? null)
      : null;
  if (connection.type === "relay") await prepareRelayDeviceSigning();
  const signing = getRelayDeviceSigning();
  const pairingRegistration = buildPairingRegistration(
    connection,
    options,
    tailscaleAdapter.platform,
  );
  return {
    ...base,
    ...(connection.type === "relay"
      ? {
          url: buildRelayWebSocketUrl({
            role: "client",
            endpoint: connection.endpoint,
            useTls: connection.useTls ?? true,
            serverId: requireServerId(serverId),
          }),
          e2ee: { enabled: true, daemonPublicKeyB64: connection.daemonPublicKeyB64 },
        }
      : {
          url: `${buildDaemonWebSocketUrl(proxyAddress ?? connection.tailnetAddress, {
            useTls: connection.useTls ?? false,
          })}?paired=1`,
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
  if (connection.type === "routed")
    throw new Error("Routed host connections are resolved by HostRuntime");
  const clientId = await deps.getClientId();
  const localTransportFactory = deps.createLocalTransportFactory();
  const base = {
    clientId,
    webSocketFactory: isNative ? nativeWebSocketFactory : defaultWebSocketFactory,
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
    return { ...base, ...directTcpClientConfig({ serverId, connection }) };
  }

  return buildTailnetClientConfig(connection, serverId, base, options);
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
        // Read before close(): closing resets nothing here, but it may record its own error.
        const message = describeConnectTimeout(client);
        const lastError = client.lastError ?? null;
        void client.close().catch(() => undefined);
        rejectOnce(
          new DaemonConnectionTestError(message, {
            reason: "Connection timed out",
            lastError,
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
  let serverId = options?.serverId;
  config.logger = deps.createLogger(() => serverId);
  const result = await connectAndProbe(
    config,
    resolveTimeout(connection, options),
    deps,
    options?.signal,
  );
  serverId = result.serverId;
  return result;
}
