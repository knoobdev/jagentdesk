import { EventEmitter } from "node:events";
import { expect, test, vi } from "vitest";
import { createEncryptedRelaySocket } from "./encrypted-relay-socket.js";

test("a stalled graceful close can still terminate its underlying relay transport", () => {
  const close = vi.fn();
  const terminate = vi.fn();
  const socket = createEncryptedRelaySocket({
    channel: { send: async () => {}, outboundWireByteLength: () => 0, close },
    emitter: new EventEmitter(),
    getTransportBufferedAmount: () => 0,
    terminateTransport: terminate,
  });
  socket.close(4401, "Device revoked");
  expect(close).toHaveBeenCalledWith(4401, "Device revoked");
  expect(terminate).not.toHaveBeenCalled();
  socket.terminate();
  socket.terminate();
  expect(terminate).toHaveBeenCalledOnce();
});
