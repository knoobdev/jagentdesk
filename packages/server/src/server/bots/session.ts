import { BotsResponseSchemas, type BotsRequest } from "@jagentdesk/protocol/bots/rpc-schemas";
import type { SessionInboundMessage, SessionOutboundMessage } from "../messages.js";
import type { BotsService } from "./service.js";
import { BotsError } from "./home.js";
const responses = new Map(BotsResponseSchemas.map((s) => [s.shape.type.value as string, s]));
export class BotsSession {
  private readonly unsubscribe: () => void;
  constructor(
    private readonly service: BotsService,
    private readonly emit: (message: SessionOutboundMessage) => void,
  ) {
    this.unsubscribe = service.onEvent((event) => emit(event));
  }
  dispose(): void {
    this.unsubscribe();
  }
  dispatch(message: SessionInboundMessage): Promise<void> | undefined {
    if (!message.type.startsWith("bots.")) return undefined;
    return this.handle(message as BotsRequest);
  }
  private async handle(message: BotsRequest): Promise<void> {
    try {
      const data = await this.service.handle(message);
      const schema = responses.get(message.type.replace(/\.request$/, ".response"));
      if (!schema) throw new Error("Unknown bots method");
      this.emit(
        schema.parse({
          type: message.type.replace(/\.request$/, ".response"),
          payload: { requestId: message.requestId, ...data },
        }),
      );
    } catch (error) {
      this.emit({
        type: "rpc_error",
        payload: {
          requestId: message.requestId,
          code: error instanceof BotsError ? error.code : "bots_error",
          requestType: message.type,
          error: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }
}
