import type pino from "pino";
import type { SpecModeError } from "@jagentdesk/protocol/spec-mode";
import type { SessionInboundMessage, SessionOutboundMessage } from "../../messages.js";
import { SpecModeRequestError, type SpecModeService } from "../../spec-mode/service.js";

/**
 * Wire side of Spec mode (spec 28.6): `agent.spec_mode.*` requests over SpecModeService.
 * Expected refusals (missing tools, autorun on, nothing to review, …) come back as the
 * response's `error`; anything else is a request failure.
 */
export interface SpecModeSessionOptions {
  emit(msg: SessionOutboundMessage): void;
  specModeService: SpecModeService;
  logger: pino.Logger;
}

type SpecModeRequest = Extract<
  SessionInboundMessage,
  {
    type:
      | "agent.spec_mode.get.request"
      | "agent.spec_mode.setup.preview.request"
      | "agent.spec_mode.set.request"
      | "agent.spec_mode.review.request";
  }
>;

function toSpecModeError(error: unknown): SpecModeError | null {
  return error instanceof SpecModeRequestError
    ? { code: error.code, message: error.message }
    : null;
}

export class SpecModeSession {
  constructor(private readonly options: SpecModeSessionOptions) {}

  private failRequest(request: SpecModeRequest, error: unknown): void {
    this.options.logger.error(
      { err: error, requestType: request.type },
      "Spec mode request failed",
    );
    this.options.emit({
      type: "rpc_error",
      payload: {
        requestId: request.requestId,
        requestType: request.type,
        error: error instanceof Error ? error.message : String(error),
        code: "spec_mode_request_failed",
      },
    });
  }

  async handle(request: SpecModeRequest, clientSupportsSpecMode: boolean): Promise<void> {
    const service = this.options.specModeService;
    const { requestId } = request;
    try {
      switch (request.type) {
        case "agent.spec_mode.get.request":
          this.options.emit({
            type: "agent.spec_mode.get.response",
            payload: { requestId, state: await service.get(request.agentId), error: null },
          });
          return;
        case "agent.spec_mode.setup.preview.request": {
          const preview = await service.preview(request.agentId);
          this.options.emit({
            type: "agent.spec_mode.setup.preview.response",
            payload: { requestId, ...preview, error: null },
          });
          return;
        }
        case "agent.spec_mode.set.request": {
          if (!clientSupportsSpecMode) {
            this.options.emit({
              type: "agent.spec_mode.set.response",
              payload: {
                requestId,
                state: null,
                error: { code: "unsupported_client", message: "Update the app to use Spec mode" },
              },
            });
            return;
          }
          const state = await service.set({
            agentId: request.agentId,
            enabled: request.enabled,
            optionalPhases: request.optionalPhases,
            confirmSetup: request.confirmSetup,
          });
          this.options.emit({
            type: "agent.spec_mode.set.response",
            payload: { requestId, state, error: null },
          });
          return;
        }
        case "agent.spec_mode.review.request": {
          const state = await service.review({
            agentId: request.agentId,
            decision: request.decision,
            note: request.note,
          });
          this.options.emit({
            type: "agent.spec_mode.review.response",
            payload: { requestId, state, error: null },
          });
          return;
        }
      }
    } catch (error) {
      const expected = toSpecModeError(error);
      if (!expected) {
        this.failRequest(request, error);
        return;
      }
      this.emitRefusal(request, expected);
    }
  }

  private emitRefusal(request: SpecModeRequest, error: SpecModeError): void {
    const { requestId } = request;
    switch (request.type) {
      case "agent.spec_mode.setup.preview.request":
        this.options.emit({
          type: "agent.spec_mode.setup.preview.response",
          payload: { requestId, files: [], missingTools: [], error },
        });
        return;
      case "agent.spec_mode.get.request":
        this.options.emit({
          type: "agent.spec_mode.get.response",
          payload: { requestId, state: null, error },
        });
        return;
      case "agent.spec_mode.set.request":
        this.options.emit({
          type: "agent.spec_mode.set.response",
          payload: { requestId, state: null, error },
        });
        return;
      case "agent.spec_mode.review.request":
        this.options.emit({
          type: "agent.spec_mode.review.response",
          payload: { requestId, state: null, error },
        });
        return;
    }
  }
}
