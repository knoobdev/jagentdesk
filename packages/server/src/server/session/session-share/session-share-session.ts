import type pino from "pino";
import type { SessionInboundMessage, SessionOutboundMessage } from "../../messages.js";
import type { SessionShareService } from "../../session-share/service.js";

/**
 * Host-side session-sharing RPC surface (spec §21 / ADR-0018). These are host↔daemon over the
 * main /ws (host token). The guest surface is a separate scoped server behind the tunnel.
 */
export interface SessionShareSessionHost {
  emit(msg: SessionOutboundMessage): void;
}

export interface SessionShareSessionOptions {
  host: SessionShareSessionHost;
  sessionShareService: SessionShareService;
  logger: pino.Logger;
}

type ShareRequest = Extract<
  SessionInboundMessage,
  {
    type:
      | "session.share.create.request"
      | "session.share.stop.request"
      | "session.share.list.request"
      | "session.share.kick.request"
      | "session.share.respond.request"
      | "session.share.set_options.request";
  }
>;

export class SessionShareSession {
  private readonly host: SessionShareSessionHost;
  private readonly service: SessionShareService;
  private readonly logger: pino.Logger;

  constructor(options: SessionShareSessionOptions) {
    this.host = options.host;
    this.service = options.sessionShareService;
    this.logger = options.logger;
  }

  private emitRpcError(request: ShareRequest, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    const code =
      typeof (error as { code?: unknown })?.code === "string"
        ? (error as { code: string }).code
        : "session_share_request_failed";
    this.logger.error({ err: error, requestType: request.type }, "Session share request failed");
    this.host.emit({
      type: "rpc_error",
      payload: { requestId: request.requestId, requestType: request.type, error: message, code },
    });
  }

  async handleCreateRequest(
    request: Extract<SessionInboundMessage, { type: "session.share.create.request" }>,
  ): Promise<void> {
    try {
      const share = await this.service.create({
        agentId: request.agentId,
        shareFullHistory: request.shareFullHistory,
        shareDraftPreview: request.shareDraftPreview,
        requireHostApproval: request.requireHostApproval,
        allowGuestModelMode: request.allowGuestModelMode,
      });
      this.host.emit({
        type: "session.share.create.response",
        payload: { requestId: request.requestId, share, error: null },
      });
    } catch (error) {
      this.emitRpcError(request, error);
    }
  }

  async handleStopRequest(
    request: Extract<SessionInboundMessage, { type: "session.share.stop.request" }>,
  ): Promise<void> {
    try {
      const share = await this.service.stopShare(request.shareId);
      this.host.emit({
        type: "session.share.stop.response",
        payload: { requestId: request.requestId, share, error: null },
      });
    } catch (error) {
      this.emitRpcError(request, error);
    }
  }

  async handleKickRequest(
    request: Extract<SessionInboundMessage, { type: "session.share.kick.request" }>,
  ): Promise<void> {
    try {
      const share = this.service.kick(request.shareId, request.memberId);
      this.host.emit({
        type: "session.share.kick.response",
        payload: { requestId: request.requestId, share, error: null },
      });
    } catch (error) {
      this.emitRpcError(request, error);
    }
  }

  async handleRespondRequest(
    request: Extract<SessionInboundMessage, { type: "session.share.respond.request" }>,
  ): Promise<void> {
    try {
      const share = this.service.respond(request.shareId, request.joinRequestId, request.accept);
      this.host.emit({
        type: "session.share.respond.response",
        payload: { requestId: request.requestId, share, error: null },
      });
    } catch (error) {
      this.emitRpcError(request, error);
    }
  }

  async handleSetOptionsRequest(
    request: Extract<SessionInboundMessage, { type: "session.share.set_options.request" }>,
  ): Promise<void> {
    try {
      const share = this.service.setOptions(request.shareId, {
        allowGuestModelMode: request.allowGuestModelMode,
      });
      this.host.emit({
        type: "session.share.set_options.response",
        payload: { requestId: request.requestId, share, error: null },
      });
    } catch (error) {
      this.emitRpcError(request, error);
    }
  }

  async handleListRequest(
    request: Extract<SessionInboundMessage, { type: "session.share.list.request" }>,
  ): Promise<void> {
    try {
      const shares = this.service.list();
      this.host.emit({
        type: "session.share.list.response",
        payload: { requestId: request.requestId, shares },
      });
    } catch (error) {
      this.emitRpcError(request, error);
    }
  }
}
