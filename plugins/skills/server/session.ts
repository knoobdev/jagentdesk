import type {
  BuiltinSessionContribution,
  SessionInboundMessage,
  SessionOutboundMessage,
} from "../../../packages/server/src/server/plugins/builtin/host-api.js";
import type { NativeSkillsService } from "./service.js";
import { handleNativeSkillsRequest, isNativeSkillsRequest } from "./session-handler.js";

/** Native skills RPCs plus the legacy skills.get / skills.mutate API (COMPAT(nativeSkills)). */
export class SkillsSession implements BuiltinSessionContribution {
  constructor(
    private readonly skillsStorage: NativeSkillsService | null,
    private readonly emit: (message: SessionOutboundMessage) => void,
  ) {}

  handle(msg: SessionInboundMessage): Promise<void> | undefined {
    if (isNativeSkillsRequest(msg)) {
      return handleNativeSkillsRequest(this.skillsStorage, msg, this.emit);
    }
    switch (msg.type) {
      case "skills.get.request":
        this.emit({
          type: "skills.get.response",
          payload: { requestId: msg.requestId, skills: this.skillsStorage?.get() ?? [] },
        });
        return undefined;
      case "skills.mutate.request":
        return (async () => {
          const skills = this.skillsStorage ? await this.skillsStorage.mutate(msg.mutation) : [];
          this.emit({
            type: "skills.mutate.response",
            payload: { requestId: msg.requestId, skills },
          });
        })();
      default:
        return undefined;
    }
  }

  // Requests are one-shot; skill changes reach clients through the daemon broadcast.
  stop(): void {}
}
