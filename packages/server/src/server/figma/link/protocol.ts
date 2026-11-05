/**
 * Wire protocol spoken between the daemon's Figma Link bridge and the
 * JAgentDesk Figma Link plugin (the vendored figma-mcp-forge plugin plus a
 * JAgentDesk pairing extension).
 *
 * Frames are JSON objects discriminated by `type`. The request/response half
 * matches figma-mcp-forge protocol version 1 so the vendored plugin speaks the
 * same language as upstream Forge; the hello/pairing half is ours.
 */

export const LINK_PROTOCOL_VERSION = 1;

/** The plugin build this daemon ships with; anything else connects `blocked`. */
export const PLUGIN_VERSION = "1.0.0";

/** Minimum interval between failed plugin installs (spec 32 §Bridge lifecycle). */
export const INSTALL_BACKOFF_MS = 5 * 60 * 1000;

/** A connection that never sends `hello` is dropped after this long. */
export const HELLO_TIMEOUT_MS = 15_000;

/** How long the daemon pings an established connection before declaring it dead. */
export const PONG_TIMEOUT_MS = 10_000;

/** Interval between application-level pings. */
export const PING_INTERVAL_MS = 30_000;

/** How long tool calls may run before the bridge gives up on the plugin. */
export const REQUEST_TIMEOUT_MS = 180_000;

/** Lifetime of an unpaired pairing code. */
export const PAIRING_CODE_TTL_MS = 120_000;

/** Default loopback port. QA runs bind an explicit `port: 0` instead. */
export const DEFAULT_LINK_PORT = 1995;

export const LINK_HOST = "127.0.0.1";

/** Secret-store key prefix for long-lived pairing keys. Non-secret records live in JSON. */
export const PAIRING_KEY_SECRET_PREFIX = "figma.link.key.";

export function pairingKeySecretName(pairingId: string): string {
  return `${PAIRING_KEY_SECRET_PREFIX}${pairingId}`;
}

/** Where non-secret pairing records persist (under JAGENTDESK_HOME). */
export const PAIRINGS_FILE = "figma/link-pairings.json";

/** Where link settings persist (under JAGENTDESK_HOME). */
export const SETTINGS_FILE = "figma/link-settings.json";

/** clientStorage key where the plugin keeps its pairing key. */
export const PLUGIN_PAIRING_KEY_STORAGE = "jadlink.pairingKey";

/** clientStorage key where the plugin keeps its stable pairing id. */
export const PLUGIN_PAIRING_ID_STORAGE = "jadlink.pairingId";

/** clientStorage key where the plugin keeps its instance id for reconnect replacement. */
export const PLUGIN_INSTANCE_ID_STORAGE = "jadlink.instanceId";

/** Manager sentinel used when a plugin connection is not paired. */
export const UNPAIRED_MANAGER = "Unpaired";

export type LinkFrame = { type: string } & Record<string, unknown>;

/** Client → daemon: identifies the plugin and its pairing state. */
export interface HelloFrame {
  type: "hello";
  name: string;
  version: string;
  protocol: number;
  fileKey: string;
  fileName: string;
  editorType?: string;
  permissions?: string[];
  pairingId?: string;
  pairingKey?: string;
  instanceId?: string;
}

/** Daemon → client: no key yet — show this code in the plugin UI. */
export interface PairingRequiredFrame {
  type: "pairing_required";
  code: string;
  expiresAt_ms: number;
}

/** Daemon → client: the code was correct; keep this key in clientStorage. */
export interface PairingGrantedFrame {
  type: "pairing_granted";
  pairingId: string;
  pairingKey: string;
}

/** Daemon → client: the presented key did not match the pairing record. */
export interface PairingRejectedFrame {
  type: "pairing_rejected";
}

/** Daemon → client: the connection is not usable (bad Origin / non-loopback). */
export interface LinkRejectedFrame {
  type: "link_rejected";
  reason: string;
}

/** Daemon → client: connected but the plugin version/protocol is unsupported. */
export interface LinkBlockedFrame {
  type: "link_blocked";
  reason: string;
  requiredVersion: string;
  protocol: number;
}

/** Client → daemon: the code the user typed into the plugin UI. */
export interface PairFrame {
  type: "pair";
  code: string;
}

/** Daemon → client: heartbeat. */
export interface PingFrame {
  type: "ping";
  sentAt: number;
}

/** Client → daemon: heartbeat reply. */
export interface PongFrame {
  type: "pong";
  sentAt?: number;
}

/** Daemon → client: a tool call to execute in the Figma sandbox. */
export interface BridgeRequestFrame {
  type: "request";
  requestId: string;
  /** Bridge-internal correlation for plugin push events (Forge wire-compat). */
  messageId?: string;
  toolName: string;
  nodeId?: string;
  nodeIds?: string[];
  params?: Record<string, unknown>;
}

/** Client → daemon: the result of a tool call. */
export interface BridgeResponseFrame {
  type: "response";
  requestId: string;
  messageId?: string;
  ok: boolean;
  message: string;
  data?: unknown;
  [key: string]: unknown;
}

/**
 * Client → daemon: current document state, pushed on documentchange /
 * currentpagechange / selectionchange. Shape must match
 * `FigmaLinkStatusSchema` in @hdc/jagentdesk-protocol — the daemon stores it
 * verbatim and republishes it on `figma.link.changed`.
 */
export interface PluginStatusFrame {
  type: "plugin_status";
  connected: true;
  fileName: string;
  fileKey: string;
  pageCount: number;
  currentPage: string;
  hasSelection: boolean;
  selectionCount: number;
  selectionTypes: string[];
  selectionNodes: Array<{
    id: string;
    name: string;
    type: string;
    visible?: boolean;
    locked?: boolean;
    opacity?: number;
    width?: number;
    height?: number;
    fontSize?: number;
    fontName?: string;
    characters?: string;
    cornerRadius?: number;
    layoutMode?: string;
    itemSpacing?: number;
    padding?: Record<string, number>;
    alignHorizontal?: string;
    alignVertical?: string;
  }>;
  lastUpdatedAt: number;
  /** Nodes a documentchange touched, when the push came from that event. */
  nodeIds?: string[];
}

export function isPluginStatusFrame(frame: LinkFrame): frame is LinkFrame & PluginStatusFrame {
  return frame.type === "plugin_status";
}
