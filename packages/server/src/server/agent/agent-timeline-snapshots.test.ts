import { appendFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { AgentManager } from "./agent-manager.js";
import { ensureAgentLoaded } from "./agent-loading.js";
import type { AgentTimelineItem } from "./agent-sdk-types.js";
import { AgentStorage } from "./agent-storage.js";
import { AgentTimelineSnapshots } from "./agent-timeline-snapshots.js";
import { InMemoryAgentTimelineStore } from "./agent-timeline-store.js";
import {
  generateClaudeLargeHistory,
  type ClaudeLargeHistory,
} from "./test-utils/large-history/claude-fixture.js";
import { ClaudeAgentClient } from "./providers/claude/agent.js";

const AGENT_ID = "00000000-0000-4000-8000-00000000c0de";
const logger = createTestLogger();

function tool(status: "running" | "completed"): AgentTimelineItem {
  return {
    type: "tool_call",
    callId: "call-1",
    name: "shell",
    status,
    error: null,
    detail: {
      type: "plain_text",
      label: "npm test",
      ...(status === "completed" ? { text: "ok" } : {}),
    },
  };
}

describe("timeline snapshot restore", () => {
  test("a restored timeline pages and merges later rows exactly like the one it was taken from", () => {
    const live = new InMemoryAgentTimelineStore();
    live.initialize("agent", { epoch: "epoch-1" });
    let clock = 0;
    // Fixed timestamps: the copies below append at different instants.
    const at = () => ({
      turnId: "t1",
      timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, clock++)).toISOString(),
    });
    live.append("agent", { type: "user_message", text: "go", messageId: "u1" }, at());
    live.append("agent", { type: "reasoning", text: "Think" }, at());
    live.append("agent", { type: "reasoning", text: "ing" }, at());
    live.append("agent", tool("running"), at());
    live.append("agent", { type: "assistant_message", text: "Hel" }, at());

    const restored = new InMemoryAgentTimelineStore();
    restored.restore("agent", JSON.parse(JSON.stringify(live.snapshot("agent"))));

    // Both receive the rest of the turn: a chunk continuing the reply and the tool's completion.
    const rest = clock;
    for (const store of [live, restored]) {
      clock = rest;
      store.append("agent", { type: "assistant_message", text: "lo" }, at());
      store.append("agent", tool("completed"), at());
      store.stampTurnMetrics("agent", [{ label: "Duration", value: "4s" }], {
        turnId: "t1",
      });
    }

    for (const options of [
      { direction: "tail" as const, limit: 2 },
      { direction: "tail" as const, limit: 0 },
      { direction: "before" as const, cursor: { epoch: "epoch-1", seq: 5 }, limit: 2 },
      { direction: "after" as const, cursor: { epoch: "epoch-1", seq: 2 }, limit: 10 },
    ]) {
      expect(restored.fetch("agent", options)).toEqual(live.fetch("agent", options));
    }
    expect(restored.getLastAssistantMessage("agent")).toBe("Hello");
    expect(restored.getHead("agent")).toEqual(live.getHead("agent"));
  });
});

describe("AgentTimelineSnapshots", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "agent-timeline-snapshots-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  test("a busy agent is not written until it settles", async () => {
    const snapshots = new AgentTimelineSnapshots({ directory: root, logger, writeDelayMs: 10 });
    let busy = true;
    snapshots.attach(async (agentId) =>
      busy
        ? { status: "busy" }
        : {
            status: "ready",
            snapshot: {
              version: 1,
              agentId,
              provider: "claude",
              sessionId: "s",
              historyVersion: "v1",
              writtenAt: "2026-11-26T00:00:00.000Z",
              timeline: { epoch: "e", nextSeq: 1, rows: [] },
              subagents: [],
            },
          },
    );
    snapshots.markChanged("agent");
    await snapshots.flush("agent");
    expect(await snapshots.read("agent")).toBeNull();

    busy = false;
    await snapshots.flush("agent");
    expect(await snapshots.read("agent")).toMatchObject({ historyVersion: "v1" });
    snapshots.dispose();
  });

  test("an unreadable snapshot reads as missing", async () => {
    const snapshots = new AgentTimelineSnapshots({ directory: root, logger });
    writeFileSync(path.join(root, "agent.json"), "{ not json");
    expect(await snapshots.read("agent")).toBeNull();
    writeFileSync(path.join(root, "agent.json"), JSON.stringify({ version: 99, agentId: "agent" }));
    expect(await snapshots.read("agent")).toBeNull();
  });
});

describe("reopening a long Claude agent", () => {
  let root: string;
  let history: ClaudeLargeHistory;
  const previousConfigDir = process.env.CLAUDE_CONFIG_DIR;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "agent-timeline-reopen-"));
    history = generateClaudeLargeHistory({
      root,
      size: {
        turns: 8,
        toolsPerTurn: 2,
        promptChars: 80,
        thinkingChars: 80,
        textChars: 80,
        toolOutputChars: 400,
        subagentEvery: 4,
        hugeOutputEvery: 0,
        hugeOutputChars: 0,
        imageEvery: 0,
      },
    });
    process.env.CLAUDE_CONFIG_DIR = history.configDir;
  });
  afterEach(() => {
    if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
    rmSync(root, { recursive: true, force: true });
  });

  /** One daemon lifetime: open the agent, read its tail page and subagents, close it. */
  async function openInFreshDaemon() {
    const storage = new AgentStorage(path.join(root, "home", "agents"), logger);
    const snapshots = new AgentTimelineSnapshots({
      directory: path.join(root, "home", "agent-timelines"),
      logger,
    });
    const manager = new AgentManager({
      clients: {
        claude: new ClaudeAgentClient({
          logger,
          queryFactory: () => {
            throw new Error("Opening history must not query Claude");
          },
          resolveBinary: async () => process.execPath,
          resolveVersion: async () => "2.1.220",
        }),
      },
      registry: storage,
      timelineSnapshots: snapshots,
      logger,
    });
    if (!(await storage.get(AGENT_ID))) {
      const now = new Date().toISOString();
      await storage.upsert({
        id: AGENT_ID,
        provider: "claude",
        cwd: history.cwd,
        createdAt: now,
        updatedAt: now,
        labels: {},
        metadata: {},
        lastStatus: "closed",
        config: null,
        persistence: { provider: "claude", sessionId: history.sessionId },
      });
    }
    await ensureAgentLoaded(AGENT_ID, {
      agentManager: manager,
      agentStorage: storage,
      logger,
      purpose: "history",
    });
    const tail = manager.fetchTimeline(AGENT_ID, {
      direction: "tail",
      limit: 40,
      wholeTurns: true,
    });
    const subagents = manager.listProviderSubagents(AGENT_ID).map(({ id, status, title }) => ({
      id,
      status,
      title,
    }));
    await manager.closeAgent(AGENT_ID);
    await manager.flush();
    snapshots.dispose();
    return { tail, subagents };
  }

  test("restores the timeline it closed with, and replays a history that changed since", async () => {
    const first = await openInFreshDaemon();
    expect(first.tail.rows.at(-1)?.item).toMatchObject({
      type: "assistant_message",
      text: history.lastAssistantText,
    });
    expect(first.subagents).toHaveLength(2);
    expect(existsSync(path.join(root, "home", "agent-timelines", `${AGENT_ID}.json`))).toBe(true);

    // Claude Code appends bookkeeping whenever a resumed session starts or exits, for example
    // when the app lists the agent's slash commands. That is not a change of history.
    appendFileSync(
      history.transcriptPath,
      `${[
        { type: "tools-used", tools: ["Bash"], sessionId: history.sessionId },
        { type: "mode", mode: "normal", sessionId: history.sessionId },
        { type: "cost-state", sessionId: history.sessionId, totalCostUSD: 0, totalDuration: 975 },
      ]
        .map((record) => JSON.stringify(record))
        .join("\n")}\n`,
    );

    // A restore keeps the epoch, so the cursors a client holds stay valid. A replay mints one.
    const reopened = await openInFreshDaemon();
    expect(reopened.tail.epoch).toBe(first.tail.epoch);
    expect(reopened.tail.rows).toEqual(first.tail.rows);
    expect(reopened.tail.window).toEqual(first.tail.window);
    expect(reopened.subagents).toEqual(first.subagents);

    // The conversation continued outside the daemon: the snapshot no longer names this history.
    appendFileSync(
      history.transcriptPath,
      `${[
        {
          type: "user",
          uuid: "outside-user",
          parentUuid: null,
          sessionId: history.sessionId,
          timestamp: "2026-09-01T00:00:00.000Z",
          message: { role: "user", content: "Continue from the terminal" },
        },
        {
          type: "assistant",
          uuid: "outside-assistant",
          parentUuid: "outside-user",
          sessionId: history.sessionId,
          timestamp: "2026-09-01T00:00:01.000Z",
          message: {
            id: "msg_outside",
            role: "assistant",
            content: [{ type: "text", text: "Answered in the terminal" }],
            stop_reason: "end_turn",
          },
        },
      ]
        .map((record) => JSON.stringify(record))
        .join("\n")}\n`,
    );
    const replayed = await openInFreshDaemon();
    expect(replayed.tail.epoch).not.toBe(first.tail.epoch);
    expect(replayed.tail.rows.at(-1)?.item).toMatchObject({
      type: "assistant_message",
      text: "Answered in the terminal",
    });
  });

  test("a session whose timeline the host holds does not keep the history it reads later", async () => {
    const client = new ClaudeAgentClient({
      logger,
      queryFactory: () => {
        throw new Error("History must not query Claude");
      },
      resolveBinary: async () => process.execPath,
      resolveVersion: async () => "2.1.220",
    });
    const held = await client.resumeSession(
      { provider: "claude", sessionId: history.sessionId },
      { provider: "claude", cwd: history.cwd },
    );
    held.discardHistoryReplay?.();
    const heldEvents = [];
    for await (const event of held.streamHistory()) heldEvents.push(event);
    await held.close();
    expect(heldEvents).toEqual([]);

    const replayed = await client.resumeSession(
      { provider: "claude", sessionId: history.sessionId },
      { provider: "claude", cwd: history.cwd },
    );
    const replayedEvents = [];
    for await (const event of replayed.streamHistory()) replayedEvents.push(event);
    await replayed.close();
    expect(replayedEvents.length).toBeGreaterThan(40);
  });
});
