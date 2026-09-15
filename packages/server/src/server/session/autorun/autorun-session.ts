import type pino from "pino";
import type { SessionInboundMessage, SessionOutboundMessage } from "../../messages.js";
import type { AutorunService } from "../../autorun/service.js";

/**
 * A client's autonomous-mode request surface (spec §20 / ADR-0017). Autonomous mode is a
 * switch on an EXISTING agent's chat, so every RPC is keyed by agentId. Stateless
 * request/response over AutorunService, plus a fire-and-forget `autorun.stream` the service
 * pushes on every state change. The service owns the driver loop + the durable doneItems
 * record; this subsystem only translates the wire.
 */
export interface AutorunSessionHost {
  emit(msg: SessionOutboundMessage): void;
}

export interface AutorunSessionOptions {
  host: AutorunSessionHost;
  autorunService: AutorunService;
  logger: pino.Logger;
}

type AutorunRequest = Extract<
  SessionInboundMessage,
  {
    type:
      | "autorun.start.request"
      | "autorun.stop.request"
      | "autorun.get.request"
      | "autorun.list.request";
  }
>;

export class AutorunSession {
  private readonly host: AutorunSessionHost;
  private readonly autorunService: AutorunService;
  private readonly logger: pino.Logger;

  constructor(options: AutorunSessionOptions) {
    this.host = options.host;
    this.autorunService = options.autorunService;
    this.logger = options.logger;
  }

  private emitRpcError(request: AutorunRequest, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.logger.error({ err: error, requestType: request.type }, "Autorun request failed");
    this.host.emit({
      type: "rpc_error",
      payload: {
        requestId: request.requestId,
        requestType: request.type,
        error: message,
        code: "autorun_request_failed",
      },
    });
  }

  async handleStartRequest(
    request: Extract<SessionInboundMessage, { type: "autorun.start.request" }>,
  ): Promise<void> {
    try {
      const state = await this.autorunService.start(request.agentId);
      this.host.emit({
        type: "autorun.start.response",
        payload: { requestId: request.requestId, state, error: null },
      });
    } catch (error) {
      this.emitRpcError(request, error);
    }
  }

  async handleStopRequest(
    request: Extract<SessionInboundMessage, { type: "autorun.stop.request" }>,
  ): Promise<void> {
    try {
      const state = await this.autorunService.stopAgent(request.agentId);
      this.host.emit({
        type: "autorun.stop.response",
        payload: { requestId: request.requestId, state, error: null },
      });
    } catch (error) {
      this.emitRpcError(request, error);
    }
  }

  async handleGetRequest(
    request: Extract<SessionInboundMessage, { type: "autorun.get.request" }>,
  ): Promise<void> {
    try {
      const state = await this.autorunService.get(request.agentId);
      this.host.emit({
        type: "autorun.get.response",
        payload: { requestId: request.requestId, state, error: null },
      });
    } catch (error) {
      this.emitRpcError(request, error);
    }
  }

  async handleListRequest(
    request: Extract<SessionInboundMessage, { type: "autorun.list.request" }>,
  ): Promise<void> {
    try {
      const states = await this.autorunService.list();
      this.host.emit({
        type: "autorun.list.response",
        payload: { requestId: request.requestId, states },
      });
    } catch (error) {
      this.emitRpcError(request, error);
    }
  }
}
