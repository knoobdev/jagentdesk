import { beforeAll, describe, expect, test } from "vitest";
import { mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestJAgentDeskDaemon } from "../test-utils/jagentdesk-daemon.js";
import { ClaudeAgentClient } from "../agent/providers/claude/agent.js";
import { isCommandAvailable } from "../../executable-resolution/executable-resolution.js";

// LIVE demo of Team mode (docs/plans/completed/agent-forum.md) with a REAL Claude agent: turn on
// Team mode → the lead opens a topic, posts a plan, creates/estimates tasks, (optionally) spawns
// peers, and moves the board. Streams the evolving topic to the console so a human can watch it.
// Runs only when the `claude` CLI is available; bounded so it never runs away.

const MODEL = process.env.FORUM_DEMO_MODEL ?? "opus";
const POLL_MS = 5000;
const MAX_MS = 240_000;

/* eslint-disable no-console */
type LiveTopic = NonNullable<Awaited<ReturnType<DaemonClient["forumGet"]>>>;

function printNewMessages(topic: LiveTopic, seen: Set<string>): void {
  for (const m of topic.messages) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    console.log(`  💬 [${m.role}] ${m.authorLabel}: ${m.text.slice(0, 240)}`);
  }
}

function printNewTasks(topic: LiveTopic, seen: Map<string, string>): void {
  for (const task of topic.tasks) {
    const sig = `${task.status}|${task.assigneeAgentId ?? "-"}|${task.estimate}`;
    if (seen.get(task.id) === sig) continue;
    seen.set(task.id, sig);
    const who = task.assigneeAgentId ? `, @${task.assigneeAgentId.slice(0, 8)}` : "";
    console.log(
      `  📋 [${task.status}] ${task.parentTaskId ? "↳ " : ""}${task.title} (est ${task.estimate}${who})`,
    );
  }
}
/* eslint-enable no-console */

describe("agent forum — LIVE team run (real claude)", () => {
  let canRun = false;
  beforeAll(async () => {
    canRun = await isCommandAvailable("claude");
  });

  test(
    "a real lead opens a topic, plans it, and works the board",
    async (context) => {
      if (!canRun) {
        context.skip();
        return;
      }
      const logger = pino({ level: "silent" });
      const cwd = mkdtempSync(path.join(tmpdir(), "forum-live-"));
      try {
        execFileSync("git", ["init", "-q"], { cwd });
      } catch {
        /* git optional */
      }

      // Use the locally logged-in `claude` CLI (Claude Code) directly — no OpenRouter env override.
      const daemon = await createTestJAgentDeskDaemon({
        agentClients: { claude: new ClaudeAgentClient({ logger }) },
        logger,
      });
      const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });

      try {
        await client.connect();
        await client.fetchAgents({ subscribe: { subscriptionId: "forum-live" } });

        const agent = await client.createAgent({
          cwd,
          title: "Team Lead (live)",
          provider: "claude",
          model: MODEL,
          modeId: "bypassPermissions",
        });
        // eslint-disable-next-line no-console
        console.log(`\n[forum-live] lead agent ${agent.id.slice(0, 8)} (${MODEL}) in ${cwd}`);

        // This is exactly what the composer's Team-mode send does.
        const topic = await client.forumCreate({
          prompt:
            "Build a tiny static web app in this folder: index.html with a title and an 'Add todo' " +
            "input + button + list, plus style.css. Work as a team: plan it, split into tasks, " +
            "estimate them, delegate where useful, and keep the board updated.",
          originAgentId: agent.id,
          bootstrapLead: true,
        });
        const topicId = topic!.id;
        // eslint-disable-next-line no-console
        console.log(`[forum-live] topic ${topicId}\n`);

        const seenMsg = new Set<string>();
        const seenTaskState = new Map<string, string>();
        const start = Date.now();
        let lastTaskCount = 0;
        while (Date.now() - start < MAX_MS) {
          const t = await client.forumGet(topicId);
          if (t) {
            printNewMessages(t, seenMsg);
            printNewTasks(t, seenTaskState);
            lastTaskCount = t.tasks.length;
            if (t.status === "done") break;
          }
          await new Promise((r) => setTimeout(r, POLL_MS));
        }

        const final = await client.forumGet(topicId);
        // eslint-disable-next-line no-console
        console.log(
          `\n[forum-live] FINAL: status=${final?.status} messages=${final?.messages.length} ` +
            `tasks=${final?.tasks.length} participants=${final?.participants.length}`,
        );
        // The lead should at least have opened the topic and started planning it as a team.
        expect(lastTaskCount + (final?.messages.length ?? 0)).toBeGreaterThan(1);
      } finally {
        await client.close();
        await daemon.close();
      }
    },
    MAX_MS + 60_000,
  );
});
