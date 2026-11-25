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
export const BotInputSchema = z.object({
  slug: z
    .string()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    .max(64),
  name: z.string().trim().min(1).max(64),
  identity: z.string().trim().min(1).max(500),
  provider: AgentProviderSchema,
  model: z.string().min(1),
  thinkingOptionId: z.string().optional(),
  modeId: z.string().min(1),
  unattended: z.boolean().optional(),
  defaultRepo: z.string().min(1).optional(),
  lookAround: z
    .object({ enabled: z.boolean(), intervalMinutes: z.number().int().min(1) })
    .optional(),
  // Jira account ids are site-specific. GitHub logins need not match the local slug.
  jiraAccounts: z.array(z.object({ connectionId: z.string(), accountId: z.string() })).optional(),
  githubLogin: z
    .string()
    .regex(/^[a-zA-Z0-9-]+$/)
    .optional(),
});
export const BotPatchSchema = BotInputSchema.omit({ slug: true }).partial();
export const BotSchema = BotInputSchema.extend({
  id: z.string(),
  unattended: z.boolean(),
  paused: z.boolean(),
  lookAround: z.object({ enabled: z.boolean(), intervalMinutes: z.number().int().min(1) }),
  schedules: z.array(BotScheduleSchema),
  agentId: z.string().optional(),
  createdAt_ms: z.number().int(),
  updatedAt_ms: z.number().int(),
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
});
export const BotSlackThreadSchema = z.object({
  hookId: z.string(),
  channel: z.string(),
  threadTs: z.string(),
  userId: z.string(),
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
});
export const BotRoomSchema = z.object({
  id: z.string(),
  name: z.string().trim().min(1).max(100),
  memberBotIds: z.array(z.string()).max(50),
  messages: z.array(BotMessageSchema),
});
export type Bot = z.infer<typeof BotSchema>;
export type BotInput = z.infer<typeof BotInputSchema>;
export type BotPatch = z.infer<typeof BotPatchSchema>;
export type BotItem = z.infer<typeof BotItemSchema>;
export type BotItemPatch = z.infer<typeof BotItemPatchSchema>;
export type BotQuestion = z.infer<typeof BotQuestionSchema>;
export type BotMessage = z.infer<typeof BotMessageSchema>;
export type BotRoom = z.infer<typeof BotRoomSchema>;
export type BotSchedule = z.infer<typeof BotScheduleSchema>;
export type BotScheduleInput = z.infer<typeof BotScheduleInputSchema>;
