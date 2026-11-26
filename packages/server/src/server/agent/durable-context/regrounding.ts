import type {
  LedgerCommand,
  LedgerError,
  LedgerFile,
  LedgerGoal,
  TimelineLedgerFacts,
} from "../session-ledger/ledger-builder.js";
import { estimateTokens } from "../session-ledger/ledger-render.js";
import type { LedgerNote, LedgerOpenItem } from "../session-ledger/ledger-schema.js";

/** Spec 42 §2: the "Where we are" block never exceeds this. */
export const REGROUNDING_TOKEN_CAP = 3_000;
/** Spec 42 §2: the per-turn recitation line stays under this. */
export const RECITATION_TOKEN_CAP = 120;
/** Spec 42 §3: the ledger nudge goes out once context use reaches this share of the window. */
export const LEDGER_NUDGE_SHARE = 0.8;
/** The artifact index starts from at most this many entries of each kind. */
const MAX_INDEX_ENTRIES = 60;
const GOAL_KEEP_RECENT = 3;

export const LEDGER_NUDGE_TEXT =
  "(JAgentDesk) Your context window is over 80 % full and will be compacted soon. Before you go on " +
  "with this message, call update_session_ledger with the decisions made so far (one-line reason " +
  "each), the open items and the next step, so they survive the compaction.";

/** Spec 42 §3 Claude PreCompact hook: the same instruction, for the compaction itself. */
export const PRE_COMPACT_INSTRUCTION =
  "Keep in the summary every decision with its reason, every open item, the next step, the files " +
  "created or changed and any unresolved error. JAgentDesk re-sends its session ledger after the " +
  "compaction; record anything missing with update_session_ledger on the next turn.";

export interface UnresolvedError {
  seq: number;
  at?: string;
  message: string;
  /** Last lines of output for a failed command. */
  outputTail?: string;
}

/** What the block shows; trimmed in place while fitting. */
export interface RegroundingDocument {
  goals: LedgerGoal[];
  /** User messages left out of the middle to fit the cap. */
  omittedGoals: number;
  nextStep: LedgerNote | null;
  decisions: LedgerNote[];
  openItems: LedgerOpenItem[];
  files: LedgerFile[];
  commands: LedgerCommand[];
  errors: UnresolvedError[];
  /** Relevant memories and lessons, one line each (spec 41 §3 selection). */
  memories: string[];
  /** True when the message already carries the "Relevant memories" attachment. */
  memoriesAttached: boolean;
}

/**
 * Failed commands that were not run again successfully later, plus error rows from the last turn:
 * the errors the agent may still be in the middle of.
 */
export function unresolvedErrors(
  facts: Pick<TimelineLedgerFacts, "commands" | "errors" | "turns">,
): UnresolvedError[] {
  const result: UnresolvedError[] = [];
  facts.commands.forEach((command, index) => {
    if (!command.failed) return;
    const fixedLater = facts.commands
      .slice(index + 1)
      .some((later) => !later.failed && later.command === command.command);
    if (fixedLater) return;
    const status = command.exitCode !== null ? `exit ${command.exitCode}` : "failed";
    result.push({
      seq: command.seq,
      ...(command.at ? { at: command.at } : {}),
      message: `\`${oneLine(command.command, 300)}\` — ${status}`,
      ...(command.outputTail ? { outputTail: command.outputTail } : {}),
    });
  });
  const lastTurnSeq = facts.turns.at(-1)?.seq ?? 0;
  for (const error of facts.errors) {
    if (error.seq < lastTurnSeq) continue;
    result.push(errorEntry(error));
  }
  return result.sort((left, right) => left.seq - right.seq);
}

function errorEntry(error: LedgerError): UnresolvedError {
  return {
    seq: error.seq,
    ...(error.at ? { at: error.at } : {}),
    message: oneLine(error.message, 600),
  };
}

function oneLine(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

export function buildRegroundingDocument(input: {
  facts: TimelineLedgerFacts;
  notes: { decisions: LedgerNote[]; openItems: LedgerOpenItem[]; nextStep: LedgerNote | null };
  memories: string[];
  memoriesAttached: boolean;
}): RegroundingDocument {
  const files = [...input.facts.files]
    .sort((left, right) => left.lastSeq - right.lastSeq)
    .slice(-MAX_INDEX_ENTRIES);
  return {
    goals: [...input.facts.goals],
    omittedGoals: 0,
    nextStep: input.notes.nextStep,
    decisions: [...input.notes.decisions],
    openItems: input.notes.openItems.filter((item) => item.closedSeq == null),
    files,
    commands: input.facts.commands
      .slice(-MAX_INDEX_ENTRIES)
      .map((command) => Object.assign({}, command)),
    errors: unresolvedErrors(input.facts),
    memories: [...input.memories],
    memoriesAttached: input.memoriesAttached,
  };
}

function quote(text: string): string {
  return text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

function fence(text: string): string {
  const longest = Math.max(2, ...Array.from(text.matchAll(/`+/g), (match) => match[0].length));
  const ticks = "`".repeat(longest + 1);
  return `${ticks}\n${text}\n${ticks}`;
}

function when(at: string | undefined): string {
  return at ? ` · ${at.replace("T", " ").replace(/\.\d+Z$/, "Z")}` : "";
}

function renderGoals(document: RegroundingDocument): string[] {
  if (document.goals.length === 0) return [];
  const lines = ["## Goals and constraints (the user's messages, verbatim, oldest first)", ""];
  document.goals.forEach((goal, index) => {
    if (document.omittedGoals > 0 && index === 1) {
      lines.push(`(${document.omittedGoals} earlier messages left out to fit)`, "");
    }
    lines.push(quote(goal.text));
    if (goal.originalLength) {
      lines.push(`(first ${goal.text.length} of ${goal.originalLength} characters)`);
    }
    lines.push("");
  });
  return lines;
}

function renderList(heading: string, entries: string[]): string[] {
  return entries.length > 0 ? [heading, "", ...entries, ""] : [];
}

function commandStatus(command: LedgerCommand): string {
  if (command.exitCode !== null) return `exit ${command.exitCode}`;
  return command.failed ? "failed" : "ok";
}

function renderArtifactIndex(document: RegroundingDocument): string[] {
  const lines: string[] = [];
  if (document.files.length > 0) {
    lines.push("Files (path — last operation · time):");
    for (const file of document.files) {
      const operation = file.lastOperation ?? file.operations.at(-1) ?? "read";
      lines.push(`- \`${file.path}\` — ${operation}${when(file.lastAt)}`);
    }
    lines.push("");
  }
  if (document.commands.length > 0) {
    lines.push("Commands (exit code):");
    for (const command of document.commands) {
      lines.push(`- \`${oneLine(command.command, 200)}\` — ${commandStatus(command)}`);
    }
    lines.push("");
  }
  if (document.errors.length > 0) {
    lines.push("Unresolved errors:");
    for (const error of document.errors) {
      lines.push(`- ${error.message}${when(error.at)}`);
      if (error.outputTail) lines.push(fence(error.outputTail));
    }
    lines.push("");
  }
  return lines.length > 0 ? ["## Artifact index", "", ...lines] : [];
}

function renderMemories(document: RegroundingDocument): string[] {
  if (document.memories.length > 0) {
    return ["## Lessons and memories for this message", "", ...document.memories, ""];
  }
  if (document.memoriesAttached) {
    return ["Relevant lessons and memories are attached to this message.", ""];
  }
  return [];
}

export function renderRegroundingBlock(document: RegroundingDocument): string {
  return [
    "<jagentdesk-where-we-are>",
    "Your context was just compacted. JAgentDesk rebuilt this from its session ledger and the " +
      "timeline (no model wrote it). Where it differs from your summary, trust this.",
    "",
    ...renderGoals(document),
    ...(document.nextStep ? ["## Next step", "", document.nextStep.text, ""] : []),
    ...renderList(
      "## Decisions",
      document.decisions.map((decision) => `- ${decision.text}`),
    ),
    ...renderList(
      "## Open items",
      document.openItems.map((item) => `- [ ] ${item.text}`),
    ),
    ...renderArtifactIndex(document),
    ...renderMemories(document),
    "</jagentdesk-where-we-are>",
  ].join("\n");
}

/**
 * Cut steps, in spec 40.3's spirit for a 3 000-token block: old command output first, then the
 * command list, memories, older files, decisions, open items and errors (oldest first), then user
 * messages from the middle (the first one and the latest three stay longest). The next step is
 * never cut. Each step returns false when it has nothing left.
 */
const CUT_STEPS: Array<(document: RegroundingDocument) => boolean> = [
  (document) => {
    const error = document.errors.find((entry) => entry.outputTail);
    if (!error) return false;
    const lines = error.outputTail?.split("\n") ?? [];
    if (lines.length > 5) error.outputTail = lines.slice(-5).join("\n");
    else delete error.outputTail;
    return true;
  },
  (document) => {
    const index = document.commands.findIndex((command) => !command.failed);
    if (index >= 0) {
      document.commands.splice(index, 1);
      return true;
    }
    return document.commands.shift() !== undefined;
  },
  (document) => document.memories.pop() !== undefined,
  (document) => (document.files.length > 10 ? document.files.shift() !== undefined : false),
  (document) => (document.goals.length > GOAL_KEEP_RECENT + 1 ? dropMiddleGoal(document) : false),
  (document) => document.decisions.shift() !== undefined,
  (document) => document.files.shift() !== undefined,
  (document) => (document.errors.length > 1 ? document.errors.shift() !== undefined : false),
  (document) => (document.openItems.length > 3 ? document.openItems.shift() !== undefined : false),
  (document) => (document.goals.length > 2 ? dropMiddleGoal(document) : false),
  (document) => shortenLongestGoal(document),
  (document) => document.openItems.shift() !== undefined,
  (document) => document.errors.shift() !== undefined,
  (document) => (document.goals.length > 1 ? dropMiddleGoal(document) : false),
];

function dropMiddleGoal(document: RegroundingDocument): boolean {
  if (document.goals.length < 2) return false;
  document.goals.splice(1, 1);
  document.omittedGoals += 1;
  return true;
}

function shortenLongestGoal(document: RegroundingDocument): boolean {
  let longest: LedgerGoal | null = null;
  for (const goal of document.goals) {
    if (goal.text.length > 400 && (!longest || goal.text.length > longest.text.length))
      longest = goal;
  }
  if (!longest) return false;
  longest.originalLength = longest.originalLength ?? longest.text.length;
  longest.text = longest.text.slice(0, Math.max(400, Math.floor(longest.text.length / 2)));
  return true;
}

export interface FittedBlock {
  text: string;
  estimatedTokens: number;
}

export function fitRegroundingBlock(
  document: RegroundingDocument,
  capTokens: number = REGROUNDING_TOKEN_CAP,
): FittedBlock {
  let text = renderRegroundingBlock(document);
  while (estimateTokens(text) > capTokens) {
    if (!CUT_STEPS.some((step) => step(document))) break;
    text = renderRegroundingBlock(document);
  }
  // Last resort for a single enormous next step: hard cut, keeping the closing tag.
  if (estimateTokens(text) > capTokens) {
    const closing = "\n</jagentdesk-where-we-are>";
    text = `${text.slice(0, capTokens * 4 - closing.length - 2)}…${closing}`;
  }
  return { text, estimatedTokens: estimateTokens(text) };
}

function clip(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/**
 * Spec 42 §2 recitation: "Goal: … · Next: … · Open: n" at the end of the message, under 120 tokens.
 * Null when there is no goal yet (an agent's first message).
 */
export function renderRecitation(input: {
  goal: string | null;
  nextStep: string | null;
  openCount: number;
}): string | null {
  if (!input.goal) return null;
  const budget = RECITATION_TOKEN_CAP * 4 - 60;
  const nextBudget = input.nextStep ? Math.floor(budget / 2) : 0;
  const goal = clip(input.goal, budget - nextBudget);
  const next = input.nextStep ? clip(input.nextStep, nextBudget) : "—";
  return `(JAgentDesk recitation) Goal: ${goal} · Next: ${next} · Open: ${input.openCount}`;
}

/** Context use as a share of the window, or null when the provider did not report both. */
export function contextShare(
  usage:
    | {
        contextWindowUsedTokens?: number;
        contextWindowMaxTokens?: number;
      }
    | null
    | undefined,
): number | null {
  const used = usage?.contextWindowUsedTokens;
  const max = usage?.contextWindowMaxTokens;
  if (typeof used !== "number" || typeof max !== "number" || max <= 0) return null;
  return used / max;
}
