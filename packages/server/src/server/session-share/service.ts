import { randomBytes, randomInt } from "node:crypto";
import type { Logger } from "pino";
import type { AgentManager } from "../agent/agent-manager.js";
import type { AgentStorage } from "../agent/agent-storage.js";
import { sendPromptToAgent } from "../agent/agent-prompt.js";
import type { AgentTimelineItem } from "../agent/agent-sdk-types.js";
import { TunnelManager, CloudflaredMissingError } from "./tunnel-manager.js";
import {
  ShareServer,
  type GuestMember,
  type ShareRequestSnapshot,
  type TranscriptRow,
} from "./share-server.js";
import type {
  SessionShare,
  SessionShareMember,
  SessionShareRequest,
} from "@jagentdesk/protocol/messages";

// Session sharing orchestrator (spec §21 / ADR-0018). Owns the live shares: each is a scoped
// ShareServer (guest web + guest WS on a loopback port) fronted by a Cloudflare quick tunnel.
// In-memory only — tunnels are child processes, so nothing survives a daemon restart (nor
// should it: the public URL would be dead). Default OFF (§21.11): constructed only when
// daemon.sessionSharing.enabled.
//
// Join flow (§21.5): guest opens link → requests to join → the host gets an auto Accept/Reject
// dialog on every connected device → on Accept the DAEMON mints the 6-digit code (single
// source, so multi-device dialogs never conflict) and shows it to the host, who relays it →
// guest enters it → joins.

const SHARE_TTL_MS = 60 * 60 * 1000; // §21.3: default 60 minutes

export class CloudflaredMissingRpcError extends Error {
  code = "cloudflared_missing";
  constructor() {
    super(
      "cloudflared is not installed on the daemon host. Install it to share sessions (e.g. `brew install cloudflared`).",
    );
    this.name = "CloudflaredMissingRpcError";
  }
}

type ShareAgentManager = Pick<
  AgentManager,
  "getAgent" | "fetchTimeline" | "setAgentMode" | "setAgentModel"
>;

interface LiveShare {
  share: SessionShare;
  server: ShareServer;
  stopTunnel: () => Promise<void>;
  expiryTimer: ReturnType<typeof setTimeout>;
}

export interface SessionShareServiceOptions {
  logger: Logger;
  agentManager: ShareAgentManager;
  agentStorage: AgentStorage;
  tunnelManager: TunnelManager;
  onUpdate?: (share: SessionShare) => void;
  now?: () => number;
}

function toTranscript(items: { seq: number; item: AgentTimelineItem }[]): TranscriptRow[] {
  const rows: TranscriptRow[] = [];
  for (const { seq, item } of items) {
    if (item.type === "user_message") rows.push({ seq, role: "user", text: item.text });
    else if (item.type === "assistant_message")
      rows.push({ seq, role: "assistant", text: item.text });
    else if (item.type === "error") rows.push({ seq, role: "error", text: item.message });
    else if (item.type === "tool_call") {
      const label = item.title || item.toolName || "tool";
      rows.push({ seq, role: "tool", text: `⚙ ${label}` });
    }
  }
  return rows;
}

export class SessionShareService {
  private readonly logger: Logger;
  private readonly agentManager: ShareAgentManager;
  private readonly agentStorage: AgentStorage;
  private readonly tunnelManager: TunnelManager;
  private readonly onUpdate?: (share: SessionShare) => void;
  private readonly now: () => number;
  private readonly shares = new Map<string, LiveShare>();

  constructor(options: SessionShareServiceOptions) {
    this.logger = options.logger.child({ module: "session-share-service" });
    this.agentManager = options.agentManager;
    this.agentStorage = options.agentStorage;
    this.tunnelManager = options.tunnelManager;
    this.onUpdate = options.onUpdate;
    this.now = options.now ?? (() => Date.now());
  }

  async stop(): Promise<void> {
    await Promise.all([...this.shares.keys()].map((id) => this.teardown(id, "revoked")));
  }

  list(): SessionShare[] {
    return [...this.shares.values()].map((s) => s.share);
  }

  async create(input: {
    agentId: string;
    shareFullHistory?: boolean;
    shareDraftPreview?: boolean;
    requireHostApproval?: boolean;
    allowGuestModelMode?: boolean;
  }): Promise<SessionShare> {
    const { agentId } = input;
    if (!this.agentManager.getAgent(agentId)) {
      throw new Error(`Agent ${agentId} is not active`);
    }
    for (const [id, live] of this.shares) {
      if (live.share.agentId === agentId) await this.teardown(id, "revoked");
    }

    const shareId = `share_${randomBytes(6).toString("hex")}`;
    const now = this.now();
    const record = await this.agentStorage.get(agentId);
    const agentLabel = record?.title?.trim() || "Agent";
    const shareFullHistory = input.shareFullHistory ?? false;
    const shareDraftPreview = input.shareDraftPreview ?? false;
    const allowGuestModelMode = input.allowGuestModelMode ?? false;

    const startSeq = shareFullHistory ? -1 : this.currentMaxSeq(agentId);
    const fetchTranscript = (): TranscriptRow[] =>
      toTranscript(this.fetchRows(agentId).filter((r) => r.seq > startSeq));

    const share: SessionShare = {
      shareId,
      agentId,
      status: "active",
      tunnelUrl: null,
      createdAt_ms: now,
      expiresAt_ms: now + SHARE_TTL_MS,
      shareFullHistory,
      shareDraftPreview,
      requireHostApproval: input.requireHostApproval ?? true,
      allowGuestModelMode,
      pendingRequests: [],
      members: [],
    };

    const server = new ShareServer({
      agentLabel,
      sendPrompt: async (text) => {
        await sendPromptToAgent({
          agentId,
          prompt: text,
          agentManager: this.agentManager as unknown as AgentManager,
          agentStorage: this.agentStorage,
          logger: this.logger,
          unarchive: false,
        });
      },
      fetchTranscript,
      shareDraftPreview,
      allowGuestModelMode,
      // Guest model/mode change (spec §21.6) — honored by ShareServer only while the share's
      // allowGuestModelMode is ON. Modes come straight off the live agent snapshot.
      getModes: () => {
        const agent = this.agentManager.getAgent(agentId);
        return {
          modes: (agent?.availableModes ?? []).map((m) => ({ id: m.id, label: m.label })),
          currentModeId: agent?.currentModeId ?? null,
        };
      },
      setMode: async (modeId) => {
        await this.agentManager.setAgentMode(agentId, modeId);
      },
      onStateChanged: (snapshot) => this.applyState(shareId, snapshot),
      logger: this.logger,
    });

    const port = await server.start();

    let tunnelUrl: string;
    let stopTunnel: () => Promise<void>;
    try {
      const tunnel = await this.tunnelManager.start(port);
      tunnelUrl = tunnel.url;
      stopTunnel = tunnel.stop;
    } catch (error) {
      await server.stop();
      if (error instanceof CloudflaredMissingError) throw new CloudflaredMissingRpcError();
      throw error;
    }

    share.tunnelUrl = tunnelUrl;
    const expiryTimer = setTimeout(() => {
      void this.teardown(shareId, "expired");
    }, SHARE_TTL_MS);
    (expiryTimer as unknown as { unref?: () => void }).unref?.();

    this.shares.set(shareId, { share, server, stopTunnel, expiryTimer });
    this.emit(share);
    this.logger.info({ shareId, agentId, tunnelUrl }, "Session share created");
    return share;
  }

  // Host Accept/Reject of a guest's join request. On accept, the daemon mints the 6-digit code
  // (single source → no conflict across the host's devices) and reveals it to the host.
  respond(shareId: string, joinRequestId: string, accept: boolean): SessionShare {
    const live = this.shares.get(shareId);
    if (!live) throw new Error(`Share not found: ${shareId}`);
    if (accept) {
      const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
      live.server.approveRequest(joinRequestId, code);
    } else {
      live.server.rejectRequest(joinRequestId);
    }
    return live.share;
  }

  // Host toggles the model/mode grant live (spec §21.6). Takes effect immediately: the guest
  // surface shows/hides its mode control and the daemon starts/stops honoring guest set-mode.
  setOptions(shareId: string, opts: { allowGuestModelMode?: boolean }): SessionShare {
    const live = this.shares.get(shareId);
    if (!live) throw new Error(`Share not found: ${shareId}`);
    if (opts.allowGuestModelMode !== undefined) {
      live.share = { ...live.share, allowGuestModelMode: opts.allowGuestModelMode };
      live.server.setAllowGuestModelMode(opts.allowGuestModelMode);
    }
    this.emit(live.share);
    return live.share;
  }

  async stopShare(shareId: string): Promise<SessionShare> {
    if (!this.shares.get(shareId)) throw new Error(`Share not found: ${shareId}`);
    return this.teardown(shareId, "revoked");
  }

  kick(shareId: string, memberId: string): SessionShare {
    const live = this.shares.get(shareId);
    if (!live) throw new Error(`Share not found: ${shareId}`);
    live.server.kick(memberId);
    return live.share;
  }

  private async teardown(shareId: string, status: "revoked" | "expired"): Promise<SessionShare> {
    const live = this.shares.get(shareId);
    if (!live) throw new Error(`Share not found: ${shareId}`);
    this.shares.delete(shareId);
    clearTimeout(live.expiryTimer);
    await live.server.stop().catch(() => undefined);
    await live.stopTunnel().catch(() => undefined);
    const stopped: SessionShare = {
      ...live.share,
      status,
      tunnelUrl: null,
      pendingRequests: [],
      members: [],
    };
    this.emit(stopped);
    this.logger.info({ shareId, status }, "Session share stopped");
    return stopped;
  }

  private applyState(
    shareId: string,
    snapshot: { members: GuestMember[]; requests: ShareRequestSnapshot[] },
  ): void {
    const live = this.shares.get(shareId);
    if (!live) return;
    const members: SessionShareMember[] = snapshot.members.map((g) => ({
      memberId: g.memberId,
      kind: "guest",
      label: g.label,
      joinedAt_ms: g.joinedAt_ms,
      lastSeen_ms: g.lastSeen_ms,
      typing: g.typing,
    }));
    const pendingRequests: SessionShareRequest[] = snapshot.requests.map((r) => ({
      requestId: r.requestId,
      label: r.label,
      requestedAt_ms: r.requestedAt_ms,
      status: r.status,
      code: r.code,
    }));
    live.share = { ...live.share, members, pendingRequests };
    this.emit(live.share);
  }

  private fetchRows(agentId: string): { seq: number; item: AgentTimelineItem }[] {
    try {
      return this.agentManager.fetchTimeline(agentId, { direction: "tail", limit: 0 }).rows;
    } catch {
      return [];
    }
  }

  private currentMaxSeq(agentId: string): number {
    const rows = this.fetchRows(agentId);
    return rows.length > 0 ? (rows[rows.length - 1]?.seq ?? 0) : 0;
  }

  private emit(share: SessionShare): void {
    this.onUpdate?.(share);
  }
}
