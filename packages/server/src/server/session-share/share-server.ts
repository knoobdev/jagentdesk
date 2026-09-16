import { createServer, type Server } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import type { Logger } from "pino";
import { renderGuestPage } from "./guest-page.js";

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
}

export interface ShareRequestSnapshot {
  requestId: string;
  label: string;
  requestedAt_ms: number;
  status: "pending" | "approved";
  code: string | null;
}

export interface ShareModesSnapshot {
  modes: { id: string; label: string }[];
  currentModeId: string | null;
}

export interface ShareServerOptions {
  agentLabel: string;
  sendPrompt: (text: string) => Promise<void>;
  fetchTranscript: () => TranscriptRow[];
  shareDraftPreview: boolean;
  // Guest model/mode grant (spec §21.6). When ON, the guest surface shows a mode picker and the
  // server honors guest set-mode; when OFF the control is hidden and set-mode is rejected. The
  // host toggles this live via setAllowGuestModelMode().
  allowGuestModelMode: boolean;
  getModes?: () => ShareModesSnapshot;
  setMode?: (modeId: string) => Promise<void>;
  // Reports the full live snapshot (authed members + pending/approved join requests) whenever
  // it changes, so the service can mirror it onto the share + stream it to host devices.
  onStateChanged: (snapshot: { members: GuestMember[]; requests: ShareRequestSnapshot[] }) => void;
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
  failed: number;
  lockoutUntil: number;
}

export class ShareServer {
  private readonly opts: ShareServerOptions;
  private readonly logger: Logger;
  private server: Server | null = null;
  private wss: WebSocketServer | null = null;
  private readonly conns = new Map<string, GuestConn>(); // keyed by requestId
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private lastSeq = 0;
  private guestCounter = 0;
  private allowGuestModelMode: boolean;

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
      if (req.method === "GET" && (req.url === "/" || req.url?.startsWith("/?"))) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(renderGuestPage(this.opts.agentLabel));
        return;
      }
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("Not found");
    });
    const wss = new WebSocketServer({ server, path: "/guest" });
    wss.on("connection", (ws) => this.onGuest(ws));
    this.server = server;
    this.wss = wss;

    const initial = this.opts.fetchTranscript();
    this.lastSeq = initial.length > 0 ? (initial[initial.length - 1]?.seq ?? 0) : 0;

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
      this.wss?.close();
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

  private onGuest(ws: WebSocket): void {
    const requestId = randomUUID();
    const conn: GuestConn = {
      ws,
      phase: "new",
      requestId,
      label: "",
      code: null,
      failed: 0,
      lockoutUntil: 0,
      member: {
        memberId: randomUUID(),
        label: "",
        typing: false,
        draft: null,
        joinedAt_ms: Date.now(),
        lastSeen_ms: Date.now(),
      },
    };
    this.conns.set(requestId, conn);
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
      if (conn.failed >= MAX_FAILED_ATTEMPTS) {
        conn.lockoutUntil = now + LOCKOUT_WINDOW_MS;
        conn.failed = 0;
      }
      this.safeSend(conn.ws, { t: "pair_result", ok: false, error: "Incorrect code." });
      return;
    }
    conn.phase = "authed";
    conn.failed = 0;
    this.safeSend(conn.ws, { t: "pair_result", ok: true, memberId: conn.member.memberId });
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

  private pumpTranscript(): void {
    const rows = this.opts.fetchTranscript();
    const fresh = rows.filter((r) => r.seq > this.lastSeq);
    if (fresh.length === 0) return;
    this.lastSeq = fresh[fresh.length - 1]?.seq ?? this.lastSeq;
    for (const c of this.conns.values()) {
      if (c.phase === "authed") this.safeSend(c.ws, { t: "append", rows: fresh });
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
      }));
    this.opts.onStateChanged({ members: this.authedMembers(), requests });
  }

  private safeSend(ws: WebSocket, payload: unknown): void {
    try {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
    } catch {
      // ignore
    }
  }
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
