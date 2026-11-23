import { describe, expect, test } from "vitest";

import { AgentRunState, ForegroundPromptStart } from "./agent-run-state.js";

function track(promise: Promise<void>): { readonly resolved: boolean } {
  const state = { resolved: false };
  void (async () => {
    await promise;
    state.resolved = true;
  })();
  return state;
}

async function flushMicrotasks(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("waitForForegroundStart", () => {
  test("resolves once the starting turn has an id", async () => {
    const runs = new AgentRunState();
    const run = runs.createPendingRun("agent");
    const wait = track(runs.waitForForegroundStart("agent"));

    await flushMicrotasks();
    expect(wait.resolved).toBe(false);

    runs.settleForegroundStart(run, { status: "started", turnId: "turn-1" });
    await flushMicrotasks();
    expect(wait.resolved).toBe(true);
  });

  test("waits for a failed start's run to be cleared", async () => {
    const runs = new AgentRunState();
    const run = runs.createPendingRun("agent");
    const wait = track(runs.waitForForegroundStart("agent"));

    runs.settleForegroundStart(run, { status: "failed", error: "start failed" });
    await flushMicrotasks();
    expect(wait.resolved).toBe(false);
    expect(runs.hasPendingRun("agent")).toBe(true);

    runs.settleForegroundRun("agent", run.token);
    await flushMicrotasks();
    expect(wait.resolved).toBe(true);
  });

  test("resolves at once when no turn is starting", async () => {
    const runs = new AgentRunState();
    await expect(runs.waitForForegroundStart("agent")).resolves.toBeUndefined();
  });
});

describe("ForegroundPromptStart", () => {
  test("remembers acceptance after a turn has already completed", async () => {
    const runs = new AgentRunState();
    const prompt = new ForegroundPromptStart("agent");
    const run = runs.createPendingRun("agent");
    prompt.bind(run);
    runs.settleForegroundStart(run, { status: "started", turnId: "fast" });
    runs.settleForegroundRun("agent", run.token);
    prompt.end();
    await expect(prompt.started).resolves.toBeUndefined();
  });
  test("waits for the replacement run after a stale-session failure", async () => {
    const runs = new AgentRunState();
    const prompt = new ForegroundPromptStart("agent");
    const first = runs.createPendingRun("agent");
    prompt.bind(first);
    runs.settleForegroundStart(first, { status: "failed", error: "stale", stale: true });
    runs.settleForegroundRun("agent", first.token);
    await flushMicrotasks();
    const retry = runs.createPendingRun("agent");
    prompt.bind(retry);
    runs.settleForegroundStart(retry, { status: "started", turnId: "retry" });
    await expect(prompt.started).resolves.toBeUndefined();
  });
  test("rejects an unstarted failed prompt with its own failure", async () => {
    const runs = new AgentRunState();
    const prompt = new ForegroundPromptStart("agent");
    const run = runs.createPendingRun("agent");
    prompt.bind(run);
    runs.settleForegroundStart(run, { status: "failed", error: "provider rejected" });
    runs.settleForegroundRun("agent", run.token);
    await expect(prompt.started).rejects.toThrow("provider rejected");
  });
});
