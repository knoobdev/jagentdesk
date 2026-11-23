/**
 * Cloudflare Durable Objects adapter for the relay (spec 35.2).
 *
 * This module provides a Durable Object class that can be deployed to
 * Cloudflare Workers. It uses WebSocket hibernation for cost efficiency.
 *
 * Each session gets its own Durable Object instance, identified by serverId.
 *
 * Wrangler config:
 * ```jsonc
 * {
 *   "durable_objects": {
 *     "bindings": [{ "name": "RELAY", "class_name": "RelayDurableObject" }]
 *   },
 *   "migrations": [{ "tag": "v1", "new_sqlite_classes": ["RelayDurableObject"] }]
 * }
 * ```
 */

import type { ConnectionRole, RelaySessionAttachment } from "./types.js";
import {
  base64UrlToBytes,
  bytesToBase64Url,
  encodeRelayChallenge,
  parseRelayAuth,
  relayChallengeMessage,
  RELAY_CHALLENGE_NONCE_BYTES,
  RELAY_ED25519_PUBLIC_KEY_BYTES,
} from "./ownership.js";
import {
  MAX_RELAY_WEBSOCKET_MESSAGE_BYTES,
  MAX_RELAY_CLIENTS_PER_SERVER,
  MAX_RELAY_CONNECTS_PER_IP_PER_MINUTE,
  MAX_RELAY_BUFFERED_FRAMES_PER_CONNECTION,
  MAX_RELAY_BUFFERED_BYTES_PER_CONNECTION,
  RELAY_OWNERSHIP_CHALLENGE_TIMEOUT_MS,
  RELAY_IDLE_SOCKET_TIMEOUT_MS,
  RELAY_CLOSE_FRAME_TOO_LARGE,
  RELAY_CLOSE_CHALLENGE_TIMEOUT,
  RELAY_CLOSE_OWNERSHIP_MISMATCH,
  RELAY_CLOSE_TOO_MANY_CLIENTS,
  RELAY_CLOSE_BUFFER_OVERFLOW,
} from "./limits.js";

const CURRENT_RELAY_VERSION = "2" as const;

const OWNERSHIP_STORAGE_KEY = "relay:serverPublicKey";
const ALARM_SCAN_INTERVAL_MS = 5_000;

interface WebSocketPair {
  0: WebSocket;
  1: WebSocket;
}

interface DurableObjectStorage {
  get<T = unknown>(key: string, opts?: { cacheTtl?: number }): Promise<T | undefined | null>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
  setAlarm(scheduledTime: number | Date): Promise<void>;
  deleteAlarm(): Promise<void>;
}

interface DurableObjectState {
  storage: DurableObjectStorage;
  acceptWebSocket(ws: WebSocket, tags?: string[]): void;
  getWebSockets(tag?: string): WebSocket[];
}

interface WebSocketWithAttachment extends WebSocket {
  serializeAttachment(value: unknown): void;
  deserializeAttachment(): unknown;
}

function hasAttachmentMethods(ws: WebSocket): ws is WebSocketWithAttachment {
  // Type-safe check for attachment methods - required for Cloudflare WebSocket hibernation API
  // Use Reflect to check for methods without type assertions
  return (
    "serializeAttachment" in ws &&
    "deserializeAttachment" in ws &&
    typeof Reflect.get(ws, "serializeAttachment") === "function" &&
    typeof Reflect.get(ws, "deserializeAttachment") === "function"
  );
}

function deserializeAttachment(ws: WebSocket): unknown {
  if (!hasAttachmentMethods(ws)) return null;
  try {
    return ws.deserializeAttachment();
  } catch {
    return null;
  }
}

function serializeAttachment(ws: WebSocket, value: unknown): void {
  if (!hasAttachmentMethods(ws)) {
    throw new Error("WebSocket does not support attachments");
  }
  ws.serializeAttachment(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function getNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function saveAttachment(ws: WebSocket, patch: Record<string, unknown>): void {
  const raw = deserializeAttachment(ws);
  if (!isRecord(raw)) return;
  try {
    serializeAttachment(ws, { ...raw, ...patch });
  } catch {
    // Attachment methods are only available before hibernation; after
    // acceptWebSocket without them the in-memory copy is best effort.
  }
}

function getGlobalWebSocketPair(): (new () => WebSocketPair) | undefined {
  // Access WebSocketPair from global scope (Cloudflare Workers runtime)
  // Use Reflect to access global property without type assertions
  const WebSocketPair = Reflect.get(globalThis, "WebSocketPair") as unknown;
  if (typeof WebSocketPair === "function") {
    return WebSocketPair as new () => WebSocketPair;
  }
  return undefined;
}

function resolveRelayVersion(rawValue: string | null): "2" | null {
  if (rawValue == null) return null;
  return rawValue.trim() === CURRENT_RELAY_VERSION ? CURRENT_RELAY_VERSION : null;
}

interface Env {
  RELAY: DurableObjectNamespace;
}

interface DurableObjectNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): DurableObjectStub;
}

interface DurableObjectId {
  toString(): string;
}

interface DurableObjectStub {
  fetch(request: Request): Promise<Response>;
}

function generateChallengeNonce(): string {
  const bytes = new Uint8Array(RELAY_CHALLENGE_NONCE_BYTES);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

const MAX_VERIFICATION_KEY_CACHE = 256;
const verificationKeyCache = new Map<string, CryptoKey>();

async function verifyEd25519Signature(
  publicKeyB64Url: string,
  signatureB64Url: string,
  message: string,
): Promise<boolean> {
  let publicKeyBytes: Uint8Array;
  let signatureBytes: Uint8Array;
  try {
    publicKeyBytes = base64UrlToBytes(publicKeyB64Url);
    signatureBytes = base64UrlToBytes(signatureB64Url);
  } catch {
    return false;
  }
  if (publicKeyBytes.length !== RELAY_ED25519_PUBLIC_KEY_BYTES) return false;
  try {
    let key = verificationKeyCache.get(publicKeyB64Url);
    if (!key) {
      key = await crypto.subtle.importKey(
        "raw",
        publicKeyBytes as unknown as BufferSource,
        { name: "Ed25519" },
        false,
        ["verify"],
      );
      if (verificationKeyCache.size >= MAX_VERIFICATION_KEY_CACHE) {
        const oldest = verificationKeyCache.keys().next().value;
        if (oldest !== undefined) verificationKeyCache.delete(oldest);
      }
      verificationKeyCache.set(publicKeyB64Url, key);
    }
    return await crypto.subtle.verify(
      "Ed25519",
      key,
      signatureBytes as unknown as BufferSource,
      new TextEncoder().encode(message) as unknown as BufferSource,
    );
  } catch {
    return false;
  }
}

/**
 * Durable Object that handles WebSocket relay for a single session.
 *
 * v2 WebSockets connect in three shapes:
 * - role=server (no connectionId): daemon control socket (one per serverId)
 * - role=server&connectionId=...: daemon per-connection data socket (one per connectionId)
 * - role=client&connectionId=...: app/client socket (many per connectionId)
 *
 * Every server socket must pass the ownership challenge (see ownership.ts)
 * before any of its frames are forwarded and before buffered client frames
 * are delivered to it. The first verified public key for a serverId is stored
 * in DO storage; later sockets presenting a different key are closed with 4403.
 */
interface CFResponseInit extends ResponseInit {
  webSocket?: WebSocket;
}

export class RelayDurableObject {
  private state: DurableObjectState;
  private pendingFrames = new Map<string, Array<string | ArrayBuffer>>();
  private pendingFrameBytes = new Map<string, number>();

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  private createWebSocketPair(): [WebSocket, WebSocket] {
    const WebSocketPairCtor = getGlobalWebSocketPair();
    if (!WebSocketPairCtor) {
      throw new Error("WebSocketPair not available in global scope");
    }
    const pair: WebSocketPair = new WebSocketPairCtor();
    return [pair[0], pair[1]];
  }

  private requireWebSocketUpgrade(request: Request): Response | null {
    const upgradeHeader = request.headers.get("Upgrade");
    if (!upgradeHeader || upgradeHeader.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }
    return null;
  }

  private asSwitchingProtocolsResponse(client: WebSocket): Response {
    return new Response(null, {
      status: 101,
      webSocket: client,
    } as CFResponseInit);
  }

  private hasServerDataSocket(connectionId: string): boolean {
    try {
      return this.state.getWebSockets(`server:${connectionId}`).length > 0;
    } catch {
      return false;
    }
  }

  private hasClientSocket(connectionId: string): boolean {
    try {
      return this.state.getWebSockets(`client:${connectionId}`).length > 0;
    } catch {
      return false;
    }
  }

  private countClientSockets(): number {
    try {
      return this.state.getWebSockets("client").length;
    } catch {
      return 0;
    }
  }

  private closeExistingServerSockets(args: {
    isServerControl: boolean;
    isServerData: boolean;
    resolvedConnectionId: string;
  }): void {
    if (args.isServerControl) {
      for (const ws of this.state.getWebSockets("server-control")) {
        ws.close(1008, "Replaced by new connection");
      }
    } else if (args.isServerData) {
      for (const ws of this.state.getWebSockets(`server:${args.resolvedConnectionId}`)) {
        ws.close(1008, "Replaced by new connection");
      }
    }
  }

  private closeSocket(ws: WebSocket, code: number, reason: string): void {
    try {
      ws.close(code, reason);
    } catch {
      // ignore
    }
  }

  /**
   * Frames on a server socket are dropped until the ownership challenge is
   * answered; client frames on the same connectionId keep buffering.
   */
  private isServerSocketAuthenticated(attachment: Record<string, unknown>): boolean {
    return attachment.authState === "ok";
  }

  private setAuthenticated(ws: WebSocket): void {
    saveAttachment(ws, { authState: "ok" });
  }

  // COMPAT(relay-json-ping): Old daemons (< v0.1.76) send JSON {type:"ping"} on the control
  // socket and rely on a JSON {type:"pong"} reply to keep controlLastSeenAt fresh. New daemons
  // use WebSocket protocol pings (auto-answered at the edge, DO stays hibernated). Remove this
  // handler once the supported-daemon floor is >= v0.1.76 (target: 2026-11-13).
  private handleControlKeepalive(ws: WebSocket, message: string): void {
    try {
      const parsed: unknown = JSON.parse(message);
      const parsedRecord = isRecord(parsed) ? parsed : null;
      if (parsedRecord?.type !== "ping") return;
      // Logged so the daemon-side e2e idle test can assert no JSON ping reached the DO
      // (which would indicate a regression to app-level pings that wake the DO).
      console.log("[Relay DO] legacy_json_ping_received");
      try {
        ws.send(JSON.stringify({ type: "pong", ts: Date.now() }));
      } catch {
        // ignore
      }
    } catch {
      // ignore non-JSON control payloads
    }
  }

  private nudgeOrResetControlForConnection(connectionId: string): void {
    // If the daemon's control WS becomes half-open, the DO can't reliably detect it via ws.send errors
    // (Cloudflare may accept writes even if the other side is no longer reading).
    //
    // Instead, observe whether the daemon reacts by opening the per-connection server-data socket.
    // If it doesn't, nudge with a sync message; if still no reaction, force-close the control
    // socket(s) so the daemon reconnects.
    const initialDelayMs = 10_000;
    const secondDelayMs = 5_000;

    setTimeout(() => {
      if (!this.hasClientSocket(connectionId)) return;
      if (this.hasServerDataSocket(connectionId)) return;

      // First nudge: send a full sync list.
      this.notifyControls({ type: "sync", connectionIds: this.listConnectedConnectionIds() });

      setTimeout(() => {
        if (!this.hasClientSocket(connectionId)) return;
        if (this.hasServerDataSocket(connectionId)) return;

        // Still nothing: assume control is stuck and force a reconnect.
        for (const ws of this.state.getWebSockets("server-control")) {
          try {
            ws.close(1011, "Control unresponsive");
          } catch {
            // ignore
          }
        }
      }, secondDelayMs);
    }, initialDelayMs);
  }

  private frameByteLength(frame: string | ArrayBuffer): number {
    return typeof frame === "string" ? new TextEncoder().encode(frame).length : frame.byteLength;
  }

  /** True when the buffer over-limit — caller closes the sending client sockets. */
  private bufferFrame(connectionId: string, message: string | ArrayBuffer): boolean {
    const existing = this.pendingFrames.get(connectionId) ?? [];
    existing.push(message);
    const bytes = (this.pendingFrameBytes.get(connectionId) ?? 0) + this.frameByteLength(message);
    this.pendingFrames.set(connectionId, existing);
    this.pendingFrameBytes.set(connectionId, bytes);
    return (
      existing.length > MAX_RELAY_BUFFERED_FRAMES_PER_CONNECTION ||
      bytes > MAX_RELAY_BUFFERED_BYTES_PER_CONNECTION
    );
  }

  private clearBuffer(connectionId: string): void {
    this.pendingFrames.delete(connectionId);
    this.pendingFrameBytes.delete(connectionId);
  }

  private flushFrames(connectionId: string, serverWs: WebSocket): void {
    const frames = this.pendingFrames.get(connectionId);
    if (!frames || frames.length === 0) {
      this.clearBuffer(connectionId);
      return;
    }
    this.clearBuffer(connectionId);
    for (const frame of frames) {
      try {
        serverWs.send(frame);
      } catch {
        // If we can't flush, re-buffer and let the daemon re-establish.
        this.bufferFrame(connectionId, frame);
        break;
      }
    }
  }

  private listConnectedConnectionIds(): string[] {
    const out = new Set<string>();
    for (const ws of this.state.getWebSockets("client")) {
      try {
        const attachmentRaw = deserializeAttachment(ws);
        const attachment = isRecord(attachmentRaw) ? attachmentRaw : null;
        if (
          attachment?.role === "client" &&
          typeof attachment.connectionId === "string" &&
          attachment.connectionId
        ) {
          out.add(attachment.connectionId);
        }
      } catch {
        // ignore
      }
    }
    return Array.from(out);
  }

  private notifyControls(message: unknown): void {
    const text = JSON.stringify(message);
    for (const ws of this.state.getWebSockets("server-control")) {
      try {
        const attachmentRaw = deserializeAttachment(ws);
        const attachment = isRecord(attachmentRaw) ? attachmentRaw : null;
        // Control notifications are part of the authenticated channel; an
        // unauthenticated control socket sees only the challenge frames.
        if (attachment && attachment.authState !== "ok") continue;
        ws.send(text);
      } catch {
        // If the control socket is dead, close it so the daemon can reconnect.
        try {
          ws.close(1011, "Control send failed");
        } catch {
          // ignore
        }
      }
    }
  }

  /**
   * Sends `relay_challenge` on a freshly accepted server socket and records
   * the deadline used by `scheduled()` to enforce the 10 s answer window.
   */
  private async beginOwnershipChallenge(serverWs: WebSocket): Promise<void> {
    const nonce = generateChallengeNonce();
    saveAttachment(serverWs, {
      authState: "pending",
      authNonce: nonce,
      authDeadlineAt: Date.now() + RELAY_OWNERSHIP_CHALLENGE_TIMEOUT_MS,
    });
    try {
      serverWs.send(JSON.stringify(encodeRelayChallenge(base64UrlToBytes(nonce))));
    } catch {
      // Socket already gone; the close handler cleans up.
    }
    await this.ensureAlarm(Date.now() + ALARM_SCAN_INTERVAL_MS);
  }

  /**
   * Handles an inbound frame on a server socket that has not passed the
   * ownership challenge yet. Only `relay_auth` answers the challenge; every
   * other frame is dropped (never forwarded).
   */
  private async handleOwnershipMessage(
    ws: WebSocket,
    attachment: Record<string, unknown>,
    message: string | ArrayBuffer,
  ): Promise<void> {
    if (typeof message !== "string") {
      // Pre-auth server traffic must be the JSON relay_auth frame.
      return;
    }
    const auth = parseRelayAuth(message);
    if (!auth) return;

    const serverId = getString(attachment, "serverId");
    const nonce = getString(attachment, "authNonce");
    if (!serverId || !nonce) {
      this.closeSocket(ws, RELAY_CLOSE_CHALLENGE_TIMEOUT, "No pending challenge");
      return;
    }

    const signatureValid = await verifyEd25519Signature(
      auth.publicKey,
      auth.signature,
      relayChallengeMessage(serverId, nonce),
    );
    if (!signatureValid) {
      this.closeSocket(ws, RELAY_CLOSE_OWNERSHIP_MISMATCH, "Ownership signature invalid");
      return;
    }

    // First key wins: the DO pins the public key seen at registration.
    const stored = await this.state.storage.get<string>(OWNERSHIP_STORAGE_KEY, { cacheTtl: 60 });
    if (typeof stored === "string" && stored !== auth.publicKey) {
      this.closeSocket(ws, RELAY_CLOSE_OWNERSHIP_MISMATCH, "serverId owned by a different key");
      return;
    }
    if (attachment.reset === true) {
      // Reset may only remove an existing pin. It never registers the caller's
      // key, and an unauthenticated reset must leave the active daemon alone.
      if (typeof stored !== "string") {
        this.closeSocket(ws, RELAY_CLOSE_OWNERSHIP_MISMATCH, "No pinned key to reset");
        return;
      }
      await this.state.storage.delete(OWNERSHIP_STORAGE_KEY);
      saveAttachment(ws, { authState: "ok", resetComplete: true });
      this.closeSocket(ws, 1000, "Relay ownership reset");
      return;
    }
    if (typeof stored !== "string") {
      await this.state.storage.put(OWNERSHIP_STORAGE_KEY, auth.publicKey);
    }

    this.setAuthenticated(ws);
    try {
      ws.send(JSON.stringify({ type: "relay_auth_ok" }));
    } catch {
      // ignore; the socket is going away
      return;
    }

    const connectionId = getString(attachment, "connectionId");
    console.log(
      `[Relay DO] v2:server${connectionId ? `(data:${connectionId})` : "(control)"} ownership verified for session ${serverId}`,
    );

    if (connectionId) {
      this.flushFrames(connectionId, ws);
      // The control "connected" notification may have arrived while this data
      // socket was still unauthenticated; re-notify so the daemon retries.
      this.notifyControls({ type: "connected", connectionId });
    } else {
      // Catch up a control socket that connected before we finished auth.
      try {
        ws.send(JSON.stringify({ type: "sync", connectionIds: this.listConnectedConnectionIds() }));
      } catch {
        // ignore
      }
    }
  }

  private async ensureAlarm(whenMs: number): Promise<void> {
    try {
      await this.state.storage.setAlarm(whenMs);
    } catch {
      // Alarms are unavailable in some test fakes; timers in this invocation
      // still cover the current window.
    }
  }

  /**
   * Periodic janitor driven by the DO alarm: enforces the ownership-challenge
   * deadline (4401) and the 10-minute idle close. Reschedules itself while any
   * socket remains.
   */
  async scheduled(): Promise<void> {
    const now = Date.now();
    let nextDeadline: number | null = null;
    let socketCount = 0;

    for (const ws of this.state.getWebSockets()) {
      socketCount += 1;
      const attachmentRaw = deserializeAttachment(ws);
      const attachment = isRecord(attachmentRaw) ? attachmentRaw : null;
      if (!attachment) continue;

      const authDeadlineAt =
        attachment.authState === "pending" ? getNumber(attachment, "authDeadlineAt") : undefined;
      if (authDeadlineAt !== undefined && authDeadlineAt <= now) {
        console.log(
          `[Relay DO] ownership challenge timed out for session ${getString(attachment, "serverId") ?? "unknown"}`,
        );
        this.closeSocket(ws, RELAY_CLOSE_CHALLENGE_TIMEOUT, "Ownership challenge timeout");
        continue;
      }
      if (authDeadlineAt !== undefined) {
        nextDeadline = Math.min(nextDeadline ?? Infinity, authDeadlineAt);
      }

      const lastActivityAt =
        getNumber(attachment, "lastActivityAt") ?? getNumber(attachment, "createdAt") ?? now;
      const idleDeadlineAt = lastActivityAt + RELAY_IDLE_SOCKET_TIMEOUT_MS;
      if (idleDeadlineAt <= now) {
        this.closeSocket(ws, 1000, "Idle timeout");
        continue;
      }
      nextDeadline = Math.min(nextDeadline ?? Infinity, idleDeadlineAt);
    }

    if (socketCount > 0 && nextDeadline !== null) {
      await this.ensureAlarm(Math.max(nextDeadline, now + ALARM_SCAN_INTERVAL_MS));
    }
  }

  private fetchV2(
    request: Request,
    role: ConnectionRole,
    serverId: string,
    connectionId: string,
    reset: boolean,
  ): Response {
    const upgradeError = this.requireWebSocketUpgrade(request);
    if (upgradeError) return upgradeError;

    // If a client didn't provide a connectionId, the relay assigns one for routing.
    const resolvedConnectionId =
      role === "client" && !connectionId
        ? `conn_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`
        : connectionId;

    const isServerControl = role === "server" && !resolvedConnectionId;
    const isServerData = role === "server" && !!resolvedConnectionId;

    // Close any existing server-side connection with the same identity.
    // - server-control: single per serverId
    // - server-data: single per connectionId
    // - client: many sockets per connectionId are allowed
    if (!reset)
      this.closeExistingServerSockets({ isServerControl, isServerData, resolvedConnectionId });

    if (role === "client" && this.countClientSockets() >= MAX_RELAY_CLIENTS_PER_SERVER) {
      const [client, server] = this.createWebSocketPair();
      this.state.acceptWebSocket(server, ["client"]);
      serializeAttachment(server, {
        serverId,
        role: "client",
        version: CURRENT_RELAY_VERSION,
        connectionId: resolvedConnectionId,
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
        authState: "ok",
      } satisfies RelaySessionAttachment);
      this.closeSocket(server, RELAY_CLOSE_TOO_MANY_CLIENTS, "Too many clients for this server");
      console.log(
        `[Relay DO] rejected client over ${MAX_RELAY_CLIENTS_PER_SERVER} limit for session ${serverId}`,
      );
      return this.asSwitchingProtocolsResponse(client);
    }

    const [client, server] = this.createWebSocketPair();

    const tags: string[] = [];
    if (role === "client") {
      tags.push("client", `client:${resolvedConnectionId}`);
    } else if (reset) {
      tags.push("server-reset");
    } else if (isServerControl) {
      tags.push("server-control");
    } else {
      tags.push("server", `server:${resolvedConnectionId}`);
    }

    this.state.acceptWebSocket(server, tags);

    const attachment: RelaySessionAttachment = {
      serverId,
      role,
      version: CURRENT_RELAY_VERSION,
      connectionId: resolvedConnectionId || null,
      ...(reset ? { reset: true } : {}),
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      ...(role === "server" ? { authState: "pending" as const } : { authState: "ok" as const }),
    };
    serializeAttachment(server, attachment);

    let roleSuffix = "";
    if (isServerControl) {
      roleSuffix = "(control)";
    } else if (isServerData) {
      roleSuffix = `(data:${resolvedConnectionId})`;
    } else if (role === "client") {
      roleSuffix = `(${resolvedConnectionId})`;
    }
    console.log(`[Relay DO] v2:${role}${roleSuffix} connected to session ${serverId}`);

    if (role === "client") {
      this.notifyControls({ type: "connected", connectionId: resolvedConnectionId });
      this.nudgeOrResetControlForConnection(resolvedConnectionId);
    }

    // The ownership challenge is the first frame on every server socket;
    // control sync catch-up and buffered client frames flow only after
    // relay_auth_ok (see handleOwnershipMessage).
    if (role === "server") {
      void this.beginOwnershipChallenge(server);
    }

    return this.asSwitchingProtocolsResponse(client);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const roleRaw = url.searchParams.get("role");
    const role = roleRaw === "server" || roleRaw === "client" ? roleRaw : null;
    const serverId = url.searchParams.get("serverId");
    const connectionIdRaw = url.searchParams.get("connectionId");
    const connectionId = typeof connectionIdRaw === "string" ? connectionIdRaw.trim() : "";
    const version = resolveRelayVersion(url.searchParams.get("v"));

    if (!role) {
      return new Response("Missing or invalid role parameter", { status: 400 });
    }

    if (!serverId) {
      return new Response("Missing serverId parameter", { status: 400 });
    }

    if (!version) {
      return new Response("Invalid v parameter (expected 2)", { status: 400 });
    }

    const reset = url.searchParams.get("reset") === "1";
    if (reset && (role !== "server" || connectionId))
      return new Response("Reset requires a server control socket", { status: 400 });
    return this.fetchV2(request, role, serverId, connectionId, reset);
  }

  /**
   * Called when a WebSocket message is received (wakes from hibernation).
   */
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const attachmentRaw = deserializeAttachment(ws);
    if (!isRecord(attachmentRaw)) {
      console.error("[Relay DO] Message from WebSocket without attachment");
      return;
    }
    const attachment = attachmentRaw;
    if (attachment.resetComplete === true) return;

    saveAttachment(ws, { lastActivityAt: Date.now() });

    const byteLength = this.frameByteLength(message);
    if (byteLength > MAX_RELAY_WEBSOCKET_MESSAGE_BYTES) {
      console.log(`[Relay DO] frame too large (${byteLength} bytes), closing socket`);
      this.closeSocket(ws, RELAY_CLOSE_FRAME_TOO_LARGE, "Frame too large");
      return;
    }

    const role = getString(attachment, "role");
    const connectionId = getString(attachment, "connectionId");

    if (role === "server" && attachment.authState !== "ok") {
      await this.handleOwnershipMessage(ws, attachment, message);
      return;
    }

    if (!connectionId) {
      // Control channel: support simple app-level keepalive.
      if (typeof message === "string") {
        this.handleControlKeepalive(ws, message);
      }
      return;
    }

    if (role === "client") {
      const servers = this.state.getWebSockets(`server:${connectionId}`).filter((socket) => {
        const raw = deserializeAttachment(socket);
        return isRecord(raw) && this.isServerSocketAuthenticated(raw);
      });
      if (servers.length === 0) {
        // No authenticated daemon data socket yet: keep buffering.
        const overflowed = this.bufferFrame(connectionId, message);
        if (overflowed) {
          console.log(`[Relay DO] buffer overflow for connection ${connectionId}, closing clients`);
          this.clearBuffer(connectionId);
          for (const clientWs of this.state.getWebSockets(`client:${connectionId}`)) {
            this.closeSocket(clientWs, RELAY_CLOSE_BUFFER_OVERFLOW, "Buffered frames overflow");
          }
        }
        return;
      }
      for (const target of servers) {
        try {
          target.send(message);
        } catch (error) {
          console.error(`[Relay DO] Failed to forward client->server(${connectionId}):`, error);
        }
      }
      return;
    }

    // server data socket -> client
    const targets = this.state.getWebSockets(`client:${connectionId}`);
    for (const target of targets) {
      try {
        target.send(message);
      } catch (error) {
        console.error(`[Relay DO] Failed to forward server->client(${connectionId}):`, error);
      }
    }
  }

  /**
   * Called when a WebSocket closes (wakes from hibernation).
   */
  webSocketClose(ws: WebSocket, code: number, reason: string, _wasClean: boolean): void {
    const attachmentRaw = deserializeAttachment(ws);
    if (!isRecord(attachmentRaw)) return;
    const attachment = attachmentRaw;

    const role = getString(attachment, "role");
    const connectionId = getString(attachment, "connectionId");
    const serverId = getString(attachment, "serverId");
    console.log(
      `[Relay DO] v${CURRENT_RELAY_VERSION}:${role ?? "unknown"}${connectionId ? `(${connectionId})` : ""} disconnected from session ${serverId ?? "unknown"} (${code}: ${reason})`,
    );

    if (role === "client" && connectionId) {
      const remainingClientSockets = this.state
        .getWebSockets(`client:${connectionId}`)
        .some((socket) => socket !== ws);
      if (remainingClientSockets) {
        return;
      }

      this.clearBuffer(connectionId);
      // Last socket for this session closed: now clean up matching server-data socket.
      for (const serverWs of this.state.getWebSockets(`server:${connectionId}`)) {
        try {
          serverWs.close(1001, "Client disconnected");
        } catch {
          // ignore
        }
      }
      this.notifyControls({ type: "disconnected", connectionId });
      return;
    }

    if (role === "server" && connectionId) {
      // Force the client to reconnect and re-handshake when the daemon side drops.
      for (const clientWs of this.state.getWebSockets(`client:${connectionId}`)) {
        try {
          clientWs.close(1012, "Server disconnected");
        } catch {
          // ignore
        }
      }
    }
  }

  /**
   * Called on WebSocket error.
   */
  webSocketError(ws: WebSocket, error: unknown): void {
    const attachmentRaw = deserializeAttachment(ws);
    const attachment = isRecord(attachmentRaw) ? attachmentRaw : null;
    const role = attachment ? getString(attachment, "role") : undefined;
    console.error(`[Relay DO] WebSocket error for ${role ?? "unknown"}:`, error);
  }
}

/**
 * Worker entry point that routes requests to the appropriate Durable Object.
 */
const MAX_CONNECT_IP_BUCKETS = 4096;
const connectTimestampsByIp = new Map<string, number[]>();

function checkIpConnectRateLimit(request: Request): Response | null {
  const ip = request.headers.get("CF-Connecting-IP");
  // No CF-Connecting-IP: wrangler dev / local harnesses. Best effort: skip.
  if (!ip) return null;

  const now = Date.now();
  const windowStart = now - 60_000;
  const timestamps = (connectTimestampsByIp.get(ip) ?? []).filter((t) => t > windowStart);
  if (timestamps.length >= MAX_RELAY_CONNECTS_PER_IP_PER_MINUTE) {
    connectTimestampsByIp.set(ip, timestamps);
    return new Response("Too many relay connections from this IP (limit 60/min)", {
      status: 429,
    });
  }
  timestamps.push(now);
  connectTimestampsByIp.set(ip, timestamps);
  if (connectTimestampsByIp.size > MAX_CONNECT_IP_BUCKETS) {
    for (const [key, list] of connectTimestampsByIp) {
      const fresh = list.filter((t) => t > windowStart);
      if (fresh.length === 0) connectTimestampsByIp.delete(key);
      else connectTimestampsByIp.set(key, fresh);
    }
  }
  return null;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Health check
    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ status: "ok" }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // Every other path is a relay connection attempt; validate before
    // waking a Durable Object so abusive requests stay in the free tier.
    const roleRaw = url.searchParams.get("role");
    const role = roleRaw === "server" || roleRaw === "client" ? roleRaw : null;
    if (!role) {
      return new Response("Missing or invalid role parameter", { status: 400 });
    }

    const serverId = url.searchParams.get("serverId");
    if (!serverId) {
      return new Response("Missing serverId parameter", { status: 400 });
    }

    if (!resolveRelayVersion(url.searchParams.get("v"))) {
      return new Response("Invalid v parameter (expected 2)", { status: 400 });
    }

    const rateLimited = checkIpConnectRateLimit(request);
    if (rateLimited) return rateLimited;

    const id = env.RELAY.idFromName(serverId);
    const stub = env.RELAY.get(id);

    const normalizedUrl = new URL(request.url);
    normalizedUrl.searchParams.set("v", CURRENT_RELAY_VERSION);
    const normalizedRequest = new Request(normalizedUrl.toString(), request);
    return stub.fetch(normalizedRequest);
  },
};
