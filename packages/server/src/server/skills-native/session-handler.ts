import type { SessionInboundMessage, SessionOutboundMessage } from "../messages.js";
import { isNativeSkillsError } from "./errors.js";
import type { NativeSkillsService } from "./service.js";

type Emit = (message: SessionOutboundMessage) => void;
type NativeSkillsRequest = Extract<
  SessionInboundMessage,
  {
    type:
      | "skills.catalog.list.request"
      | "skills.catalog.get.request"
      | "skills.sources.browse.request"
      | "skills.sources.list.request"
      | "skills.sources.add.request"
      | "skills.sources.remove.request"
      | "skills.sources.set_enabled.request"
      | "skills.install.request"
      | "skills.uninstall.request"
      | "skills.set_enabled.request"
      | "skills.author.request"
      | "skills.learn.request"
      | "skills.fork.request";
  }
>;

const NATIVE_SKILLS_REQUEST_TYPES = new Set<string>([
  "skills.catalog.list.request",
  "skills.catalog.get.request",
  "skills.sources.browse.request",
  "skills.sources.list.request",
  "skills.sources.add.request",
  "skills.sources.remove.request",
  "skills.sources.set_enabled.request",
  "skills.install.request",
  "skills.uninstall.request",
  "skills.set_enabled.request",
  "skills.author.request",
  "skills.learn.request",
  "skills.fork.request",
]);

export function isNativeSkillsRequest(msg: SessionInboundMessage): msg is NativeSkillsRequest {
  return NATIVE_SKILLS_REQUEST_TYPES.has(msg.type);
}

async function respond(
  service: NativeSkillsService,
  msg: NativeSkillsRequest,
): Promise<SessionOutboundMessage> {
  const requestId = msg.requestId;
  switch (msg.type) {
    case "skills.catalog.list.request":
      return {
        type: "skills.catalog.list.response",
        payload: { requestId, ...(await service.listCatalog(msg.cwd)) },
      };
    case "skills.catalog.get.request":
      return {
        type: "skills.catalog.get.response",
        payload: { requestId, ...(await service.getSkill(msg.skillId, msg.cwd)) },
      };
    case "skills.sources.browse.request":
      return {
        type: "skills.sources.browse.response",
        payload: {
          requestId,
          items: await service.browse(msg.source, {
            sourceId: msg.sourceId,
            query: msg.query,
            refresh: msg.refresh,
          }),
        },
      };
    case "skills.sources.list.request":
      return {
        type: "skills.sources.list.response",
        payload: { requestId, sources: await service.listSources() },
      };
    case "skills.sources.add.request":
      return {
        type: "skills.sources.add.response",
        payload: { requestId, source: await service.addSource(msg.source, msg.label) },
      };
    case "skills.sources.remove.request":
      await service.removeSource(msg.sourceId);
      return {
        type: "skills.sources.remove.response",
        payload: { requestId, sourceId: msg.sourceId },
      };
    case "skills.sources.set_enabled.request":
      return {
        type: "skills.sources.set_enabled.response",
        payload: { requestId, source: await service.setSourceEnabled(msg.sourceId, msg.enabled) },
      };
    case "skills.install.request":
      return {
        type: "skills.install.response",
        payload: { requestId, ...(await service.install(msg)) },
      };
    case "skills.uninstall.request":
      return {
        type: "skills.uninstall.response",
        payload: { requestId, ...(await service.uninstall(msg)) },
      };
    case "skills.set_enabled.request":
      return {
        type: "skills.set_enabled.response",
        payload: { requestId, skill: await service.setEnabled(msg) },
      };
    case "skills.author.request":
      return {
        type: "skills.author.response",
        payload: { requestId, skill: await service.author(msg) },
      };
    case "skills.learn.request":
      return {
        type: "skills.learn.response",
        payload: { requestId, skill: await service.learn(msg) },
      };
    case "skills.fork.request":
      return {
        type: "skills.fork.response",
        payload: { requestId, skill: await service.fork(msg) },
      };
  }
}

/**
 * Answer a native skills RPC (spec 22.4). A {@link NativeSkillsError} becomes an
 * `rpc_error` carrying its code (e.g. `skill_name_conflict`) so the app can offer
 * rename / confirm; anything else propagates to the session's generic handler.
 */
export async function handleNativeSkillsRequest(
  service: NativeSkillsService | null,
  msg: NativeSkillsRequest,
  emit: Emit,
): Promise<void> {
  if (!service) {
    emit({
      type: "rpc_error",
      payload: {
        requestId: msg.requestId,
        requestType: msg.type,
        error: "Skills are not available on this daemon",
        code: "unavailable",
      },
    });
    return;
  }
  try {
    emit(await respond(service, msg));
  } catch (error) {
    if (!isNativeSkillsError(error)) throw error;
    emit({
      type: "rpc_error",
      payload: {
        requestId: msg.requestId,
        requestType: msg.type,
        error: error.message,
        code: error.code,
      },
    });
  }
}
