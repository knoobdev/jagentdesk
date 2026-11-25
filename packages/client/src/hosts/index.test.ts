import { expect, test } from "vitest";
import { DaemonClient } from "../daemon-client.js";
import { createHostChannelTransport } from "./index.js";

test("an already disconnected gateway notifies handlers installed after transport creation", async () => {
  const origin = new DaemonClient({
    url: "ws://127.0.0.1:1/ws",
    clientId: "gateway",
    reconnect: { enabled: false },
  });
  const transport = createHostChannelTransport(
    origin,
    "destination",
    "scope",
    "route",
  )({ url: "ws://routed-host/ws" });
  let closed = 0;
  transport.onClose(() => {
    closed++;
  });
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  expect(closed).toBe(1);
  await origin.close();
});
test("the 32 MiB gateway queue releases reservations independently", async () => {
  const origin = new DaemonClient({
    url: "ws://127.0.0.1:1/ws",
    clientId: "gateway",
    reconnect: { enabled: false },
  });
  const release = origin.reserveHostQueue(32 * 1024 * 1024);
  expect(() => origin.reserveHostQueue(1)).toThrow("queue limit");
  release();
  release();
  const sibling = origin.reserveHostQueue(32 * 1024 * 1024);
  sibling();
  await origin.close();
});
