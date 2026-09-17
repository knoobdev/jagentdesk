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

// Live push whenever a topic changes (new message, task created/moved, status change).
export const ForumStreamSchema = z.object({
  type: z.literal("forum.stream"),
  payload: z.object({
    topic: StoredForumTopicSchema,
  }),
});
