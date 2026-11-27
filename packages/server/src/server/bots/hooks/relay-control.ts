import type { RelayControlHandler } from "../../relay-transport.js";

/** The relay transport takes one control handler; every bot connector sees every control frame. */
export function composeRelayControlHandlers(
  handlers: readonly RelayControlHandler[],
): RelayControlHandler {
  return {
    ready(send) {
      for (const handler of handlers) handler.ready(send);
    },
    closed() {
      for (const handler of handlers) handler.closed();
    },
    message(frame) {
      for (const handler of handlers) handler.message(frame);
    },
  };
}
