/**
 * Spec 41 acceptance on a real Claude Code CLI with the local login (no API key routing):
 * A41.1–A41.4 and A41.9 for Memory, A41.7–A41.8 for the fast fork.
 *
 * Opt in with JAGENTDESK_REAL_MEMORY_E2E=1. It spends real tokens (haiku): the fork case sends
 * about four turns over a ~150k-token seeded session. Set JAGENTDESK_REAL_MEMORY_E2E_OUT to a
 * directory to write the measured timings as JSON.
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { describe, expect, test } from "vitest";
import type { AgentTimelineItem } from "@jagentdesk/protocol/agent-types";
import { ClaudeAgentClient } from "../agent/providers/claude/agent.js";
import { claudeProjectDir, claudeTranscriptPath } from "../agent/providers/claude/project-dir.js";
import { createTestJAgentDeskDaemon } from "../test-utils/jagentdesk-daemon.js";
import { DaemonClient } from "../test-utils/daemon-client.js";

const ENABLED = process.env.JAGENTDESK_REAL_MEMORY_E2E === "1";
const OUT_DIR = process.env.JAGENTDESK_REAL_MEMORY_E2E_OUT;
const CLAUDE = { provider: "claude" as const, model: "haiku", modeId: "bypassPermissions" };
const APP_VERSION = "0.10.1";
const TURN_TIMEOUT_MS = 240_000;

function tmpCwd(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

async function startDaemon() {
  const logger = pino({ level: "silent" });
  const daemon = await createTestJAgentDeskDaemon({
    agentClients: { claude: new ClaudeAgentClient({ logger }) },
    logger,
  });
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: APP_VERSION,
  });
  await client.connect();
  await client.fetchAgents({ subscribe: { subscriptionId: "memory-e2e" } });
  return { daemon, client };
}

async function timeline(client: DaemonClient, agentId: string): Promise<AgentTimelineItem[]> {
  const page = await client.fetchAgentTimeline(agentId, {
    direction: "tail",
    limit: 0,
    projection: "projected",
  });
  return page.entries.map((entry) => entry.item);
}

async function ask(client: DaemonClient, agentId: string, text: string): Promise<number> {
  const startedAt = performance.now();
  await client.sendMessage(agentId, text);
  const finish = await client.waitForFinish(agentId, TURN_TIMEOUT_MS);
  expect(finish.status).toBe("idle");
  return performance.now() - startedAt;
}

function lastAssistantText(items: readonly AgentTimelineItem[]): string {
  const index = items.findLastIndex((item) => item.type === "user_message");
  return items
    .slice(index + 1)
    .flatMap((item) => (item.type === "assistant_message" ? [item.text] : []))
    .join("");
}

function memoryCards(items: readonly AgentTimelineItem[]) {
  return items.flatMap((item) =>
    item.type === "plugin" && item.pluginId === "memory" && item.kind === "memory-used"
      ? [item.data as { memories: { id: string; kind: string }[] }]
      : [],
  );
}

function writeResult(name: string, value: unknown): void {
  if (!OUT_DIR) return;
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(path.join(OUT_DIR, `${name}.json`), `${JSON.stringify(value, null, 2)}\n`);
}

describe.runIf(ENABLED)("spec 41 memory on real Claude", () => {
  test("A41.1–A41.4, A41.9", { timeout: 1_200_000 }, async () => {
    const { daemon, client } = await startDaemon();
    const cwdA = tmpCwd("jad-mem-a-");
    const cwdB = tmpCwd("jad-mem-b-");
    let turnsStarted = 0;
    const offTurns = client.on("agent_stream", (message) => {
      if (message.payload.event.type === "turn_started") turnsStarted += 1;
    });
    const sentTurns = { count: 0 };
    const send = async (agentId: string, text: string) => {
      sentTurns.count += 1;
      return ask(client, agentId, text);
    };
    try {
      // A41.1
      const first = await client.createAgent({ ...CLAUDE, cwd: cwdA, title: "memory-a" });
      await send(
        first.id,
        "Remember that this project uses pnpm to install dependencies. Save that with the remember tool, then reply 'saved'.",
      );
      const projectList = await client.listMemories({ scope: "project", agentId: first.id });
      const pnpm = projectList.memories.find((memory) => /pnpm/i.test(memory.text));
      expect(pnpm?.source).toMatchObject({ by: "agent", agentId: first.id });

      // A41.4
      await send(
        first.id,
        "Use the remember tool to save exactly this text and nothing else: 'CI deploy token is ghp_abcdefghijklmnopqrstuvwxyzABCDEFGHIJ12'. Then tell me what the tool answered.",
      );
      const afterSecret = await client.listMemories({ scope: "project", agentId: first.id });
      expect(afterSecret.memories.some((memory) => memory.text.includes("ghp_"))).toBe(false);
      const firstItems = await timeline(client, first.id);
      writeResult("memory-first-agent-timeline", firstItems);
      // Either the tool refused it, or the model declined to send a credential at all.
      const secretCalls = firstItems.filter(
        (item) =>
          item.type === "tool_call" &&
          /remember/.test(item.name) &&
          JSON.stringify(item.detail).includes("ghp_"),
      );
      expect(secretCalls.every((item) => JSON.stringify(item).includes('"secret"'))).toBe(true);
      // The same validation behind the tool, through memory.save.
      await expect(
        client.saveMemory({
          scope: "project",
          agentId: first.id,
          text: "CI deploy token is ghp_abcdefghijklmnopqrstuvwxyzABCDEFGHIJ12",
        }),
      ).rejects.toMatchObject({ code: "secret" });

      // A41.2
      const second = await client.createAgent({ ...CLAUDE, cwd: cwdA, title: "memory-a2" });
      await send(
        second.id,
        "Which tool should I use to install the dependencies of this project? Answer in one short line.",
      );
      const secondItems = await timeline(client, second.id);
      const secondCards = memoryCards(secondItems);
      expect(secondCards.at(-1)?.memories.map((memory) => memory.id)).toEqual([pnpm!.id]);
      expect(lastAssistantText(secondItems)).toMatch(/pnpm/i);

      // A41.3
      const global = await client.saveMemory({ scope: "global", text: "Trả lời bằng tiếng Việt." });
      const third = await client.createAgent({ ...CLAUDE, cwd: cwdB, title: "memory-b" });
      await send(third.id, "Trả lời ngắn gọn: thủ đô của Pháp là gì?");
      const thirdCards = memoryCards(await timeline(client, third.id));
      expect(thirdCards.at(-1)?.memories.map((memory) => memory.id)).toContain(global.memory.id);
      await client.deleteMemory(global.memory.id);
      await send(third.id, "Trả lời ngắn gọn: hai cộng hai bằng mấy?");
      const thirdItemsAfter = await timeline(client, third.id);
      const lastUser = thirdItemsAfter.findLastIndex((item) => item.type === "user_message");
      expect(memoryCards(thirdItemsAfter.slice(lastUser))).toEqual([]);

      // A41.9: every provider turn is one the user sent; memory never started one.
      expect(turnsStarted).toBe(sentTurns.count);
      writeResult("memory", {
        pnpmMemory: pnpm,
        secondAnswer: lastAssistantText(secondItems),
        thirdCards,
        secretToolCalls: secretCalls.length,
        turnsStarted,
        sentTurns: sentTurns.count,
      });
    } finally {
      offTurns();
      await client.close().catch(() => undefined);
      await daemon.close();
      for (const cwd of [cwdA, cwdB]) {
        rmSync(await claudeProjectDir(cwd), { recursive: true, force: true });
        rmSync(cwd, { recursive: true, force: true });
      }
    }
  });
});

const SEEDED_TURNS = 1_000;
const FORK_STEP = 500;
const FILLER =
  "Context for this step: the build pipeline compiles the protocol package first, then the client, then the daemon, and each stage writes declarations that the next stage reads; when a stage is stale the type checker reports missing modules that are not really missing. Rebuilding the owning stack before diagnosing such errors saves an afternoon of chasing phantom type mismatches across workspaces.";

function codeWord(step: number): string {
  return `CW${step.toString(36).toUpperCase()}${((step * 7919) % 9973).toString(36).toUpperCase()}`;
}

/** Writes a ~150k-token Claude transcript built from a real session's entry shapes. */
function seedTranscript(input: { templatePath: string; targetPath: string; sessionId: string }) {
  const entries = readFileSync(input.templatePath, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  // The prompt the template agent was sent: a user entry carrying text, not a tool result.
  const userTemplate = entries.find((entry) => {
    if (entry.type !== "user" || entry.isMeta) return false;
    const content = (entry.message as { content?: unknown }).content;
    if (typeof content === "string") return content.includes("ready");
    return (
      Array.isArray(content) &&
      content.some(
        (block: { type?: string; text?: string }) =>
          block.type === "text" && block.text?.includes("ready"),
      )
    );
  });
  const assistantTemplate = entries.find((entry) => entry.type === "assistant");
  if (!userTemplate || !assistantTemplate) throw new Error("Template session has no turn");
  const lines: string[] = [];
  let parentUuid: string | null = null;
  const start = Date.now() - SEEDED_TURNS * 2_000;
  for (let step = 1; step <= SEEDED_TURNS; step += 1) {
    const userUuid = randomUUID();
    lines.push(
      JSON.stringify({
        ...userTemplate,
        parentUuid,
        uuid: userUuid,
        sessionId: input.sessionId,
        timestamp: new Date(start + step * 2_000).toISOString(),
        message: {
          role: "user",
          content: `Step ${step}: the code word is ${codeWord(step)}. ${FILLER}`,
        },
      }),
    );
    const assistantUuid = randomUUID();
    const assistantMessage = assistantTemplate.message as Record<string, unknown>;
    lines.push(
      JSON.stringify({
        ...assistantTemplate,
        parentUuid: userUuid,
        uuid: assistantUuid,
        sessionId: input.sessionId,
        requestId: `req_seed_${step}`,
        timestamp: new Date(start + step * 2_000 + 1_000).toISOString(),
        message: {
          ...assistantMessage,
          id: `msg_seed_${step}`,
          content: [
            {
              type: "text",
              text: `Noted step ${step}. ${FILLER}`,
            },
          ],
        },
      }),
    );
    parentUuid = assistantUuid;
  }
  writeFileSync(input.targetPath, `${lines.join("\n")}\n`);
}

class RssSampler {
  peak = process.memoryUsage().rss;
  private readonly timer = setInterval(() => {
    this.peak = Math.max(this.peak, process.memoryUsage().rss);
  }, 20);
  stop(): number {
    clearInterval(this.timer);
    return Math.max(this.peak, process.memoryUsage().rss);
  }
}

const mb = (bytes: number) => Math.round(bytes / 1024 / 1024);

describe.runIf(ENABLED)("spec 41 fast fork on real Claude", () => {
  test("A41.7, A41.8 against the seeded-history fork", { timeout: 1_800_000 }, async () => {
    const { daemon, client } = await startDaemon();
    const cwd = tmpCwd("jad-fork-");
    try {
      // A real one-turn session supplies the transcript entry shapes.
      const template = await client.createAgent({ ...CLAUDE, cwd, title: "fork-template" });
      await ask(client, template.id, "Reply with the single word: ready");
      const templateSession = (await client.fetchAgent(template.id))?.agent.persistence?.sessionId;
      expect(templateSession).toBeTruthy();
      const templatePath = await claudeTranscriptPath({ cwd, sessionId: templateSession! });

      const sessionId = randomUUID();
      const targetPath = path.join(path.dirname(templatePath), `${sessionId}.jsonl`);
      seedTranscript({ templatePath, targetPath, sessionId });
      const transcriptChars = readFileSync(targetPath, "utf8").length;

      const parent = await client.resumeAgent(
        { provider: "claude", sessionId, nativeHandle: sessionId },
        { cwd, model: CLAUDE.model, modeId: CLAUDE.modeId, title: "seeded parent" },
      );
      const page = await client.fetchAgentTimeline(parent.id, {
        direction: "tail",
        limit: 0,
        projection: "projected",
      });
      const timelineEntries = page.entries.length;
      expect(timelineEntries).toBeGreaterThanOrEqual(2_000);
      const boundaryEntry = page.entries.find(
        (entry) =>
          entry.item.type === "assistant_message" &&
          entry.item.text.startsWith(`Noted step ${FORK_STEP}.`),
      );
      expect(boundaryEntry).toBeDefined();
      const boundaryCursor = { epoch: page.epoch, seq: boundaryEntry!.seqEnd };
      const question = `What was the code word in step 400, and in step 700? If a step is not in this conversation, write UNKNOWN for it. Reply in one line.`;

      // Before (seeded draft): the curated chat-history attachment, then a new agent.
      const rssBeforeOld = process.memoryUsage().rss;
      const oldSampler = new RssSampler();
      const oldStart = performance.now();
      const context = await client.buildAgentForkContext(parent.id, { boundaryCursor });
      const oldAgent = await client.createAgent({
        ...CLAUDE,
        cwd,
        title: "old fork",
        attachments: context.attachment ? [context.attachment] : [],
        initialPrompt: question,
      });
      const oldVisibleMs = performance.now() - oldStart;
      const oldFinish = await client.waitForFinish(oldAgent.id, TURN_TIMEOUT_MS);
      const oldReplyMs = performance.now() - oldStart;
      const oldPeak = oldSampler.stop();
      const oldAnswer = lastAssistantText(await timeline(client, oldAgent.id));

      // After: the native fork.
      const rssBeforeNew = process.memoryUsage().rss;
      const newSampler = new RssSampler();
      const newStart = performance.now();
      const forked = await client.forkAgent(parent.id, { boundaryCursor });
      const newVisibleMs = performance.now() - newStart;
      const newForkPeak = newSampler.stop();
      expect(forked.error).toBeNull();
      const forkId = forked.agent!.id;
      const forkItems = await timeline(client, forkId);
      const newReplyMs = await ask(client, forkId, question);
      const newAnswer = lastAssistantText(await timeline(client, forkId));

      // A normal turn on the parent, for the first-reply comparison.
      const normalTurnMs = await ask(
        client,
        parent.id,
        "What was the code word in step 3? Reply in one line.",
      );

      const usageOf = async (agentId: string) =>
        (await client.fetchAgent(agentId))?.agent.lastUsage ?? null;
      const result = {
        usage: {
          parentNormalTurn: await usageOf(parent.id),
          beforeFork: await usageOf(oldAgent.id),
          afterFork: await usageOf(forkId),
        },
        transcriptChars,
        approxTranscriptTokens: Math.round(transcriptChars / 4),
        timelineEntries,
        before: {
          visibleMs: Math.round(oldVisibleMs),
          firstReplyMs: Math.round(oldReplyMs),
          finishStatus: oldFinish.status,
          rssBeforeMb: mb(rssBeforeOld),
          rssPeakMb: mb(oldPeak),
          contextChars: context.attachment?.text.length ?? 0,
          answer: oldAnswer,
        },
        after: {
          visibleMs: Math.round(newVisibleMs),
          firstReplyMs: Math.round(newReplyMs),
          rssBeforeMb: mb(rssBeforeNew),
          rssPeakDuringForkMb: mb(newForkPeak),
          forkTimelineRows: forkItems.length,
          answer: newAnswer,
        },
        normalParentTurnMs: Math.round(normalTurnMs),
      };
      writeResult("fork", result);

      // A41.7
      expect(newVisibleMs).toBeLessThanOrEqual(2_000);
      expect(newForkPeak - rssBeforeNew).toBeLessThanOrEqual(200 * 1024 * 1024);
      expect(forkItems).toHaveLength(1);
      // A41.8
      expect(newAnswer).toContain(codeWord(400));
      expect(newAnswer).not.toContain(codeWord(700));
    } finally {
      await client.close().catch(() => undefined);
      await daemon.close();
      rmSync(await claudeProjectDir(cwd), { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
