import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import type { Duplex } from "node:stream";
import type pino from "pino";
import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";
import type {
  FigmaEditOp,
  FigmaLinkFile,
  FigmaLinkStatus,
  FigmaNode,
} from "@jagentdesk/protocol/figma/rpc-schemas";
import type { FigmaLinkBridge } from "../context.js";
import { FigmaServiceError } from "../context.js";
import { planOp, resolveTempIds, unresolvedTempIds, type PlannedOp } from "./edit-ops.js";
import { installFigmaLinkPlugin } from "./plugin-install.js";
import { FigmaLinkPairingManager, type LinkSecretStoreLike } from "./pairing.js";
import {
  DEFAULT_LINK_PORT,
  PLUGIN_VERSION,
  HELLO_TIMEOUT_MS,
  INSTALL_BACKOFF_MS,
  LINK_HOST,
  LINK_PROTOCOL_VERSION,
  PAIRING_CODE_TTL_MS,
  PING_INTERVAL_MS,
  REQUEST_TIMEOUT_MS,
  type PluginStatusFrame,
} from "./protocol.js";
import { FigmaLinkSettingsStore } from "./settings.js";

/** The plugin build this daemon ships; anything else is `link_version_mismatch`. */
export const EXPECTED_PLUGIN_VERSION = PLUGIN_VERSION;

export interface FigmaLinkServerOptions {
  secrets: LinkSecretStoreLike;
  /** JAGENTDESK_HOME root — pairing records + settings persist under it. */
  dataDir: string;
  logger: pino.Logger;
  host?: string;
  /** 0 binds an ephemeral port (tests); production callers pass 1995. */
  port?: number;
  requestTimeoutMs?: number;
  pingIntervalMs?: number;
  now?: () => number;
  /** Override the vendored plugin dir (tests). */
  vendorPluginDir?: string;
  /** Override the plugin install root (tests). */
  /** Plugin install directory; defaults to `<dataDir>/figma/plugin` (spec 32.4.1). */
  installDir?: string;
  /** Skip the copy-the-vendor step entirely (tests). */
  autoInstall?: boolean;
}

interface PendingCall {
  resolve: (response: { ok: boolean; message: string; data?: unknown }) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface LinkConnection {
  socket: WebSocket;
  fileName: string;
  fileKey: string;
  pluginVersion: string;
  protocol: number;
  pairingId?: string;
  paired: boolean;
  blocked: boolean;
  connectedAt: number;
  pageName: string | null;
  pendingCode: { code: string; expiresAt: number } | null;
  alive: boolean;
  pingTimer?: ReturnType<typeof setInterval>;
  helloTimer?: ReturnType<typeof setTimeout>;
  pending: Map<string, PendingCall>;
}

export type LinkPushListener = (status: FigmaLinkStatus) => void;
export type LinkChangeListener = (event: { fileKey: string | null; nodeIds?: string[] }) => void;

/**
 * The Figma Link bridge (spec 32, ADR-0035): a loopback WebSocket server on
 * 127.0.0.1:1995 that the JAgentDesk Figma Link plugin dials into. One daemon,
 * one plugin per file — the newest connection for a fileKey replaces the
 * previous one.
 *
 * Rejections follow the research §8 findings: a non-null Origin or a
 * non-loopback peer is refused with `link_rejected` then closed (the plugin UI
 * surfaces it verbatim), and a version/protocol mismatch keeps the connection
 * registered but blocked so `callTool` throws `link_version_mismatch`.
 * Pairing (32.4): unpaired connections are issued a short-lived numeric code
 * (`pairing_required`) that the app redeems via `pair(code)`; the long-lived
 * key lands in the SecretStore, the record in `figma/link-pairings.json`.
 */
export class FigmaLinkServer implements FigmaLinkBridge {
  private server?: http.Server;
  private wss?: WebSocketServer;
  private serverState: FigmaLinkStatus["server"] = "stopped";
  private boundPort: number;
  private readonly connections = new Map<string, LinkConnection>();
  private readonly pushListeners = new Set<LinkPushListener>();
  private readonly changeListeners = new Set<LinkChangeListener>();
  private lastInstallFailureAt = 0;
  private install: {
    pluginInstalled: boolean;
    pluginVersion: string | null;
    manifestPath: string | null;
  } = {
    pluginInstalled: false,
    pluginVersion: null,
    manifestPath: null,
  };
  private runScript = false;
  private readonly host: string;
  private readonly requestTimeoutMs: number;
  private readonly pingIntervalMs: number;
  private readonly now: () => number;
  private readonly pairing: FigmaLinkPairingManager;
  private readonly settings: FigmaLinkSettingsStore;

  constructor(private readonly options: FigmaLinkServerOptions) {
    this.host = options.host ?? LINK_HOST;
    this.boundPort = options.port ?? DEFAULT_LINK_PORT;
    this.requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
    this.pingIntervalMs = options.pingIntervalMs ?? PING_INTERVAL_MS;
    this.now = options.now ?? (() => Date.now());
    this.pairing = new FigmaLinkPairingManager({
      secrets: options.secrets,
      dataDir: options.dataDir,
      now: this.now,
      codeTtlMs: PAIRING_CODE_TTL_MS,
    });
    this.settings = new FigmaLinkSettingsStore(options.dataDir);
  }

  /** Wire the `figma.link.changed` push; create.ts calls this once, after the service exists. */
  attachPush(listener: LinkPushListener): void {
    this.pushListeners.add(listener);
  }

  async start(): Promise<{ ok: true; port: number } | { ok: false; error: "port_in_use" }> {
    await this.settings.load();
    this.runScript = this.settings.runScriptEnabled;
    void this.tryInstall();
    try {
      await this.listen();
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "EADDRINUSE") {
        this.serverState = "port_in_use";
        return { ok: false, error: "port_in_use" };
      }
      throw error;
    }
    this.serverState = "listening";
    return { ok: true, port: this.boundPort };
  }

  private listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        if (req.url?.startsWith("/ping")) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              ok: true,
              protocol: LINK_PROTOCOL_VERSION,
              version: EXPECTED_PLUGIN_VERSION,
            }),
          );
          return;
        }
        res.writeHead(404).end();
      });
      server.on("error", reject);
      const wss = new WebSocketServer({ noServer: true });
      server.on("upgrade", (req, socket, head) => {
        const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
        if (url.pathname !== "/ws") {
          socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
          socket.destroy();
          return;
        }
        // ADR-0035 §3: refuse before any WebSocket exists — a browser page (any Origin other than
        // the plugin iframe's literal "null") or a non-loopback peer never gets a socket.
        const origin = req.headers.origin;
        const remote = (req.socket.remoteAddress ?? "").replace(/^::ffff:/, "");
        if ((origin !== undefined && origin !== "null") || !isLoopback(remote)) {
          socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
          socket.destroy();
          return;
        }
        wss.handleUpgrade(req, socket as Duplex, head, (ws) => this.onSocket(ws, req, url));
      });
      server.listen({ host: this.host, port: this.options.port ?? DEFAULT_LINK_PORT }, () => {
        const addr = server.address();
        if (typeof addr === "object" && addr) this.boundPort = addr.port;
        resolve();
      });
      this.server = server;
      this.wss = wss;
    });
  }

  port(): number {
    return this.boundPort;
  }

  private onSocket(socket: WebSocket, req: http.IncomingMessage, url: URL): void {
    const remote = (req.socket.remoteAddress ?? "").replace(/^::ffff:/, "");
    const origin = req.headers.origin;
    socket.on("error", () => socket.terminate());

    // The Figma plugin iframe presents the literal origin "null"; anything
    // else is a browser tab poking the port. Non-loopback peers are QA runs
    // that picked the wrong machine (research §8.1/§8.2).
    if ((origin !== undefined && origin !== "null") || !isLoopback(remote)) {
      socket.send(
        JSON.stringify({ type: "link_rejected", reason: origin ? "bad-origin" : "non-loopback" }),
      );
      socket.close(1008, "link rejected");
      return;
    }

    const conn: LinkConnection = {
      socket,
      fileName: url.searchParams.get("fileName") ?? "",
      fileKey: url.searchParams.get("fileKey") ?? "",
      pluginVersion: url.searchParams.get("version") ?? "",
      protocol: Number(url.searchParams.get("protocol") ?? LINK_PROTOCOL_VERSION),
      paired: false,
      blocked: false,
      connectedAt: this.now(),
      pageName: null,
      pendingCode: null,
      alive: true,
      pending: new Map(),
    };
    socket.on("message", (raw: unknown) => void this.onMessage(conn, raw));
    socket.on("close", () => this.onClose(conn));
    conn.helloTimer = setTimeout(() => {
      if (!conn.fileKey) socket.close(1008, "hello timeout");
    }, HELLO_TIMEOUT_MS);
    conn.helloTimer.unref?.();
  }

  private async onMessage(conn: LinkConnection, raw: unknown): Promise<void> {
    let frame: { type?: string } & Record<string, unknown>;
    try {
      frame = JSON.parse(String(raw)) as { type?: string } & Record<string, unknown>;
    } catch {
      return;
    }
    conn.alive = true;
    switch (frame.type) {
      case "hello":
        await this.onHello(conn, frame);
        return;
      case "pair":
        await this.redeemPairing(conn, String(frame.code ?? ""));
        return;
      case "ping":
        conn.socket.send(JSON.stringify({ type: "pong", sentAt: frame.sentAt ?? this.now() }));
        return;
      case "pong":
        return;
      case "plugin_status":
        this.onPluginStatus(conn, frame as unknown as PluginStatusFrame);
        return;
      case "response": {
        const requestId = String(frame.requestId ?? "");
        const pending = conn.pending.get(requestId);
        if (pending) {
          conn.pending.delete(requestId);
          clearTimeout(pending.timer);
          pending.resolve({
            ok: Boolean(frame.ok),
            message: String(frame.message ?? ""),
            data: frame.data,
          });
        }
        return;
      }
      default:
        return;
    }
  }

  private async onHello(
    conn: LinkConnection,
    frame: { type?: string } & Record<string, unknown>,
  ): Promise<void> {
    if (conn.helloTimer) {
      clearTimeout(conn.helloTimer);
      conn.helloTimer = undefined;
    }
    conn.fileName = String(frame.fileName ?? conn.fileName);
    conn.fileKey = String(frame.fileKey ?? conn.fileKey);
    conn.pluginVersion = String(frame.version ?? conn.pluginVersion);
    conn.protocol = Number(frame.protocol ?? conn.protocol);
    if (!conn.fileKey) {
      conn.socket.close(1008, "hello missing fileKey");
      return;
    }
    // Newest wins per fileKey (spec 32 — no takeover/leader negotiation).
    const existing = this.connections.get(conn.fileKey);
    if (existing && existing !== conn) {
      this.unregister(existing, existing.pending.size ? "replaced" : undefined);
      existing.socket.close(1000, "replaced by a newer connection");
    }
    this.connections.set(conn.fileKey, conn);

    if (conn.protocol !== LINK_PROTOCOL_VERSION || conn.pluginVersion !== EXPECTED_PLUGIN_VERSION) {
      conn.blocked = true;
      conn.socket.send(
        JSON.stringify({
          type: "link_blocked",
          reason:
            conn.protocol !== LINK_PROTOCOL_VERSION ? "protocol mismatch" : "version mismatch",
          requiredVersion: EXPECTED_PLUGIN_VERSION,
          protocol: LINK_PROTOCOL_VERSION,
        }),
      );
      this.startPing(conn);
      this.notifyChange({ fileKey: conn.fileKey });
      return;
    }

    const pairingId = frame.pairingId ? String(frame.pairingId) : undefined;
    const pairingKey = frame.pairingKey ? String(frame.pairingKey) : undefined;
    if (pairingId && pairingKey) {
      if (await this.pairing.validate(pairingId, pairingKey)) {
        conn.pairingId = pairingId;
        conn.paired = true;
        this.pairing.touchConnected(pairingId);
        conn.socket.send(JSON.stringify({ type: "hello_ack", ok: true, paired: true }));
        this.startPing(conn);
        this.notifyChange({ fileKey: conn.fileKey });
        return;
      }
      conn.socket.send(JSON.stringify({ type: "pairing_rejected" }));
    }
    await this.issueCode(conn);
    this.startPing(conn);
    this.notifyChange({ fileKey: conn.fileKey });
  }

  /** Send a fresh pairing code down the socket for the user to type into the app. */
  private async issueCode(conn: LinkConnection): Promise<void> {
    const pairingId = conn.pairingId ?? randomUUID();
    conn.pairingId = pairingId;
    conn.paired = false;
    const issued = this.pairing.issueCode({
      pairingId,
      name: conn.fileName || "Figma file",
      fileKey: conn.fileKey,
      fileName: conn.fileName,
    });
    conn.pendingCode = issued;
    conn.socket.send(
      JSON.stringify({
        type: "pairing_required",
        code: issued.code,
        expiresAt_ms: issued.expiresAt,
      }),
    );
  }

  /** The plugin UI relaying a code typed by the user (the app path is `pair()`). */
  private async redeemPairing(conn: LinkConnection, code: string): Promise<void> {
    if (conn.paired) return;
    const granted = await this.pairing.pair(code);
    if (!granted) {
      await this.issueCode(conn); // unknown/expired — a fresh code instead of a dead end
      this.notifyChange({ fileKey: conn.fileKey });
      return;
    }
    conn.pairingId = granted.pairingId;
    conn.paired = true;
    conn.pendingCode = null;
    this.pairing.touchConnected(granted.pairingId);
    conn.socket.send(
      JSON.stringify({
        type: "pairing_granted",
        pairingId: granted.pairingId,
        pairingKey: granted.pairingKey,
      }),
    );
    this.notifyChange({ fileKey: conn.fileKey });
  }

  private onPluginStatus(conn: LinkConnection, frame: PluginStatusFrame): void {
    conn.pageName = frame.currentPage ? frame.currentPage : null;
    const event = {
      fileKey: conn.fileKey,
      ...(frame.nodeIds?.length ? { nodeIds: frame.nodeIds } : {}),
    };
    for (const listener of this.changeListeners) {
      try {
        listener(event);
      } catch (error) {
        this.options.logger.warn({ err: error }, "figma link change listener failed");
      }
    }
    this.notifyChange(event);
  }

  private startPing(conn: LinkConnection): void {
    conn.pingTimer = setInterval(() => {
      if (!conn.alive) {
        conn.socket.terminate();
        return;
      }
      conn.alive = false;
      conn.socket.send(JSON.stringify({ type: "ping", sentAt: this.now() }));
    }, this.pingIntervalMs);
    conn.pingTimer.unref?.();
  }

  private onClose(conn: LinkConnection): void {
    if (conn.pingTimer) clearInterval(conn.pingTimer);
    if (conn.helloTimer) clearTimeout(conn.helloTimer);
    this.unregister(conn);
    this.notifyChange({ fileKey: conn.fileKey });
  }

  private unregister(conn: LinkConnection, _reason?: string): void {
    for (const pending of conn.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new FigmaServiceError("link_closed", "Figma Link connection closed"));
    }
    conn.pending.clear();
    if (conn.fileKey && this.connections.get(conn.fileKey) === conn) {
      this.connections.delete(conn.fileKey);
    }
  }

  private notifyChange(_event: { fileKey: string | null }): void {
    if (this.pushListeners.size === 0) return;
    const status = this.status();
    for (const listener of this.pushListeners) {
      try {
        listener(status);
      } catch (error) {
        this.options.logger.warn({ err: error }, "figma link push listener failed");
      }
    }
  }

  status(): FigmaLinkStatus {
    const files: FigmaLinkFile[] = [...this.connections.values()].map((conn) => ({
      fileKey: conn.fileKey,
      fileName: conn.fileName,
      pageName: conn.pageName,
      paired: conn.paired,
      pluginVersion: conn.pluginVersion,
      connectedAt_ms: conn.connectedAt,
    }));
    const waiting = [...this.connections.values()].find(
      (conn) =>
        !conn.paired &&
        !conn.blocked &&
        conn.pendingCode &&
        conn.pendingCode.expiresAt > this.now(),
    );
    return {
      server: this.serverState,
      port: this.boundPort,
      pluginInstalled: this.install.pluginInstalled,
      pluginVersion: this.install.pluginVersion,
      manifestPath: this.install.manifestPath,
      runScriptEnabled: this.runScript,
      files,
      pendingPairing: waiting?.pendingCode
        ? { fileName: waiting.fileName, expiresAt_ms: waiting.pendingCode.expiresAt }
        : null,
    };
  }

  isLinked(fileKey: string): boolean {
    const conn = this.connections.get(fileKey);
    return conn !== undefined && !conn.blocked;
  }

  async pair(code: string): Promise<FigmaLinkStatus> {
    const granted = await this.pairing.pair(code);
    if (!granted) {
      throw new FigmaServiceError(
        "pairing_required",
        "That pairing code is invalid or has expired",
      );
    }
    for (const conn of this.connections.values()) {
      if (conn.pairingId === granted.pairingId && !conn.paired) {
        conn.paired = true;
        conn.pendingCode = null;
        conn.socket.send(
          JSON.stringify({
            type: "pairing_granted",
            pairingId: granted.pairingId,
            pairingKey: granted.pairingKey,
          }),
        );
      }
    }
    this.pairing.touchConnected(granted.pairingId);
    this.notifyChange({ fileKey: null });
    return this.status();
  }

  async revoke(pairingId?: string): Promise<void> {
    for (const conn of this.connections.values()) {
      if (!pairingId || conn.pairingId === pairingId) {
        conn.paired = false;
        await this.issueCode(conn);
      }
    }
    if (pairingId) await this.pairing.revoke(pairingId);
    else await this.pairing.revokeAll();
    this.notifyChange({ fileKey: null });
  }

  async setRunScriptEnabled(enabled: boolean): Promise<FigmaLinkStatus> {
    await this.settings.setRunScriptEnabled(enabled);
    this.runScript = enabled;
    this.notifyChange({ fileKey: null });
    return this.status();
  }

  async callTool(
    fileKey: string,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<{ ok: boolean; message: string; data?: unknown }> {
    const conn = this.requireUsable(fileKey);
    const { nodeIds, ...params } = args;
    return this.sendRequest(
      conn,
      tool,
      Array.isArray(nodeIds) ? (nodeIds as string[]) : undefined,
      params,
    );
  }

  /**
   * Map each FigmaEditOp onto its Forge plugin tool and run the batch
   * sequentially — later ops reference earlier tempIds and must see the real
   * node ids the plugin returned for them.
   */
  async applyOps(
    fileKey: string,
    ops: FigmaEditOp[],
  ): Promise<{ createdIds: Record<string, string>; results: { ok: boolean; message?: string }[] }> {
    this.requireUsable(fileKey);
    const createdIds: Record<string, string> = {};
    const declared = new Set(ops.flatMap((op) => tempIdsOf(op)));
    const results: { ok: boolean; message?: string }[] = [];
    for (const op of ops) {
      const planned = planOp(op);
      const resolved = resolveTempIds(planned, createdIds, declared);
      const missing = unresolvedTempIds(resolved, createdIds, declared);
      if (missing.length > 0) {
        results.push({
          ok: false,
          message: `Prerequisite node ${missing.join(", ")} was never created in this batch`,
        });
        continue;
      }
      try {
        const response = await this.sendRequestForOp(fileKey, resolved);
        if (response.ok) {
          const realId = extractCreatedNodeId(response.data);
          const tempId = "tempId" in op ? op.tempId : undefined;
          if (tempId && realId) createdIds[tempId] = realId;
          results.push({ ok: true });
        } else {
          results.push({ ok: false, message: response.message });
        }
      } catch (error) {
        results.push({
          ok: false,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { createdIds, results };
  }

  private async sendRequestForOp(
    fileKey: string,
    planned: PlannedOp,
  ): Promise<{ ok: boolean; message: string; data?: unknown }> {
    const conn = this.requireUsable(fileKey);
    return this.sendRequest(conn, planned.tool, planned.nodeIds, planned.params);
  }

  async getNodes(fileKey: string, ids: string[]): Promise<Record<string, FigmaNode | null>> {
    const response = await this.callTool(fileKey, "get_nodes", { nodeIds: ids });
    const nodes = (response.data as { nodes?: Record<string, unknown>[] } | undefined)?.nodes ?? [];
    const byId = new Map(nodes.map((node) => [String(node.id), node as FigmaNode]));
    const out: Record<string, FigmaNode | null> = {};
    for (const id of ids) out[id] = byId.get(id) ?? null;
    return out;
  }

  async exportNode(
    fileKey: string,
    nodeId: string,
    format: "png" | "jpg" | "svg" | "pdf",
    scale: number,
  ): Promise<{ mimeType: string; data: Buffer }> {
    const response = await this.callTool(fileKey, "get_screenshot", {
      nodeIds: [nodeId],
      scale,
      format,
    });
    const exports = (response.data as { exports?: { base64?: string }[] } | undefined)?.exports;
    const base64 = exports?.[0]?.base64;
    if (!response.ok || !base64) {
      throw new FigmaServiceError(
        "link_unavailable",
        response.message || `Figma Link export of ${nodeId} produced no image`,
      );
    }
    return { mimeType: MIME_TYPES[format], data: Buffer.from(base64, "base64") };
  }

  onChange(listener: LinkChangeListener): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  async close(): Promise<void> {
    this.serverState = "stopped";
    for (const conn of this.connections.values()) {
      if (conn.pingTimer) clearInterval(conn.pingTimer);
      if (conn.helloTimer) clearTimeout(conn.helloTimer);
      conn.socket.terminate();
    }
    this.unregisterAll();
    await new Promise<void>((resolve) => {
      if (this.wss) this.wss.close(() => resolve());
      else resolve();
    });
    await new Promise<void>((resolve) => {
      if (this.server?.listening) this.server.close(() => resolve());
      else resolve();
    });
    this.pushListeners.clear();
    this.changeListeners.clear();
  }

  private requireUsable(fileKey: string): LinkConnection {
    const conn = this.connections.get(fileKey);
    if (!conn) {
      throw new FigmaServiceError(
        "link_unavailable",
        `No Figma Link plugin is connected for ${fileKey}`,
      );
    }
    if (conn.blocked) {
      throw new FigmaServiceError(
        "link_version_mismatch",
        `Figma Link plugin v${conn.pluginVersion} does not match JAgentDesk (expected v${EXPECTED_PLUGIN_VERSION})`,
      );
    }
    if (!conn.paired) {
      throw new FigmaServiceError(
        "link_unpaired",
        "Enter the pairing code shown in the Figma plugin into JAgentDesk to use Figma Link",
      );
    }
    return conn;
  }

  private sendRequest(
    conn: LinkConnection,
    toolName: string,
    nodeIds: string[] | undefined,
    params: Record<string, unknown> | undefined,
  ): Promise<{ ok: boolean; message: string; data?: unknown }> {
    const requestId = randomUUID();
    const frame = { type: "request", requestId, toolName, nodeIds, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        conn.pending.delete(requestId);
        reject(new FigmaServiceError("link_timeout", `Figma Link tool ${toolName} timed out`));
      }, this.requestTimeoutMs);
      timer.unref?.();
      conn.pending.set(requestId, { resolve, reject, timer });
      conn.socket.send(JSON.stringify(frame), (err) => {
        if (err && conn.pending.delete(requestId)) {
          clearTimeout(timer);
          reject(
            new FigmaServiceError("link_unavailable", "Figma Link connection is not writable"),
          );
        }
      });
    });
  }

  private unregisterAll(): void {
    for (const conn of this.connections.values()) {
      for (const pending of conn.pending.values()) clearTimeout(pending.timer);
      conn.pending.clear();
    }
    this.connections.clear();
  }

  private async tryInstall(): Promise<void> {
    if (this.options.autoInstall === false) return;
    const result = await installFigmaLinkPlugin({
      logger: this.options.logger,
      vendorPluginDir: this.options.vendorPluginDir,
      installDir: this.options.installDir ?? path.join(this.options.dataDir, "figma", "plugin"),
      backoffMs: INSTALL_BACKOFF_MS,
      lastFailureAt: this.lastInstallFailureAt,
      now: this.now,
    });
    if (result.ok) {
      this.lastInstallFailureAt = 0;
      this.install = {
        pluginInstalled: true,
        pluginVersion: readVendorPluginVersion(result.dir),
        manifestPath: path.join(result.dir, "manifest.json"),
      };
      this.notifyChange({ fileKey: null });
    } else {
      if (result.error !== "backoff") {
        this.lastInstallFailureAt = this.now();
        this.options.logger.warn({ error: result.error }, "figma link plugin install failed");
      }
    }
  }
}

const MIME_TYPES: Record<"png" | "jpg" | "svg" | "pdf", string> = {
  png: "image/png",
  jpg: "image/jpeg",
  svg: "image/svg+xml",
  pdf: "application/pdf",
};

function readVendorPluginVersion(installDir: string): string | null {
  try {
    const manifest = JSON.parse(readFileSync(path.join(installDir, "manifest.json"), "utf8")) as {
      version?: string;
    };
    return manifest.version ?? null;
  } catch {
    return existsSync(installDir) ? null : null;
  }
}

function tempIdsOf(op: FigmaEditOp): string[] {
  const tempId = "tempId" in op ? op.tempId : undefined;
  return tempId ? [tempId] : [];
}

function extractCreatedNodeId(data: unknown): string | undefined {
  if (!data || typeof data !== "object") return undefined;
  const record = data as Record<string, unknown>;
  if (typeof record.nodeId === "string" && record.nodeId) return record.nodeId;
  const duplicates = record.duplicates;
  if (Array.isArray(duplicates)) {
    const first = duplicates[0] as Record<string, unknown> | undefined;
    if (first && typeof first.nodeId === "string") return first.nodeId;
  }
  return undefined;
}

function isLoopback(address: string): boolean {
  if (!address) return true; // unix-socket dial-in
  return address.startsWith("127.") || address === "::1" || address === "::ffff:127.0.0.1";
}
