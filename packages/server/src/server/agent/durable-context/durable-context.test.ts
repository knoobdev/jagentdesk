import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentPromptInput, AgentTimelineItem } from "../agent-sdk-types.js";
import {
  DEFAULT_DURABLE_CONTEXT_SETTINGS,
  type DurableContextSettings,
  type MemoryPort,
} from "../memory-port.js";
import type { LedgerTimelineRow } from "../session-ledger/ledger-builder.js";
import { estimateTokens } from "../session-ledger/ledger-render.js";
import { SessionLedgerStore } from "../session-ledger/ledger-store.js";
import { DurableContext } from "./durable-context.js";
import {
  buildRegroundingDocument,
  fitRegroundingBlock,
  LEDGER_NUDGE_TEXT,
  RECITATION_TOKEN_CAP,
  REGROUNDING_TOKEN_CAP,
  renderRecitation,
  unresolvedErrors,
} from "./regrounding.js";
import { collectTimelineLedgerFacts } from "../session-ledger/ledger-builder.js";

const logger = pino({ level: "silent" });

function note(text: string, seq: number) {
  return { id: `n${seq}`, text, seq, at: "2026-11-26T00:00:00.000Z" };
}

function shell(seq: number, command: string, exitCode: number, output = ""): LedgerTimelineRow {
  return {
    seq,
    timestamp: `2026-11-26T10:${String(seq % 60).padStart(2, "0")}:00.000Z`,
    item: {
      type: "tool_call",
      callId: `c${seq}`,
      name: "Bash",
      status: exitCode === 0 ? "completed" : "failed",
      error: exitCode === 0 ? null : "failed",
      detail: { type: "shell", command, exitCode, output },
    } as AgentTimelineItem,
  };
}

function user(seq: number, text: string): LedgerTimelineRow {
  return { seq, item: { type: "user_message", text } };
}

function edit(seq: number, filePath: string): LedgerTimelineRow {
  return {
    seq,
    timestamp: "2026-11-26T09:00:00.000Z",
    item: {
      type: "tool_call",
      callId: `e${seq}`,
      name: "Edit",
      status: "completed",
      error: null,
      detail: { type: "edit", filePath, unifiedDiff: "@@ -1 +1 @@\n-a\n+b" },
    } as AgentTimelineItem,
  };
}

describe("re-grounding block (spec 42 §2)", () => {
  it("lists files with last operation and time, commands with exit codes and unresolved errors", () => {
    const rows = [
      user(1, "Port the importer to pnpm"),
      edit(2, "/repo/src/importer.ts"),
      shell(3, "pnpm test", 1, Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n")),
      shell(4, "pnpm lint", 0),
    ];
    const facts = collectTimelineLedgerFacts({ rows, cwd: "/repo" });
    const document = buildRegroundingDocument({
      facts,
      notes: {
        decisions: [note("Use pnpm workspaces — the lockfile is pnpm", 2)],
        openItems: [note("Fix failing importer test", 3)],
        nextStep: note("Run pnpm test again", 4),
      },
      memories: ["- [lesson, project] This project uses pnpm (source: package.json) {id: mem_1}"],
      memoriesAttached: false,
    });
    const { text } = fitRegroundingBlock(document);
    expect(text).toContain("> Port the importer to pnpm");
    expect(text).toContain("`src/importer.ts` — edit · 2026-11-26 09:00:00Z");
    expect(text).toContain("`pnpm test` — exit 1");
    expect(text).toContain("`pnpm lint` — exit 0");
    expect(text).toContain("Unresolved errors:");
    expect(text).toContain("line 39");
    expect(text).not.toContain("line 19\n");
    expect(text).toContain("## Next step\n\nRun pnpm test again");
    expect(text).toContain("- Use pnpm workspaces — the lockfile is pnpm");
    expect(text).toContain("- [ ] Fix failing importer test");
    expect(text).toContain("This project uses pnpm");
  });

  it("drops a failed command from the unresolved list once the same command passed later", () => {
    const facts = collectTimelineLedgerFacts({
      rows: [user(1, "go"), shell(2, "npm test", 1, "boom"), shell(3, "npm test", 0)],
    });
    expect(unresolvedErrors(facts)).toEqual([]);
  });

  it("stays within 3 000 tokens for a long session and never cuts the goal, the next step or the newest message", () => {
    const rows: LedgerTimelineRow[] = [];
    let seq = 0;
    for (let turn = 0; turn < 400; turn += 1) {
      rows.push(user(++seq, `Turn ${turn}: ${"please keep going with the migration ".repeat(8)}`));
      rows.push(edit(++seq, `/repo/src/module-${turn}.ts`));
      rows.push(
        shell(++seq, `npm run check -- module-${turn}`, turn % 7 === 0 ? 1 : 0, "x\n".repeat(30)),
      );
    }
    const facts = collectTimelineLedgerFacts({ rows, cwd: "/repo" });
    const nextStep = note("Ship module-399 and then open the PR", seq);
    const document = buildRegroundingDocument({
      facts,
      notes: {
        goal: note("Ship the migration of every module", seq - 3),
        decisions: Array.from({ length: 80 }, (_, i) => note(`Decision ${i} with a reason`, i)),
        openItems: Array.from({ length: 30 }, (_, i) => note(`Open item ${i}`, i)),
        nextStep,
      },
      memories: Array.from({ length: 10 }, (_, i) => `- [project] Memory ${i}`),
      memoriesAttached: false,
    });
    const fitted = fitRegroundingBlock(document);
    expect(fitted.estimatedTokens).toBeLessThanOrEqual(REGROUNDING_TOKEN_CAP);
    expect(estimateTokens(fitted.text)).toBeLessThanOrEqual(REGROUNDING_TOKEN_CAP);
    expect(fitted.text).toContain("Ship module-399 and then open the PR");
    expect(fitted.text).toContain("Ship the migration of every module");
    // The newest messages survive, newest first; the oldest are cut and counted.
    expect(fitted.text).toContain("Turn 399:");
    expect(fitted.text).not.toContain("Turn 0:");
    expect(fitted.text.indexOf("Turn 399:")).toBeLessThan(fitted.text.indexOf("Turn 398:"));
    expect(fitted.text).toMatch(/\(\d+ older messages left out to fit\)/);
    expect(fitted.text.endsWith("</jagentdesk-where-we-are>")).toBe(true);
  });

  it("recites Goal · Next · Open in under 120 tokens, marked as context", () => {
    const line = renderRecitation({
      goal: "Build the importer ".repeat(100),
      nextStep: "Run the tests ".repeat(100),
      openCount: 4,
    });
    expect(line).toMatch(
      /^\[JAgentDesk context, not a new request\] Goal: .+ · Next: .+ · Open: 4$/,
    );
    expect(estimateTokens(line ?? "")).toBeLessThanOrEqual(RECITATION_TOKEN_CAP);
  });

  it("leaves empty parts out and sends no line when all are empty", () => {
    expect(renderRecitation({ goal: null, nextStep: null, openCount: 0 })).toBeNull();
    expect(renderRecitation({ goal: "  ", nextStep: "", openCount: 0 })).toBeNull();
    expect(renderRecitation({ goal: "Fix it", nextStep: null, openCount: 0 })).toBe(
      "[JAgentDesk context, not a new request] Goal: Fix it",
    );
    expect(renderRecitation({ goal: null, nextStep: "Run lint", openCount: 2 })).toBe(
      "[JAgentDesk context, not a new request] Next: Run lint · Open: 2",
    );
  });

  it("lists the user's messages newest first with their time", () => {
    const facts = collectTimelineLedgerFacts({
      rows: [
        { ...user(1, "Read the old report"), timestamp: "2026-11-01T09:12:00.000Z" },
        { ...user(2, "Continue"), timestamp: "2026-11-20T16:40:00.000Z" },
      ],
    });
    const { text } = fitRegroundingBlock(
      buildRegroundingDocument({
        facts,
        notes: { decisions: [], openItems: [], nextStep: null },
        memories: [],
        memoriesAttached: false,
      }),
    );
    expect(text).toContain("Earlier requests, newest first. Older ones may already be done");
    expect(text).toContain("2026-11-20 16:40Z:\n> Continue");
    expect(text.indexOf("> Continue")).toBeLessThan(text.indexOf("> Read the old report"));
  });
});

describe("DurableContext", () => {
  let dir: string;
  let store: SessionLedgerStore;
  let rows: LedgerTimelineRow[];
  let appended: AgentTimelineItem[];
  let settings: DurableContextSettings;
  let memory: MemoryPort | undefined;
  let commits: number;
  let durable: DurableContext;
  const agent = {
    id: "agent-1",
    provider: "claude",
    cwd: "/repo",
    sessionId: "s1",
    lastUsage: { contextWindowUsedTokens: 10_000, contextWindowMaxTokens: 200_000 },
  };

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "durable-context-"));
    store = new SessionLedgerStore(
      async (agentId) => path.join(dir, `${agentId}.ledger.json`),
      logger,
    );
    rows = [user(1, "Migrate the importer to pnpm"), edit(2, "/repo/src/importer.ts")];
    appended = [];
    settings = { ...DEFAULT_DURABLE_CONTEXT_SETTINGS };
    commits = 0;
    memory = {
      durableSettings: () => settings,
      prepareUserTurn: async () => ({
        block: {
          type: "text",
          mimeType: "text/plain",
          title: "Relevant memories",
          text: "<relevant-memories>\n- [lesson, project] Use pnpm {id: mem_1}\n</relevant-memories>",
        },
        memoryIds: ["mem_1"],
        commit: async () => {
          commits += 1;
        },
      }),
    };
    durable = new DurableContext({
      store,
      settings: () => settings,
      memory: () => memory,
      rows: () => rows,
      appendTimelineItem: async (_agentId, item) => {
        appended.push(item);
        rows.push({ seq: rows.length + 1, item });
      },
      labelFor: (provider) => (provider === "claude" ? "Claude" : provider),
      logger,
    });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  async function compact(preTokens = 180_000, postTokens = 25_000) {
    durable.observeUsage(agent, {
      contextWindowUsedTokens: preTokens,
      contextWindowMaxTokens: 200_000,
    });
    durable.observeTimelineItem(agent, {
      type: "compaction",
      status: "completed",
      trigger: "manual",
      preTokens,
    });
    durable.observeUsage(agent, {
      contextWindowUsedTokens: postTokens,
      contextWindowMaxTokens: 200_000,
    });
    await durable.settle(agent.id);
  }

  function texts(prompt: AgentPromptInput): string {
    return typeof prompt === "string"
      ? prompt
      : prompt.map((block) => ("text" in block ? block.text : "")).join("\n---\n");
  }

  it("shows one Context compacted row with provider and before → after tokens", async () => {
    await compact();
    expect(appended).toEqual([
      expect.objectContaining({
        type: "notification",
        message: "Context compacted · Claude · 180,000 → 25,000 tokens",
        contextCompaction: expect.objectContaining({
          provider: "claude",
          trigger: "manual",
          preTokens: 180_000,
          postTokens: 25_000,
          inferred: false,
        }),
      }),
    ]);
  });

  it("re-grounds only the first turn after a compaction, in the user message, then recites", async () => {
    await compact();
    const turn = await durable.prepareTurn(agent, "What did we decide?");
    expect(turn).not.toBeNull();
    const prompt = turn!.prompt;
    expect(typeof prompt).toBe("string");
    const text = prompt as string;
    expect(text.startsWith("<jagentdesk-where-we-are>")).toBe(true);
    expect(text.indexOf("What did we decide?")).toBeGreaterThan(
      text.indexOf("</jagentdesk-where-we-are>"),
    );
    expect(text).toContain("Use pnpm");
    // No goal, next step or open item recorded yet: no recitation line at all.
    expect(text).not.toContain("[JAgentDesk context");
    expect(text.trimEnd().endsWith("What did we decide?")).toBe(true);
    await turn!.accepted({ messageId: "m1" });
    expect(commits).toBe(1);
    expect(appended.at(-1)).toEqual(
      expect.objectContaining({
        message: "Re-grounded after compaction",
        regrounding: expect.objectContaining({ estimatedTokens: expect.any(Number) }),
      }),
    );
    const view = await durable.view(agent.id);
    expect(view.regroundings).toHaveLength(1);
    expect(view.regroundings[0].text.startsWith("<jagentdesk-where-we-are>")).toBe(true);

    const next = await durable.prepareTurn(agent, "And now?");
    expect(next).toBeNull();
  });

  it("never recites an old user message as the goal; recites the ledger goal once the agent sets it", async () => {
    rows = [];
    for (let index = 0; index < 220; index += 1) {
      rows.push({
        seq: rows.length + 1,
        timestamp: "2026-11-01T08:00:00.000Z",
        item: { type: "user_message", text: `Old request ${index}` },
      });
      rows.push({
        seq: rows.length + 1,
        item: { type: "assistant_message", text: `Done ${index}` },
      });
    }
    rows.push({ seq: rows.length + 1, item: { type: "user_message", text: "Continue" } });
    const turn = await durable.prepareTurn(agent, "Continue");
    expect(turn).toBeNull();

    await store.update(agent.id, (ledger) => ({
      ...ledger,
      goal: note("Write the changelog", 441),
    }));
    const withGoal = await durable.prepareTurn(agent, "Continue");
    const text = texts(withGoal!.prompt);
    expect(text).toContain("[JAgentDesk context, not a new request] Goal: Write the changelog");
    expect(text).not.toContain("Old request 0");
  });

  it("does not repeat memories already attached to the message", async () => {
    await compact();
    const turn = await durable.prepareTurn(agent, [
      {
        type: "text",
        mimeType: "text/plain",
        title: "Relevant memories",
        text: "<relevant-memories/>",
      },
      { type: "text", text: "Continue" },
    ]);
    expect(texts(turn!.prompt)).toContain(
      "Relevant lessons and memories are attached to this message.",
    );
    await turn!.accepted({});
    expect(commits).toBe(0);
  });

  it("keeps the block pending across a message that leads with a command", async () => {
    await compact();
    expect(await durable.prepareTurn(agent, "/compact keep the tests")).toBeNull();
    const turn = await durable.prepareTurn(agent, "Go on");
    expect(texts(turn!.prompt)).toContain("<jagentdesk-where-we-are>");
  });

  it("sends the 80 % ledger nudge once per compaction cycle", async () => {
    const full = {
      ...agent,
      lastUsage: { contextWindowUsedTokens: 170_000, contextWindowMaxTokens: 200_000 },
    };
    const first = await durable.prepareTurn(full, "next");
    expect(texts(first!.prompt)).toContain(LEDGER_NUDGE_TEXT);
    await first!.accepted({});
    // Nothing else to add (no ledger notes yet), so the second turn is left as it is.
    expect(await durable.prepareTurn(full, "next again")).toBeNull();
    await compact();
    const afterCompaction = await durable.prepareTurn(full, "after");
    expect(texts(afterCompaction!.prompt)).toContain(LEDGER_NUDGE_TEXT);
  });

  it("adds nothing when every switch is off, and clears a pending re-grounding", async () => {
    settings = {
      ...settings,
      regroundAfterCompaction: false,
      recitation: false,
      ledgerNudge: false,
    };
    await compact();
    const turn = await durable.prepareTurn(agent, "hello");
    expect(turn?.prompt).toBe("hello");
    await turn!.accepted({});
    settings = { ...DEFAULT_DURABLE_CONTEXT_SETTINGS, recitation: false };
    expect(await durable.prepareTurn(agent, "hello again")).toBeNull();
  });

  it("infers a compaction for a provider without a signal and re-grounds after it", async () => {
    const custom = { ...agent, provider: "my-custom-api" };
    durable.observeUsage(custom, {
      contextWindowUsedTokens: 100_000,
      contextWindowMaxTokens: 128_000,
    });
    durable.observeUsage(custom, {
      contextWindowUsedTokens: 12_000,
      contextWindowMaxTokens: 128_000,
    });
    await durable.settle(custom.id);
    expect(appended[0]).toEqual(
      expect.objectContaining({
        message: "Context compacted · my-custom-api · 100,000 → 12,000 tokens (inferred)",
      }),
    );
    const turn = await durable.prepareTurn(custom, "Where were we?");
    expect(texts(turn!.prompt)).toContain("<jagentdesk-where-we-are>");
  });

  it("a fresh session (rollover) drops the pending block and starts a new cycle", async () => {
    await compact();
    await durable.onFreshSession(agent.id);
    expect(await durable.prepareTurn(agent, "hi")).toBeNull();
  });

  it("keeps Claude's PostCompact summary on the compaction record", async () => {
    await compact();
    durable
      .hooksFor(agent.id)
      .onCompactSummary({ summary: "We moved to pnpm.", trigger: "manual" });
    await durable.settle(agent.id);
    const view = await durable.view(agent.id);
    expect(view.compactions).toHaveLength(1);
    expect(view.compactions[0].summary).toBe("We moved to pnpm.");
    expect(durable.hooksFor(agent.id).preCompactInstruction()).toContain("update_session_ledger");
  });
});
