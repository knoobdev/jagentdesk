import type pino from "pino";
import type { ProviderAvailability } from "../../agent/agent-manager.js";
import type { SessionInboundMessage, SessionOutboundMessage } from "../../messages.js";
import { getPidLockInfo } from "../../pid-lock.js";
import { generateLocalPairingOffer } from "../../pairing-offer.js";
import {
  collectDaemonDiagnostics,
  type DaemonWebSocketRuntimeDiagnosticSnapshot,
} from "./diagnostics.js";
import { DaemonSelfUpdateSessionController } from "./daemon-self-update-session-controller.js";
import type { ManagedAgent } from "../../agent/agent-manager.js";
import type { PersistedProjectRecord, PersistedWorkspaceRecord } from "../../workspace-registry.js";
import type { HubRelationshipManagement } from "../../hub/relationship-controller.js";
import type { PairedDeviceStore } from "../../pairing/paired-devices.js";
import type { PairingCodeManager } from "../../pairing/pairing-code.js";

export interface DaemonRuntimeConfig {
  listen: string | null;
  worktreesRoot?: string;
  appBaseUrl?: string;
  desktopManaged?: boolean;
  getTailnetAddress(): { host: string; port: number; useTls?: boolean } | null;
}

export interface DaemonSessionHost {
  emit(msg: SessionOutboundMessage): void;
  emitLifecycleIntent(intent: {
    type: "restart";
    clientId: string;
    requestId: string;
    reason: string;
  }): void;
}

export interface DaemonSessionOptions {
  host: DaemonSessionHost;
  clientId: string;
  jagentdeskHome: string;
  serverId: string | undefined;
  daemonVersion: string | undefined;
  daemonRuntimeConfig: DaemonRuntimeConfig | undefined;
  listAgents: () => ManagedAgent[];
  listProjects: () => Promise<PersistedProjectRecord[]>;
  listWorkspaces: () => Promise<PersistedWorkspaceRecord[]>;
  listProviderAvailability: () => Promise<ProviderAvailability[]>;
  getWebSocketRuntimeMetrics?: () => DaemonWebSocketRuntimeDiagnosticSnapshot | null;
  logger: pino.Logger;
  hubRelationships?: HubRelationshipManagement;
  /** Paired-device store for the `pairing.device.*` RPC surface. */
  pairedDevices?: PairedDeviceStore;
  /** The daemon's own public key, used to verify pairing registrations. */
  daemonPublicKeyB64?: string;
  pairingCodeManager?: PairingCodeManager;
  /** Declines a pending unauthenticated tailnet pairing request. */
  cancelPendingPairingRequest?: (input: {
    requestId: string;
    reason: string;
  }) => Promise<{ ok: boolean; error?: string }> | { ok: boolean; error?: string };
}

/**
 * A client's read surface for the daemon process itself: its runtime status
 * (pid-lock start time, listen address, tailnet config, provider availability) and
 * a fresh local pairing offer for connecting a new client. Owns the `daemon.*`
 * RPCs. Reaches no state beyond the never-mutated runtime values injected at
 * construction and the outbound channel.
 */
export class DaemonSession {
  private readonly host: DaemonSessionHost;
  private readonly clientId: string;
  private readonly jagentdeskHome: string;
  private readonly serverId: string | undefined;
  private readonly daemonVersion: string | undefined;
  private readonly daemonRuntimeConfig: DaemonRuntimeConfig | undefined;
  private readonly listAgents: () => ManagedAgent[];
  private readonly listProjects: () => Promise<PersistedProjectRecord[]>;
  private readonly listWorkspaces: () => Promise<PersistedWorkspaceRecord[]>;
  private readonly listProviderAvailability: () => Promise<ProviderAvailability[]>;
  private readonly getWebSocketRuntimeMetrics: () => DaemonWebSocketRuntimeDiagnosticSnapshot | null;
  private readonly logger: pino.Logger;
  private readonly selfUpdate: DaemonSelfUpdateSessionController;
  private readonly hubRelationships: HubRelationshipManagement | null;
  private readonly pairedDevices: PairedDeviceStore | null;
  private readonly daemonPublicKeyB64: string | null;
  private readonly pairingCodeManager: PairingCodeManager | null;
  private readonly cancelPendingPairingRequest:
    | ((input: {
        requestId: string;
        reason: string;
      }) => Promise<{ ok: boolean; error?: string }> | { ok: boolean; error?: string })
    | null;

  constructor(options: DaemonSessionOptions) {
    this.host = options.host;
    this.clientId = options.clientId;
    this.jagentdeskHome = options.jagentdeskHome;
    this.serverId = options.serverId;
    this.daemonVersion = options.daemonVersion;
    this.daemonRuntimeConfig = options.daemonRuntimeConfig;
    this.listAgents = options.listAgents;
    this.listProjects = options.listProjects;
    this.listWorkspaces = options.listWorkspaces;
    this.listProviderAvailability = options.listProviderAvailability;
    this.getWebSocketRuntimeMetrics = options.getWebSocketRuntimeMetrics ?? (() => null);
    this.logger = options.logger;
    this.hubRelationships = options.hubRelationships ?? null;
    this.pairedDevices = options.pairedDevices ?? null;
    this.daemonPublicKeyB64 = options.daemonPublicKeyB64 ?? null;
    this.pairingCodeManager = options.pairingCodeManager ?? null;
    this.cancelPendingPairingRequest = options.cancelPendingPairingRequest ?? null;
    this.selfUpdate = new DaemonSelfUpdateSessionController({
      clientId: this.clientId,
      daemonVersion: this.daemonVersion ?? null,
      desktopManaged: this.daemonRuntimeConfig?.desktopManaged === true,
      emit: (msg) => this.host.emit(msg),
      emitLifecycleIntent: (intent) => this.host.emitLifecycleIntent(intent),
      sessionLogger: this.logger,
    });
  }

  async handleHubRelationshipRequest(
    msg: Extract<
      SessionInboundMessage,
      {
        type:
          | "hub.management.daemon.connect.request"
          | "hub.management.daemon.get_status.request"
          | "hub.management.daemon.disconnect.request";
      }
    >,
  ): Promise<void> {
    try {
      if (!this.hubRelationships) throw new Error("Hub relationship management is unavailable");
      if (msg.type === "hub.management.daemon.connect.request") {
        const status = await this.hubRelationships.connect({
          hubUrl: msg.hubUrl,
          token: msg.token,
        });
        this.host.emit({
          type: "hub.management.daemon.connect.response",
          payload: { requestId: msg.requestId, status },
        });
        return;
      }
      if (msg.type === "hub.management.daemon.disconnect.request") {
        const result = await this.hubRelationships.disconnect({ force: msg.force ?? false });
        this.host.emit({
          type: "hub.management.daemon.disconnect.response",
          payload: { requestId: msg.requestId, ...result },
        });
        return;
      }
      this.host.emit({
        type: "hub.management.daemon.get_status.response",
        payload: { requestId: msg.requestId, status: this.hubRelationships.status() },
      });
    } catch (error) {
      this.logger.error({ err: error }, "Failed to handle Hub relationship request");
      this.host.emit({
        type: "rpc_error",
        payload: {
          requestId: msg.requestId,
          requestType: msg.type,
          error: error instanceof Error ? error.message : String(error),
          code: "handler_error",
        },
      });
    }
  }

  async handleGetStatusRequest(
    msg: Extract<SessionInboundMessage, { type: "daemon.get_status.request" }>,
  ): Promise<void> {
    try {
      const pidInfo = await getPidLockInfo(this.jagentdeskHome);
      const providers = (await this.listProviderAvailability()).map((p) => ({
        provider: p.provider,
        available: p.available,
        error: p.error ?? null,
      }));
      this.host.emit({
        type: "daemon.get_status.response",
        payload: {
          requestId: msg.requestId,
          serverId: this.serverId ?? "",
          version: this.daemonVersion ?? null,
          pid: process.pid,
          nodePath: process.execPath,
          startedAt: pidInfo?.startedAt ?? null,
          listen: this.daemonRuntimeConfig?.listen ?? null,
          tailnet: this.daemonRuntimeConfig?.getTailnetAddress() ?? null,
          providers,
        },
      });
    } catch (error) {
      this.logger.error({ err: error }, "Failed to handle daemon status request");
      this.host.emit({
        type: "daemon.get_status.response",
        payload: {
          requestId: msg.requestId,
          serverId: this.serverId ?? "",
          version: this.daemonVersion ?? null,
          pid: process.pid,
          nodePath: process.execPath,
          startedAt: null,
          listen: null,
          tailnet: null,
          providers: [],
        },
      });
    }
  }

  async handleGetPairingOfferRequest(
    msg: Extract<SessionInboundMessage, { type: "daemon.get_pairing_offer.request" }>,
  ): Promise<void> {
    try {
      const tailnetAddress = this.daemonRuntimeConfig?.getTailnetAddress() ?? null;
      const pairing = await generateLocalPairingOffer({
        jagentdeskHome: this.jagentdeskHome,
        tailnetAddress: tailnetAddress ? `${tailnetAddress.host}:${tailnetAddress.port}` : null,
        useTls: tailnetAddress?.useTls,
        appBaseUrl: this.daemonRuntimeConfig?.appBaseUrl,
        includeQr: true,
        logger: this.logger,
        pairingCodeManager: this.pairingCodeManager ?? undefined,
        forceNewPairingCode: msg.forceRefresh === true,
      });
      this.host.emit({
        type: "daemon.get_pairing_offer.response",
        payload: {
          requestId: msg.requestId,
          url: pairing.url ?? "",
          qr: pairing.qr ?? null,
          tailnetEnabled: pairing.tailnetEnabled,
          ...(pairing.pairingCode ? { pairingCode: pairing.pairingCode } : {}),
          ...(pairing.pairingCodeExpiresAtMs
            ? { pairingCodeExpiresAtMs: pairing.pairingCodeExpiresAtMs }
            : {}),
        },
      });
    } catch (error) {
      this.logger.error({ err: error }, "Failed to handle daemon pairing offer request");
      this.host.emit({
        type: "rpc_error",
        payload: {
          requestId: msg.requestId,
          requestType: "daemon.get_pairing_offer.request",
          error: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  async handleDiagnosticsRequest(
    msg: Extract<SessionInboundMessage, { type: "diagnostics.request" }>,
  ): Promise<void> {
    try {
      const diagnostic = await collectDaemonDiagnostics({
        jagentdeskHome: this.jagentdeskHome,
        serverId: this.serverId,
        daemonVersion: this.daemonVersion,
        daemonRuntimeConfig: this.daemonRuntimeConfig,
        listAgents: this.listAgents,
        listProjects: this.listProjects,
        listWorkspaces: this.listWorkspaces,
        listProviderAvailability: this.listProviderAvailability,
        getWebSocketRuntimeMetrics: this.getWebSocketRuntimeMetrics,
        logger: this.logger,
      });
      this.host.emit({
        type: "diagnostics.response",
        payload: {
          requestId: msg.requestId,
          diagnostic,
        },
      });
    } catch (error) {
      this.logger.error({ err: error }, "Failed to handle diagnostics request");
      this.host.emit({
        type: "diagnostics.response",
        payload: {
          requestId: msg.requestId,
          diagnostic: `JAgentDesk diagnostics\n  Error: ${
            error instanceof Error ? error.message : String(error)
          }`,
        },
      });
    }
  }

  async handleUpdateRequest(
    msg: Extract<SessionInboundMessage, { type: "daemon.update.request" }>,
  ): Promise<void> {
    await this.selfUpdate.dispatch(msg);
  }

  async handlePairingRegisterRequest(
    msg: Extract<SessionInboundMessage, { type: "pairing.device.register.request" }>,
  ): Promise<void> {
    if (!this.pairedDevices || !this.daemonPublicKeyB64) {
      this.host.emit({
        type: "pairing.device.register.response",
        payload: {
          requestId: msg.requestId,
          ok: false,
          error: "Pairing is not configured on the daemon",
        },
      });
      return;
    }
    if (msg.daemonPublicKeyB64 !== this.daemonPublicKeyB64) {
      this.host.emit({
        type: "pairing.device.register.response",
        payload: {
          requestId: msg.requestId,
          ok: false,
          error: "daemon public key mismatch",
        },
      });
      return;
    }
    if (
      this.pairingCodeManager &&
      (!msg.pairingCode || !this.pairingCodeManager.verify(msg.pairingCode))
    ) {
      this.host.emit({
        type: "pairing.device.register.response",
        payload: {
          requestId: msg.requestId,
          ok: false,
          error: "Invalid or expired 6-digit pairing code",
        },
      });
      return;
    }
    try {
      const device = this.pairedDevices.register({
        devicePublicKeyB64: msg.devicePublicKeyB64,
        deviceName: msg.deviceName,
      });
      this.logger.info(
        { clientId: this.clientId, deviceId: device.deviceId, requestId: msg.requestId },
        "Registered paired device",
      );
      this.host.emit({
        type: "pairing.device.register.response",
        payload: { requestId: msg.requestId, ok: true, deviceId: device.deviceId },
      });
    } catch (error) {
      this.logger.warn(
        { err: error, requestId: msg.requestId },
        "Failed to register paired device",
      );
      this.host.emit({
        type: "pairing.device.register.response",
        payload: {
          requestId: msg.requestId,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  async handlePairingRevokeRequest(
    msg: Extract<SessionInboundMessage, { type: "pairing.device.revoke.request" }>,
  ): Promise<void> {
    if (!this.pairedDevices) {
      this.host.emit({
        type: "pairing.device.revoke.response",
        payload: {
          requestId: msg.requestId,
          ok: false,
          error: "Pairing is not configured on the daemon",
        },
      });
      return;
    }
    const revoked = this.pairedDevices.revokeById(msg.deviceId);
    this.logger.info(
      { clientId: this.clientId, deviceId: msg.deviceId, revoked, requestId: msg.requestId },
      "Revoked paired device",
    );
    this.host.emit({
      type: "pairing.device.revoke.response",
      payload: {
        requestId: msg.requestId,
        ok: revoked,
        ...(revoked ? {} : { error: "device not found" }),
      },
    });
  }

  async handlePairingCancelRequest(
    msg: Extract<SessionInboundMessage, { type: "pairing.device.cancel.request" }>,
  ): Promise<void> {
    const reason = msg.reason ?? "Pairing request declined by desktop";
    const result = this.cancelPendingPairingRequest
      ? await this.cancelPendingPairingRequest({ requestId: msg.targetRequestId, reason })
      : { ok: false, error: "Pending pairing cancellation is unavailable" };
    this.host.emit({
      type: "pairing.device.cancel.response",
      payload: {
        requestId: msg.requestId,
        targetRequestId: msg.targetRequestId,
        ok: result.ok,
        ...(result.error ? { error: result.error } : {}),
      },
    });
  }

  async handlePairingListRequest(
    msg: Extract<SessionInboundMessage, { type: "pairing.device.list.request" }>,
  ): Promise<void> {
    if (!this.pairedDevices) {
      this.host.emit({
        type: "pairing.device.list.response",
        payload: { requestId: msg.requestId, devices: [] },
      });
      return;
    }
    this.host.emit({
      type: "pairing.device.list.response",
      payload: {
        requestId: msg.requestId,
        devices: this.pairedDevices.list(),
      },
    });
  }
}
