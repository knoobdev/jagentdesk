import { describe, expect, test } from "vitest";

import { AgentBackgroundWorkStore } from "./index.js";

const T0 = "2026-10-06T10:00:00.000Z";
const T1 = "2026-10-06T10:05:00.000Z";

describe("AgentBackgroundWorkStore", () => {
  test("stamps new items and keeps their start time across replacements", () => {
    const store = new AgentBackgroundWorkStore();

    expect(
      store.apply("agent-a", [{ id: "bash-1", kind: "shell", description: "sleep 20" }], T0),
    ).toEqual([{ id: "bash-1", kind: "shell", description: "sleep 20", startedAt: T0 }]);

    expect(
      store.apply(
        "agent-a",
        [
          { id: "bash-1", kind: "shell", description: "sleep 20" },
          { id: "task-1", kind: "other", description: null },
        ],
        T1,
      ),
    ).toEqual([
      { id: "bash-1", kind: "shell", description: "sleep 20", startedAt: T0 },
      { id: "task-1", kind: "other", description: null, startedAt: T1 },
    ]);
  });

  test("returns null when the replacement changes nothing", () => {
    const store = new AgentBackgroundWorkStore();
    store.apply("agent-a", [{ id: "bash-1", kind: "shell", description: "sleep 20" }], T0);

    expect(
      store.apply("agent-a", [{ id: "bash-1", kind: "shell", description: "sleep 20" }], T1),
    ).toBeNull();
    expect(store.apply("agent-b", [], T1)).toEqual([]);
    expect(store.apply("agent-b", [], T1)).toBeNull();
  });

  test("distinguishes an unknown inventory from an observed empty inventory", () => {
    const store = new AgentBackgroundWorkStore();
    expect(store.summary("agent-a")).toBeUndefined();
    store.apply("agent-a", []);
    expect(store.summary("agent-a")).toEqual({ count: 0 });
    store.clear("agent-a");
    expect(store.summary("agent-a")).toBeUndefined();
  });

  test("keeps the first occurrence of a duplicated id", () => {
    const store = new AgentBackgroundWorkStore();

    expect(
      store.apply(
        "agent-a",
        [
          { id: "bash-1", kind: "shell", description: "first" },
          { id: "bash-1", kind: "shell", description: "second" },
        ],
        T0,
      ),
    ).toEqual([{ id: "bash-1", kind: "shell", description: "first", startedAt: T0 }]);
  });

  test("scopes lists per agent and clears one agent", () => {
    const store = new AgentBackgroundWorkStore();
    store.apply("agent-a", [{ id: "bash-1", kind: "shell", description: null }], T0);
    store.apply("agent-b", [{ id: "bash-2", kind: "shell", description: null }], T0);

    expect(store.clear("agent-a")).toEqual([]);
    expect(store.clear("agent-a")).toBeNull();
    expect(store.list("agent-a")).toEqual([]);
    expect(store.list("agent-b")).toHaveLength(1);
  });

  test("keeps only the wire fields of each input", () => {
    const store = new AgentBackgroundWorkStore();
    const input = { id: "bash-1", kind: "shell", description: null, pid: 4242 };

    expect(store.apply("agent-a", [input], T0)).toEqual([
      { id: "bash-1", kind: "shell", description: null, startedAt: T0 },
    ]);
  });

  test("list returns a copy", () => {
    const store = new AgentBackgroundWorkStore();
    store.apply("agent-a", [{ id: "bash-1", kind: "shell", description: null }], T0);

    store.list("agent-a").pop();

    expect(store.list("agent-a")).toHaveLength(1);
  });
});

test("stop tokens follow a live item and change when an id is reused", () => {
  const store = new AgentBackgroundWorkStore();
  const input = { id: "1", kind: "shell", description: null, canStop: true };
  const first = store.apply("agent", [input], T0)![0];
  expect(first.stopToken).toBeTruthy();
  expect(store.apply("agent", [input], T1)).toBeNull();
  store.apply("agent", []);
  const second = store.apply("agent", [input], T0)![0];
  expect(second.stopToken).not.toBe(first.stopToken);
});

test("revokes a stop token while inventory ownership is being re-established", () => {
  const store = new AgentBackgroundWorkStore();
  const item = { id: "1", kind: "shell", description: null, canStop: true };
  const first = store.apply("agent", [item])![0];
  const stale = store.apply("agent", [{ ...item, canStop: false }])![0];
  expect(stale.stopToken).toBeUndefined();
  expect(store.apply("agent", [item])![0].stopToken).not.toBe(first.stopToken);
});

test("publishes command changes without replacing a live item's identity", () => {
  const store = new AgentBackgroundWorkStore();
  const item = {
    id: "1",
    kind: "monitor",
    description: "Watch build",
    command: "tail -f build.log",
    canStop: true,
  };
  const first = store.apply("agent", [item], T0)![0];
  expect(first.command).toBe("tail -f build.log");
  const changed = store.apply("agent", [{ ...item, command: "tail -f other.log" }], T1)![0];
  expect(changed).toMatchObject({
    command: "tail -f other.log",
    startedAt: T0,
    stopToken: first.stopToken,
  });
});

// ADR-0062: detail and output source of live and ended work.
describe("background work detail", () => {
  const output = {
    type: "reader" as const,
    read: async () => ({ bytes: new Uint8Array(), nextCursor: 0, size: 0 }),
  };

  test("keeps the folder and output source off the list", () => {
    const store = new AgentBackgroundWorkStore();
    const [item] = store.apply(
      "agent",
      [{ id: "1", kind: "shell", description: null, cwd: "/repo", output }],
      T0,
    )!;
    expect(item).toEqual({ id: "1", kind: "shell", description: null, startedAt: T0 });
    expect(store.detail("agent", "1")).toMatchObject({
      status: "running",
      cwd: "/repo",
      output,
      exitCode: null,
      endedAt: null,
    });
  });

  test("an item that leaves the inventory stays readable as finished", () => {
    const store = new AgentBackgroundWorkStore();
    store.apply("agent", [{ id: "1", kind: "shell", description: null, output }], T0);
    store.apply("agent", [], T1);
    expect(store.list("agent")).toEqual([]);
    expect(store.detail("agent", "1")).toMatchObject({
      status: "finished",
      endedAt: T1,
      exitCode: null,
      output,
    });
  });

  test("applies an end notice that arrives before or after the item leaves", () => {
    const store = new AgentBackgroundWorkStore();
    store.apply(
      "agent",
      [
        { id: "early", kind: "shell", description: null },
        { id: "late", kind: "shell", description: null },
      ],
      T0,
    );
    store.end("agent", { id: "early", status: "failed", exitCode: 2 });
    expect(store.detail("agent", "early")?.status).toBe("running");
    store.apply("agent", [], T1);
    store.end("agent", { id: "late", status: "finished", exitCode: 0, output });

    expect(store.detail("agent", "early")).toMatchObject({ status: "failed", exitCode: 2 });
    expect(store.detail("agent", "late")).toMatchObject({
      status: "finished",
      exitCode: 0,
      output,
    });
  });

  test("ended work drops its stop token and a reset marks it stopped", () => {
    const store = new AgentBackgroundWorkStore();
    store.apply("agent", [{ id: "1", kind: "shell", description: null, canStop: true }], T0);
    store.clear("agent", T1);
    const detail = store.detail("agent", "1");
    expect(detail?.status).toBe("stopped");
    expect(detail?.item.stopToken).toBeUndefined();
    expect(detail?.item.canStop).toBeUndefined();
  });

  test("another agent's item id is unknown", () => {
    const store = new AgentBackgroundWorkStore();
    store.apply("agent-a", [{ id: "1", kind: "shell", description: null, output }], T0);
    expect(store.detail("agent-b", "1")).toBeNull();
    store.end("agent-b", { id: "1", status: "failed" });
    expect(store.detail("agent-a", "1")?.status).toBe("running");
  });

  test("work listed again is live again", () => {
    const store = new AgentBackgroundWorkStore();
    const item = { id: "1", kind: "shell", description: null };
    store.apply("agent", [item], T0);
    store.clear("agent", T1);
    store.apply("agent", [item], T1);
    expect(store.detail("agent", "1")?.status).toBe("running");
  });

  test("forget drops what an agent's ended work left behind", () => {
    const store = new AgentBackgroundWorkStore();
    store.apply("agent", [{ id: "1", kind: "shell", description: null }], T0);
    store.apply("agent", [], T1);
    store.forget("agent");
    expect(store.detail("agent", "1")).toBeNull();
  });
});
