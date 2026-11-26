import path from "node:path";
import type { AgentTimelineItem } from "../agent-sdk-types.js";

export const MAX_GOAL_CHARS = 4000;
export const MAX_TURN_ANSWER_CHARS = 2000;
export const FAILED_COMMAND_TAIL_LINES = 20;
const SYSTEM_ERROR_PREFIX = "[System Error]";

export interface LedgerTimelineRow {
  seq: number;
  item: AgentTimelineItem;
  /** ISO time the row was written; the artifact index shows it (spec 42 §2). */
  timestamp?: string;
}

export interface LedgerGoal {
  seq: number;
  text: string;
  /** Original length when the message was cut to {@link MAX_GOAL_CHARS}. */
  originalLength?: number;
}

export type LedgerFileOperation = "read" | "write" | "edit" | "delete";

export interface LedgerFile {
  path: string;
  operations: LedgerFileOperation[];
  firstSeq: number;
  lastSeq: number;
  lastOperation?: LedgerFileOperation;
  lastAt?: string;
}

export interface LedgerCommand {
  seq: number;
  at?: string;
  command: string;
  exitCode: number | null;
  failed: boolean;
  /** Last {@link FAILED_COMMAND_TAIL_LINES} lines of output, kept for failed commands only. */
  outputTail?: string;
}

export interface LedgerError {
  seq: number;
  at?: string;
  message: string;
}

export interface LedgerTurn {
  /** Seq of the user message that opened the turn. */
  seq: number;
  endSeq: number;
  userText: string;
  /** Last assistant message of the turn. */
  answer: string | null;
}

/** The deterministic part of the session ledger: everything that can be read off the timeline. */
export interface TimelineLedgerFacts {
  goals: LedgerGoal[];
  files: LedgerFile[];
  commands: LedgerCommand[];
  errors: LedgerError[];
  turns: LedgerTurn[];
  latestSeq: number;
}

function truncateGoal(text: string, seq: number): LedgerGoal {
  if (text.length <= MAX_GOAL_CHARS) return { seq, text };
  return { seq, text: text.slice(0, MAX_GOAL_CHARS), originalLength: text.length };
}

export function truncateTurnAnswer(text: string): string {
  if (text.length <= MAX_TURN_ANSWER_CHARS) return text;
  return `${text.slice(0, MAX_TURN_ANSWER_CHARS)}\n[…cut, ${text.length} characters in full]`;
}

function tailLines(output: string, lines: number): string {
  const parts = output.replace(/\s+$/, "").split(/\r?\n/);
  return parts.slice(-lines).join("\n");
}

function toDisplayPath(filePath: string, cwd: string | undefined): string {
  if (!cwd || !path.isAbsolute(filePath)) return filePath;
  const relative = path.relative(cwd, filePath);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : filePath;
}

function errorText(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return JSON.stringify(error ?? null);
}

function isDeleteDiff(diff: string | undefined): boolean {
  return Boolean(diff && (/^\+\+\+ \/dev\/null$/m.test(diff) || /^deleted file mode/m.test(diff)));
}

type ToolCallItem = Extract<AgentTimelineItem, { type: "tool_call" }>;

class LedgerFactCollector {
  readonly goals: LedgerGoal[] = [];
  readonly files = new Map<string, LedgerFile>();
  readonly commands: LedgerCommand[] = [];
  readonly errors: LedgerError[] = [];
  readonly turns: LedgerTurn[] = [];
  private readonly commandIndexByCallId = new Map<string, number>();
  private currentTurn: LedgerTurn | null = null;
  private at: string | undefined;

  constructor(private readonly cwd: string | undefined) {}

  add(seq: number, item: AgentTimelineItem, at?: string): void {
    this.at = at;
    switch (item.type) {
      case "user_message":
        this.addUserMessage(seq, item.text.trim());
        break;
      case "assistant_message":
        this.addAssistantMessage(seq, item.text.trim());
        break;
      case "error":
        this.errors.push({ seq, message: item.message, ...(this.at ? { at: this.at } : {}) });
        break;
      case "tool_call":
        this.addToolCall(seq, item);
        break;
      default:
        break;
    }
  }

  private addUserMessage(seq: number, text: string): void {
    if (!text) return;
    this.goals.push(truncateGoal(text, seq));
    this.currentTurn = { seq, endSeq: seq, userText: text, answer: null };
    this.turns.push(this.currentTurn);
  }

  private addAssistantMessage(seq: number, text: string): void {
    if (text.startsWith(SYSTEM_ERROR_PREFIX)) {
      this.errors.push({ seq, message: text.slice(SYSTEM_ERROR_PREFIX.length).trim() });
      return;
    }
    if (!text || !this.currentTurn) return;
    this.currentTurn.answer = text;
    this.currentTurn.endSeq = seq;
  }

  private addToolCall(seq: number, item: ToolCallItem): void {
    if (this.currentTurn) this.currentTurn.endSeq = seq;
    const detail = item.detail;
    switch (detail.type) {
      case "read":
        this.touchFile(detail.filePath, "read", seq);
        return;
      case "write":
        this.touchFile(detail.filePath, "write", seq);
        return;
      case "edit":
        this.touchFile(detail.filePath, isDeleteDiff(detail.unifiedDiff) ? "delete" : "edit", seq);
        return;
      case "shell":
        this.addCommand(seq, item, detail);
        return;
      default:
        if (item.status === "failed") {
          this.errors.push({ seq, message: `${item.name}: ${errorText(item.error)}` });
        }
    }
  }

  private addCommand(
    seq: number,
    item: ToolCallItem,
    detail: Extract<ToolCallItem["detail"], { type: "shell" }>,
  ): void {
    const exitCode = typeof detail.exitCode === "number" ? detail.exitCode : null;
    const failed = item.status === "failed" || (exitCode !== null && exitCode !== 0);
    const command: LedgerCommand = { seq, command: detail.command, exitCode, failed };
    if (this.at) command.at = this.at;
    if (failed && detail.output) {
      command.outputTail = tailLines(detail.output, FAILED_COMMAND_TAIL_LINES);
    }
    // A tool call is re-emitted as it progresses; the last row for a call id wins.
    const previousIndex = this.commandIndexByCallId.get(item.callId);
    if (previousIndex !== undefined) {
      this.commands[previousIndex] = command;
      return;
    }
    this.commandIndexByCallId.set(item.callId, this.commands.length);
    this.commands.push(command);
  }

  private touchFile(filePath: string, operation: LedgerFileOperation, seq: number): void {
    const display = toDisplayPath(filePath, this.cwd);
    const existing = this.files.get(display);
    if (existing) {
      if (!existing.operations.includes(operation)) existing.operations.push(operation);
      existing.lastSeq = seq;
      existing.lastOperation = operation;
      if (this.at) existing.lastAt = this.at;
      return;
    }
    this.files.set(display, {
      path: display,
      operations: [operation],
      firstSeq: seq,
      lastSeq: seq,
      lastOperation: operation,
      ...(this.at ? { lastAt: this.at } : {}),
    });
  }
}

/**
 * Read the files, commands, errors, user messages and per-turn answers off the timeline. No model
 * call is involved, so the result is exact and repeatable.
 */
export function collectTimelineLedgerFacts(input: {
  rows: readonly LedgerTimelineRow[];
  cwd?: string;
  sinceSeq?: number;
}): TimelineLedgerFacts {
  const sinceSeq = input.sinceSeq ?? 0;
  const collector = new LedgerFactCollector(input.cwd);
  let latestSeq = 0;
  for (const row of input.rows) {
    latestSeq = Math.max(latestSeq, row.seq);
    if (row.seq > sinceSeq) collector.add(row.seq, row.item, row.timestamp);
  }
  return {
    goals: collector.goals,
    files: Array.from(collector.files.values()),
    commands: collector.commands,
    errors: collector.errors,
    turns: collector.turns,
    latestSeq,
  };
}
