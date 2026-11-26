import { expect, test } from "vitest";
import type { RelaySocketLike } from "./relay-transport.js";
import { tallyRelayFrames } from "./relay-frame-tally.js";

function fakeSocket() {
  const listeners: Array<(...args: unknown[]) => void> = [];
  const written: unknown[] = [];
  const socket: RelaySocketLike = {
    readyState: 1,
    send: (data) => {
      written.push(data);
    },
    close: () => {},
    terminate: () => {},
    on: (event, listener) => {
      if (event === "message") listeners.push(listener);
    },
    once: () => {},
  };
  return {
    socket,
    written,
    receive: (data: unknown, isBinary = false) => {
      for (const listener of listeners) listener(data, isBinary);
    },
  };
}

test("tells hello retries, encrypted records and control frames apart without payloads", () => {
  let now = 1_000;
  const { socket, written, receive } = fakeSocket();
  const tally = tallyRelayFrames(socket, () => now);

  receive(Buffer.from('{"type":"e2ee_hello","key":"k"}'));
  now += 40;
  socket.send('{"type":"e2ee_ready","protected":{}}');
  socket.send("cmVjb3Jk");
  now += 1_000;
  receive(Buffer.from('{"type":"e2ee_hello","key":"k"}'));
  receive(Buffer.from('{"type":"relay_ping"}'));
  now += 500;
  receive(Buffer.from("ZW5jcnlwdGVk"));
  receive(new Uint8Array([1, 2, 3]), true);

  expect(written).toHaveLength(2);
  expect(tally.summary()).toEqual({
    openMs: 1_540,
    in: {
      e2eeHellos: 2,
      e2eeHelloAtMs: [0, 1_040],
      records: 2,
      recordBytes: 15,
      control: { relay_ping: 1 },
      firstRecordAtMs: 1_540,
      lastAtMs: 1_540,
    },
    out: { e2eeReadies: 1, records: 1, recordBytes: 8, lastAtMs: 40 },
  });
});
