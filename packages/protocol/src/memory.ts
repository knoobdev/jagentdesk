import { z } from "zod";

// Memory built-in (spec 41, ADR-0058). Requests use the `memory.` namespace; failures answer with
// `rpc_error` carrying a code (`secret`, `too_long`, `empty`, `not_found`, `no_project`,
// `plugin_disabled`).

export const MemoryScopeSchema = z.enum(["project", "global"]);

export const MemorySourceSchema = z.object({
  agentId: z.string().optional(),
  provider: z.string().optional(),
  timelineSeq: z.number().int().optional(),
  by: z.enum(["agent", "user"]),
});

export const MemoryRecordSchema = z.object({
  id: z.string(),
  scope: MemoryScopeSchema,
  projectId: z.string().nullable(),
  text: z.string(),
  tags: z.array(z.string()),
  pinned: z.boolean(),
  source: MemorySourceSchema,
  createdAtMs: z.number(),
  updatedAtMs: z.number(),
  lastUsedAtMs: z.number().nullable(),
  useCount: z.number().int(),
});

export const MemoryUseSchema = z.object({
  memory: MemoryRecordSchema,
  turnKey: z.string(),
  kind: z.enum(["injected", "searched"]),
  score: z.number().nullable(),
  usedAtMs: z.number(),
});

export const MemoryProjectSchema = z.object({
  projectId: z.string(),
  name: z.string(),
  rootPath: z.string(),
});

export const MemorySettingsSchema = z.object({
  enabled: z.boolean(),
  autoInject: z.boolean(),
  tokenCap: z.number().int(),
});

export const MemoryListRequestSchema = z.object({
  type: z.literal("memory.list.request"),
  requestId: z.string(),
  scope: MemoryScopeSchema,
  /** Required for scope "project"; the agent's project when only `agentId` is known. */
  projectId: z.string().optional(),
  agentId: z.string().optional(),
  query: z.string().optional(),
  tag: z.string().optional(),
});
export const MemoryListResponseSchema = z.object({
  type: z.literal("memory.list.response"),
  payload: z.object({
    requestId: z.string(),
    memories: z.array(MemoryRecordSchema),
    projects: z.array(MemoryProjectSchema),
    /** The project the request resolved to (from `projectId` or `agentId`). */
    projectId: z.string().nullable(),
  }),
});

export const MemorySaveRequestSchema = z.object({
  type: z.literal("memory.save.request"),
  requestId: z.string(),
  /** Absent: create. Present: update that memory. */
  id: z.string().optional(),
  scope: MemoryScopeSchema.optional(),
  projectId: z.string().optional(),
  /** The agent a "Remember this" came from; resolves the project when `projectId` is absent. */
  agentId: z.string().optional(),
  timelineSeq: z.number().int().optional(),
  text: z.string().optional(),
  tags: z.array(z.string()).optional(),
  pinned: z.boolean().optional(),
});
export const MemorySaveResponseSchema = z.object({
  type: z.literal("memory.save.response"),
  payload: z.object({
    requestId: z.string(),
    memory: MemoryRecordSchema,
    deduplicated: z.boolean(),
  }),
});

export const MemoryDeleteRequestSchema = z.object({
  type: z.literal("memory.delete.request"),
  requestId: z.string(),
  id: z.string(),
});
export const MemoryDeleteResponseSchema = z.object({
  type: z.literal("memory.delete.response"),
  payload: z.object({ requestId: z.string(), id: z.string(), deleted: z.boolean() }),
});

export const MemoryAgentRequestSchema = z.object({
  type: z.literal("memory.agent.request"),
  requestId: z.string(),
  agentId: z.string(),
});
export const MemoryAgentResponseSchema = z.object({
  type: z.literal("memory.agent.response"),
  payload: z.object({
    requestId: z.string(),
    agentId: z.string(),
    /** Memories this agent wrote. */
    created: z.array(MemoryRecordSchema),
    /** Memories injected into or found by this agent's turns, newest first. */
    used: z.array(MemoryUseSchema),
  }),
});

export const MemorySettingsGetRequestSchema = z.object({
  type: z.literal("memory.settings.get.request"),
  requestId: z.string(),
});
export const MemorySettingsGetResponseSchema = z.object({
  type: z.literal("memory.settings.get.response"),
  payload: z.object({ requestId: z.string(), settings: MemorySettingsSchema }),
});
export const MemorySettingsSetRequestSchema = z.object({
  type: z.literal("memory.settings.set.request"),
  requestId: z.string(),
  enabled: z.boolean().optional(),
  autoInject: z.boolean().optional(),
  tokenCap: z.number().int().optional(),
});
export const MemorySettingsSetResponseSchema = z.object({
  type: z.literal("memory.settings.set.response"),
  payload: z.object({ requestId: z.string(), settings: MemorySettingsSchema }),
});

/** Pushed to every session after any memory or memory setting changes. */
export const MemoryChangedMessageSchema = z.object({
  type: z.literal("memory.changed"),
  payload: z.object({
    memoryId: z.string().nullable(),
    scope: MemoryScopeSchema.nullable(),
    projectId: z.string().nullable(),
  }),
});

export type MemoryRecordWire = z.infer<typeof MemoryRecordSchema>;
export type MemoryUseWire = z.infer<typeof MemoryUseSchema>;
export type MemoryProject = z.infer<typeof MemoryProjectSchema>;
export type MemorySettingsWire = z.infer<typeof MemorySettingsSchema>;
export type MemoryListRequest = z.infer<typeof MemoryListRequestSchema>;
export type MemorySaveRequest = z.infer<typeof MemorySaveRequestSchema>;
export type MemoryDeleteRequest = z.infer<typeof MemoryDeleteRequestSchema>;
export type MemoryAgentRequest = z.infer<typeof MemoryAgentRequestSchema>;
export type MemorySettingsSetRequest = z.infer<typeof MemorySettingsSetRequestSchema>;

export const MemoryRequestSchemas = [
  MemoryListRequestSchema,
  MemorySaveRequestSchema,
  MemoryDeleteRequestSchema,
  MemoryAgentRequestSchema,
  MemorySettingsGetRequestSchema,
  MemorySettingsSetRequestSchema,
] as const;

export const MemoryResponseSchemas = [
  MemoryListResponseSchema,
  MemorySaveResponseSchema,
  MemoryDeleteResponseSchema,
  MemoryAgentResponseSchema,
  MemorySettingsGetResponseSchema,
  MemorySettingsSetResponseSchema,
  MemoryChangedMessageSchema,
] as const;
