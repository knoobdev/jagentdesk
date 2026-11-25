import { setImmediate } from "node:timers/promises";
import pino from "pino";
import { expect, test } from "vitest";
import type { SessionOutboundMessage } from "@jagentdesk/protocol/messages";
import { Session } from "./session.js";
import { observeSourceSend } from "./session/source-send.js";

const message: SessionOutboundMessage = {
  type: "agent.timeline.set_subscription.response",
  payload: { agentIds: [], requestId: "subscription" },
};

function sourceDelivery(send: (source: object) => void | Promise<void>) {
  const logger = pino({ level: "silent" });
  const session = {
    // Match the Session constructor boundary used by every JSON source callback.
    onMessageToSource: (source: object) => observeSourceSend(() => send(source), logger),
    sessionLogger: logger,
  } as unknown as Session;
  return (source: object) => Session.prototype["emitForSource"].call(session, message, source);
}

test("a disconnected source's unawaited reply does not interrupt delivery to another source", async () => {
  const closedSource = {};
  const activeSource = {};
  const attempted: object[] = [];
  const emit = sourceDelivery((source) => {
    attempted.push(source);
    return source === closedSource
      ? Promise.reject(new Error("Source message delivery unavailable"))
      : Promise.resolve();
  });

  void emit(closedSource);
  await setImmediate();
  await emit(activeSource);

  expect(attempted).toEqual([closedSource, activeSource]);
});

test.each([
  ["asynchronous", () => Promise.reject(new Error("send failed"))],
  [
    "synchronous",
    () => {
      throw new Error("send failed");
    },
  ],
] as const)("awaited %s source delivery still rejects on failure", async (_kind, send) => {
  const emit = sourceDelivery(send);
  await expect(emit({})).rejects.toThrow("send failed");
});
