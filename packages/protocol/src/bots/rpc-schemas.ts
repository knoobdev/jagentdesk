import { z } from "zod";
import {
  BotSchema,
  BotInputSchema,
  BotPatchSchema,
  BotItemSchema,
  BotMessageSchema,
  BotRoomSchema,
  BotScheduleSchema,
  BotScheduleInputSchema,
} from "./types.js";

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
    room: BotRoomSchema.omit({ messages: true }).extend({ id: z.string().optional() }),
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
  response("bots.items.list.response", { items: z.array(BotItemSchema) }),
  response("bots.items.answer.response", { item: BotItemSchema }),
  response("bots.items.cancel.response", { item: BotItemSchema }),
  response("bots.rooms.list.response", { rooms: z.array(BotRoomSchema) }),
  response("bots.rooms.save.response", { room: BotRoomSchema }),
  response("bots.rooms.delete.response", {}),
  response("bots.rooms.send.response", { message: BotMessageSchema }),
  response("bots.schedules.list.response", { schedules: z.array(BotScheduleSchema) }),
  response("bots.schedules.save.response", { schedule: BotScheduleSchema }),
  response("bots.schedules.delete.response", {}),
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
