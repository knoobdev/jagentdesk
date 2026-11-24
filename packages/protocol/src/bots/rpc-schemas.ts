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
const botId = { botId: z.string() };
export const BotsRequestSchemas = [
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
