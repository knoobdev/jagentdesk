// Read models the daemon computes for the Orca-layout bot screens (ADR-0060 §Protocol, spec 37.4).
// Ported from Orca dfdb4fda (MIT): bots/bot-chat-tree-schema.ts, bots/bot-look-around.ts:118-160,
// bots/bot-tidy-up.ts:60-100, bots/bot-memory-history.ts, bot-memory-lines.ts:9-17,
// bots/bot-templates.ts:45-88, bots/needs-you-fold.ts.
import { z } from "zod";
import { AgentProviderSchema } from "../provider-manifest.js";
import { TidyUpEverySchema } from "./types.js";

/** One row of Needs you (spec 37.4.4), in display order: approval → question → connector → item. */
export const BotNeedsYouRowSchema = z.object({
  key: z.string(),
  kind: z.enum(["approval", "question", "connector", "item"]),
  /** approval: `"Permission · {{tool}}"` when `tool` is set, else `"Permission needed"`. */
  tool: z.string().optional(),
  /** The agent that waits: the bot's own chat, or a worker. */
  agentId: z.string().optional(),
  /** Permission request id, for the existing `agent_permission_response` RPC. */
  requestId: z.string().optional(),
  /** Set when the approval is a worker's: `"Worker: {{name}} · …"`. */
  workerName: z.string().optional(),
  /** The chat that started the worker; its card is answerable in place. */
  chatAgentId: z.string().optional(),
  /** question: the chat's title (`"Your chat with {{name}}"`). */
  chatTitle: z.string().optional(),
  /** connector: `slack` | `github` | `gitlab` | `telegram`. */
  connector: z.string().optional(),
  itemId: z.string().optional(),
  itemNumber: z.number().int().optional(),
  title: z.string(),
  detail: z.string().optional(),
  at_ms: z.number().int(),
});

export const BotWorkerStateSchema = z.enum(["running", "needs-you", "done", "failed", "stopped"]);
export const BotChatWorkerSchema = z.object({
  agentId: z.string(),
  title: z.string(),
  state: BotWorkerStateSchema,
  itemId: z.string().optional(),
  worktree: z.string().optional(),
  branch: z.string().optional(),
  startedAt_ms: z.number().int(),
  settledAt_ms: z.number().int().optional(),
});
export const BotChatKindSchema = z.enum([
  "home",
  "side",
  "slack",
  "github",
  "gitlab",
  "telegram",
  "automation",
]);
export const BotChatSchema = z.object({
  /** The chat's agent id. */
  id: z.string(),
  kind: BotChatKindSchema,
  title: z.string(),
  live: z.enum(["replying", "needs-you", "idle"]),
  lastActiveAt_ms: z.number().int(),
  /** Automation runs: which run, and its state. */
  run: z
    .object({
      kind: z.enum(["look_around", "tidy_up", "automation"]),
      scheduleId: z.string().optional(),
      state: z.enum(["running", "done", "failed"]),
    })
    .optional(),
  workers: z.array(BotChatWorkerSchema),
  runningTotal: z.number().int(),
  waitingTotal: z.number().int(),
});
export const BotChatTreeSchema = z.object({
  /** Absent until the Home Chat agent exists. */
  home: BotChatSchema.optional(),
  /** Newest first. */
  chats: z.array(BotChatSchema),
  /** Workspaces handed to the bot (`"Workspaces · {{total}}"`). */
  workspaces: z.array(z.object({ workspaceId: z.string(), title: z.string() })),
});

export const BotSuggestionSchema = z.object({
  id: z.string(),
  title: z.string().max(80),
  why: z.string().max(400),
  /** The message Start sends to the Home Chat. */
  ask: z.string().max(2000),
  link: z.string().optional(),
  source: z.enum(["slack", "github", "gitlab", "telegram"]).optional(),
  createdAt_ms: z.number().int(),
});
export const BotUpNextStateSchema = z.object({
  lastLookedAt_ms: z.number().int().optional(),
  tookMs: z.number().int().optional(),
  nextAt_ms: z.number().int().optional(),
  running: z.boolean(),
  runAgentId: z.string().optional(),
  lastAgentId: z.string().optional(),
  error: z.string().optional(),
  /** Why Look around turned itself off after 10 failures in a row. */
  turnedOff: z.string().optional(),
});

export const BotTidyUpSummarySchema = z.object({
  runId: z.string(),
  at_ms: z.number().int(),
  tookMs: z.number().int(),
  /** The History row Undo reverts; absent when only memory/ files changed. */
  rowId: z.string().optional(),
  learned: z.array(z.string()),
  replaced: z.array(z.string()),
  filed: z.array(z.object({ topic: z.string(), count: z.number().int() })),
  moved: z.number().int(),
  merged: z.number().int(),
  changes: z.number().int(),
  undone: z.boolean(),
  /** Its conversation, opened from the Home Chat line and the Chats row. */
  runAgentId: z.string().optional(),
});
export const BotTidyUpViewSchema = z.object({
  setting: z.object({ on: z.boolean(), every: TidyUpEverySchema }),
  last: BotTidyUpSummarySchema.optional(),
  running: z.boolean(),
  nextAt_ms: z.number().int().optional(),
  turnedOff: z.string().optional(),
  error: z.string().optional(),
});

/** `bot-memory-lines.ts:9-17`: one MEMORY.md fact. `line` is its index in the file. */
export const BotMemoryFactSchema = z.object({
  line: z.number().int().min(0),
  date: z.string().nullable(),
  text: z.string(),
  source: z.string().nullable(),
  kind: z.enum(["rule", "preference", "decision", "lesson", "fact"]).nullable(),
});
export const BotMemoryAuthorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("chat"), agentId: z.string(), title: z.string().optional() }),
  z.object({ kind: z.literal("kept"), agentId: z.string() }),
  z.object({ kind: z.literal("owner") }),
  z.object({ kind: z.literal("bot"), agentId: z.string() }),
  z.object({ kind: z.literal("undo"), of: z.string() }),
  z.object({ kind: z.literal("tidy-up") }),
]);
const BotMemoryLineSchema = z.object({ line: z.string(), after: z.string().nullable() });
export const BotMemoryHistoryRowSchema = z.object({
  id: z.string(),
  at_ms: z.number().int(),
  by: BotMemoryAuthorSchema,
  change: z.object({ added: z.array(BotMemoryLineSchema), removed: z.array(BotMemoryLineSchema) }),
  undoable: z.boolean(),
});
export const BotMemoryViewSchema = z.object({
  facts: z.array(BotMemoryFactSchema),
  /** Lines the session loader counts; the gauge is `"{{count}} / {{cap}} lines"`. */
  count: z.number().int(),
  cap: z.number().int(),
});

export const BotTemplateSchema = z.object({
  id: z.string(),
  category: z.string(),
  categoryLabel: z.string(),
  name: z.string(),
  line: z.string(),
  firstChat: z.string(),
  mascot: z.string(),
  watches: z.string(),
  does: z.string(),
  reports: z.string(),
  connectors: z.array(z.string()),
  schedules: z.array(z.object({ id: z.string(), when: z.string(), what: z.string() })),
  events: z.array(z.object({ id: z.string(), name: z.string(), source: z.string() })),
  skills: z.array(z.string()),
  needsSetup: z.string().optional(),
  example: z.array(z.string()),
});

export const BotAutomationSchema = z.object({
  /** Core schedule id, `look_around`, `tidy_up`, or `wait:<itemId>`. */
  id: z.string(),
  kind: z.enum(["schedule", "look_around", "tidy_up", "wait"]),
  name: z.string(),
  /** Core schedule cadence label or the preset label. */
  when: z.string().optional(),
  nextAt_ms: z.number().int().optional(),
  state: z.enum(["idle", "running", "failed", "stopped"]),
  enabled: z.boolean(),
  itemId: z.string().optional(),
  /** Event automations (Slack, GitHub, GitLab, Telegram, Jira). */
  event: z.object({ source: z.string(), event: z.string() }).optional(),
});

export const BotFirstScreenSchema = z.object({
  projects: z.object({ count: z.number().int(), names: z.array(z.string()) }),
  /** Absent when `gh` is not signed in. */
  github: z.object({ openPrs: z.number().int() }).optional(),
  workspaces: z.object({ count: z.number().int() }),
  /** Absent when the host keeps no MCP server list of its own. */
  mcp: z.object({ count: z.number().int(), names: z.array(z.string()) }).optional(),
});

export const BotAllowedPersonSchema = z.object({
  source: z.enum(["slack", "github", "gitlab", "telegram"]),
  id: z.string(),
  name: z.string(),
  workspaceId: z.string().optional(),
});

export const BotHomeFileSchema = z.enum(["SOUL.md", "MEMORY.md"]);

export const BotTemplateCreateInputSchema = z.object({
  templateId: z.string().min(1).max(64),
  name: z.string().trim().min(1).max(64),
  identity: z.string().trim().max(500).optional(),
  avatar: z.string().optional(),
  avatarColor: z.string().optional(),
  avatarOutfit: z.string().nullable().optional(),
  provider: AgentProviderSchema,
  model: z.string().min(1),
  thinkingOptionId: z.string().optional(),
});

export const BotItemCountsSchema = z.object({
  planned: z.number().int().optional(),
  working: z.number().int().optional(),
  waiting: z.number().int().optional(),
  needs_you: z.number().int().optional(),
  done: z.number().int().optional(),
  canceled: z.number().int().optional(),
});

export type BotNeedsYouRow = z.infer<typeof BotNeedsYouRowSchema>;
export type BotChat = z.infer<typeof BotChatSchema>;
export type BotChatWorker = z.infer<typeof BotChatWorkerSchema>;
export type BotChatTree = z.infer<typeof BotChatTreeSchema>;
export type BotSuggestion = z.infer<typeof BotSuggestionSchema>;
export type BotUpNextState = z.infer<typeof BotUpNextStateSchema>;
export type BotTidyUpSummary = z.infer<typeof BotTidyUpSummarySchema>;
export type BotTidyUpView = z.infer<typeof BotTidyUpViewSchema>;
export type BotMemoryFact = z.infer<typeof BotMemoryFactSchema>;
export type BotMemoryAuthor = z.infer<typeof BotMemoryAuthorSchema>;
export type BotMemoryHistoryRow = z.infer<typeof BotMemoryHistoryRowSchema>;
export type BotMemoryView = z.infer<typeof BotMemoryViewSchema>;
export type BotTemplate = z.infer<typeof BotTemplateSchema>;
export type BotAutomation = z.infer<typeof BotAutomationSchema>;
export type BotFirstScreen = z.infer<typeof BotFirstScreenSchema>;
export type BotAllowedPerson = z.infer<typeof BotAllowedPersonSchema>;
export type BotHomeFile = z.infer<typeof BotHomeFileSchema>;
