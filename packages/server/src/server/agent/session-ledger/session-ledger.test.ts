import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentTimelineItem } from "../agent-sdk-types.js";
import { collectTimelineLedgerFacts, type LedgerTimelineRow } from "./ledger-builder.js";
import { mergeSessionLedgerUpdate } from "./ledger-merge.js";
import {
  buildLedgerDocument,
  estimateTokens,
  fitHandoff,
  handoffBudgetTokens,
  renderHandoffText,
} from "./ledger-render.js";
import { emptySessionLedger } from "./ledger-schema.js";
import { SessionLedgerStore } from "./ledger-store.js";
import { SessionContinuity } from "./session-continuity.js";

function rows(items: AgentTimelineItem[]): LedgerTimelineRow[] {
  return items.map((item, index) => ({ seq: index + 1, item }));
}

function shell(callId: string, command: string, exitCode: number, output = ""): AgentTimelineItem {
  return {
    type: "tool_call",
    callId,
    name: "Bash",
    status: exitCode === 0 ? "completed" : "failed",
    error: exitCode === 0 ? null : `exit ${exitCode}`,
    detail: { type: "shell", command, exitCode, output },
  } as AgentTimelineItem;
}

function edit(callId: string, filePath: string): AgentTimelineItem {
  return {
    type: "tool_call",
    callId,
    name: "Edit",
    status: "completed",
    error: null,
    detail: { type: "edit", filePath, oldString: "a", newString: "b" },
  };
}

function ids() {
  let next = 0;
  return () => `n${++next}`;
}

describe("mergeSessionLedgerUpdate", () => {
  it("appends decisions and open items anchored to the seq, closes done items, replaces next step", () => {
    const createId = ids();
    const first = mergeSessionLedgerUpdate(
      emptySessionLedger("a1"),
      {
        decisions: ["Use SQLite — no server to run"],
        openItems: ["Write migration", "Add index"],
        nextStep: "Write the migration",
      },
      { seq: 4, at: "t1", createId },
    );
    expect(first.added).toEqual({ decisions: 1, openItems: 2 });
    expect(first.ledger.decisions[0]).toMatchObject({
      text: "Use SQLite — no server to run",
      seq: 4,
    });

    const second = mergeSessionLedgerUpdate(
      first.ledger,
      {
        decisions: ["use sqlite —  no server to run", "Keep the API flat"],
        openItems: [{ text: "write migration", done: true }, "Add index"],
        nextStep: "Add the index",
      },
      { seq: 9, at: "t2", createId },
    );
    expect(second.ledger.decisions.map((note) => [note.text, note.seq])).toEqual([
      ["Use SQLite — no server to run", 4],
      ["Keep the API flat", 9],
    ]);
    expect(second.closed).toBe(1);
    expect(second.added.openItems).toBe(0);
    expect(second.ledger.openItems.map((item) => [item.text, item.seq, item.closedSeq])).toEqual([
      ["Write migration", 4, 9],
      ["Add index", 4, null],
    ]);
    expect(second.ledger.nextStep).toMatchObject({ text: "Add the index", seq: 9 });
    expect(second.nextStepChanged).toBe(true);
  });

  it("closes an item by id", () => {
    const createId = ids();
    const first = mergeSessionLedgerUpdate(
      emptySessionLedger("a1"),
      { openItems: ["Ship it"] },
      { seq: 1, at: "t", createId },
    );
    const id = first.ledger.openItems[0]!.id;
    const second = mergeSessionLedgerUpdate(
      first.ledger,
      { openItems: [{ text: id, done: true }] },
      { seq: 2, at: "t", createId },
    );
    expect(second.ledger.openItems[0]?.closedSeq).toBe(2);
  });
});

describe("collectTimelineLedgerFacts", () => {
  it("reads goals verbatim, files, commands with failing tails, errors and turn answers", () => {
    const longGoal = "x".repeat(4100);
    const failingOutput = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join("\n");
    const facts = collectTimelineLedgerFacts({
      cwd: "/repo",
      rows: rows([
        { type: "user_message", text: "Fix the parser. Do not touch tests." },
        {
          type: "tool_call",
          callId: "r1",
          name: "Read",
          status: "completed",
          error: null,
          detail: { type: "read", filePath: "/repo/src/parser.ts" },
        },
        edit("e1", "/repo/src/parser.ts"),
        shell("s1", "npm test", 1, failingOutput),
        shell("s2", "git status", 0, "clean"),
        { type: "assistant_message", text: "Working on it" },
        { type: "assistant_message", text: "Parser fixed." },
        { type: "user_message", text: longGoal },
        { type: "assistant_message", text: "[System Error] Claude usage limit reached" },
      ]),
    });
    expect(facts.goals[0]).toEqual({ seq: 1, text: "Fix the parser. Do not touch tests." });
    expect(facts.goals[1]?.text).toHaveLength(4000);
    expect(facts.goals[1]?.originalLength).toBe(4100);
    expect(facts.files).toEqual([
      {
        path: "src/parser.ts",
        operations: ["read", "edit"],
        firstSeq: 2,
        lastSeq: 3,
        lastOperation: "edit",
      },
    ]);
    expect(facts.commands[0]).toMatchObject({ command: "npm test", exitCode: 1, failed: true });
    expect(facts.commands[0]?.outputTail?.split("\n")).toHaveLength(20);
    expect(facts.commands[0]?.outputTail?.startsWith("line 11")).toBe(true);
    expect(facts.commands[1]).toEqual({
      seq: 5,
      command: "git status",
      exitCode: 0,
      failed: false,
    });
    expect(facts.errors).toEqual([{ seq: 9, message: "Claude usage limit reached" }]);
    expect(facts.turns.map((turn) => turn.answer)).toEqual(["Parser fixed.", null]);
  });

  it("keeps only rows after sinceSeq", () => {
    const facts = collectTimelineLedgerFacts({
      rows: rows([
        { type: "user_message", text: "one" },
        { type: "assistant_message", text: "1" },
        { type: "user_message", text: "two" },
        { type: "assistant_message", text: "2" },
      ]),
      sinceSeq: 2,
    });
    expect(facts.goals.map((goal) => goal.text)).toEqual(["two"]);
    expect(facts.latestSeq).toBe(4);
  });
});

describe("fitHandoff", () => {
  function bigDocument() {
    const items: AgentTimelineItem[] = [];
    items.push({ type: "user_message", text: "GOAL: keep the public API unchanged." });
    for (let turn = 0; turn < 40; turn += 1) {
      items.push({ type: "user_message", text: `Request ${turn}` });
      items.push(shell(`s${turn}`, `npm run build-${turn}`, 1, "error\n".repeat(200)));
      items.push(edit(`e${turn}`, `/repo/src/file-${turn}.ts`));
      items.push({ type: "assistant_message", text: `Answer ${turn} ${"a".repeat(1800)}` });
    }
    const facts = collectTimelineLedgerFacts({ rows: rows(items), cwd: "/repo" });
    const diffs = new Map(facts.files.map((file) => [file.path, "+".repeat(3000)]));
    const notes = mergeSessionLedgerUpdate(
      emptySessionLedger("a1"),
      { decisions: ["Keep v1 routes"], nextStep: "NEXT: rerun the build" },
      { seq: 3, at: "t", createId: ids() },
    ).ledger;
    return buildLedgerDocument({ facts, notes, diffs });
  }

  it("fits a handoff into 60 % of a small window and never cuts goals or the next step", () => {
    const document = bigDocument();
    const render = (current: typeof document) =>
      renderHandoffText({
        document: current,
        mode: "handoff",
        agentId: "a1",
        fromProvider: "Claude",
        toProvider: "Codex",
      });
    const unfitted = estimateTokens(render(document));
    const budget = handoffBudgetTokens(16_000);
    expect(budget).toBe(9_600);
    expect(unfitted).toBeGreaterThan(budget);

    const fitted = fitHandoff({ document, budgetTokens: budget, render });
    expect(fitted.overBudget).toBe(false);
    expect(fitted.estimatedTokens).toBeLessThanOrEqual(budget);
    expect(fitted.text).toContain("GOAL: keep the public API unchanged.");
    for (let turn = 0; turn < 40; turn += 1) expect(fitted.text).toContain(`Request ${turn}`);
    expect(fitted.text).toContain("NEXT: rerun the build");
  });

  it("cuts old command output first", () => {
    const document = bigDocument();
    const render = (current: typeof document) =>
      renderHandoffText({
        document: current,
        mode: "handoff",
        agentId: "a1",
        fromProvider: "Claude",
        toProvider: "Codex",
      });
    const full = estimateTokens(render(document));
    // A budget just under the full size only needs the oldest command output removed.
    const fitted = fitHandoff({ document, budgetTokens: full - 100, render });
    expect(document.commands[0]?.outputTail).toBeUndefined();
    expect(document.commands.at(-1)?.outputTail).toBeDefined();
    expect(document.turnAnswers).toHaveLength(37);
    expect(fitted.overBudget).toBe(false);
  });
});

describe("SessionContinuity", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("persists notes, includes git diffs of edited files and stages a delta after a seq", async () => {
    const repo = mkdtempSync(path.join(os.tmpdir(), "ledger-repo-"));
    const home = mkdtempSync(path.join(os.tmpdir(), "ledger-home-"));
    dirs.push(repo, home);
    const git = (...args: string[]) =>
      execFileSync("git", args, {
        cwd: repo,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "t",
          GIT_AUTHOR_EMAIL: "t@t",
          GIT_COMMITTER_NAME: "t",
          GIT_COMMITTER_EMAIL: "t@t",
        },
      });
    git("init", "-q");
    writeFileSync(path.join(repo, "a.txt"), "one\n");
    git("add", ".");
    git("commit", "-qm", "init");

    const ledgerPath = path.join(home, "agent-1.ledger.json");
    const logger = pino({ level: "silent" });
    const continuity = new SessionContinuity(
      new SessionLedgerStore(async () => ledgerPath, logger),
    );
    await continuity.ensureGitBase("agent-1", repo);
    writeFileSync(path.join(repo, "a.txt"), "two\n");
    writeFileSync(path.join(repo, "b.txt"), "new file\n");
    await continuity.updateNotes({
      agentId: "agent-1",
      update: { decisions: ["Rename one to two"] },
      seq: 2,
    });

    const timeline = rows([
      { type: "user_message", text: "Change a.txt and add b.txt" },
      edit("e1", path.join(repo, "a.txt")),
      {
        type: "tool_call",
        callId: "w1",
        name: "Write",
        status: "completed",
        error: null,
        detail: { type: "write", filePath: path.join(repo, "b.txt"), content: "new file\n" },
      },
      { type: "assistant_message", text: "Done." },
    ]);
    const handoff = await continuity.stageHandoff({
      agentId: "agent-1",
      cwd: repo,
      rows: timeline,
      mode: "handoff",
      reason: "manual",
      fromProvider: "Claude",
      toProvider: "Codex",
      model: "gpt-5",
      budgetTokens: 10_000,
    });
    expect(handoff.text).toContain("-one");
    expect(handoff.text).toContain("+two");
    expect(handoff.text).toContain("+new file");
    expect(handoff.text).toContain("Rename one to two");

    // A fresh store reads the same file back.
    const reread = new SessionContinuity(new SessionLedgerStore(async () => ledgerPath, logger));
    expect((await reread.peekPendingHandoff("agent-1"))?.id).toBe(handoff.id);
    await reread.clearPendingHandoff("agent-1", handoff.id);
    expect(await reread.peekPendingHandoff("agent-1")).toBeNull();

    await reread.updateNotes({ agentId: "agent-1", update: { decisions: ["Later call"] }, seq: 6 });
    const delta = await reread.stageHandoff({
      agentId: "agent-1",
      cwd: repo,
      rows: [
        ...timeline,
        { seq: 5, item: { type: "user_message", text: "Now explain" } },
        { seq: 6, item: { type: "assistant_message", text: "Explained." } },
      ],
      sinceSeq: 4,
      mode: "delta",
      reason: "manual",
      fromProvider: "Codex",
      toProvider: "Claude",
      model: null,
      budgetTokens: 10_000,
    });
    expect(delta.text).toContain("Now explain");
    expect(delta.text).toContain("Later call");
    expect(delta.text).not.toContain("Change a.txt and add b.txt");
    expect(delta.text).not.toContain("Rename one to two");
    expect(delta.estimatedTokens).toBeLessThan(handoff.estimatedTokens);
  });
});
