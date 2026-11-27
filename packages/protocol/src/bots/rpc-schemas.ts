import { z } from "zod";
import {
  BotSchema,
  BotInputSchema,
  BotPatchSchema,
  BotItemSchema,
  BotItemEventSchema,
  BotItemStatusSchema,
  BotMessageSchema,
  BotRoomSchema,
  BotScheduleSchema,
  BotScheduleInputSchema,
  BotGroupReplyModeSchema,
} from "./types.js";
import {
  BotAllowedPersonSchema,
  BotAutomationSchema,
  BotChatTreeSchema,
  BotFirstScreenSchema,
  BotHomeFileSchema,
  BotItemCountsSchema,
  BotMemoryHistoryRowSchema,
  BotMemoryViewSchema,
  BotNeedsYouRowSchema,
  BotSuggestionSchema,
  BotTemplateCreateInputSchema,
  BotTemplateSchema,
  BotTidyUpViewSchema,
  BotUpNextStateSchema,
} from "./views.js";

const request = <T extends string, S extends z.ZodRawShape>(type: T, shape: S) =>
  z.object({ type: z.literal(type), requestId: z.string(), ...shape });
const response = <T extends string, S extends z.ZodRawShape>(type: T, shape: S) =>
  z.object({ type: z.literal(type), payload: z.object({ requestId: z.string(), ...shape }) });
export const SlackStatusSchema = z.object({
  connected: z.boolean(),
  relayConnected: z.boolean(),
  requestUrl: z.string().optional(),
  workspace: z.string().optional(),
  botName: z.string().optional(),
  allowedUsers: z.array(z.object({ id: z.string(), name: z.string() })),
});
export type SlackStatus = z.infer<typeof SlackStatusSchema>;
const AllowedUserSchema = z.object({
  id: z.string(),
  name: z.string(),
  username: z.string().optional(),
});
/** Repository or organization hook state: waiting for GitHub's ping, connected, or made by hand. */
const HookTargetStateSchema = z.enum(["waiting", "connected", "manual"]);
export const GitHubStatusSchema = z.object({
  relayConnected: z.boolean(),
  /** `gh auth status` succeeded on the host; otherwise the UI shows the sign-in line. */
  signedIn: z.boolean(),
  host: z.string(),
  requestUrl: z.string().optional(),
  ownerLogin: z.string().optional(),
  targets: z.array(
    z.object({
      target: z.string(),
      state: HookTargetStateSchema,
      lastEventAt_ms: z.number().optional(),
    }),
  ),
  allowedUsers: z.array(AllowedUserSchema),
});
export type GitHubStatus = z.infer<typeof GitHubStatusSchema>;
/** Shown once when the hook must be made by hand; the secret is never returned again. */
export const HookManualSetupSchema = z.object({
  payloadUrl: z.string(),
  contentType: z.string().optional(),
  secret: z.string(),
  events: z.array(z.string()),
  settingsUrl: z.string().optional(),
});
export type HookManualSetup = z.infer<typeof HookManualSetupSchema>;
export const GitLabStatusSchema = z.object({
  relayConnected: z.boolean(),
  signedIn: z.boolean(),
  host: z.string(),
  requestUrl: z.string().optional(),
  ownerUsername: z.string().optional(),
  targets: z.array(
    z.object({
      host: z.string(),
      path: z.string(),
      scope: z.enum(["project", "group"]),
      state: HookTargetStateSchema,
      lastEventAt_ms: z.number().optional(),
    }),
  ),
  allowedUsers: z.array(AllowedUserSchema),
});
export type GitLabStatus = z.infer<typeof GitLabStatusSchema>;
export const TelegramStatusSchema = z.object({
  connected: z.boolean(),
  relayConnected: z.boolean(),
  requestUrl: z.string().optional(),
  botUsername: z.string().optional(),
  allowedUsers: z.array(AllowedUserSchema),
});
export type TelegramStatus = z.infer<typeof TelegramStatusSchema>;
const botId = { botId: z.string() };
const githubTarget = z
  .string()
  .trim()
  .regex(
    /^(?:org:[A-Za-z0-9][A-Za-z0-9-]{0,38}|[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100})$/,
  );
const gitlabTarget = {
  host: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9.-]+(?::\d{1,5})?$/)
    .max(253),
  path: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/)
    .max(255),
};
export const BotsRequestSchemas = [
  request("bots.slack.manifest.request", botId),
  request("bots.slack.connect.request", {
    ...botId,
    botToken: z.string().min(1).max(4096),
    signingSecret: z.string().min(1).max(4096),
  }),
  request("bots.slack.status.request", botId),
  request("bots.slack.link_code.request", botId),
  request("bots.slack.allowed.remove.request", { ...botId, userId: z.string().min(1) }),
  request("bots.slack.disconnect.request", botId),
  request("bots.github.add_repo.request", { ...botId, target: githubTarget }),
  request("bots.github.status.request", botId),
  request("bots.github.rotate_secret.request", { ...botId, target: githubTarget }),
  request("bots.github.remove.request", { ...botId, target: githubTarget }),
  request("bots.github.allowed.add.request", {
    ...botId,
    login: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9-]{1,39}$/),
  }),
  request("bots.github.allowed.remove.request", { ...botId, login: z.string().min(1) }),
  request("bots.gitlab.add_project.request", { ...botId, ...gitlabTarget }),
  request("bots.gitlab.status.request", { ...botId, host: gitlabTarget.host.optional() }),
  request("bots.gitlab.rotate_secret.request", { ...botId, ...gitlabTarget }),
  request("bots.gitlab.remove.request", { ...botId, ...gitlabTarget }),
  request("bots.gitlab.allowed.add.request", {
    ...botId,
    username: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9_.-]{1,255}$/),
  }),
  request("bots.gitlab.allowed.remove.request", { ...botId, username: z.string().min(1) }),
  request("bots.telegram.connect.request", {
    ...botId,
    token: z
      .string()
      .trim()
      .regex(/^\d{1,20}:[A-Za-z0-9_-]{20,100}$/),
  }),
  request("bots.telegram.status.request", botId),
  request("bots.telegram.link_code.request", botId),
  request("bots.telegram.allowed.remove.request", { ...botId, userId: z.string().min(1) }),
  request("bots.telegram.disconnect.request", botId),
  request("bots.list.request", {}),
  request("bots.create.request", { bot: BotInputSchema }),
  request("bots.update.request", { ...botId, patch: BotPatchSchema }),
  request("bots.delete.request", botId),
  request("bots.pause.request", { ...botId, paused: z.boolean() }),
  request("bots.chat.send.request", {
    ...botId,
    text: z.string().trim().min(1).max(20000),
    messageId: z.string().optional(),
  }),
  request("bots.chat.history.request", {
    ...botId,
    before_ms: z.number().int().optional(),
    limit: z.number().int().min(1).max(200).optional(),
  }),
  request("bots.items.list.request", { ...botId, includeClosed: z.boolean().optional() }),
  request("bots.items.answer.request", {
    ...botId,
    itemId: z.string(),
    answers: z
      .array(
        z.object({
          questionIndex: z.number().int().min(0).max(4),
          text: z.string().trim().min(1).max(4000),
        }),
      )
      .min(1)
      .max(5),
  }),
  request("bots.items.cancel.request", {
    ...botId,
    itemId: z.string(),
    reason: z.string().min(1).max(4000),
  }),
  request("bots.rooms.list.request", {}),
  request("bots.rooms.save.request", {
    room: BotRoomSchema.omit({ messages: true, folder: true }).extend({
      id: z.string().optional(),
      replyMode: BotGroupReplyModeSchema.optional(),
    }),
  }),
  request("bots.rooms.delete.request", { roomId: z.string() }),
  request("bots.rooms.send.request", {
    roomId: z.string(),
    text: z.string().trim().min(1).max(20000),
    messageId: z.string().optional(),
  }),
  request("bots.schedules.list.request", botId),
  request("bots.schedules.save.request", {
    ...botId,
    scheduleId: z.string().optional(),
    schedule: BotScheduleInputSchema,
  }),
  request("bots.schedules.delete.request", { ...botId, scheduleId: z.string() }),
  // Orca layout (ADR-0060 §Protocol, spec 37.2-37.4). Gate on `server_info.features.botsOrca`.
  request("bots.needs_you.list.request", botId),
  request("bots.items.show.request", { ...botId, itemId: z.string() }),
  request("bots.items.snooze.request", {
    ...botId,
    itemUid: z.string(),
    until_ms: z.number().int().nullable(),
  }),
  request("bots.items.cancel_many.request", {
    ...botId,
    itemUids: z.array(z.string()).min(1).max(100),
    reason: z.string().trim().min(1).max(4000),
  }),
  request("bots.items.set_status.request", {
    ...botId,
    itemId: z.string(),
    status: BotItemStatusSchema,
  }),
  request("bots.items.done.request", {
    ...botId,
    itemId: z.string(),
    // "Mark done anyway" (spec 37.3.7 step 3): the only way past `review_pending`.
    force: z.boolean().optional(),
  }),
  request("bots.items.comment.request", {
    ...botId,
    itemId: z.string(),
    text: z.string().trim().min(1).max(8000),
  }),
  request("bots.items.mark_seen.request", botId),
  request("bots.chats.tree.request", { ...botId, query: z.string().max(200).optional() }),
  request("bots.chat.reset.request", botId),
  request("bots.suggestions.list.request", botId),
  request("bots.suggestions.start.request", { ...botId, suggestionId: z.string() }),
  request("bots.suggestions.dismiss.request", { ...botId, suggestionId: z.string() }),
  request("bots.look_around.run_now.request", botId),
  request("bots.tidy_up.status.request", botId),
  request("bots.tidy_up.run_now.request", botId),
  request("bots.tidy_up.undo.request", { ...botId, runId: z.string() }),
  request("bots.memory.read.request", botId),
  request("bots.memory.history.request", botId),
  request("bots.memory.add.request", { ...botId, text: z.string().trim().min(1).max(2000) }),
  request("bots.memory.edit.request", {
    ...botId,
    line: z.number().int().min(0),
    /** The fact's text as read, so an edit never lands on a line that moved. */
    expected: z.string(),
    text: z.string().trim().max(2000),
  }),
  request("bots.memory.forget.request", {
    ...botId,
    line: z.number().int().min(0),
    expected: z.string(),
  }),
  request("bots.memory.undo.request", { ...botId, rowId: z.string() }),
  request("bots.home_file.read.request", { ...botId, file: BotHomeFileSchema }),
  request("bots.home_file.write.request", {
    ...botId,
    file: BotHomeFileSchema,
    content: z.string().max(1_000_000),
    /** Hash from the last read; a mismatch fails with `file_changed`. Omit to overwrite ("Keep mine"). */
    baseHash: z.string().optional(),
  }),
  request("bots.templates.list.request", {}),
  request("bots.create_from_template.request", BotTemplateCreateInputSchema.shape),
  request("bots.hand_over.request", {
    workspaceId: z.string(),
    /** A bot id, or "new" with `newBot`. */
    botId: z.string(),
    newBot: BotInputSchema.optional(),
    goal: z.string().trim().max(4000).optional(),
  }),
  request("bots.automations.list.request", botId),
  request("bots.automations.run_now.request", { ...botId, automationId: z.string() }),
  request("bots.automations.cancel_wait.request", { ...botId, itemId: z.string() }),
  request("bots.first_screen.scan.request", botId),
  request("bots.allowed.list.request", botId),
  // Orca `bots.avatar.upload` / `.read`: a square PNG, 512-2000 px, at most 2 MB, base64.
  request("bots.avatar.upload.request", { ...botId, png: z.string().min(1).max(2_800_000) }),
  request("bots.avatar.read.request", botId),
] as const;
export const BotsResponseSchemas = [
  response("bots.slack.manifest.response", { manifest: z.string(), requestUrl: z.string() }),
  response("bots.slack.connect.response", { status: SlackStatusSchema }),
  response("bots.slack.status.response", { status: SlackStatusSchema }),
  response("bots.slack.link_code.response", { code: z.string(), expiresAt_ms: z.number() }),
  response("bots.slack.allowed.remove.response", { status: SlackStatusSchema }),
  response("bots.slack.disconnect.response", { status: SlackStatusSchema }),
  response("bots.github.add_repo.response", {
    status: GitHubStatusSchema,
    manual: HookManualSetupSchema.optional(),
  }),
  response("bots.github.status.response", { status: GitHubStatusSchema }),
  response("bots.github.rotate_secret.response", {
    status: GitHubStatusSchema,
    manual: HookManualSetupSchema.optional(),
  }),
  response("bots.github.remove.response", { status: GitHubStatusSchema }),
  response("bots.github.allowed.add.response", { status: GitHubStatusSchema }),
  response("bots.github.allowed.remove.response", { status: GitHubStatusSchema }),
  response("bots.gitlab.add_project.response", {
    status: GitLabStatusSchema,
    manual: HookManualSetupSchema.optional(),
  }),
  response("bots.gitlab.status.response", { status: GitLabStatusSchema }),
  response("bots.gitlab.rotate_secret.response", {
    status: GitLabStatusSchema,
    manual: HookManualSetupSchema.optional(),
  }),
  response("bots.gitlab.remove.response", { status: GitLabStatusSchema }),
  response("bots.gitlab.allowed.add.response", { status: GitLabStatusSchema }),
  response("bots.gitlab.allowed.remove.response", { status: GitLabStatusSchema }),
  response("bots.telegram.connect.response", { status: TelegramStatusSchema }),
  response("bots.telegram.status.response", { status: TelegramStatusSchema }),
  response("bots.telegram.link_code.response", { code: z.string(), expiresAt_ms: z.number() }),
  response("bots.telegram.allowed.remove.response", { status: TelegramStatusSchema }),
  response("bots.telegram.disconnect.response", { status: TelegramStatusSchema }),
  response("bots.list.response", { bots: z.array(BotSchema) }),
  response("bots.create.response", { bot: BotSchema }),
  response("bots.update.response", { bot: BotSchema }),
  response("bots.delete.response", {}),
  response("bots.pause.response", { bot: BotSchema }),
  response("bots.chat.send.response", { message: BotMessageSchema }),
  response("bots.chat.history.response", { messages: z.array(BotMessageSchema) }),
  response("bots.items.list.response", {
    items: z.array(BotItemSchema),
    counts: BotItemCountsSchema.optional(),
  }),
  response("bots.items.answer.response", { item: BotItemSchema }),
  response("bots.items.cancel.response", { item: BotItemSchema }),
  response("bots.rooms.list.response", { rooms: z.array(BotRoomSchema) }),
  response("bots.rooms.save.response", { room: BotRoomSchema }),
  response("bots.rooms.delete.response", {}),
  response("bots.rooms.send.response", { message: BotMessageSchema }),
  response("bots.schedules.list.response", { schedules: z.array(BotScheduleSchema) }),
  response("bots.schedules.save.response", { schedule: BotScheduleSchema }),
  response("bots.schedules.delete.response", {}),
  response("bots.needs_you.list.response", { rows: z.array(BotNeedsYouRowSchema) }),
  response("bots.items.show.response", {
    item: BotItemSchema,
    events: z.array(BotItemEventSchema),
  }),
  response("bots.items.snooze.response", { item: BotItemSchema }),
  response("bots.items.cancel_many.response", { canceled: z.array(z.string()) }),
  response("bots.items.set_status.response", { item: BotItemSchema }),
  response("bots.items.done.response", { item: BotItemSchema }),
  response("bots.items.comment.response", { item: BotItemSchema }),
  response("bots.items.mark_seen.response", { bot: BotSchema }),
  response("bots.chats.tree.response", BotChatTreeSchema.shape),
  response("bots.chat.reset.response", { bot: BotSchema }),
  response("bots.suggestions.list.response", {
    suggestions: z.array(BotSuggestionSchema),
    state: BotUpNextStateSchema,
  }),
  response("bots.suggestions.start.response", {
    suggestions: z.array(BotSuggestionSchema),
    state: BotUpNextStateSchema,
    message: BotMessageSchema,
  }),
  response("bots.suggestions.dismiss.response", {
    suggestions: z.array(BotSuggestionSchema),
    state: BotUpNextStateSchema,
  }),
  response("bots.look_around.run_now.response", {
    started: z.boolean(),
    runAgentId: z.string().optional(),
  }),
  response("bots.tidy_up.status.response", { tidyUp: BotTidyUpViewSchema }),
  response("bots.tidy_up.run_now.response", { started: z.boolean() }),
  response("bots.tidy_up.undo.response", { undone: z.boolean() }),
  response("bots.memory.read.response", { memory: BotMemoryViewSchema }),
  response("bots.memory.history.response", { history: z.array(BotMemoryHistoryRowSchema) }),
  response("bots.memory.add.response", { memory: BotMemoryViewSchema }),
  response("bots.memory.edit.response", { memory: BotMemoryViewSchema }),
  response("bots.memory.forget.response", { memory: BotMemoryViewSchema }),
  response("bots.memory.undo.response", {
    memory: BotMemoryViewSchema,
    history: z.array(BotMemoryHistoryRowSchema),
  }),
  response("bots.home_file.read.response", { content: z.string(), hash: z.string() }),
  response("bots.home_file.write.response", { content: z.string(), hash: z.string() }),
  response("bots.templates.list.response", { templates: z.array(BotTemplateSchema) }),
  response("bots.create_from_template.response", { bot: BotSchema }),
  response("bots.hand_over.response", {
    bot: BotSchema,
    workspace: z.object({ workspaceId: z.string(), title: z.string() }),
  }),
  response("bots.automations.list.response", {
    automations: z.array(BotAutomationSchema),
    /** All of the bot's core schedules, for `"All {{count}} automations"`. */
    total: z.number().int(),
  }),
  response("bots.automations.run_now.response", { started: z.boolean() }),
  response("bots.automations.cancel_wait.response", { item: BotItemSchema }),
  response("bots.first_screen.scan.response", { scan: BotFirstScreenSchema }),
  response("bots.allowed.list.response", { people: z.array(BotAllowedPersonSchema) }),
  response("bots.avatar.upload.response", { bot: BotSchema }),
  response("bots.avatar.read.response", { png: z.string().nullable() }),
] as const;
export const BotsPushSchemas = [
  z.object({
    type: z.literal("bots.changed"),
    payload: z.object({ botId: z.string(), deleted: z.boolean().optional() }),
  }),
  z.object({ type: z.literal("bots.item.changed"), payload: z.object({ item: BotItemSchema }) }),
  z.object({
    type: z.literal("bots.chat.message"),
    payload: z.object({ message: BotMessageSchema }),
  }),
  z.object({
    type: z.literal("bots.room.changed"),
    payload: z.object({ roomId: z.string(), deleted: z.boolean().optional() }),
  }),
  // Orca layout pushes (ADR-0060 §Protocol). `bots.item.changed` above stays the per-item push.
  /** Several items changed at once (cancel_many, stale sweep): refetch `bots.items.list`. */
  z.object({
    type: z.literal("bots.items_changed"),
    payload: z.object({ botId: z.string(), counts: BotItemCountsSchema.optional() }),
  }),
  z.object({
    type: z.literal("bots.suggestions_changed"),
    payload: z.object({ botId: z.string() }),
  }),
  /** Needs you rows, chats tree or automations changed: refetch the open panel's read. */
  z.object({
    type: z.literal("bots.activity_changed"),
    payload: z.object({
      botId: z.string(),
      parts: z.array(z.enum(["needs_you", "chats", "automations", "memory", "tidy_up"])),
    }),
  }),
  /** SOUL.md or MEMORY.md changed on disk (spec 37.4.9 "SOUL.md changed on disk."). */
  z.object({
    type: z.literal("bots.home_file_changed"),
    payload: z.object({ botId: z.string(), file: BotHomeFileSchema, hash: z.string() }),
  }),
] as const;
export type BotsRequest = z.infer<(typeof BotsRequestSchemas)[number]>;
export type BotsResponse = z.infer<(typeof BotsResponseSchemas)[number]>;
export type BotsPush = z.infer<(typeof BotsPushSchemas)[number]>;
export type BotsRequestType = BotsRequest["type"];
export type BotsRequestParams<T extends BotsRequestType> = Omit<
  Extract<BotsRequest, { type: T }>,
  "type" | "requestId"
>;
export type BotsResponseTypeFor<T extends BotsRequestType> = T extends `${infer N}.request`
  ? `${N}.response`
  : never;
export type BotsResponseFor<T extends BotsRequestType> = Extract<
  BotsResponse,
  { type: BotsResponseTypeFor<T> }
>;
