import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";

import type { AgentTimelineItem } from "../agent/agent-sdk-types.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestJAgentDeskDaemon } from "../test-utils/jagentdesk-daemon.js";
import { ClaudeAgentClient } from "../agent/providers/claude/agent.js";
import { CodexAppServerAgentClient } from "../agent/providers/codex-app-server-agent.js";

/** Claude and Codex with their own local sign-in; no OpenRouter key is involved. */
function hasBinary(name: string): boolean {
  try {
    execFileSync("which", [name], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function gitRepo(): string {
  const cwd = mkdtempSync(path.join(tmpdir(), "daemon-real-switch-provider-"));
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@t",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@t",
  };
  execFileSync("git", ["init", "-q"], { cwd, env });
  writeFileSync(path.join(cwd, "README.md"), "switch provider test\n");
  execFileSync("git", ["add", "."], { cwd, env });
  execFileSync("git", ["commit", "-qm", "init"], { cwd, env });
  return cwd;
}

function compactText(value: string): string {
  return value.replace(/\s+/g, "").toLowerCase();
}

async function timelineItems(client: DaemonClient, agentId: string): Promise<AgentTimelineItem[]> {
  const timeline = await client.fetchAgentTimeline(agentId, {
    direction: "tail",
    limit: 0,
    projection: "canonical",
  });
  return timeline.entries.map((entry) => entry.item as AgentTimelineItem);
}

async function lastAssistantText(client: DaemonClient, agentId: string): Promise<string> {
  const items = await timelineItems(client, agentId);
  const last = items.findLast((item) => item.type === "assistant_message");
  return last && last.type === "assistant_message" ? last.text : "";
}

async function sendAndFinish(client: DaemonClient, agentId: string, text: string): Promise<void> {
  await client.sendMessage(agentId, text);
  const finish = await client.waitForFinish(agentId, 240_000);
  expect(finish.status).toBe("idle");
  expect(finish.final?.lastError).toBeUndefined();
}

async function switchToCodexWithHandoff(client: DaemonClient, agentId: string) {
  await client.switchAgentProvider(agentId, "codex", null);
  // Keep the run cheap: the switch starts Codex on its defaults.
  await client.setAgentThinkingOption(agentId, "low");
  const switchRow = (await timelineItems(client, agentId)).find(
    (item) => item.type === "notification" && item.providerSwitch?.toProvider === "codex",
  );
  expect(switchRow?.type === "notification" ? switchRow.message : "").toMatch(/^Switched to Codex/);
  const ledger = (await client.getAgentLedger(agentId)).ledger;
  const handoff = ledger?.handoffs.at(-1);
  if (!handoff) throw new Error("No handoff was staged");
  expect(handoff.mode).toBe("handoff");
  // A40.2: the handoff lists both files with their diffs; A40.8: it carries the decision.
  for (const expected of [
    "alpha.txt",
    "beta.txt",
    "+alpha one",
    "+beta one",
    "Secret code is 4417",
  ]) {
    expect(handoff.text).toContain(expected);
  }
  return handoff;
}

async function switchBackToClaudeWithDelta(
  client: DaemonClient,
  agentId: string,
  input: { model: string; claudeSessionId: string | null | undefined; handoffTokens: number },
): Promise<void> {
  await client.switchAgentProvider(agentId, "claude", input.model);
  const ledger = (await client.getAgentLedger(agentId)).ledger;
  const delta = ledger?.handoffs.at(-1);
  if (!delta) throw new Error("No delta was staged");
  expect(delta.mode).toBe("delta");
  expect(delta.toProvider).toBe("Claude");
  expect(delta.estimatedTokens).toBeLessThan(input.handoffTokens);
  expect(delta.text).not.toContain("+alpha one");
  const current = ledger?.providerSessions.find((entry) => entry.current);
  expect(current?.provider).toBe("claude");
  expect(current?.sessionId).toBe(input.claudeSessionId);
}

// Spec 40 A40.1, A40.2, A40.3, A40.8, A40.9 on real Claude and Codex.
describe("daemon E2E (real claude + codex) - cross-provider continuity", () => {
  let canRun = false;

  beforeAll(async () => {
    canRun = hasBinary("claude") && hasBinary("codex");
  });

  beforeEach((context) => {
    if (!canRun) {
      context.skip();
    }
  });

  test("claude → codex → claude keeps context through the ledger and native resume", async () => {
    const logger = pino({ level: "silent" });
    const cwd = gitRepo();
    const daemon = await createTestJAgentDeskDaemon({
      agentClients: {
        claude: new ClaudeAgentClient({ logger }),
        codex: new CodexAppServerAgentClient(logger),
      },
      logger,
    });
    const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
    const claude = { provider: "claude", model: "haiku", modeId: "bypassPermissions" } as const;

    try {
      await client.connect();
      await client.fetchAgents({ subscribe: { subscriptionId: "switch-provider-real" } });
      const agent = await client.createAgent({ cwd, title: "switch-provider-real", ...claude });

      // Turn 1: edit two files on Claude.
      await sendAndFinish(
        client,
        agent.id,
        "In the current directory create alpha.txt containing exactly 'alpha one' and beta.txt " +
          "containing exactly 'beta one'. Use your file tools. Then reply DONE.",
      );
      // Turn 2: the secret, recorded as a decision with update_session_ledger (A40.8).
      await sendAndFinish(
        client,
        agent.id,
        "The secret code is 4417. Call the update_session_ledger tool with decisions " +
          '["Secret code is 4417 (given by the user)"]. Then reply ACK.',
      );
      const ledgerBefore = await client.getAgentLedger(agent.id);
      expect(ledgerBefore.ledger?.decisions.map((note) => note.text).join("\n")).toContain("4417");
      const claudeSessionId = ledgerBefore.ledger?.providerSessions.find(
        (entry) => entry.current,
      )?.sessionId;
      expect(claudeSessionId).toBeTruthy();

      // Switch to Codex (A40.1): a new session with the full handoff.
      const handoff = await switchToCodexWithHandoff(client, agent.id);

      // Turn 3 on Codex answers from the handoff (A40.1, A40.2).
      await sendAndFinish(
        client,
        agent.id,
        "Without running any tools: what is the secret code, and which files were created or " +
          "edited in this session? Answer in one line as CODE=<code> FILES=<names separated by commas>.",
      );
      const codexAnswer = compactText(await lastAssistantText(client, agent.id));
      expect(codexAnswer).toContain("4417");
      expect(codexAnswer).toContain("alpha.txt");
      expect(codexAnswer).toContain("beta.txt");

      // Switch back to Claude (A40.3): resume the same native session and send only the delta.
      await switchBackToClaudeWithDelta(client, agent.id, {
        model: claude.model,
        claudeSessionId,
        handoffTokens: handoff.estimatedTokens,
      });

      await sendAndFinish(
        client,
        agent.id,
        "Without running any tools: what did you answer in the turn before this one? Quote the CODE part only.",
      );
      expect(compactText(await lastAssistantText(client, agent.id))).toContain("4417");

      // A40.9: one provider turn per user message, nothing hidden.
      const items = await timelineItems(client, agent.id);
      const userTurns = items.filter((item) => item.type === "user_message").length;
      expect(userTurns).toBe(4);
      const snapshot = await client.fetchAgent(agent.id);
      expect(snapshot?.agent.usageTotals?.turns).toBe(userTurns);
    } finally {
      await client.close().catch(() => undefined);
      await daemon.close().catch(() => undefined);
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 900_000);
});
