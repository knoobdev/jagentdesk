export type {
  DaemonTransport,
  DaemonTransportFactory,
  TransportLogger,
  WebSocketFactory,
  WebSocketLike,
} from "./daemon-client-transport-types.js";
export {
  decodeMessageData,
  describeTransportClose,
  describeTransportError,
  encodeUtf8String,
  extractTransportMessage,
  normalizeTransportPayload,
  safeRandomId,
} from "./daemon-client-transport-utils.js";
export {
  bindWsHandler,
  createWebSocketTransportFactory,
  defaultWebSocketFactory,
  nativeWebSocketFactory,
} from "./daemon-client-websocket-transport.js";
export {
  createEncryptedTransport,
  createRelayE2eeTransportFactory,
  createRelayUpgradeTransportFactory,
  describeEndpointSecurityClose,
  type RelayE2eeTransportOptions,
} from "./daemon-client-relay-e2ee-transport.js";
export {
  CONNECTION_DIAGNOSTICS_CAPACITY,
  ConnectionDiagnosticsLog,
  connectionDiagnostics,
  formatConnectionDiagnosticEntry,
  type ConnectionDiagnosticEntry,
  type ConnectionDiagnosticValue,
} from "./connection-diagnostics.js";
