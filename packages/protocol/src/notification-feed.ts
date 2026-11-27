import { z } from "zod";

// Notification feed (ADR-0063, spec 14 §8.5): the daemon keeps one list per host of what it
// notified about, shared by every device. Requests use the `notifications.feed.` namespace and are
// gated on `server_info.features.notificationFeed`.

/** Retention: whichever limit is reached first. */
export const NOTIFICATION_FEED_MAX_ITEMS = 500;
export const NOTIFICATION_FEED_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const NOTIFICATION_FEED_PAGE_SIZE = 50;

/**
 * Kinds this daemon writes. The wire field is a plain string so a newer daemon can add a kind
 * without breaking older clients; clients draw an unknown kind with a generic icon.
 */
export const NOTIFICATION_FEED_KINDS = [
  "agent_finished",
  "agent_permission",
  "agent_error",
  "bot_needs_you",
  "bot_task_complete",
  "bot_could_not_finish",
  "plugin",
] as const;
export type NotificationFeedKind = (typeof NOTIFICATION_FEED_KINDS)[number];

/** A plugin's declared open target, kept loose for the same reason as `kind`. */
export const NotificationFeedOpenSchema = z.object({
  type: z.string(),
  agentId: z.string().optional(),
  workspaceId: z.string().optional(),
  screenId: z.string().optional(),
  params: z.record(z.string(), z.string()).optional(),
});

/**
 * Where a row opens: `agent` (agentId + workspaceId), `bot` (botId, optional itemId/agentId), or
 * `plugin` (pluginId + notificationId, optional declared `open`).
 */
export const NotificationFeedTargetSchema = z.object({
  type: z.string(),
  agentId: z.string().optional(),
  workspaceId: z.string().optional(),
  botId: z.string().optional(),
  itemId: z.string().optional(),
  pluginId: z.string().optional(),
  notificationId: z.string().optional(),
  open: NotificationFeedOpenSchema.optional(),
});

export const NotificationFeedItemSchema = z.object({
  id: z.string(),
  kind: z.string(),
  title: z.string(),
  body: z.string(),
  target: NotificationFeedTargetSchema,
  createdAtMs: z.number(),
  readAtMs: z.number().nullable(),
});

/** Unread items per plugin id, so a device can leave out plugins it muted from its badge. */
const UnreadPluginsSchema = z.record(z.string(), z.number().int());

export const NotificationFeedListRequestSchema = z.object({
  type: z.literal("notifications.feed.list.request"),
  requestId: z.string(),
  /** Id of the oldest item the client has; the page starts right after it. */
  before: z.string().optional(),
  limit: z.number().int().positive().optional(),
});

export const NotificationFeedListResponseSchema = z.object({
  type: z.literal("notifications.feed.list.response"),
  payload: z.object({
    requestId: z.string(),
    items: z.array(NotificationFeedItemSchema),
    unreadCount: z.number().int(),
    unreadPlugins: UnreadPluginsSchema.optional(),
    hasMore: z.boolean(),
  }),
});

export const NotificationFeedMarkReadRequestSchema = z.object({
  type: z.literal("notifications.feed.mark_read.request"),
  requestId: z.string(),
  ids: z.array(z.string()).optional(),
  all: z.boolean().optional(),
});

export const NotificationFeedMarkReadResponseSchema = z.object({
  type: z.literal("notifications.feed.mark_read.response"),
  payload: z.object({
    requestId: z.string(),
    readIds: z.array(z.string()),
    unreadCount: z.number().int(),
  }),
});

/** Pushed to sessions that subscribed to `notifications.feed.changed`. */
export const NotificationFeedChangedMessageSchema = z.object({
  type: z.literal("notifications.feed.changed"),
  payload: z.object({
    appended: z.array(NotificationFeedItemSchema).optional(),
    readIds: z.array(z.string()).optional(),
    /** Items the daemon dropped (retention). */
    removedIds: z.array(z.string()).optional(),
    unreadCount: z.number().int(),
    unreadPlugins: UnreadPluginsSchema.optional(),
  }),
});

export const NotificationFeedRequestSchemas = [
  NotificationFeedListRequestSchema,
  NotificationFeedMarkReadRequestSchema,
] as const;

export const NotificationFeedResponseSchemas = [
  NotificationFeedListResponseSchema,
  NotificationFeedMarkReadResponseSchema,
  NotificationFeedChangedMessageSchema,
] as const;

export type NotificationFeedOpen = z.infer<typeof NotificationFeedOpenSchema>;
export type NotificationFeedTarget = z.infer<typeof NotificationFeedTargetSchema>;
export type NotificationFeedItem = z.infer<typeof NotificationFeedItemSchema>;
export type NotificationFeedListPayload = z.infer<
  typeof NotificationFeedListResponseSchema
>["payload"];
export type NotificationFeedMarkReadPayload = z.infer<
  typeof NotificationFeedMarkReadResponseSchema
>["payload"];
export type NotificationFeedChangedPayload = z.infer<
  typeof NotificationFeedChangedMessageSchema
>["payload"];
