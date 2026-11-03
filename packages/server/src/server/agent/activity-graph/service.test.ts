import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentManagerEvent, ManagedAgent } from "../agent-manager.js";
import type { AgentTimelineItem } from "../agent-sdk-types.js";
import type { AgentTimelineRow } from "../agent-timeline-store-types.js";
import type { ProviderSubagentDescriptor } from "../provider-subagents/store.js";
import type { GraphModel } from "./model.js";
import {
  ActivityGraphService,
  RENDER_THROTTLE_MS,
  type ActivityGraphAgentSource,
  type ActivityGraphPush,
} from "./service.js";

// Spec 31.3 / 31.7 #2, #3, #7: throttled structural re-renders, immediate status pushes, and no
// work for agents nobody watches. The renderer is a counting stand-in; real archify renders are
// covered by renderer.test.ts.

const AGENT_ID = "agt_activity";

class FakeAgents implements ActivityGraphAgentSource {
  rows: AgentTimelineRow[] = [];
  lifecycle: "idle" | "running" = "running";
  private listeners = new Set<(event: AgentManagerEvent) => void>();
  private seq = 0;

  subscribe(callback: (event: AgentManagerEvent) => void) {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }
  getAgent(agentId: string): ManagedAgent | null {
    if (agentId !== AGENT_ID) return null;
    return {
      id: AGENT_ID,
      lifecycle: this.lifecycle,
      pendingPermissions: new Map(),
      config: { title: "Activity" },
      cwd: "/repo",
    } as unknown as ManagedAgent;
  }
  async getTimelineRows(): Promise<AgentTimelineRow[]> {
    return this.rows.map((row) => ({ ...row }));
  }
  listProviderSubagents(): ProviderSubagentDescriptor[] {
    return [];
  }
  append(item: AgentTimelineItem): void {
    this.seq += 1;
    this.rows.push({ seq: this.seq, timestamp: new Date(0).toISOString(), item });
    this.emitTimeline(item, this.seq);
  }
  replaceLast(item: AgentTimelineItem): void {
    const last = this.rows.at(-1)!;
    last.item = item;
    this.emitTimeline(item, last.seq);
  }
  private emitTimeline(item: AgentTimelineItem, seq: number): void {
    for (const listener of this.listeners) {
      listener({
        type: "agent_stream",
        agentId: AGENT_ID,
        seq,
        event: { type: "timeline", provider: "mock", item },
      });
    }
  }
}

function tool(callId: string, status: "running" | "completed"): AgentTimelineItem {
  return {
    type: "tool_call",
    callId,
    name: "Bash",
    status,
    error: null,
    detail: { type: "shell", command: `echo ${callId}` },
  } as AgentTimelineItem;
}

describe("ActivityGraphService", () => {
  let agents: FakeAgents;
  let rendered: GraphModel[];
  let service: ActivityGraphService;
  let pushes: ActivityGraphPush[];

  beforeEach(() => {
    vi.useFakeTimers();
    agents = new FakeAgents();
    rendered = [];
    pushes = [];
    service = new ActivityGraphService({
      agents,
      logger: pino({ level: "silent" }),
      now: () => Date.now(),
      render: async (model) => {
        rendered.push(model);
        return { ok: true, html: `<svg>${model.nodes.map((node) => node.id).join(",")}</svg>` };
      },
    });
    agents.append({ type: "user_message", text: "Run the steps" });
  });

  afterEach(() => {
    service.dispose();
    vi.useRealTimers();
  });

  it("does nothing for an agent nobody asked about", async () => {
    agents.append(tool("call_1", "running"));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(rendered).toHaveLength(0);
  });

  it("renders at most 3 times for 10 structural steps in 3 s (31.7 #3)", async () => {
    service.subscribe(AGENT_ID, "flow", (push) => pushes.push(push));
    const renderTimes: number[] = [];
    const startedAt = Date.now();
    const originalPush = rendered.push.bind(rendered);
    rendered.push = (...models: GraphModel[]) => {
      renderTimes.push(Date.now() - startedAt);
      return originalPush(...models);
    };
    for (let index = 1; index <= 10; index += 1) {
      agents.append({ type: "reasoning", text: `step ${index}` });
      agents.append(tool(`call_${index}`, "running"));
      await vi.advanceTimersByTimeAsync(300);
    }
    await vi.advanceTimersByTimeAsync(RENDER_THROTTLE_MS * 3);
    expect(service.renderCount(AGENT_ID)).toBeLessThanOrEqual(3);
    // One render per 1 500 ms window at most.
    for (let index = 1; index < renderTimes.length; index += 1) {
      expect(renderTimes[index]! - renderTimes[index - 1]!).toBeGreaterThanOrEqual(
        RENDER_THROTTLE_MS,
      );
    }
    // The last render has every step, and each new version was pushed as `changed`.
    expect(rendered.at(-1)?.nodes.some((node) => node.id === "tools-call_10")).toBe(true);
    expect(pushes.filter((push) => push.type === "changed")).toHaveLength(rendered.length);
  });

  it("pushes a status change within 1 s without re-rendering (31.7 #2)", async () => {
    service.subscribe(AGENT_ID, "flow", (push) => pushes.push(push));
    agents.append(tool("call_1", "running"));
    await vi.advanceTimersByTimeAsync(RENDER_THROTTLE_MS + 500);
    const rendersBefore = rendered.length;
    expect(rendersBefore).toBeGreaterThan(0);
    pushes.length = 0;
    agents.replaceLast(tool("call_1", "completed"));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(rendered.length).toBe(rendersBefore);
    expect(pushes).toEqual([
      {
        type: "status",
        agentId: AGENT_ID,
        view: "flow",
        graphVersion: expect.any(Number),
        nodes: [{ id: "tools-call_1", status: "done" }],
      },
    ]);
  });

  it("answers get with the html, node index and statuses, sharing the live render", async () => {
    service.subscribe(AGENT_ID, "flow", (push) => pushes.push(push));
    agents.append(tool("call_1", "running"));
    const result = await service.get(AGENT_ID, "flow");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.html).toContain("tools-call_1");
    expect(result.snapshot.nodeIndex["tools-call_1"]).toMatchObject({
      kind: "tools",
      callId: "call_1",
    });
    expect(result.snapshot.nodes).toContainEqual({ id: "tools-call_1", status: "running" });
    expect(result.snapshot.live).toBe(true);
    const renders = rendered.length;
    const again = await service.get(AGENT_ID, "flow");
    expect(again.ok && again.snapshot.graphVersion).toBe(result.snapshot.graphVersion);
    expect(rendered.length).toBe(renders);
  });

  it("reports no_activity and not_found", async () => {
    const empty = new FakeAgents();
    const other = new ActivityGraphService({
      agents: empty,
      logger: pino({ level: "silent" }),
      render: async () => ({ ok: true, html: "" }),
    });
    expect(await other.get(AGENT_ID, "flow")).toEqual({ ok: false, error: "no_activity" });
    expect(await other.get("agt_missing", "flow")).toEqual({ ok: false, error: "not_found" });
    other.dispose();
  });

  it("stops pushing after the last unsubscribe", async () => {
    const id = service.subscribe(AGENT_ID, "flow", (push) => pushes.push(push));
    service.unsubscribe(id);
    agents.append(tool("call_1", "running"));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(pushes).toEqual([]);
    expect(rendered).toHaveLength(0);
  });
});
