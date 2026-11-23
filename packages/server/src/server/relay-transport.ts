/// <reference lib="dom" />
import { WebSocket } from "ws";
import type pino from "pino";
import { buildRelayWebSocketUrl } from "@jagentdesk/protocol/daemon-endpoints";
import type { ExternalSocketMetadata } from "./websocket-server.js";
import { createRelayOwnershipGuard } from "./relay-ownership.js";
import type { RelayOwnershipSigner } from "./daemon-keypair.js";

export interface RelayTransportOptions {
  logger: pino.Logger;
  attachSocket(ws: RelaySocketLike, metadata?: ExternalSocketMetadata): Promise<void>;
  relayEndpoint: string; // "host[:port]"
  relayUseTls: boolean;
  serverId: string;
  /** Proves `serverId` ownership to the Worker's Durable Object (spec 35.2). */
  relayOwnership: RelayOwnershipSigner;
  createWebSocket?: RelayWebSocketFactory;
}

export interface RelayTransportController {
  stop: () => Promise<void>;
}

export interface RelaySocketLike {
  readyState: number;
  bufferedAmount?: number;
  send: (data: string | Uint8Array | ArrayBuffer, callback?: (error?: Error) => void) => void;
  close: (code?: number, reason?: string) => void;
  terminate: () => void;
  on: (event: "message" | "close" | "error", listener: (...args: unknown[]) => void) => void;
  once: (event: "close" | "error", listener: (...args: unknown[]) => void) => void;
}

interface RelayWebSocketLike extends RelaySocketLike {
  ping: () => void;
  on: (
    event: "open" | "message" | "close" | "error" | "pong",
    listener: (...args: unknown[]) => void,
  ) => void;
}

type RelayWebSocketFactory = (url: string) => RelayWebSocketLike;

type ControlMessage =
  | { type: "sync"; connectionIds: string[] }
  | { type: "connected"; connectionId: string }
  | { type: "disconnected"; connectionId: string }
  | { type: "ping" }
  | { type: "pong" };

const CONTROL_PING_INTERVAL_MS = 30_000;
const CONTROL_STALE_TIMEOUT_MS = 60_000;
const CONTROL_READY_TIMEOUT_MS = 8_000;
const RELAY_WEBSOCKET_OPTIONS = {
  handshakeTimeout: 10_000,
  perMessageDeflate: false,
  // Node cancels each non-final address when this expires, even if the next
  // address is unreachable. Allow high-latency routes time to connect.
  autoSelectFamilyAttemptTimeout: 5_000,
} as const;

function createDefaultRelayWebSocket(url: string): RelayWebSocketLike {
  // Relay is a separate transport; HTTP(S)_PROXY applies to fetch and Hub sockets only.
  return new WebSocket(url, RELAY_WEBSOCKET_OPTIONS);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function tryParseControlMessage(raw: unknown): ControlMessage | null {
  try {
    let text: string;
    if (typeof raw === "string") {
      text = raw;
    } else if (Buffer.isBuffer(raw)) {
      text = raw.toString("utf8");
    } else {
      text = String(raw);
    }
    const parsed = JSON.parse(text);
    if (!isRecord(parsed)) return null;
    if (parsed.type === "ping") return { type: "ping" };
    if (parsed.type === "pong") return { type: "pong" };
    if (parsed.type === "sync" && Array.isArray(parsed.connectionIds)) {
      const connectionIds = parsed.connectionIds.filter(
        (id: unknown) => typeof id === "string" && id.trim().length > 0,
      );
      return { type: "sync", connectionIds };
    }
    if (
      parsed.type === "connected" &&
      typeof parsed.connectionId === "string" &&
      parsed.connectionId.trim()
    ) {
      return { type: "connected", connectionId: parsed.connectionId.trim() };
    }
    if (
      parsed.type === "disconnected" &&
      typeof parsed.connectionId === "string" &&
      parsed.connectionId.trim()
    ) {
      return { type: "disconnected", connectionId: parsed.connectionId.trim() };
    }
    return null;
  } catch {
    return null;
  }
}

export function startRelayTransport({
  logger,
  attachSocket,
  relayEndpoint,
  relayUseTls,
  serverId,
  relayOwnership,
  createWebSocket = createDefaultRelayWebSocket,
}: RelayTransportOptions): RelayTransportController {
  const relayLogger = logger.child({ module: "relay-transport" });

  let stopped = false;
  let controlWs: RelayWebSocketLike | null = null;
  let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  let reconnectAttempt = 0;
  const dataSockets = new Map<string, RelaySocketLike>(); // connectionId -> socket (post-guard)
  const rawDataSockets = new Map<string, RelayWebSocketLike>(); // connectionId -> transport socket
  let controlKeepaliveInterval: ReturnType<typeof setInterval> | null = null;
  let controlReadyTimeout: ReturnType<typeof setTimeout> | null = null;
  let controlLastSeenAt = 0;
  let controlConnectionSeq = 0;

  const stop = async (): Promise<void> => {
    stopped = true;
    if (reconnectTimeout) {
      clearTimeout(reconnectTimeout);
      reconnectTimeout = null;
    }
    if (controlKeepaliveInterval) {
      clearInterval(controlKeepaliveInterval);
      controlKeepaliveInterval = null;
    }
    if (controlReadyTimeout) {
      clearTimeout(controlReadyTimeout);
      controlReadyTimeout = null;
    }
    if (controlWs) {
      try {
        controlWs.close();
      } catch {
        // ignore
      }
      controlWs = null;
    }
    for (const ws of rawDataSockets.values()) {
      try {
        ws.close();
      } catch {
        // ignore
      }
    }
    dataSockets.clear();
    rawDataSockets.clear();
  };

  const connectControl = (): void => {
    if (stopped) return;

    const connectionId = ++controlConnectionSeq;
    const url = buildRelayWebSocketUrl({
      endpoint: relayEndpoint,
      useTls: relayUseTls,
      serverId,
      role: "server",
    });
    const socket = createWebSocket(url);
    // The control socket authenticates `serverId` to the Durable Object before
    // any routing frame is parsed; the guard consumes challenge/auth frames and
    // forwards everything else untouched.
    const guardedControl = createRelayOwnershipGuard(socket, relayOwnership, relayLogger, serverId);
    controlWs = socket;
    let controlConnected = false;
    let controlReadyAt = 0;

    const markControlReady = () => {
      if (controlWs !== socket) return;
      if (controlConnected) return;
      controlConnected = true;
      controlReadyAt = Date.now();
      if (controlReadyTimeout) {
        clearTimeout(controlReadyTimeout);
        controlReadyTimeout = null;
      }
      relayLogger.info({ connectionId }, "relay_control_connected");
    };

    socket.on("open", () => {
      if (controlWs !== socket) return;

      controlLastSeenAt = Date.now();
      if (controlKeepaliveInterval) {
        clearInterval(controlKeepaliveInterval);
        controlKeepaliveInterval = null;
      }
      if (controlReadyTimeout) {
        clearTimeout(controlReadyTimeout);
        controlReadyTimeout = null;
      }
      controlReadyTimeout = setTimeout(() => {
        if (stopped) return;
        if (controlWs !== socket) return;
        if (controlConnected) return;
        relayLogger.warn(
          { url, connectionId, waitedMs: CONTROL_READY_TIMEOUT_MS },
          "relay_control_ready_timeout_terminating",
        );
        try {
          socket.terminate();
        } catch {
          // ignore
        }
      }, CONTROL_READY_TIMEOUT_MS);
      controlKeepaliveInterval = setInterval(() => {
        if (stopped) return;
        if (controlWs !== socket) return;
        if (socket.readyState !== WebSocket.OPEN) return;

        const now = Date.now();
        const staleForMs = now - controlLastSeenAt;
        // If the control socket is half-open or silently dropped, ws may never emit "close".
        // Use a WebSocket protocol ping to detect staleness and force a reconnect.
        // Cloudflare's runtime auto-responds to protocol pings at the edge without waking the
        // hibernated relay Durable Object, so this keepalive does not incur DO CPU billing.
        if (staleForMs > CONTROL_STALE_TIMEOUT_MS) {
          relayLogger.warn(
            { url, staleForMs, connectionId, staleTimeoutMs: CONTROL_STALE_TIMEOUT_MS },
            "relay_control_stale_terminating",
          );
          try {
            socket.terminate();
          } catch {
            // ignore
          }
          return;
        }

        try {
          socket.ping();
        } catch (error) {
          relayLogger.warn({ err: error, connectionId }, "relay_control_ping_send_failed");
          try {
            socket.terminate();
          } catch {
            // ignore
          }
        }
      }, CONTROL_PING_INTERVAL_MS);
      try {
        socket.ping();
      } catch (error) {
        relayLogger.warn({ err: error, connectionId }, "relay_control_ping_send_failed");
        try {
          socket.terminate();
        } catch {
          // ignore
        }
      }
      relayLogger.debug({ connectionId }, "relay_control_open_waiting_for_ready");
    });

    socket.on("close", (code, reason) => {
      if (controlWs !== socket) return;
      relayLogger.warn(
        { code, reason: reason?.toString?.(), url, connectionId },
        "relay_control_disconnected",
      );
      controlWs = null;
      if (controlKeepaliveInterval) {
        clearInterval(controlKeepaliveInterval);
        controlKeepaliveInterval = null;
      }
      if (controlReadyTimeout) {
        clearTimeout(controlReadyTimeout);
        controlReadyTimeout = null;
      }
      if (controlConnected && Date.now() - controlReadyAt >= 30_000) reconnectAttempt = 0;
      scheduleReconnect();
    });

    socket.on("error", (err) => {
      if (controlWs !== socket) return;
      relayLogger.warn({ err, connectionId }, "relay_error");
      // close event will schedule reconnect
    });

    socket.on("pong", () => {
      if (controlWs !== socket) return;
      controlLastSeenAt = Date.now();
      relayLogger.debug({ connectionId }, "relay_control_pong_received");
    });

    guardedControl.on("message", (data) => {
      if (controlWs !== socket) return;
      controlLastSeenAt = Date.now();
      const msg = tryParseControlMessage(data);
      if (msg) {
        markControlReady();
      }
      if (!msg) return;
      if (msg.type === "ping") {
        try {
          socket.send(JSON.stringify({ type: "pong", ts: Date.now() }));
        } catch {
          // ignore
        }
        return;
      }
      if (msg.type === "pong") return;
      if (msg.type === "sync") {
        for (const clientConnectionId of msg.connectionIds) {
          ensureClientDataSocket(clientConnectionId);
        }
        return;
      }
      if (msg.type === "connected") {
        ensureClientDataSocket(msg.connectionId);
        return;
      }
      if (msg.type === "disconnected") {
        const existing = dataSockets.get(msg.connectionId);
        if (existing) {
          try {
            existing.close(1001, "Client disconnected");
          } catch {
            // ignore
          }
          dataSockets.delete(msg.connectionId);
          rawDataSockets.delete(msg.connectionId);
        }
      }
    });
  };

  const scheduleReconnect = (): void => {
    if (stopped) return;
    if (reconnectTimeout) return;

    reconnectAttempt += 1;
    const delayMs =
      Math.min(30_000, 1_500 * 2 ** Math.min(reconnectAttempt - 1, 5)) *
      (0.8 + Math.random() * 0.4);
    reconnectTimeout = setTimeout(() => {
      reconnectTimeout = null;
      connectControl();
    }, delayMs);
  };

  const ensureClientDataSocket = (connectionId: string): void => {
    if (stopped) return;
    if (!connectionId) return;
    if (rawDataSockets.has(connectionId)) return;

    const url = buildRelayWebSocketUrl({
      endpoint: relayEndpoint,
      useTls: relayUseTls,
      serverId,
      role: "server",
      connectionId,
    });
    const socket = createWebSocket(url);
    rawDataSockets.set(connectionId, socket);

    let attached = false;
    const openTimeout = setTimeout(() => {
      if (stopped) return;
      if (socket.readyState === WebSocket.OPEN) return;
      relayLogger.warn({ connectionId }, "relay_data_open_timeout_terminating");
      try {
        socket.terminate();
      } catch {
        // ignore
      }
    }, 15_000);

    socket.on("open", () => {
      clearTimeout(openTimeout);
      relayLogger.info({ connectionId }, "relay_data_connected");
      if (attached) return;
      attached = true;
      const externalMetadata: ExternalSocketMetadata = {
        transport: "relay",
        externalSessionKey: `session:${connectionId}`,
        relayConnectionId: connectionId,
      };
      // The data socket proves `serverId` first; only post-auth frames reach the
      // Noise handshake in `attachSocket`.
      const guarded = createRelayOwnershipGuard(socket, relayOwnership, relayLogger, serverId);
      dataSockets.set(connectionId, guarded);
      void attachSocket(guarded, externalMetadata).catch((error: unknown) => {
        relayLogger.warn({ err: error, connectionId }, "relay_data_admission_failed");
        guarded.close(1011, "Relay admission failed");
      });
    });

    socket.on("close", (code, reason) => {
      clearTimeout(openTimeout);
      relayLogger.warn(
        { code, reason: reason?.toString?.(), url, connectionId },
        "relay_data_disconnected",
      );
      if (rawDataSockets.get(connectionId) === socket) {
        rawDataSockets.delete(connectionId);
        dataSockets.delete(connectionId);
      }
    });

    socket.on("error", (err) => {
      relayLogger.warn({ err, connectionId }, "relay_data_error");
    });
  };

  connectControl();

  return { stop };
}
