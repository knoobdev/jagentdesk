import { describe, expect, test } from "vitest";
import {
  createAgentMessageDelivery,
  type AgentMessageDispatchRequest,
  type AgentMessageDeliveryDependencies,
} from "./delivery.js";
import { parseAgentMessages } from "./envelope.js";

function createClock() {
  let now = 0;
  let nextId = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const schedule: NonNullable<AgentMessageDeliveryDependencies["schedule"]> = (delay, callback) => {
    const id = nextId++;
    timers.set(id, { at: now + delay, callback });
    return () => timers.delete(id);
  };
  async function advance(ms: number): Promise<void> {
    const target = now + ms;
    while (true) {
      const due = [...timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      now = due[1].at;
      due[1].callback();
      await Promise.resolve();
    }
    now = target;
    // Let queued dispatch promises settle.
    for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
  }
  return { schedule, now: () => now, advance };
}

function createHarness() {
  const clock = createClock();
  const dispatched: AgentMessageDispatchRequest[] = [];
  const delivery = createAgentMessageDelivery({
    schedule: clock.schedule,
    now: clock.now,
    dispatch: async (request) => {
      dispatched.push(request);
      return "steered";
    },
    onError: () => {},
  });
  return { clock, dispatched, delivery };
}

function texts(request: AgentMessageDispatchRequest): string[] {
  return (parseAgentMessages(request.prompt as string) ?? []).map((message) => message.text);
}

describe("agent message delivery", () => {
  test("a Peer handback and its finish notification reach the Lead as one steered prompt", async () => {
    const { clock, dispatched, delivery } = createHarness();

    const handback = delivery.enqueue({
      recipientId: "lead",
      prompt: "<orchestration-handback>evidence</orchestration-handback>",
      source: { kind: "agent-message", agentId: "peer" },
      activeTurnBehavior: "steer",
    });
    expect(handback.status).toBe("queued");
    await clock.advance(1_500);
    delivery.enqueue({
      recipientId: "lead",
      prompt: "Agent peer finished.",
      source: { kind: "agent-notification", agentId: "peer", event: "finished" },
      activeTurnBehavior: "steer",
    });
    await clock.advance(1_999);
    expect(dispatched).toHaveLength(0);

    await clock.advance(1);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]!.activeTurnBehavior).toBe("steer");
    expect(texts(dispatched[0]!)).toEqual([
      "<orchestration-handback>evidence</orchestration-handback>",
      "Agent peer finished.",
    ]);
    await expect(handback.dispatched).resolves.toBe("steered");
  });

  test("a steady stream still dispatches 10 s after the first message", async () => {
    const { clock, dispatched, delivery } = createHarness();
    for (let elapsed = 0; elapsed < 10_000; elapsed += 1_000) {
      delivery.enqueue({
        recipientId: "lead",
        prompt: `report ${elapsed}`,
        source: { kind: "agent-message", agentId: "peer" },
      });
      await clock.advance(1_000);
    }
    expect(dispatched).toHaveLength(1);
    expect(texts(dispatched[0]!)).toHaveLength(10);
  });

  test("steer and interrupt messages dispatch separately and in order", async () => {
    const { clock, dispatched, delivery } = createHarness();
    delivery.enqueue({
      recipientId: "coder",
      prompt: "add this",
      source: { kind: "agent-message", agentId: "lead" },
    });
    delivery.enqueue({
      recipientId: "coder",
      prompt: "stop",
      source: { kind: "agent-message", agentId: "lead" },
      activeTurnBehavior: "interrupt",
    });
    await clock.advance(2_000);
    expect(dispatched.map((request) => request.activeTurnBehavior)).toEqual(["steer", "interrupt"]);
  });

  test("recipients have separate windows", async () => {
    const { clock, dispatched, delivery } = createHarness();
    delivery.enqueue({
      recipientId: "a",
      prompt: "one",
      source: { kind: "agent-message", agentId: "lead" },
    });
    delivery.enqueue({
      recipientId: "b",
      prompt: "two",
      source: { kind: "agent-message", agentId: "lead" },
    });
    await clock.advance(2_000);
    expect(dispatched.map((request) => request.recipientId).sort()).toEqual(["a", "b"]);
  });

  test("waitForDispatch resolves only after admitted messages are dispatched", async () => {
    const { clock, dispatched, delivery } = createHarness();
    delivery.enqueue({
      recipientId: "child",
      prompt: "go",
      source: { kind: "agent-message", agentId: "parent" },
    });
    let waited = false;
    const wait = delivery.waitForDispatch("child").then(() => {
      waited = true;
      return undefined;
    });
    await clock.advance(1_000);
    expect(waited).toBe(false);
    await clock.advance(1_000);
    await wait;
    expect(waited).toBe(true);
    expect(dispatched).toHaveLength(1);
  });

  test("close flushes pending windows and refuses new messages", async () => {
    const { dispatched, delivery } = createHarness();
    delivery.enqueue({
      recipientId: "lead",
      prompt: "last report",
      source: { kind: "agent-message", agentId: "peer" },
    });
    await delivery.close();
    expect(dispatched).toHaveLength(1);
    expect(() =>
      delivery.enqueue({
        recipientId: "lead",
        prompt: "late",
        source: { kind: "agent-message", agentId: "peer" },
      }),
    ).toThrow("closed");
  });
});
