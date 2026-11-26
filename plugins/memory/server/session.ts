import type {
  BuiltinSessionContribution,
  SessionInboundMessage,
  SessionOutboundMessage,
} from "../../../packages/server/src/server/plugins/builtin/host-api.js";
import type { MemoryService } from "./service.js";
import { MemoryInputError } from "./store.js";

type MemoryRequest = Extract<SessionInboundMessage, { type: `memory.${string}` }>;

function isMemoryRequest(message: SessionInboundMessage): message is MemoryRequest {
  return message.type.startsWith("memory.");
}

/** The Memory page, inspector tab, chip actions and settings RPCs (`memory.*`). */
export class MemorySession implements BuiltinSessionContribution {
  constructor(
    private readonly service: MemoryService | undefined,
    private readonly emit: (message: SessionOutboundMessage) => void,
  ) {}

  async handle(message: SessionInboundMessage): Promise<void> {
    if (!isMemoryRequest(message)) return;
    if (!this.service) {
      this.fail(message, "Memory is not available on this daemon", "unavailable");
      return;
    }
    try {
      this.emit(await this.respond(this.service, message));
    } catch (error) {
      if (!(error instanceof MemoryInputError)) throw error;
      this.fail(message, error.message, error.code);
    }
  }

  stop(): void {}

  private fail(message: MemoryRequest, error: string, code: string): void {
    this.emit({
      type: "rpc_error",
      payload: { requestId: message.requestId, requestType: message.type, error, code },
    });
  }

  private async respond(
    service: MemoryService,
    message: MemoryRequest,
  ): Promise<SessionOutboundMessage> {
    switch (message.type) {
      case "memory.list.request": {
        const projectId =
          message.projectId ?? (await service.projectIdForAgent(message.agentId)) ?? null;
        const memories =
          message.scope === "project" && !projectId
            ? []
            : service.store.list({
                scope: message.scope,
                projectId,
                tag: message.tag,
                contains: message.query,
              });
        return {
          type: "memory.list.response",
          payload: {
            requestId: message.requestId,
            memories,
            projects: await service.listProjects(),
            projectId,
          },
        };
      }
      case "memory.save.request": {
        const result = await service.saveAsUser(message);
        return {
          type: "memory.save.response",
          payload: { requestId: message.requestId, ...result },
        };
      }
      case "memory.delete.request":
        return {
          type: "memory.delete.response",
          payload: {
            requestId: message.requestId,
            id: message.id,
            deleted: service.remove(message.id),
          },
        };
      case "memory.agent.request":
        return {
          type: "memory.agent.response",
          payload: {
            requestId: message.requestId,
            agentId: message.agentId,
            created: service.store.list({ createdByAgentId: message.agentId }),
            used: service.store.usesForAgent(message.agentId),
          },
        };
      case "memory.settings.get.request":
        return {
          type: "memory.settings.get.response",
          payload: { requestId: message.requestId, settings: service.settings() },
        };
      case "memory.settings.set.request":
        return {
          type: "memory.settings.set.response",
          payload: { requestId: message.requestId, settings: service.updateSettings(message) },
        };
    }
  }
}
