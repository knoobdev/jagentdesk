import type { RelayControlHandler } from "./relay-transport.js";

/** One relay control socket, several handlers: each sees ready/closed and every frame. */
export function relayControlMux(handlers: readonly RelayControlHandler[]): RelayControlHandler {
  return {
    ready: (send) => {
      for (const handler of handlers) handler.ready(send);
    },
    closed: () => {
      for (const handler of handlers) handler.closed();
    },
    message: (frame) => {
      for (const handler of handlers) handler.message(frame);
    },
  };
}
