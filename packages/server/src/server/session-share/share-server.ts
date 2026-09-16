import { createServer, type Server } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, normalize, extname } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import type { Logger } from "pino";
import type { SessionShareCapabilities } from "@jagentdesk/protocol/messages";
import { renderGuestPage } from "./guest-page.js";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
};

function shareHintScript(
  agentId: string,
  agentLabel: string,
  capabilities: SessionShareCapabilities,
  workspaceCwd: string | null,
): string {
  const json = JSON.stringify({ agentId, agentLabel, capabilities, workspaceCwd }).replace(
    /</g,
    "\\u003c",
  );
  return `<script>window.__JAGENTDESK_SHARE__=${json};</script>`;
}

// Scoped per-share HTTP + WebSocket server (spec §21 / ADR-0018). The ONLY thing the
// Cloudflare tunnel exposes. Bespoke, minimal surface: a guest requests to join, the host
// Accepts/Rejects, on accept the host relays a 6-digit code the guest enters, then the guest
// can read the shared agent's transcript, send prompts, and share presence — nothing else.
// Scope is enforced by construction (this is not the full Session), never by trusting the guest.

export interface TranscriptRow {
  seq: number;
  role: "user" | "assistant" | "tool" | "error";
  text: string;
}

export interface GuestMember {
  memberId: string;
  label: string;
  typing: boolean;
  draft: string | null;
  joinedAt_ms: number;
  lastSeen_ms: number;
  device: string;
}

export interface ShareRequestSnapshot {
  requestId: string;
  label: string;
  requestedAt_ms: number;
  status: "pending" | "approved";
  code: string | null;
  device: string;
  failedAttempts: number;
  lockedUntil_ms: number | null;
}

export interface ShareActivity {
  memberId: string;
  label: string;
  device: string;
  text: string;
  at_ms: number;
}

export interface ShareModesSnapshot {
  modes: { id: string; label: string }[];
  currentModeId: string | null;
}

export interface ShareServerOptions {
  agentLabel: string;
  agentId: string;
  // The shared agent's workspace root, injected into the guest app share hint so the Files/Changes
  // tabs can resolve the directory without depending on a fetch_agent round-trip. null → no cwd.
  workspaceCwd?: string | null;
  // Directory of the app web build (app-dist) to serve as the guest surface (ADR-0019). When set,
  // `/` serves the real app SPA with an injected share hint; when absent, the bespoke page is used.
  appDistDir?: string;
  sendPrompt: (text: string) => Promise<void>;
  fetchTranscript: () => TranscriptRow[];
  shareDraftPreview: boolean;
  // Guest model/mode grant (spec §21.6). When ON, the guest surface shows a mode picker and the
  // server honors guest set-mode; when OFF the control is hidden and set-mode is rejected. The
  // host toggles this live via setAllowGuestModelMode().
  allowGuestModelMode: boolean;
  // Live capabilities of this share, read at page-serve time to seed the guest app's share hint so
  // it shows only the tabs the host granted (chat/files/…). Reflects the grant at page load.
  getCapabilities?: () => SessionShareCapabilities;
  getModes?: () => ShareModesSnapshot;
  setMode?: (modeId: string) => Promise<void>;
  // Mint a guest token on successful pairing; the real app uses it to open the scoped /ws.
  mintGuestToken?: (member: { memberId: string; label: string; device: string }) => string;
  // Validate a guest token + attach the socket as a scoped real-protocol session (ADR-0019).
  // Returns true if accepted; false → the socket is closed. Wired by bootstrap to the daemon's
  // websocket-server.attachGuestSocket after resolving the token to {agentId, capabilities}.
  attachGuestWs?: (ws: WebSocket, token: string) => boolean;
  // Reports the full live snapshot (authed members + pending/approved join requests) whenever
  // it changes, so the service can mirror it onto the share + stream it to host devices.
  onStateChanged: (snapshot: {
    members: GuestMember[];
    requests: ShareRequestSnapshot[];
    activity: ShareActivity[];
  }) => void;
  logger: Logger;
}

const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_WINDOW_MS = 60_000;
const POLL_MS = 1500;

type Phase = "new" | "pending" | "approved" | "authed";

interface GuestConn {
  ws: WebSocket;
  phase: Phase;
  requestId: string;
  label: string;
  code: string | null; // set by the service on approve; the guest must enter it
  member: GuestMember;
  device: string;
  failed: number; // rolling count within the current window (drives lockout)
  totalFailed: number; // cumulative wrong-code attempts, shown to the host
  lockoutUntil: number;
}

export class ShareServer {
  private readonly opts: ShareServerOptions;
  private readonly logger: Logger;
  private server: Server | null = null;
  private wss: WebSocketServer | null = null;
  private guestWss: WebSocketServer | null = null;
  private readonly conns = new Map<string, GuestConn>(); // keyed by requestId
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private lastTranscriptJson = "";
  private guestCounter = 0;
  private allowGuestModelMode: boolean;
  private readonly activity: ShareActivity[] = []; // recent guest messages, capped

  constructor(options: ShareServerOptions) {
    this.opts = options;
    this.logger = options.logger.child({ module: "share-server" });
    this.allowGuestModelMode = options.allowGuestModelMode;
  }

  // Host toggled the model/mode grant (spec §21.6). Push the new capability to connected guests
  // so their mode picker appears/disappears immediately.
  setAllowGuestModelMode(value: boolean): void {
    this.allowGuestModelMode = value;
    this.broadcastModes();
  }

  async start(): Promise<number> {
    const server = createServer((req, res) => {
      if (req.method !== "GET") {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("Not found");
        return;
      }
      if (this.opts.appDistDir) {
        this.serveApp(req.url ?? "/", res);
        return;
      }
      // Fallback (no app build available): bespoke minimal page.
      if (req.url === "/" || req.url?.startsWith("/?")) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(renderGuestPage(this.opts.agentLabel));
        return;
      }
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("Not found");
    });
    // Two WS endpoints on one http server: `/guest` (bespoke pairing channel) and `/ws` (scoped
    // real-protocol channel, ADR-0019). Use `noServer` + a single upgrade router — attaching two
    // `WebSocketServer`s via the `server` option makes both try to handle every upgrade (ws gotcha).
    const wss = new WebSocketServer({ noServer: true });
    wss.on("connection", (ws, req) => this.onGuest(ws, parseDevice(req.headers["user-agent"])));
    const guestWss = new WebSocketServer({
      noServer: true,
      handleProtocols: (protocols) => [...protocols][0] ?? false,
    });
    guestWss.on("connection", (ws, req) => {
      const token = extractBearerToken(req.headers["sec-websocket-protocol"]);
      if (!token || !this.opts.attachGuestWs?.(ws, token)) {
        try {
          ws.close();
        } catch {
          // ignore
        }
      }
    });
    server.on("upgrade", (req, socket, head) => {
      const path = (req.url ?? "").split("?")[0];
      if (path === "/guest") {
        wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
      } else if (path === "/ws") {
        guestWss.handleUpgrade(req, socket, head, (ws) => guestWss.emit("connection", ws, req));
      } else {
        socket.destroy();
      }
    });
    this.server = server;
    this.wss = wss;
    this.guestWss = guestWss;

    this.lastTranscriptJson = JSON.stringify(this.opts.fetchTranscript());

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    this.pollTimer = setInterval(() => this.pumpTranscript(), POLL_MS);
    (this.pollTimer as unknown as { unref?: () => void }).unref?.();
    this.logger.info({ port }, "Share server listening");
    return port;
  }

  async stop(): Promise<void> {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    for (const c of this.conns.values()) {
      this.safeSend(c.ws, { t: "ended", reason: "Share ended" });
      try {
        c.ws.close();
      } catch {
        // ignore
      }
    }
    this.conns.clear();
    await new Promise<void>((resolve) => {
      if (!this.server) return resolve();
      // Forcibly terminate any live sockets first. wss.close() only stops NEW upgrades — it leaves
      // already-upgraded sockets open, and http server.close() waits for every open connection to
      // drain before its callback fires. A connected scoped /ws guest would therefore hang stop()
      // (and the host's Stop-share RPC) indefinitely. terminate() drops them immediately.
      for (const client of this.wss?.clients ?? []) client.terminate();
      for (const client of this.guestWss?.clients ?? []) client.terminate();
      this.wss?.close();
      this.guestWss?.close();
      this.server.close(() => resolve());
      this.server = null;
    });
  }

  // Host accepted a join request: the service passes the daemon-minted 6-digit code, which the
  // host will read out to the guest. The guest is told to enter it now.
  approveRequest(requestId: string, code: string): void {
    const c = this.conns.get(requestId);
    if (!c || c.phase !== "pending") return;
    c.phase = "approved";
    c.code = code;
    this.safeSend(c.ws, { t: "approved" });
    this.emitState();
  }

  rejectRequest(requestId: string): void {
    const c = this.conns.get(requestId);
    if (!c) return;
    this.safeSend(c.ws, { t: "rejected", reason: "The host declined the request." });
    try {
      c.ws.close();
    } catch {
      // ignore
    }
    this.conns.delete(requestId);
    this.emitState();
  }

  kick(memberId: string): void {
    for (const [rid, c] of this.conns) {
      if (c.member.memberId === memberId) {
        this.safeSend(c.ws, { t: "ended", reason: "Removed by host" });
        try {
          c.ws.close();
        } catch {
          // ignore
        }
        this.conns.delete(rid);
        this.emitState();
        return;
      }
    }
  }

  // Serve the app web build (SPA) as the guest surface. index.html gets the share hint injected;
  // unknown non-file paths fall back to index.html (client-side routing). Guards path traversal.
  private serveApp(url: string, res: import("node:http").ServerResponse): void {
    const distDir = this.opts.appDistDir as string;
    const pathname = decodeURIComponent(url.split("?")[0] || "/");
    const caps = this.opts.getCapabilities?.() ?? {
      chat: true,
      files: false,
      terminal: false,
      modelMode: this.opts.allowGuestModelMode,
    };
    const hint = shareHintScript(
      this.opts.agentId,
      this.opts.agentLabel,
      caps,
      this.opts.workspaceCwd ?? null,
    );
    const serveIndex = (): void => {
      try {
        const html = readFileSync(join(distDir, "index.html"), "utf8");
        const injected = html.includes("</head>")
          ? html.replace("</head>", `${hint}</head>`)
          : hint + html;
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
        });
        res.end(injected);
      } catch {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end("App build unavailable");
      }
    };
    if (pathname === "/" || pathname === "" || pathname === "/index.html") {
      serveIndex();
      return;
    }
    const target = normalize(join(distDir, pathname));
    if (!target.startsWith(normalize(distDir))) {
      res.writeHead(403, { "content-type": "text/plain" });
      res.end("Forbidden");
      return;
    }
    const ext = extname(target).toLowerCase();
    if (!ext) {
      // No extension → treat as a client-side route.
      serveIndex();
      return;
    }
    try {
      const body = readFileSync(target);
      res.writeHead(200, {
        "content-type": CONTENT_TYPES[ext] ?? "application/octet-stream",
        "cache-control": "public, max-age=31536000, immutable",
      });
      res.end(body);
    } catch {
      serveIndex();
    }
  }

  private onGuest(ws: WebSocket, device: string): void {
    const requestId = randomUUID();
    const conn: GuestConn = {
      ws,
      phase: "new",
      requestId,
      label: "",
      code: null,
      device,
      failed: 0,
      totalFailed: 0,
      lockoutUntil: 0,
      member: {
        memberId: randomUUID(),
        label: "",
        typing: false,
        draft: null,
        joinedAt_ms: Date.now(),
        lastSeen_ms: Date.now(),
        device,
      },
    };
    this.conns.set(requestId, conn);
    this.logger.info({ requestId, device }, "Guest connected to share server");
    this.safeSend(ws, { t: "hello", agentLabel: this.opts.agentLabel });

    ws.on("message", (data) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(data.toString()) as Record<string, unknown>;
      } catch {
        return;
      }
      conn.member.lastSeen_ms = Date.now();
      void this.handleGuestMessage(conn, msg);
    });
    ws.on("close", () => {
      this.conns.delete(requestId);
      this.emitState();
    });
    ws.on("error", () => {
      this.conns.delete(requestId);
    });
  }

  private async handleGuestMessage(conn: GuestConn, msg: Record<string, unknown>): Promise<void> {
    if (conn.phase === "new") {
      this.handleRequestPhase(conn, msg);
      return;
    }
    if (conn.phase === "approved") {
      this.handlePairPhase(conn, msg);
      return;
    }
    if (conn.phase === "authed") {
      await this.handleAuthedPhase(conn, msg);
    }
  }

  private handleRequestPhase(conn: GuestConn, msg: Record<string, unknown>): void {
    if (msg.t !== "request") return;
    const name = typeof msg.name === "string" ? msg.name.trim().slice(0, 40) : "";
    this.guestCounter += 1;
    conn.label = name || `Guest ${this.guestCounter}`;
    conn.member.label = conn.label;
    conn.phase = "pending";
    this.logger.info(
      { requestId: conn.requestId, label: conn.label },
      "Guest requested to join — awaiting host approval",
    );
    this.safeSend(conn.ws, { t: "pending" });
    this.emitState();
  }

  private handlePairPhase(conn: GuestConn, msg: Record<string, unknown>): void {
    if (msg.t !== "pair") return;
    const now = Date.now();
    if (now < conn.lockoutUntil) {
      this.safeSend(conn.ws, {
        t: "pair_result",
        ok: false,
        error: `Too many attempts. Try again in ${Math.ceil((conn.lockoutUntil - now) / 1000)}s.`,
      });
      return;
    }
    const input = typeof msg.code === "string" ? msg.code : "";
    if (!conn.code || !codesMatch(input, conn.code)) {
      conn.failed += 1;
      conn.totalFailed += 1;
      let locked = false;
      if (conn.failed >= MAX_FAILED_ATTEMPTS) {
        conn.lockoutUntil = now + LOCKOUT_WINDOW_MS;
        conn.failed = 0;
        locked = true;
      }
      this.logger.warn(
        { requestId: conn.requestId, device: conn.device, totalFailed: conn.totalFailed, locked },
        "Guest entered an incorrect pairing code",
      );
      this.safeSend(conn.ws, {
        t: "pair_result",
        ok: false,
        error: locked
          ? `Too many attempts. Locked for ${Math.ceil(LOCKOUT_WINDOW_MS / 1000)}s.`
          : "Incorrect code.",
      });
      // Notify the host (desktop/mobile) so they see the device + failed-attempt count (spec §21.8).
      this.emitState();
      return;
    }
    conn.phase = "authed";
    conn.failed = 0;
    const guestToken = this.opts.mintGuestToken?.({
      memberId: conn.member.memberId,
      label: conn.label,
      device: conn.device,
    });
    this.safeSend(conn.ws, {
      t: "pair_result",
      ok: true,
      memberId: conn.member.memberId,
      guestToken,
    });
    this.safeSend(conn.ws, { t: "transcript", rows: this.opts.fetchTranscript() });
    this.sendModes(conn);
    this.emitState();
    this.broadcastPresence();
  }

  private async handleAuthedPhase(conn: GuestConn, msg: Record<string, unknown>): Promise<void> {
    switch (msg.t) {
      case "prompt": {
        const text = typeof msg.text === "string" ? msg.text.trim() : "";
        if (!text) return;
        conn.member.typing = false;
        conn.member.draft = null;
        // Record who sent what (name + device) so the host can attribute guest messages.
        this.activity.push({
          memberId: conn.member.memberId,
          label: conn.label,
          device: conn.device,
          text: text.slice(0, 500),
          at_ms: Date.now(),
        });
        if (this.activity.length > 30) this.activity.shift();
        this.logger.info(
          { requestId: conn.requestId, label: conn.label, device: conn.device },
          "Guest sent a message",
        );
        this.emitState();
        this.broadcastPresence();
        try {
          await this.opts.sendPrompt(text);
        } catch (error) {
          this.safeSend(conn.ws, {
            t: "error",
            message: error instanceof Error ? error.message : "Failed to send",
          });
        }
        return;
      }
      case "typing": {
        conn.member.typing = msg.typing === true;
        if (!conn.member.typing) conn.member.draft = null;
        this.emitState();
        this.broadcastPresence();
        return;
      }
      case "draft": {
        conn.member.draft =
          this.opts.shareDraftPreview && typeof msg.text === "string" ? msg.text : null;
        this.emitState();
        return;
      }
      case "set_mode": {
        // Spec §21.6: honored ONLY while the host's model/mode grant is ON. Never trust the
        // guest — re-check the live flag here, not just the hidden UI control.
        if (!this.allowGuestModelMode || !this.opts.setMode) {
          this.safeSend(conn.ws, { t: "error", message: "Changing mode isn't allowed." });
          return;
        }
        const modeId = typeof msg.modeId === "string" ? msg.modeId : "";
        if (!modeId) return;
        try {
          await this.opts.setMode(modeId);
        } catch (error) {
          this.safeSend(conn.ws, {
            t: "error",
            message: error instanceof Error ? error.message : "Failed to change mode",
          });
          return;
        }
        this.broadcastModes();
        return;
      }
      default:
        return;
    }
  }

  private sendModes(conn: GuestConn): void {
    const snapshot = this.allowGuestModelMode ? (this.opts.getModes?.() ?? null) : null;
    this.safeSend(conn.ws, {
      t: "modes",
      allowed: this.allowGuestModelMode,
      modes: snapshot?.modes ?? [],
      currentModeId: snapshot?.currentModeId ?? null,
    });
  }

  private broadcastModes(): void {
    for (const c of this.conns.values()) {
      if (c.phase === "authed") this.sendModes(c);
    }
  }

  // Push the FULL coalesced transcript snapshot whenever it changes (not per-row deltas): the
  // guest re-renders it, so a streaming reply reconciles into one clean bubble instead of many
  // fragments. Cheap: a share transcript is a handful of messages.
  private pumpTranscript(): void {
    const rows = this.opts.fetchTranscript();
    const json = JSON.stringify(rows);
    if (json === this.lastTranscriptJson) return;
    this.lastTranscriptJson = json;
    for (const c of this.conns.values()) {
      if (c.phase === "authed") this.safeSend(c.ws, { t: "transcript", rows });
    }
  }

  private broadcastPresence(): void {
    const members = this.authedMembers();
    for (const c of this.conns.values()) {
      if (c.phase === "authed") this.safeSend(c.ws, { t: "presence", members });
    }
  }

  private authedMembers(): GuestMember[] {
    return [...this.conns.values()].filter((c) => c.phase === "authed").map((c) => c.member);
  }

  private emitState(): void {
    const requests: ShareRequestSnapshot[] = [...this.conns.values()]
      .filter((c) => c.phase === "pending" || c.phase === "approved")
      .map((c) => ({
        requestId: c.requestId,
        label: c.label,
        requestedAt_ms: c.member.joinedAt_ms,
        status: c.phase === "approved" ? "approved" : "pending",
        code: c.code,
        device: c.device,
        failedAttempts: c.totalFailed,
        lockedUntil_ms: c.lockoutUntil > Date.now() ? c.lockoutUntil : null,
      }));
    this.opts.onStateChanged({
      members: this.authedMembers(),
      requests,
      activity: [...this.activity],
    });
  }

  private safeSend(ws: WebSocket, payload: unknown): void {
    try {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
    } catch {
      // ignore
    }
  }
}

// The guest token rides as a WS bearer subprotocol (reusing DaemonClient's `jagentdesk.bearer.<x>`
// wiring). Extract it from the Sec-WebSocket-Protocol header.
export function extractBearerToken(header: string | undefined): string | null {
  if (!header) return null;
  for (const raw of header.split(",")) {
    const proto = raw.trim();
    if (proto.startsWith("jagentdesk.bearer.")) return proto.slice("jagentdesk.bearer.".length);
  }
  return null;
}

// Best-effort human-readable device from a User-Agent, e.g. "Chrome on iPhone". Not for security —
// only so the host recognizes who is asking to join / entering a wrong code (spec §21.8).
export function parseDevice(ua: string | undefined): string {
  if (!ua) return "Unknown device";
  let os = "Unknown OS";
  if (/iPhone/.test(ua)) os = "iPhone";
  else if (/iPad/.test(ua)) os = "iPad";
  else if (/Android/.test(ua)) os = "Android";
  else if (/Macintosh|Mac OS X/.test(ua)) os = "macOS";
  else if (/Windows/.test(ua)) os = "Windows";
  else if (/Linux/.test(ua)) os = "Linux";
  let browser = "browser";
  if (/Edg\//.test(ua)) browser = "Edge";
  else if (/OPR\/|Opera/.test(ua)) browser = "Opera";
  else if (/Chrome\//.test(ua)) browser = "Chrome";
  else if (/Firefox\//.test(ua)) browser = "Firefox";
  else if (/Safari\//.test(ua)) browser = "Safari";
  return `${browser} on ${os}`;
}

// Constant-time 6-digit comparison.
export function codesMatch(input: string, expected: string): boolean {
  if (!/^\d{6}$/.test(input) || expected.length !== input.length) return false;
  try {
    return timingSafeEqual(Buffer.from(input), Buffer.from(expected));
  } catch {
    return false;
  }
}
