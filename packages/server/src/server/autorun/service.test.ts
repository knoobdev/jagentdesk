import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { AgentRunResult } from "../agent/agent-sdk-types.js";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { AutorunService, type AutorunServiceOptions } from "./service.js";
import type { AutorunState } from "@jagentdesk/protocol/messages";

const AGENT_ID = "agent_test";

interface ScriptedTurn {
  done?: boolean;
  nothingNew?: boolean;
  note?: string;
  doneItems?: string[];
  costUsd?: number;
  throwError?: string;
}

function marker(turn: ScriptedTurn): string {
  return `Working...\n${"AUTORUN_RESULT"} ${JSON.stringify({
    done: turn.done ?? false,
    nothing_new: turn.nothingNew ?? false,
    note: turn.note ?? "",
    done_items: turn.doneItems ?? [],
  })}`;
}

function makeResult(turn: ScriptedTurn): AgentRunResult {
  return {
    sessionId: "sess_test",
    finalText: marker(turn),
    usage: { totalCostUsd: turn.costUsd ?? 0, inputTokens: 0, outputTokens: 0 },
    timeline: [],
    canceled: false,
  };
}

class FakeAgentManager {
  public runCount = 0;
  public cancelCount = 0;
  public prompts: string[] = [];
  public busyFor = 0; // number of initial hasInFlightRun() checks that return true
  private checks = 0;
  constructor(private readonly turns: ScriptedTurn[]) {}
  getAgent(): unknown {
    return { id: AGENT_ID };
  }
  hasInFlightRun(): boolean {
    this.checks += 1;
    return this.checks <= this.busyFor;
  }
  async runAgent(_agentId: string, prompt: string): Promise<AgentRunResult> {
    this.prompts.push(prompt);
    const turn = this.turns[Math.min(this.runCount, this.turns.length - 1)];
    this.runCount += 1;
    if (turn.throwError) throw new Error(turn.throwError);
    return makeResult(turn);
  }
  async cancelAgentRun(): Promise<{ canceled: boolean }> {
    this.cancelCount += 1;
    return { canceled: true };
  }
}

async function waitForStopped(service: AutorunService, timeoutMs = 5000): Promise<AutorunState> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const s = await service.get(AGENT_ID);
    if (s && s.status === "stopped") return s;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`Autorun for ${AGENT_ID} did not stop within ${timeoutMs}ms`);
}

describe("AutorunService (autonomous mode on an existing agent)", () => {
  let home: string;
  let updates: AutorunState[];
  let stopped: AutorunState[];

  function build(turns: ScriptedTurn[]): { service: AutorunService; manager: FakeAgentManager } {
    const manager = new FakeAgentManager(turns);
    const service = new AutorunService({
      jagentdeskHome: home,
      logger: createTestLogger(),
      agentManager: manager as unknown as AutorunServiceOptions["agentManager"],
      onUpdate: (s) => updates.push(s),
      onStopped: (s) => stopped.push(s),
      // Tiny idle backoff so the "waiting for new work" path runs fast in tests.
      idleBackoffBaseMs: 5,
      idleBackoffMaxMs: 20,
    });
    return { service, manager };
  }

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "autorun-test-"));
    updates = [];
    stopped = [];
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  test("drives the existing agent turn-after-turn and stops when it reports done", async () => {
    const { service, manager } = build([
      { doneItems: ["messaged @a"], note: "t1" },
      { doneItems: ["messaged @b"], note: "t2" },
      { done: true, note: "all outreach done" },
    ]);
    await service.start(AGENT_ID);
    const s = await waitForStopped(service);
    expect(manager.runCount).toBe(3);
    expect(s.stopReason).toBe("done");
    expect(s.doneItems).toEqual(["messaged @a", "messaged @b"]);
    expect(s.iteration).toBe(3);
  });

  test("feeds the done record back so the agent does not repeat work", async () => {
    const { service, manager } = build([
      { doneItems: ["messaged @acme"], note: "t1" },
      { done: true, note: "done" },
    ]);
    await service.start(AGENT_ID);
    await waitForStopped(service);
    // The second prompt must carry the already-done list + the do-not-repeat instruction.
    const second = manager.prompts[1];
    expect(second).toContain("ALREADY done");
    expect(second).toContain("messaged @acme");
    expect(second).toContain("Never redo completed work");
  });

  test("de-duplicates repeated done-items", async () => {
    const { service } = build([
      { doneItems: ["messaged @a"] },
      { doneItems: ["messaged @a", "messaged @b"] },
      { done: true },
    ]);
    await service.start(AGENT_ID);
    const s = await waitForStopped(service);
    expect(s.doneItems).toEqual(["messaged @a", "messaged @b"]);
  });

  test("nothing_new does NOT stop the run — it stays alive and re-checks (Grok-style waiting)", async () => {
    // The agent reports "nothing to do right now" for a while (waiting for replies), then
    // new work appears and it acts, then it is genuinely done. It must never stop on the lull.
    const { service, manager } = build([
      { nothingNew: true, note: "sent batch, waiting for replies" },
      { nothingNew: true, note: "still no replies" },
      { nothingNew: true, note: "still waiting" },
      { doneItems: ["replied to @foo"], note: "a reply arrived — answered it" },
      { done: true, note: "all handled" },
    ]);
    await service.start(AGENT_ID);
    const s = await waitForStopped(service);
    // It ran through ALL the nothing-new turns (did not stop), then reacted, then finished.
    expect(s.stopReason).toBe("done");
    expect(manager.runCount).toBeGreaterThanOrEqual(5);
    expect(s.doneItems).toContain("replied to @foo");
  });

  test("an idle run can still be turned off promptly while waiting", async () => {
    const { service } = build([{ nothingNew: true, note: "waiting" }]);
    await service.start(AGENT_ID);
    // Give it a moment to enter the idle-wait loop, then turn it off.
    await new Promise((r) => setTimeout(r, 40));
    const s = await service.stopAgent(AGENT_ID);
    expect(s.status).toBe("stopped");
    expect(s.stopReason).toBe("user");
  });

  test("stops with no-progress when turns produce no new done-items", async () => {
    const { service, manager } = build([{ note: "spun", doneItems: [] }]);
    await service.start(AGENT_ID);
    const s = await waitForStopped(service);
    expect(s.stopReason).toBe("no-progress");
    expect(manager.runCount).toBe(5); // MAX_NO_PROGRESS
  });

  test("stops with error after consecutive failures", async () => {
    const { service, manager } = build([{ throwError: "provider exploded" }]);
    await service.start(AGENT_ID);
    const s = await waitForStopped(service);
    expect(s.stopReason).toBe("error");
    expect(manager.runCount).toBe(3);
  });

  test("stopAgent turns it off and cancels an in-flight turn", async () => {
    const { service } = build([{ doneItems: ["x"] }]);
    await service.start(AGENT_ID);
    const s = await service.stopAgent(AGENT_ID);
    expect(s.status).toBe("stopped");
    expect(s.stopReason).toBe("user");
  });

  test("waits for a user turn (busy) before driving", async () => {
    const { service, manager } = build([{ done: true, note: "done after user turn" }]);
    manager.busyFor = 2; // first two busy checks say the user is mid-turn
    await service.start(AGENT_ID);
    const s = await waitForStopped(service);
    expect(s.stopReason).toBe("done");
    expect(manager.runCount).toBe(1); // it still ran exactly one driver turn after waiting
  });

  test("done record survives a fresh service instance (durable, not in agent context)", async () => {
    const { service } = build([{ doneItems: ["messaged @a"] }, { done: true }]);
    await service.start(AGENT_ID);
    await waitForStopped(service);
    const { service: reopened } = build([]);
    const s = await reopened.get(AGENT_ID);
    expect(s?.doneItems).toContain("messaged @a");
    expect(s?.status).toBe("stopped");
  });

  test("fires onStopped exactly once at the terminal state", async () => {
    const { service } = build([{ done: true }]);
    await service.start(AGENT_ID);
    await waitForStopped(service);
    expect(stopped).toHaveLength(1);
    expect(stopped[0].stopReason).toBe("done");
  });
});
