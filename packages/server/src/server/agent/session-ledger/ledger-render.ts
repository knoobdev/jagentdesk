import {
  truncateTurnAnswer,
  type LedgerCommand,
  type LedgerError,
  type LedgerFile,
  type LedgerGoal,
  type LedgerTurn,
  type TimelineLedgerFacts,
} from "./ledger-builder.js";
import type { LedgerNote, LedgerOpenItem, StoredSessionLedger } from "./ledger-schema.js";

/** Share of the target model's context window a handoff may take. */
export const HANDOFF_WINDOW_SHARE = 0.6;
/** Used when the target model does not report its context window. */
export const DEFAULT_CONTEXT_WINDOW_TOKENS = 128_000;
export const RECENT_TURNS_VERBATIM = 3;

/** Conservative token estimate: about four characters per token for English and code. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function handoffBudgetTokens(contextWindowTokens: number | null | undefined): number {
  const window =
    typeof contextWindowTokens === "number" && contextWindowTokens > 0
      ? contextWindowTokens
      : DEFAULT_CONTEXT_WINDOW_TOKENS;
  return Math.floor(window * HANDOFF_WINDOW_SHARE);
}

export interface LedgerFileWithDiff extends LedgerFile {
  diff?: string | null;
}

/** Everything a ledger view or a handoff renders. Mutated in place while fitting. */
export interface LedgerDocument {
  goals: LedgerGoal[];
  nextStep: LedgerNote | null;
  decisions: LedgerNote[];
  openItems: LedgerOpenItem[];
  files: LedgerFileWithDiff[];
  commands: LedgerCommand[];
  errors: LedgerError[];
  /** Earlier turns: only the final answer is kept. */
  turnAnswers: Array<{ seq: number; text: string }>;
  /** Most recent turns, verbatim. */
  recentTurns: LedgerTurn[];
}

export function buildLedgerDocument(input: {
  facts: TimelineLedgerFacts;
  notes: Pick<StoredSessionLedger, "decisions" | "openItems" | "nextStep">;
  diffs?: ReadonlyMap<string, string>;
  /** Notes written at or before this seq are left out (delta handoffs). */
  sinceSeq?: number;
  recentTurns?: number;
}): LedgerDocument {
  const sinceSeq = input.sinceSeq ?? 0;
  const recentCount = input.recentTurns ?? RECENT_TURNS_VERBATIM;
  const turns = input.facts.turns;
  const recentTurns = recentCount > 0 ? turns.slice(-recentCount) : [];
  const earlierTurns = turns.slice(0, turns.length - recentTurns.length);
  return {
    goals: [...input.facts.goals],
    nextStep: input.notes.nextStep,
    decisions: input.notes.decisions.filter((note) => note.seq > sinceSeq),
    openItems: input.notes.openItems.filter(
      (item) => item.seq > sinceSeq || (item.closedSeq ?? 0) > sinceSeq || item.closedSeq == null,
    ),
    files: input.facts.files.map((file) =>
      Object.assign({}, file, { diff: input.diffs?.get(file.path) ?? null }),
    ),
    commands: input.facts.commands.map((command) => Object.assign({}, command)),
    errors: [...input.facts.errors],
    turnAnswers: earlierTurns
      .filter((turn) => turn.answer)
      .map((turn) => ({ seq: turn.seq, text: truncateTurnAnswer(turn.answer ?? "") })),
    recentTurns: recentTurns.map((turn) => Object.assign({}, turn)),
  };
}

function quoteBlock(text: string): string {
  return text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

function fence(text: string, language = ""): string {
  const longest = Math.max(2, ...Array.from(text.matchAll(/`+/g), (match) => match[0].length));
  const ticks = "`".repeat(longest + 1);
  return `${ticks}${language}\n${text}\n${ticks}`;
}

function renderGoals(goals: LedgerGoal[]): string[] {
  if (goals.length === 0) return [];
  const lines = ["## Goals and constraints (user messages, verbatim, oldest first)", ""];
  goals.forEach((goal, index) => {
    lines.push(`${index + 1}.`, quoteBlock(goal.text));
    if (goal.originalLength) {
      lines.push(`   (first ${goal.text.length} of ${goal.originalLength} characters)`);
    }
    lines.push("");
  });
  return lines;
}

function renderNotes(document: LedgerDocument): string[] {
  const lines: string[] = [];
  if (document.nextStep) {
    lines.push("## Next step", "", document.nextStep.text, "");
  }
  if (document.decisions.length > 0) {
    lines.push("## Decisions", "");
    for (const decision of document.decisions) lines.push(`- ${decision.text}`);
    lines.push("");
  }
  const open = document.openItems.filter((item) => item.closedSeq == null);
  const closed = document.openItems.filter((item) => item.closedSeq != null);
  if (open.length > 0) {
    lines.push("## Open items", "");
    for (const item of open) lines.push(`- [ ] ${item.text}`);
    lines.push("");
  }
  if (closed.length > 0) {
    lines.push("## Done items", "");
    for (const item of closed) lines.push(`- [x] ${item.text}`);
    lines.push("");
  }
  return lines;
}

function renderFiles(files: LedgerFileWithDiff[]): string[] {
  if (files.length === 0) return [];
  const lines = ["## Files", ""];
  for (const file of files) {
    lines.push(`- \`${file.path}\` — ${file.operations.join(", ")}`);
  }
  lines.push("");
  const withDiff = files.filter((file) => file.diff);
  for (const file of withDiff) {
    lines.push(`### Diff: ${file.path}`, "", fence(file.diff ?? "", "diff"), "");
  }
  return lines;
}

function commandStatus(command: LedgerCommand): string {
  if (command.exitCode !== null) return `exit ${command.exitCode}`;
  return command.failed ? "failed" : "ok";
}

function renderCommands(commands: LedgerCommand[]): string[] {
  if (commands.length === 0) return [];
  const lines = ["## Commands", ""];
  for (const command of commands) {
    const status = commandStatus(command);
    lines.push(`- \`${command.command.replace(/\s+/g, " ").slice(0, 500)}\` — ${status}`);
    if (command.outputTail) {
      lines.push("", fence(command.outputTail), "");
    }
  }
  lines.push("");
  return lines;
}

function renderErrors(errors: LedgerError[]): string[] {
  if (errors.length === 0) return [];
  const lines = ["## Errors", ""];
  for (const error of errors) lines.push(`- ${error.message.replace(/\s+/g, " ").slice(0, 600)}`);
  lines.push("");
  return lines;
}

function renderTurnAnswers(answers: LedgerDocument["turnAnswers"]): string[] {
  if (answers.length === 0) return [];
  const lines = ["## Earlier answers (last message of each turn)", ""];
  for (const answer of answers) lines.push(quoteBlock(answer.text), "");
  return lines;
}

function renderRecentTurns(turns: LedgerTurn[], heading: string): string[] {
  if (turns.length === 0) return [];
  const lines = [`## ${heading}`, ""];
  for (const turn of turns) {
    lines.push("**User:**", "", quoteBlock(turn.userText), "");
    lines.push("**Assistant:**", "", turn.answer ? quoteBlock(turn.answer) : "> (no answer)", "");
  }
  return lines;
}

export function renderLedgerSections(
  document: LedgerDocument,
  options: { recentHeading?: string } = {},
): string {
  return [
    ...renderGoals(document.goals),
    ...renderNotes(document),
    ...renderFiles(document.files),
    ...renderCommands(document.commands),
    ...renderErrors(document.errors),
    ...renderTurnAnswers(document.turnAnswers),
    ...renderRecentTurns(document.recentTurns, options.recentHeading ?? "Recent turns (verbatim)"),
  ]
    .join("\n")
    .trimEnd();
}

/**
 * Cut steps in the order the spec sets: old command output, old turn answers, large diffs. When
 * that is not enough the remaining lists are shortened oldest-first. Goals and the next step are
 * never cut. Each step returns false once it has nothing left to cut.
 */
const CUT_STEPS: Array<(document: LedgerDocument) => boolean> = [
  (document) => {
    const command = document.commands.find((entry) => entry.outputTail);
    if (!command) return false;
    delete command.outputTail;
    return true;
  },
  (document) => document.turnAnswers.shift() !== undefined,
  (document) => {
    let largest: LedgerFileWithDiff | null = null;
    for (const file of document.files) {
      if (file.diff && (!largest || file.diff.length > (largest.diff?.length ?? 0))) {
        largest = file;
      }
    }
    if (!largest) return false;
    largest.diff = null;
    return true;
  },
  (document) => document.commands.shift() !== undefined,
  (document) => document.errors.shift() !== undefined,
  (document) => {
    const closedIndex = document.openItems.findIndex((item) => item.closedSeq != null);
    if (closedIndex < 0) return false;
    document.openItems.splice(closedIndex, 1);
    return true;
  },
  (document) => {
    const turn = document.recentTurns.find((entry) => entry.answer && entry.answer.length > 400);
    if (turn?.answer) {
      turn.answer = truncateTurnAnswer(turn.answer).slice(0, 400);
      return true;
    }
    return document.recentTurns.length > 1 ? document.recentTurns.shift() !== undefined : false;
  },
  (document) => (document.files.length > 0 ? document.files.shift() !== undefined : false),
  (document) => document.decisions.shift() !== undefined,
];

export interface FittedHandoff {
  text: string;
  estimatedTokens: number;
  budgetTokens: number;
  overBudget: boolean;
}

export function fitHandoff(input: {
  document: LedgerDocument;
  budgetTokens: number;
  render: (document: LedgerDocument) => string;
}): FittedHandoff {
  const { document, budgetTokens } = input;
  let text = input.render(document);
  while (estimateTokens(text) > budgetTokens) {
    const cut = CUT_STEPS.some((step) => step(document));
    if (!cut) break;
    text = input.render(document);
  }
  const estimatedTokens = estimateTokens(text);
  return { text, estimatedTokens, budgetTokens, overBudget: estimatedTokens > budgetTokens };
}

export function renderHandoffText(input: {
  document: LedgerDocument;
  mode: "handoff" | "delta";
  agentId: string;
  fromProvider: string;
  toProvider: string;
}): string {
  const intro =
    input.mode === "handoff"
      ? [
          "<jagentdesk-session-handoff>",
          `You are taking over JAgentDesk agent ${input.agentId}, which was running on ${input.fromProvider}. ` +
            "This is the session ledger so far: the user's own messages verbatim, the files and commands " +
            "touched, the recorded decisions and the most recent turns. Treat it as your own memory of " +
            "the conversation and continue from it. Keep the ledger current with update_session_ledger.",
          "",
        ]
      : [
          "<jagentdesk-session-handoff>",
          `You are resuming JAgentDesk agent ${input.agentId}. While you were away the session ran on ` +
            `${input.fromProvider}. Below is only what changed since your last turn; everything before ` +
            "that is already in your own history.",
          "",
        ];
  const body = renderLedgerSections(input.document, {
    recentHeading: input.mode === "handoff" ? "Recent turns (verbatim)" : "Turns since you left",
  });
  return [...intro, body, "</jagentdesk-session-handoff>"].join("\n");
}

export function renderLedgerMarkdown(input: {
  document: LedgerDocument;
  agentTitle: string | null;
  agentId: string;
}): string {
  const title = input.agentTitle?.trim() || input.agentId;
  const body = renderLedgerSections(input.document);
  return [`# Session ledger — ${title}`, "", body || "_Nothing recorded yet._"].join("\n");
}
