import { maxSecuredPlaintextByteLength } from "@jagentdesk/relay";
import { MAX_RELAY_WEBSOCKET_MESSAGE_BYTES } from "@jagentdesk/protocol/websocket-message-limit";
import {
  openClientSecureChannel,
  PROTECTED_HANDSHAKE_FAILED_CLOSE_CODE,
  type ClientHandshakeEvent,
  type SecureChannel,
  type SecurityMode,
  type Transport as RelayTransport,
} from "@jagentdesk/relay/e2ee";
import type {
  DaemonTransport,
  DaemonTransportFactory,
  TransportLogger,
} from "./daemon-client-transport-types.js";
import {
  extractTransportMessage,
  normalizeTransportPayload,
} from "./daemon-client-transport-utils.js";

type OpenHandler = () => void;
type CloseHandler = (event?: unknown) => void;
type ErrorHandler = (event?: unknown) => void;
type MessageHandler = (data: unknown, isBinary: boolean) => void;

export interface RelayE2eeTransportOptions {
  daemonPublicKeyB64: string;
  logger: TransportLogger;
  /** Refuse to open unless the daemon negotiates at least this endpoint security mode. */
  minimumMode?: SecurityMode;
  assertOutboundCapacity?: (wireBytes: number) => void;
  /** Reports the negotiated mode once the daemon has authenticated the handshake. */
  onSecurityMode?: (mode: SecurityMode) => void;
  /**
   * Socket and handshake events for the connection diagnostics log: names,
   * sizes, codes and reasons only, never payloads or keys.
   */
  onDiagnostic?: (event: string, fields?: Record<string, unknown>) => void;
}

/** Frames recorded per connection before the channel opens; enough to see the handshake. */
const MAX_PRE_OPEN_FRAME_DIAGNOSTICS = 12;

export function createRelayE2eeTransportFactory(
  args: RelayE2eeTransportOptions & { baseFactory: DaemonTransportFactory },
): DaemonTransportFactory {
  const { baseFactory, ...options } = args;
  return ({ url }) => createEncryptedTransport(baseFactory({ url }), options);
}

const DAEMON_REQUIRES_PROTECTED_REASON = "daemon requires protected endpoint security";

/**
 * Returns a user-facing message when this client closed the session itself
 * because endpoint security could not be established, so reconnecting cannot help.
 *
 * The daemon's own policy close never reaches the client: both relays replace a
 * daemon-side close with their own code (1012 on the wrangler relay).
 */
export function describeEndpointSecurityClose(event: unknown): string | null {
  if (!event || typeof event !== "object") return null;
  const code = "code" in event ? event.code : undefined;
  const reason = "reason" in event && typeof event.reason === "string" ? event.reason : "";
  if (code === PROTECTED_HANDSHAKE_FAILED_CLOSE_CODE) {
    return `Endpoint security handshake failed: ${reason || "protected mode unavailable"}`;
  }
  return null;
}

/**
 * The first session message from the daemon is `server_info`. A daemon that can
 * negotiate protected security advertises it there, so a legacy session with such
 * a daemon was downgraded in transit and must not proceed to admission.
 */
function readServerInfoProtectedSupport(text: string): boolean | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed.type !== "session" || !isRecord(parsed.message)) return null;
  const message = parsed.message;
  if (message.type !== "status" || !isRecord(message.payload)) return null;
  if (message.payload.status !== "server_info") return null;
  const features = message.payload.features;
  return isRecord(features) && features.relayProtectedSecurity === true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Relay upgrades carry routing only. Daemon credentials and subprotocols must
 * never reach the relay; they travel inside the encrypted hello.
 */
export function createRelayUpgradeTransportFactory(
  baseFactory: DaemonTransportFactory,
): DaemonTransportFactory {
  return ({ url }) => baseFactory({ url });
}

function messageTooLargeError(size: number, limit: number): Error {
  const toMiB = (bytes: number) => (bytes / (1024 * 1024)).toFixed(1);
  return new Error(
    `Message is too large to send (${toMiB(size)} MiB). The limit is ${toMiB(limit)} MiB, so send fewer or smaller attachments.`,
  );
}

export function createEncryptedTransport(
  base: DaemonTransport,
  options: RelayE2eeTransportOptions,
): DaemonTransport {
  const { daemonPublicKeyB64, logger, minimumMode, onSecurityMode } = options;
  let channel: SecureChannel | null = null;
  let opened = false;
  let closed = false;
  let awaitingServerInfo = true;
  let preOpenFrames = 0;
  const diagnostic = (event: string, fields?: Record<string, unknown>) => {
    try {
      options.onDiagnostic?.(event, fields);
    } catch {
      // Diagnostics never break the connection.
    }
  };

  const openHandlers = new Set<OpenHandler>();
  const closeHandlers = new Set<CloseHandler>();
  const errorHandlers = new Set<ErrorHandler>();
  const messageHandlers = new Set<MessageHandler>();

  const emitOpen = () => {
    if (opened || closed) {
      return;
    }
    opened = true;
    emitHandlers(openHandlers);
  };

  const emitClose = (event?: unknown) => {
    if (closed) {
      return;
    }
    closed = true;
    emitHandlers(closeHandlers, event);
  };

  const emitError = (event?: unknown) => {
    if (closed) {
      return;
    }
    emitHandlers(errorHandlers, event);
  };

  const emitMessage = (data: unknown) => {
    if (closed) {
      return;
    }
    if (awaitingServerInfo && typeof data === "string") {
      const daemonSupportsProtected = readServerInfoProtectedSupport(data);
      if (daemonSupportsProtected !== null) {
        awaitingServerInfo = false;
        if (daemonSupportsProtected && channel?.securityMode() === "legacy") {
          diagnostic("e2ee_downgrade_rejected");
          logger.warn(
            { reason: DAEMON_REQUIRES_PROTECTED_REASON },
            "relay_e2ee_downgrade_rejected",
          );
          channel.close(PROTECTED_HANDSHAKE_FAILED_CLOSE_CODE, DAEMON_REQUIRES_PROTECTED_REASON);
          return;
        }
      }
    }
    emitHandlers(messageHandlers, data, data instanceof ArrayBuffer);
  };

  const relayTransport: RelayTransport = {
    send: (data) => {
      if (typeof data === "string") {
        return base.send(data);
      }
      if (ArrayBuffer.isView(data)) {
        return base.send(normalizeTransportPayload(data));
      }
      if (data instanceof ArrayBuffer) {
        return base.send(data);
      }
      return base.send(String(data));
    },
    // The channel decides the close code. Report it now: a socket close event
    // arrives asynchronously, and the consumer must not act on an earlier
    // error before it has seen the code.
    close: (code?: number, reason?: string) => {
      base.close(code, reason);
      emitClose({ code, reason });
    },
    onmessage: null,
    onclose: null,
    onerror: null,
  };

  const startHandshake = async () => {
    try {
      channel = await openClientSecureChannel(relayTransport, {
        daemonPublicKeyB64,
        ...(minimumMode ? { minimumMode } : {}),
        onHandshakeEvent: (event) => diagnostic(...describeHandshakeEvent(event)),
        events: {
          onopen: () => {
            onSecurityMode?.(channel?.securityMode() ?? "legacy");
            emitOpen();
          },
          onmessage: (data) => emitMessage(data),
          onclose: (code, reason) => emitClose({ code, reason }),
          // Every fatal channel error is followed by a close that carries the
          // code and reason; forwarding the error first would make the consumer
          // reconnect before it sees them.
          onerror: (error) => {
            diagnostic("e2ee_channel_error", { message: error.message });
            logger.warn({ err: normalizeTransportError(error) }, "relay_e2ee_channel_error");
          },
        },
      });
    } catch (error) {
      diagnostic("e2ee_handshake_start_failed", {
        message: error instanceof Error ? error.message : String(error),
      });
      logger.warn({ err: normalizeTransportError(error) }, "relay_e2ee_handshake_failed");
      emitError(error);
      // Browser WebSocket.close only accepts 1000 or 3000-4999.
      // Use an app-defined code so this path works in browser and Node runtimes.
      base.close(4001, "E2EE handshake failed");
    }
  };

  base.onOpen(() => {
    diagnostic("ws_open");
    void startHandshake();
  });
  base.onMessage((data, isBinary) => {
    const message = extractTransportMessage(data, isBinary);
    if (!opened && preOpenFrames < MAX_PRE_OPEN_FRAME_DIAGNOSTICS) {
      preOpenFrames += 1;
      diagnostic("ws_frame_before_open", {
        kind: message.isBinary ? "binary" : "text",
        shape: describeFrameShape(data),
        bytes: frameBytes(message.data),
      });
    }
    relayTransport.onmessage?.(message);
  });
  base.onClose((event) => {
    const record = event as { code?: number; reason?: string } | undefined;
    diagnostic("ws_close", {
      code: record?.code ?? null,
      reason: record?.reason ?? "",
      channelOpened: opened,
    });
    relayTransport.onclose?.(record?.code ?? 0, record?.reason ?? "");
    emitClose(event);
  });
  base.onError((event) => {
    diagnostic("ws_error", { message: describeErrorEvent(event), channelOpened: opened });
    relayTransport.onerror?.(event instanceof Error ? event : new Error(String(event)));
    emitError(event);
  });

  return {
    supportsDrain: base.supportsDrain,
    maxFrameBytes: maxSecuredPlaintextByteLength(MAX_RELAY_WEBSOCKET_MESSAGE_BYTES),
    send: (data) => {
      if (!channel) {
        throw new Error("Encrypted channel not ready");
      }
      const payload = normalizeTransportPayload(data);
      // Reject synchronously so the requesting operation fails without closing the transport.
      const wireBytes = channel.outboundWireByteLength(payload);
      if (wireBytes > MAX_RELAY_WEBSOCKET_MESSAGE_BYTES) {
        throw messageTooLargeError(wireBytes, MAX_RELAY_WEBSOCKET_MESSAGE_BYTES);
      }
      options.assertOutboundCapacity?.(wireBytes);
      return channel.send(payload).catch((error: unknown) => {
        emitError(error);
        throw error;
      });
    },
    close: (code?: number, reason?: string) => {
      if (channel) {
        channel.close(code, reason);
      } else {
        base.close(code, reason);
      }
      emitClose({ code, reason });
    },
    onMessage: (handler) => {
      messageHandlers.add(handler);
      return () => messageHandlers.delete(handler);
    },
    onOpen: (handler) => {
      openHandlers.add(handler);
      if (opened) {
        invokeHandler(handler);
      }
      return () => openHandlers.delete(handler);
    },
    onClose: (handler) => {
      closeHandlers.add(handler);
      if (closed) {
        invokeHandler(handler);
      }
      return () => closeHandlers.delete(handler);
    },
    onError: (handler) => {
      errorHandlers.add(handler);
      return () => errorHandlers.delete(handler);
    },
  };
}

function describeHandshakeEvent(event: ClientHandshakeEvent): [string, Record<string, unknown>] {
  switch (event.type) {
    case "hello_sent":
      return ["e2ee_hello_sent", { attempt: event.attempt }];
    case "opened":
      return ["e2ee_open", { mode: event.mode, helloAttempts: event.helloAttempts }];
    case "duplicate_ready":
      return ["e2ee_duplicate_ready", {}];
    case "frame_ignored":
      return ["e2ee_frame_ignored", { reason: event.reason, bytes: event.bytes }];
    case "failed":
      return ["e2ee_handshake_failed", { reason: event.reason }];
  }
}

function describeFrameShape(data: unknown): string {
  if (typeof data === "string") return "string";
  if (data instanceof ArrayBuffer) return "ArrayBuffer";
  if (ArrayBuffer.isView(data)) return data.constructor?.name ?? "ArrayBufferView";
  if (data === null || data === undefined) return String(data);
  return (data as { constructor?: { name?: string } }).constructor?.name ?? typeof data;
}

function frameBytes(data: string | ArrayBuffer): number {
  return typeof data === "string" ? data.length : data.byteLength;
}

function describeErrorEvent(event: unknown): string {
  if (event instanceof Error) return event.message;
  if (event && typeof event === "object" && "message" in event) {
    const message = (event as { message?: unknown }).message;
    if (typeof message === "string" && message.length > 0) return message;
  }
  return "no detail";
}

function emitHandlers<TArgs extends unknown[]>(
  handlers: Set<(...args: TArgs) => void>,
  ...args: TArgs
) {
  for (const handler of handlers) {
    invokeHandler(handler, ...args);
  }
}

function invokeHandler<TArgs extends unknown[]>(handler: (...args: TArgs) => void, ...args: TArgs) {
  try {
    handler(...args);
  } catch {
    // no-op
  }
}

function normalizeTransportError(error: unknown): Record<string, string> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      ...(typeof error.stack === "string" ? { stack: error.stack } : {}),
    };
  }
  return { message: String(error) };
}
