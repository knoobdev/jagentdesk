import { randomBytes, randomInt } from "node:crypto";
import type { Logger } from "pino";
import type { AgentManager } from "../agent/agent-manager.js";
import type { AgentStorage } from "../agent/agent-storage.js";
import { sendPromptToAgent } from "../agent/agent-prompt.js";
import type { AgentTimelineItem } from "../agent/agent-sdk-types.js";
import type { WebSocket as WsSocket } from "ws";
import { TunnelManager, CloudflaredMissingError } from "./tunnel-manager.js";
import { guestScopesForCapabilities } from "./guest-scopes.js";
import {
  ShareServer,
  type GuestMember,
  type ShareActivity,
  type ShareRequestSnapshot,
  type TranscriptRow,
} from "./share-server.js";
import type {
  SessionShare,
  SessionShareCapabilities,
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

// A minted guest token → the scope it unlocks. Capabilities are resolved LIVE from the share at
// connect time (so host toggles apply), so we only store identity here.
export interface GuestGrant {
  token: string;
  shareId: string;
  agentId: string;
  memberId: string;
  label: string;
  device: string;
  // Workspace root (the shared agent's cwd) the guest's file/diff RPCs are confined to. null when
  // the agent has no resolvable cwd — the file guard then denies every file RPC (ADR-0019).
  workspaceCwd: string | null;
}

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
  // App web build directory served to guests as the real UI (ADR-0019); bespoke page if unset.
  appDistDir?: string;
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
  return coalesceRows(rows);
}

// While the agent is streaming, its assistant message arrives as many small delta rows; the raw
// timeline (and thus the guest) would otherwise shatter one reply into dozens of bubbles. Merge
// adjacent rows of the same non-tool role into a single bubble so the guest sees one clean message
// (matching how the desktop/mobile composer coalesces a turn). Tool calls stay individual.
function coalesceRows(rows: TranscriptRow[]): TranscriptRow[] {
  const out: TranscriptRow[] = [];
  for (const row of rows) {
    const prev = out[out.length - 1];
    if (prev && prev.role === row.role && row.role !== "tool") {
      prev.text = `${prev.text}${row.text}`;
      prev.seq = row.seq;
    } else {
      out.push({ ...row });
    }
  }
  return out;
}

// The workspace root a guest's file/diff RPCs are confined to (the shared agent's cwd). null when
// the agent has no usable cwd → the Session file guard then denies every file RPC (ADR-0019).
function resolveWorkspaceCwd(record: { cwd?: string } | null | undefined): string | null {
  const cwd = record?.cwd;
  return typeof cwd === "string" && cwd.trim().length > 0 ? cwd : null;
}

// Build the initial capability set for a share (chat always on; everything else opt-in). Extracted
// to keep SessionShareService.create's cyclomatic complexity within budget.
function resolveInitialCapabilities(
  requested: Partial<SessionShareCapabilities> | undefined,
  allowGuestModelMode: boolean | undefined,
): SessionShareCapabilities {
  return {
    chat: true,
    files: requested?.files ?? false,
    terminal: requested?.terminal ?? false,
    modelMode: requested?.modelMode ?? allowGuestModelMode ?? false,
    readOnly: requested?.readOnly ?? false,
    artifacts: requested?.artifacts ?? false,
  };
}

export class SessionShareService {
  private readonly logger: Logger;
  private readonly agentManager: ShareAgentManager;
  private readonly agentStorage: AgentStorage;
  private readonly tunnelManager: TunnelManager;
  private readonly onUpdate?: (share: SessionShare) => void;
  private readonly now: () => number;
  private readonly appDistDir?: string;
  private readonly shares = new Map<string, LiveShare>();
  private readonly guestTokens = new Map<string, GuestGrant>(); // token → grant
  // Set by bootstrap once the websocket-server exists: attaches a validated guest socket as a
  // scoped real-protocol session (ADR-0019). Kept as a setter to break the bootstrap ordering
  // cycle (service is constructed before the websocket-server).
  private guestAttacher:
    | ((
        ws: WsSocket,
        params: {
          agentId: string;
          scopes: readonly string[];
          workspaceCwd: string | null;
          onGuestActivity?: (text: string) => void;
        },
      ) => void)
    | null = null;

  setGuestAttacher(
    fn: (
      ws: WsSocket,
      params: {
        agentId: string;
        scopes: readonly string[];
        workspaceCwd: string | null;
        onGuestActivity?: (text: string) => void;
      },
    ) => void,
  ): void {
    this.guestAttacher = fn;
  }

  // Resolve a guest token to its grant + the share's CURRENT capabilities (live, so host toggles
  // apply). Returns null if the token is unknown or its share is gone. Used by the scoped /ws path.
  validateGuestToken(
    token: string,
  ): { grant: GuestGrant; capabilities: SessionShareCapabilities } | null {
    const grant = this.guestTokens.get(token);
    if (!grant) return null;
    const live = this.shares.get(grant.shareId);
    if (!live || live.share.status !== "active") return null;
    return { grant, capabilities: live.share.capabilities };
  }

  constructor(options: SessionShareServiceOptions) {
    this.logger = options.logger.child({ module: "session-share-service" });
    this.agentManager = options.agentManager;
    this.agentStorage = options.agentStorage;
    this.tunnelManager = options.tunnelManager;
    this.onUpdate = options.onUpdate;
    this.now = options.now ?? (() => Date.now());
    this.appDistDir = options.appDistDir;
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
    capabilities?: Partial<SessionShareCapabilities>;
  }): Promise<SessionShare> {
    const { agentId } = input;
    if (!this.agentManager.getAgent(agentId)) {
      throw new Error(`Agent ${agentId} is not active`);
    }
    // An agent may have several concurrent shares (separate links/codes for different people or
    // groups, each revocable on its own). We no longer tear down the agent's existing shares here.

    const shareId = `share_${randomBytes(6).toString("hex")}`;
    const now = this.now();
    const record = await this.agentStorage.get(agentId);
    const agentLabel = record?.title?.trim() || "Agent";
    // The workspace root the guest's file/diff RPCs are confined to (defense-in-depth on top of the
    // capability scope). null when the agent has no cwd → the file guard denies all file RPCs.
    const workspaceCwd = resolveWorkspaceCwd(record);
    // Default ON so a guest lands in the existing conversation (spec §21.4): joining a share and
    // seeing an empty pane is confusing. The host can still create a from-now share explicitly.
    const shareFullHistory = input.shareFullHistory ?? true;
    const shareDraftPreview = input.shareDraftPreview ?? false;
    const capabilities = resolveInitialCapabilities(input.capabilities, input.allowGuestModelMode);
    const allowGuestModelMode = capabilities.modelMode;

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
      capabilities,
      pendingRequests: [],
      members: [],
      recentActivity: [],
    };

    const server = new ShareServer({
      agentLabel,
      agentId,
      workspaceCwd,
      appDistDir: this.appDistDir,
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
      // Live capabilities so the guest app's share hint shows only the granted tabs (ADR-0019).
      getCapabilities: () => this.shares.get(shareId)?.share.capabilities ?? capabilities,
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
      // On successful pairing, mint a guest token the real app uses to open the scoped /ws and
      // render the actual chat UI (ADR-0019). Token → {shareId, agentId, member}.
      mintGuestToken: (member) => {
        const token = `gt_${randomBytes(24).toString("hex")}`;
        this.guestTokens.set(token, {
          token,
          shareId,
          agentId,
          memberId: member.memberId,
          label: member.label,
          device: member.device,
          workspaceCwd,
        });
        return token;
      },
      // Validate a guest token on the scoped /ws and hand the socket to the daemon as a real,
      // agent-confined session (ADR-0019). Capabilities are resolved live.
      attachGuestWs: (ws, token) => {
        const resolved = this.validateGuestToken(token);
        if (!resolved || !this.guestAttacher) return false;
        const grant = resolved.grant;
        this.guestAttacher(ws, {
          agentId: grant.agentId,
          scopes: guestScopesForCapabilities(resolved.capabilities),
          workspaceCwd: grant.workspaceCwd,
          // Attribute the guest's real-protocol messages back onto the share so the host sees
          // who·device·what (recentActivity), like the bespoke channel did (ADR-0019).
          onGuestActivity: (text) =>
            this.shares
              .get(grant.shareId)
              ?.server.recordGuestActivity(
                { memberId: grant.memberId, label: grant.label, device: grant.device },
                text,
              ),
        });
        return true;
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

  // Host toggles share capabilities live (spec §21.6 / ADR-0019): model/mode grant or any other
  // capability. Takes effect immediately for connected guests.
  setOptions(
    shareId: string,
    opts: { allowGuestModelMode?: boolean; capabilities?: Partial<SessionShareCapabilities> },
  ): SessionShare {
    const live = this.shares.get(shareId);
    if (!live) throw new Error(`Share not found: ${shareId}`);
    const capabilities: SessionShareCapabilities = {
      ...live.share.capabilities,
      ...opts.capabilities,
      chat: true,
    };
    if (opts.allowGuestModelMode !== undefined) capabilities.modelMode = opts.allowGuestModelMode;
    live.share = { ...live.share, capabilities, allowGuestModelMode: capabilities.modelMode };
    live.server.setAllowGuestModelMode(capabilities.modelMode);
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
    for (const [token, grant] of this.guestTokens) {
      if (grant.shareId === shareId) this.guestTokens.delete(token);
    }
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
    snapshot: {
      members: GuestMember[];
      requests: ShareRequestSnapshot[];
      activity: ShareActivity[];
    },
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
      device: g.device,
    }));
    const pendingRequests: SessionShareRequest[] = snapshot.requests.map((r) => ({
      requestId: r.requestId,
      label: r.label,
      requestedAt_ms: r.requestedAt_ms,
      status: r.status,
      code: r.code,
      device: r.device,
      failedAttempts: r.failedAttempts,
      lockedUntil_ms: r.lockedUntil_ms,
    }));
    live.share = { ...live.share, members, pendingRequests, recentActivity: snapshot.activity };
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
