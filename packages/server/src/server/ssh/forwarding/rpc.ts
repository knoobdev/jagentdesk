import {
  ForwardingInboundMessageSchema,
  ForwardingInboundSchemas,
  type ForwardingInboundMessage,
  type ForwardingOutboundMessage,
} from "@jagentdesk/protocol/ssh/forwarding-schemas";
import type { SshModuleError } from "@jagentdesk/protocol/ssh/module-rpc";
import { ForwardingError } from "./rule-store.js";
import type { ForwardingService } from "./service.js";

const INBOUND_TYPES = new Set<string>(
  ForwardingInboundSchemas.map((schema) => schema.shape.type.value),
);

type Emit = (message: ForwardingOutboundMessage) => void;

function toModuleError(error: unknown): SshModuleError {
  if (error instanceof ForwardingError) return { code: error.code, message: error.message };
  return { code: "failed", message: error instanceof Error ? error.message : String(error) };
}

async function respond<T>(
  run: () => Promise<T>,
  ok: (value: T) => void,
  fail: (error: SshModuleError) => void,
): Promise<void> {
  let value: T;
  try {
    value = await run();
  } catch (error) {
    fail(toModuleError(error));
    return;
  }
  ok(value);
}

// Runs one port-forwarding request and emits its response. Returns false when `message` is not
// an ssh.forward.* RPC.
export async function handleForwardingMessage(
  service: ForwardingService,
  message: { type: string },
  emit: Emit,
): Promise<boolean> {
  if (!INBOUND_TYPES.has(message.type)) return false;
  const parsed = ForwardingInboundMessageSchema.safeParse(message);
  if (!parsed.success) return false;
  await dispatch(service, parsed.data, emit);
  return true;
}

async function dispatch(
  service: ForwardingService,
  msg: ForwardingInboundMessage,
  emit: Emit,
): Promise<void> {
  const { requestId } = msg;
  switch (msg.type) {
    case "ssh.forward.list.request":
      return respond(
        async () => service.list(),
        ({ rules, states }) =>
          emit({
            type: "ssh.forward.list.response",
            payload: { requestId, error: null, rules, states },
          }),
        (error) =>
          emit({
            type: "ssh.forward.list.response",
            payload: { requestId, error, rules: [], states: [] },
          }),
      );
    case "ssh.forward.save.request":
      return respond(
        () => service.save(msg.rule),
        (rule) =>
          emit({ type: "ssh.forward.save.response", payload: { requestId, error: null, rule } }),
        (error) =>
          emit({ type: "ssh.forward.save.response", payload: { requestId, error, rule: null } }),
      );
    case "ssh.forward.delete.request":
      return respond(
        () => service.delete(msg.id),
        () => emit({ type: "ssh.forward.delete.response", payload: { requestId, error: null } }),
        (error) => emit({ type: "ssh.forward.delete.response", payload: { requestId, error } }),
      );
    case "ssh.forward.start.request":
      return respond(
        () => service.start(msg.id),
        (state) =>
          emit({
            type: "ssh.forward.start.response",
            payload: {
              requestId,
              error: state.status === "error" ? (state.error ?? null) : null,
              state,
            },
          }),
        (error) =>
          emit({ type: "ssh.forward.start.response", payload: { requestId, error, state: null } }),
      );
    case "ssh.forward.stop.request":
      return respond(
        () => service.stop(msg.id),
        (state) =>
          emit({ type: "ssh.forward.stop.response", payload: { requestId, error: null, state } }),
        (error) =>
          emit({ type: "ssh.forward.stop.response", payload: { requestId, error, state: null } }),
      );
  }
}
