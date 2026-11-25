import { expect, test } from "vitest";
import { SessionDelivery, type OwnedSubscription } from "./index.js";
import type { SessionOutboundMessage } from "../../messages.js";

const request = { type: "ping", requestId: "request", clientSentAt: 0 } as const;
const message: SessionOutboundMessage = {
  type: "pong",
  payload: { requestId: "request", serverReceivedAt: 0, serverSentAt: 0 },
};

test("detach cancels old owners immediately while a replacement source receives pushes", async () => {
  const sent: object[] = [];
  const delivery = new SessionDelivery((source) => {
    sent.push(source);
  });
  const original = {};
  const replacement = {};
  let finishStop!: () => void;
  let oldOwner!: OwnedSubscription;
  delivery.attach(original, true);
  await delivery.request(original, request, async () => {
    oldOwner = delivery.begin(
      "events",
      undefined,
      () =>
        new Promise<void>((resolve) => {
          finishStop = resolve;
        }),
    );
  });
  const detaching = delivery.detach(original);
  expect(oldOwner.signal.aborted).toBe(true);
  delivery.attach(replacement, true);
  await delivery.request(replacement, request, async () => {
    const owner = delivery.begin("events", undefined, () => {});
    oldOwner.emit(message);
    owner.emit(message);
    await owner.release();
  });
  expect(sent).toEqual([replacement]);
  finishStop();
  await detaching;
  expect(delivery.registrationCount).toBe(0);
  await delivery.close();
});

test("owned awaitable sends preserve transport failure and can be released after disconnect", async () => {
  let rejectSend!: (error: Error) => void;
  const delivery = new SessionDelivery(
    () =>
      new Promise<void>((_resolve, reject) => {
        rejectSend = reject;
      }),
  );
  const source = {};
  delivery.attach(source, true);
  await delivery.request(source, request, async () => {
    const owner = delivery.begin("host-route", undefined, () => {});
    const pending = owner.emitAndWait(message);
    const failure = new Error("socket closed during send");
    const rejected = expect(pending).rejects.toBe(failure);
    await delivery.detach(source);
    rejectSend(failure);
    await rejected;
    await owner.release();
    expect(owner.signal.aborted).toBe(true);
  });
  expect(delivery.registrationCount).toBe(0);
  await delivery.close();
});

test("detached requests cannot emit late replies into a replacement source", async () => {
  const sent: SessionOutboundMessage[] = [];
  const delivery = new SessionDelivery((_source, output) => {
    sent.push(output);
  });
  const original = {};
  const replacement = {};
  delivery.attach(original, true);
  await delivery.request(original, request, async () => {
    await delivery.detach(original);
    delivery.attach(replacement, true);
    expect(delivery.reply(message)).toBe(true);
  });
  await delivery.request(replacement, request, async () => {
    expect(delivery.reply(message)).toBe(true);
  });
  expect(sent).toEqual([message]);
  await delivery.close();
});

test("final cleanup is terminal; reconnect must use a retained live session or a new session", async () => {
  const delivery = new SessionDelivery(() => {});
  delivery.attach({}, true);
  await delivery.close();
  expect(() => delivery.attach({}, true)).toThrow("Session delivery is closed");
  const replacement = new SessionDelivery(() => {});
  expect(() => replacement.attach({}, true)).not.toThrow();
  await replacement.close();
});
