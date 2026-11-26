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

export const MemoryKindSchema = z.enum(["memory", "lesson"]);
export const MemoryStatusSchema = z.enum(["active", "pending", "stale", "deprecated", "graduated"]);

/** Where a lesson came from (spec 42 §4): a file, optionally a symbol and an exact excerpt. */
export const MemoryCitationSchema = z.object({
  path: z.string(),
  symbol: z.string().optional(),
  excerpt: z.string().optional(),
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
  // COMPAT(durableContext): spec 42 fields, added in v0.10.2; older daemons omit them.
  kind: MemoryKindSchema.optional(),
  status: MemoryStatusSchema.optional(),
  citations: z.array(MemoryCitationSchema).optional(),
  helpful: z.number().int().optional(),
  harmful: z.number().int().optional(),
  /** Why the entry is stale or deprecated ("Cited file not found: …", "Not used for 28 days"). */
  statusReason: z.string().nullable().optional(),
  lastValidatedAtMs: z.number().nullable().optional(),
  /** Distinct agents the entry was injected into or found by. */
  agentCount: z.number().int().optional(),
  /** The rules file a graduated lesson was written to. */
  graduatedPath: z.string().nullable().optional(),
  /** True when the lesson meets the "Make this a project rule" bar. */
  graduationReady: z.boolean().optional(),
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
  // COMPAT(durableContext): spec 42 §8 switches, added in v0.10.2.
  regroundAfterCompaction: z.boolean().optional(),
  recitation: z.boolean().optional(),
  ledgerNudge: z.boolean().optional(),
  learnFromCorrections: z.boolean().optional(),
  lessonExpiry: z.boolean().optional(),
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
  kind: MemoryKindSchema.optional(),
  status: MemoryStatusSchema.optional(),
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
  kind: MemoryKindSchema.optional(),
  citations: z.array(MemoryCitationSchema).optional(),
  /** "active" approves a pending lesson or restores a stale/deprecated entry. */
  status: MemoryStatusSchema.optional(),
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
  regroundAfterCompaction: z.boolean().optional(),
  recitation: z.boolean().optional(),
  ledgerNudge: z.boolean().optional(),
  learnFromCorrections: z.boolean().optional(),
  lessonExpiry: z.boolean().optional(),
});
export const MemorySettingsSetResponseSchema = z.object({
  type: z.literal("memory.settings.set.response"),
  payload: z.object({ requestId: z.string(), settings: MemorySettingsSchema }),
});

/** 👍/👎 on the "Used N memories" chip (spec 42 §4). */
export const MemoryRateRequestSchema = z.object({
  type: z.literal("memory.rate.request"),
  requestId: z.string(),
  id: z.string(),
  helpful: z.boolean(),
  agentId: z.string().optional(),
});
export const MemoryRateResponseSchema = z.object({
  type: z.literal("memory.rate.response"),
  payload: z.object({ requestId: z.string(), memory: MemoryRecordSchema }),
});

/** "Validate now": checks the citations of one lesson, or of every lesson in a project. */
export const MemoryValidateRequestSchema = z.object({
  type: z.literal("memory.validate.request"),
  requestId: z.string(),
  id: z.string().optional(),
  projectId: z.string().optional(),
});
export const MemoryValidateResponseSchema = z.object({
  type: z.literal("memory.validate.response"),
  payload: z.object({ requestId: z.string(), memories: z.array(MemoryRecordSchema) }),
});

/** "Make this a project rule" (spec 42 §5): the diff to AGENTS.md / CLAUDE.md, not yet written. */
export const MemoryGraduationPreviewRequestSchema = z.object({
  type: z.literal("memory.graduation.preview.request"),
  requestId: z.string(),
  id: z.string(),
});
export const MemoryGraduationPreviewResponseSchema = z.object({
  type: z.literal("memory.graduation.preview.response"),
  payload: z.object({
    requestId: z.string(),
    id: z.string(),
    path: z.string(),
    relativePath: z.string(),
    created: z.boolean(),
    diff: z.string(),
    /** Hash of the file as previewed; apply refuses when the file changed since. */
    baseHash: z.string(),
  }),
});
export const MemoryGraduationApplyRequestSchema = z.object({
  type: z.literal("memory.graduation.apply.request"),
  requestId: z.string(),
  id: z.string(),
  baseHash: z.string(),
});
export const MemoryGraduationApplyResponseSchema = z.object({
  type: z.literal("memory.graduation.apply.response"),
  payload: z.object({ requestId: z.string(), memory: MemoryRecordSchema, path: z.string() }),
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
export type MemoryCitationWire = z.infer<typeof MemoryCitationSchema>;
export type MemoryKindWire = z.infer<typeof MemoryKindSchema>;
export type MemoryStatusWire = z.infer<typeof MemoryStatusSchema>;
export type MemoryGraduationPreview = z.infer<
  typeof MemoryGraduationPreviewResponseSchema
>["payload"];

export const MemoryRequestSchemas = [
  MemoryListRequestSchema,
  MemorySaveRequestSchema,
  MemoryDeleteRequestSchema,
  MemoryAgentRequestSchema,
  MemorySettingsGetRequestSchema,
  MemorySettingsSetRequestSchema,
  MemoryRateRequestSchema,
  MemoryValidateRequestSchema,
  MemoryGraduationPreviewRequestSchema,
  MemoryGraduationApplyRequestSchema,
] as const;

export const MemoryResponseSchemas = [
  MemoryListResponseSchema,
  MemorySaveResponseSchema,
  MemoryDeleteResponseSchema,
  MemoryAgentResponseSchema,
  MemorySettingsGetResponseSchema,
  MemorySettingsSetResponseSchema,
  MemoryRateResponseSchema,
  MemoryValidateResponseSchema,
  MemoryGraduationPreviewResponseSchema,
  MemoryGraduationApplyResponseSchema,
  MemoryChangedMessageSchema,
] as const;
