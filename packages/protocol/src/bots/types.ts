// Bots wire shapes. Round 1 (v0.10) shapes stay readable by older apps: every field they require is
// still sent, and every field added for the Orca layout (ADR-0060, spec 37.2) is optional.
// Field meanings follow Orca dfdb4fda (MIT): src/shared/bot-types.ts:167-255,
// src/shared/bots/bot-items.ts, bot-item-ask.ts, bot-look-around.ts, bot-tidy-up.ts.
import { z } from "zod";
import { AgentProviderSchema } from "../provider-manifest.js";
import { ReviewSchema } from "../review/types.js";

export const BotScheduleInputSchema = z.object({
  name: z.string().trim().min(1).max(100),
  cron: z.string().min(1).max(100),
  timezone: z.string().optional(),
  prompt: z.string().trim().min(1).max(20000),
  enabled: z.boolean(),
});
export const BotScheduleSchema = BotScheduleInputSchema.extend({
  id: z.string(),
  nextRunAt_ms: z.number().int(),
});

/** `shared/bots/bot-avatar-color.ts`: a `#rrggbb` tile color; the picker offers BOT_AVATAR_COLORS. */
export const BotAvatarColorSchema = z.string().regex(/^#[0-9a-f]{6}$/);
/** `shared/bots/bot-avatar-outfit.ts`: any stored id, so an outfit a newer app added survives. */
export const BotAvatarOutfitSchema = z.string().regex(/^[a-z0-9-]{1,40}$/);
/** `mascot:<id>` (one of BOT_MASCOT_IDS) or `upload:<sha16>` (avatar.png in the bot home). */
export const BotAvatarSchema = z.string().regex(/^(?:mascot:[A-Z][0-9]|upload:[0-9a-f]{16})$/);
export const BotNotificationsSchema = z.object({
  needsPermission: z.boolean(),
  taskComplete: z.boolean(),
  couldNotFinish: z.boolean(),
});
export const LookAroundEverySchema = z.enum(["every-4h", "every-2h", "twice-daily", "mornings"]);
export const TidyUpEverySchema = z.enum(["night", "week"]);
export const BotTidyUpSchema = z.object({
  on: z.boolean(),
  every: TidyUpEverySchema,
  /** When it was last turned on; absent: on since the bot was made. */
  since_ms: z.number().int().optional(),
});
export const BotItemsStaleSchema = z.union([
  z.literal(3),
  z.literal(5),
  z.literal(7),
  z.literal(14),
  z.literal("never"),
]);
/** "same-as-chats" or one of the provider's mode ids (spec 37.3.3). */
export const BotPermissionModeSchema = z.string().min(1).max(100);
/** A connector's state as the bot row and the Connectors tab show it; bt4/bt5 own the details. */
export const BotConnectorSummarySchema = z.object({
  connected: z.boolean(),
  /** Token revoked, signature failures, webhook removed: `"{{name}} needs you to sign in again or fix it."` */
  needsFix: z.boolean().optional(),
  label: z.string().optional(),
});
export const BotShareSummarySchema = z.object({
  shared: z.boolean(),
  updatedAt_ms: z.number().int().optional(),
});

const LookAroundInputSchema = z.object({
  // COMPAT(botsRound1LookAround): added in v0.10.0, remove after 2027-06-01 once app floor >= v0.12.0.
  enabled: z.boolean().optional(),
  // COMPAT(botsRound1LookAround): see above.
  intervalMinutes: z.number().int().min(1).optional(),
  on: z.boolean().optional(),
  every: LookAroundEverySchema.optional(),
  weekdaysOnly: z.boolean().optional(),
  focus: z.string().max(500).optional(),
});

export const BotInputSchema = z.object({
  // Optional since `features.botsOrca`: the daemon derives the folder from the name (spec 37.2.3).
  slug: z
    .string()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    .max(64)
    .optional(),
  name: z.string().trim().min(1).max(64),
  // Optional since `features.botsOptionalIdentity`: an empty identity gets the daemon's default
  // line, so every stored bot still carries one (older apps require it on `Bot`). The New bot
  // dialog caps it at 200 (spec 37.5); round-1 apps could send up to 500.
  identity: z.string().trim().max(500).optional(),
  provider: AgentProviderSchema,
  model: z.string().min(1),
  thinkingOptionId: z.string().optional(),
  // Optional since `features.botsOrca`: `permissionMode` replaces it.
  modeId: z.string().min(1).optional(),
  unattended: z.boolean().optional(),
  defaultRepo: z.string().min(1).optional(),
  lookAround: LookAroundInputSchema.optional(),
  // Jira account ids are site-specific. GitHub logins need not match the local slug.
  jiraAccounts: z.array(z.object({ connectionId: z.string(), accountId: z.string() })).optional(),
  githubLogin: z
    .string()
    .regex(/^[a-zA-Z0-9-]+$/)
    .optional(),
  permissionMode: BotPermissionModeSchema.optional(),
  avatar: BotAvatarSchema.optional(),
  avatarColor: BotAvatarColorSchema.optional(),
  avatarOutfit: BotAvatarOutfitSchema.nullable().optional(),
  notifications: BotNotificationsSchema.partial().optional(),
  tidyUp: BotTidyUpSchema.omit({ since_ms: true }).partial().optional(),
  itemsStale: BotItemsStaleSchema.optional(),
  reviewBeforeDone: z.boolean().optional(),
});
export const BotPatchSchema = BotInputSchema.omit({ slug: true }).partial();
export const BotSchema = BotInputSchema.extend({
  id: z.string(),
  // Round-1 apps require slug and modeId; the daemon always sends them (slug = folder).
  slug: z
    .string()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    .max(64),
  modeId: z.string().min(1),
  identity: z.string().trim().min(1).max(500),
  unattended: z.boolean(),
  paused: z.boolean(),
  lookAround: z.object({
    // COMPAT(botsRound1LookAround): round-1 apps require both; `enabled` mirrors `on`.
    enabled: z.boolean(),
    intervalMinutes: z.number().int().min(1),
    on: z.boolean().optional(),
    every: LookAroundEverySchema.optional(),
    weekdaysOnly: z.boolean().optional(),
    focus: z.string().max(500).optional(),
    since_ms: z.number().int().optional(),
  }),
  // COMPAT(botsRound1Schedules): mirror of the bot's core-schedule automations for round-1 apps.
  schedules: z.array(BotScheduleSchema),
  /** The Home Chat agent; absent until the first message is delivered. */
  agentId: z.string().optional(),
  createdAt_ms: z.number().int(),
  updatedAt_ms: z.number().int(),
  // Orca layout (spec 37.2.3). Absent from older daemons.
  folder: z.string().optional(),
  /** Absolute home path on the host (`$JAGENTDESK_HOME/bots/<folder>`), for Files and "Copy Path". */
  home: z.string().optional(),
  homeAgentId: z.string().optional(),
  tidyUp: BotTidyUpSchema.optional(),
  notifications: BotNotificationsSchema.optional(),
  firstRun: z.boolean().optional(),
  templateId: z.string().max(64).optional(),
  /** Workspaces handed to the bot (spec 37.4.11), oldest first. */
  handedWorkspaces: z
    .array(z.object({ workspaceId: z.string(), at_ms: z.number().int() }))
    .max(50)
    .optional(),
  /** Newest item event the owner has seen in Items; items with later events count as new. */
  itemsSeen_ms: z.number().int().optional(),
  slack: BotConnectorSummarySchema.optional(),
  github: BotConnectorSummarySchema.optional(),
  gitlab: BotConnectorSummarySchema.optional(),
  telegram: BotConnectorSummarySchema.optional(),
  share: BotShareSummarySchema.optional(),
});

export const BotQuestionSchema = z.object({
  text: z.string().trim().min(1).max(500),
  options: z.array(z.string().min(1).max(500)).max(8),
  recommended: z.number().int().min(0).max(7).optional(),
  answer: z.string().max(4000).optional(),
});
export const BotItemStatusSchema = z.enum([
  "planned",
  "working",
  "waiting",
  "needs_you",
  "done",
  "canceled",
]);

/** `shared/bots/bot-item-ask.ts`: one decision of an ask, with quick replies. */
export const BotItemDecisionSchema = z.object({
  prompt: z.string().trim().min(1).max(500),
  options: z
    .array(
      z.object({
        label: z.string().trim().min(1).max(150),
        detail: z.string().trim().max(500).optional(),
      }),
    )
    .max(8),
  recommended: z.number().int().min(0).max(7).optional(),
  multi: z.boolean().optional(),
});
export const BotItemAskSchema = z.object({
  context: z.string().trim().max(8000).optional(),
  questions: z.array(BotItemDecisionSchema).min(1).max(5),
});

export const BotItemPatchSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  doneMeans: z.string().trim().min(1).max(2000).optional(),
  status: BotItemStatusSchema.optional(),
  waitFor: z
    .object({ condition: z.string().min(1).max(2000), until_ms: z.number().int() })
    .optional(),
  questions: z
    .array(BotQuestionSchema.omit({ answer: true }))
    .max(5)
    .optional(),
  description: z.string().max(20000).optional(),
});

export const BotItemChatKindSchema = z.enum(["home", "chat", "thread", "automation"]);
export const BotItemWorkerStateSchema = z.enum([
  "working",
  "completed",
  "failed",
  "stopped",
  "unknown",
  "missing",
]);
export const BotItemLinkSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("dispatch"),
    /** The worker agent id. */
    ref: z.string(),
    title: z.string().nullable(),
    state: BotItemWorkerStateSchema,
    worktree: z.string().optional(),
    branch: z.string().optional(),
    startedAt_ms: z.number().int().nullable(),
    settledAt_ms: z.number().int().nullable(),
    report: z.string().nullable(),
  }),
  z.object({
    kind: z.literal("pr"),
    /** `owner/repo#n` */
    ref: z.string(),
    url: z.string().optional(),
  }),
  z.object({ kind: z.literal("url"), ref: z.string() }),
  z.object({ kind: z.literal("file"), ref: z.string() }),
  z.object({
    kind: z.literal("automation"),
    ref: z.string(),
    name: z.string().nullable(),
    active: z.boolean(),
  }),
]);
export const BotItemReviewStateSchema = z.object({
  /** `pending`: a worker finished and the three reviews have not passed yet (`review_pending`). */
  state: z.enum(["pending", "running", "blocked", "passed"]),
  round: z.number().int().min(0).max(2),
});

export const BotItemSchema = z.object({
  id: z.string(),
  botId: z.string(),
  title: z.string(),
  doneMeans: z.string(),
  status: BotItemStatusSchema,
  waitFor: z.object({ condition: z.string(), until_ms: z.number().int() }).optional(),
  questions: z.array(BotQuestionSchema).max(5).optional(),
  workerAgentIds: z.array(z.string()),
  comments: z.array(
    z.object({
      id: z.string(),
      text: z.string(),
      author: z.string(),
      createdAt_ms: z.number().int(),
    }),
  ),
  worktree: z.string().optional(),
  baseCommit: z.string().optional(),
  reviewRounds: z.number().int(),
  reviews: z.array(ReviewSchema),
  reviewedDiffHash: z.string().optional(),
  summary: z.string().optional(),
  diff: z.string().optional(),
  createdAt_ms: z.number().int(),
  updatedAt_ms: z.number().int(),
  // Orca item fields (spec 37.2.5). Absent from older daemons.
  /** Same as `id`. */
  uid: z.string().optional(),
  /** Per-bot item number, shown as `#N`. */
  number: z.number().int().positive().optional(),
  description: z.string().optional(),
  chat: z
    .object({ id: z.string(), kind: BotItemChatKindSchema, title: z.string().nullable() })
    .optional(),
  madeBy: z.enum(["bot", "owner", "jagentdesk"]).optional(),
  /** Needs you: the comment asking the owner, with its decisions and quick replies. */
  question: z
    .object({
      eventId: z.string(),
      text: z.string(),
      decisions: z.array(BotItemDecisionSchema).max(5).optional(),
    })
    .optional(),
  closeNote: z.string().optional(),
  wait: z.object({ text: z.string(), at_ms: z.number().int() }).optional(),
  links: z.array(BotItemLinkSchema).max(50).optional(),
  snoozedUntil_ms: z.number().int().optional(),
  lastActivityAt_ms: z.number().int().optional(),
  closedAt_ms: z.number().int().optional(),
  /** Only on bots with `reviewBeforeDone` (spec 37.3.7). */
  review: BotItemReviewStateSchema.optional(),
});

export const BotItemActorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("bot"), botId: z.string(), chatId: z.string().optional() }),
  z.object({ kind: z.literal("owner"), device: z.string().optional() }),
  z.object({ kind: z.literal("worker"), agentId: z.string() }),
  z.object({ kind: z.literal("jagentdesk"), why: z.string() }),
]);
export const BotItemEventKindSchema = z.enum([
  "made",
  "edited",
  "status",
  "commented",
  "linked",
  "snoozed",
  "unsnoozed",
]);
/** One row of an item's Activity (spec 37.4.5); `data` carries the kind's fields (`from`, `to`, `text`, `link`, `until_ms`, `reason`). */
export const BotItemEventSchema = z.object({
  id: z.string(),
  itemId: z.string(),
  kind: BotItemEventKindSchema,
  actor: BotItemActorSchema,
  data: z.record(z.string(), z.unknown()),
  at_ms: z.number().int(),
});

export const BotSlackThreadSchema = z.object({
  hookId: z.string(),
  channel: z.string(),
  threadTs: z.string(),
  userId: z.string(),
});
/** A Home Chat line the daemon writes (spec 37.2.6, 37.4.2): runs, item notes, waits that ended. */
export const BotChatNoteSchema = z.object({
  kind: z.enum(["look_around", "tidy_up", "automation", "item", "wait_ended", "hand_over"]),
  state: z.enum(["running", "done", "failed"]).optional(),
  count: z.number().int().optional(),
  /** The run's own conversation, opened when the line is pressed. */
  runAgentId: z.string().optional(),
  itemIds: z.array(z.string()).optional(),
  /** Item note verb: `added`, `moved`, `asked`, `done`, `commented`. */
  verb: z.string().optional(),
  status: BotItemStatusSchema.optional(),
});
export const BotMessageSchema = z.object({
  id: z.string(),
  botId: z.string(),
  role: z.enum(["user", "assistant", "system"]),
  text: z.string(),
  source: z.string(),
  createdAt_ms: z.number().int(),
  roomId: z.string().optional(),
  rootId: z.string().optional(),
  slack: BotSlackThreadSchema.optional(),
  note: BotChatNoteSchema.optional(),
  /** Updated in place (a running note that finished); clients replace by `id`. */
  updatedAt_ms: z.number().int().optional(),
});
/** `shared/bots/bot-group-schema.ts` BotGroupReplyMode. */
export const BotGroupReplyModeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("bot"), botId: z.string().min(1) }),
  z.object({ kind: z.literal("all") }),
  z.object({ kind: z.literal("mentions") }),
]);
export const BotRoomSchema = z.object({
  id: z.string(),
  name: z.string().trim().min(1).max(100),
  memberBotIds: z.array(z.string()).max(50),
  messages: z.array(BotMessageSchema),
  // Groups (spec 37.3.6). Absent from older daemons: mentions only.
  replyMode: BotGroupReplyModeSchema.optional(),
  folder: z.string().optional(),
});

export type Bot = z.infer<typeof BotSchema>;
export type BotInput = z.infer<typeof BotInputSchema>;
export type BotPatch = z.infer<typeof BotPatchSchema>;
export type BotItem = z.infer<typeof BotItemSchema>;
export type BotItemPatch = z.infer<typeof BotItemPatchSchema>;
export type BotItemLink = z.infer<typeof BotItemLinkSchema>;
export type BotItemEvent = z.infer<typeof BotItemEventSchema>;
export type BotItemActor = z.infer<typeof BotItemActorSchema>;
export type BotItemAsk = z.infer<typeof BotItemAskSchema>;
export type BotItemDecision = z.infer<typeof BotItemDecisionSchema>;
export type BotItemStatus = z.infer<typeof BotItemStatusSchema>;
export type BotItemsStale = z.infer<typeof BotItemsStaleSchema>;
export type BotQuestion = z.infer<typeof BotQuestionSchema>;
export type BotMessage = z.infer<typeof BotMessageSchema>;
export type BotChatNote = z.infer<typeof BotChatNoteSchema>;
export type BotRoom = z.infer<typeof BotRoomSchema>;
export type BotGroupReplyMode = z.infer<typeof BotGroupReplyModeSchema>;
export type BotSchedule = z.infer<typeof BotScheduleSchema>;
export type BotScheduleInput = z.infer<typeof BotScheduleInputSchema>;
export type BotNotifications = z.infer<typeof BotNotificationsSchema>;
export type BotTidyUp = z.infer<typeof BotTidyUpSchema>;
export type LookAroundEvery = z.infer<typeof LookAroundEverySchema>;
export type TidyUpEvery = z.infer<typeof TidyUpEverySchema>;
