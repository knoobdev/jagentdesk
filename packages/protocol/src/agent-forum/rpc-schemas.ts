import { z } from "zod";
import { ForumTopicSummarySchema, StoredForumTopicSchema } from "./types.js";

// RPCs for the Agent Forum / Team mode (docs/plans/active/agent-forum.md). Request shape mirrors the
// schedule feature: `{ type, requestId, ...fields }`; responses are `{ type, payload: { requestId,
// <data>, error } }`. The daemon also pushes `forum.stream` whenever a topic changes.

export const ForumCreateRequestSchema = z.object({
  type: z.literal("forum/create"),
  requestId: z.string(),
  // The user's coding prompt that seeds the topic.
  prompt: z.string().min(1),
  title: z.string().optional(),
  projectKey: z.string().optional(),
  // The chat agent that triggered Team mode; used to bootstrap the orchestration lead from its cwd.
  originAgentId: z.string().optional(),
  // Bootstrap a Supervisor/Lead orchestration run to actually drive the work (default true).
  bootstrapLead: z.boolean().optional(),
});

export const ForumListRequestSchema = z.object({
  type: z.literal("forum/list"),
  requestId: z.string(),
});

export const ForumGetRequestSchema = z.object({
  type: z.literal("forum/get"),
  requestId: z.string(),
  topicId: z.string(),
});

export const ForumArchiveRequestSchema = z.object({
  type: z.literal("forum/archive"),
  requestId: z.string(),
  topicId: z.string(),
});

// Human posts a reply into a thread (e.g. answering an agent's ask_human question).
export const ForumPostRequestSchema = z.object({
  type: z.literal("forum/post"),
  requestId: z.string(),
  topicId: z.string(),
  text: z.string().min(1),
  replyToId: z.string().nullable().optional(),
});

// Human votes a post up/down (or clears their vote).
export const ForumVoteRequestSchema = z.object({
  type: z.literal("forum/vote"),
  requestId: z.string(),
  topicId: z.string(),
  messageId: z.string(),
  direction: z.enum(["up", "down", "clear"]),
});

// Human joins the banter chat: post a casual message (text or a sticker) into a room (default
// #general). For a sticker send kind:"sticker" + stickerId (and text may be empty).
export const ForumChatPostRequestSchema = z.object({
  type: z.literal("forum/chat-post"),
  requestId: z.string(),
  topicId: z.string(),
  text: z.string().max(2000).default(""),
  kind: z.enum(["text", "sticker"]).optional(),
  stickerId: z.string().nullable().optional(),
  roomId: z.string().nullable().optional(),
  replyToId: z.string().nullable().optional(),
});

// Human toggles an emoji reaction on a banter message.
export const ForumChatReactRequestSchema = z.object({
  type: z.literal("forum/chat-react"),
  requestId: z.string(),
  topicId: z.string(),
  messageId: z.string(),
  emoji: z.string().min(1).max(8),
});

// Human opens a new banter room.
export const ForumChatRoomRequestSchema = z.object({
  type: z.literal("forum/chat-room"),
  requestId: z.string(),
  topicId: z.string(),
  name: z.string().min(1).max(60),
  purpose: z.string().max(200).optional(),
});

// Human-only: permanently delete a topic (manage/clean up old forums).
export const ForumDeleteRequestSchema = z.object({
  type: z.literal("forum/delete"),
  requestId: z.string(),
  topicId: z.string(),
});

export const ForumCreateResponseSchema = z.object({
  type: z.literal("forum/create/response"),
  payload: z.object({
    requestId: z.string(),
    topic: StoredForumTopicSchema.nullable(),
    error: z.string().nullable(),
  }),
});

export const ForumListResponseSchema = z.object({
  type: z.literal("forum/list/response"),
  payload: z.object({
    requestId: z.string(),
    topics: z.array(ForumTopicSummarySchema),
    error: z.string().nullable(),
  }),
});

export const ForumGetResponseSchema = z.object({
  type: z.literal("forum/get/response"),
  payload: z.object({
    requestId: z.string(),
    topic: StoredForumTopicSchema.nullable(),
    error: z.string().nullable(),
  }),
});

export const ForumArchiveResponseSchema = z.object({
  type: z.literal("forum/archive/response"),
  payload: z.object({
    requestId: z.string(),
    topic: StoredForumTopicSchema.nullable(),
    error: z.string().nullable(),
  }),
});

export const ForumPostResponseSchema = z.object({
  type: z.literal("forum/post/response"),
  payload: z.object({
    requestId: z.string(),
    topic: StoredForumTopicSchema.nullable(),
    error: z.string().nullable(),
  }),
});

export const ForumVoteResponseSchema = z.object({
  type: z.literal("forum/vote/response"),
  payload: z.object({
    requestId: z.string(),
    topic: StoredForumTopicSchema.nullable(),
    error: z.string().nullable(),
  }),
});

const ForumChatTopicResponse = z.object({
  requestId: z.string(),
  topic: StoredForumTopicSchema.nullable(),
  error: z.string().nullable(),
});

export const ForumChatPostResponseSchema = z.object({
  type: z.literal("forum/chat-post/response"),
  payload: ForumChatTopicResponse,
});

export const ForumChatReactResponseSchema = z.object({
  type: z.literal("forum/chat-react/response"),
  payload: ForumChatTopicResponse,
});

export const ForumChatRoomResponseSchema = z.object({
  type: z.literal("forum/chat-room/response"),
  payload: z.object({
    requestId: z.string(),
    topic: StoredForumTopicSchema.nullable(),
    roomId: z.string().nullable(),
    error: z.string().nullable(),
  }),
});

export const ForumDeleteResponseSchema = z.object({
  type: z.literal("forum/delete/response"),
  payload: z.object({
    requestId: z.string(),
    topicId: z.string(),
    deleted: z.boolean(),
    error: z.string().nullable(),
  }),
});

// Live push whenever a topic changes (new message, task created/moved, status change).
export const ForumStreamSchema = z.object({
  type: z.literal("forum.stream"),
  payload: z.object({
    topic: StoredForumTopicSchema,
  }),
});
