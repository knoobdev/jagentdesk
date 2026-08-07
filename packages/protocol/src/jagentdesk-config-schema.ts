import { z } from "zod";

const TCP_PORT_RANGE_PATTERN = /^(\d{1,5})-(\d{1,5})$/;

export const JAgentDeskServicePortAllocationSchema = z
  .object({
    range: z.string().trim().regex(TCP_PORT_RANGE_PATTERN).optional(),
    portScript: z.string().trim().min(1).optional(),
  })
  .strict()
  .refine((value) => value.range !== undefined || value.portScript !== undefined, "Expected range or portScript")
  .refine((value) => {
    if (!value.range) return true;
    const match = TCP_PORT_RANGE_PATTERN.exec(value.range);
    if (!match) return false;
    const start = Number(match[1]);
    const end = Number(match[2]);
    return start >= 1 && end <= 65_535 && start <= end;
  }, "Expected an inclusive TCP port range from 1-65535");

export function normalizeLifecycleCommands(commands: unknown): string[] {
  if (typeof commands === "string") return commands.trim().length > 0 ? [commands] : [];
  if (!Array.isArray(commands)) return [];
  return commands.filter((command): command is string => typeof command === "string" && command.trim().length > 0);
}

export const JAgentDeskLifecycleCommandRawSchema = z.union([z.string(), z.array(z.string())]);

export const JAgentDeskScriptEntryRawSchema = z
  .object({ type: z.unknown().optional(), command: z.unknown().optional(), port: z.unknown().optional() })
  .passthrough();

export const JAgentDeskWorktreeConfigRawSchema = z
  .object({
    setup: JAgentDeskLifecycleCommandRawSchema.optional(),
    teardown: JAgentDeskLifecycleCommandRawSchema.optional(),
    terminals: z.unknown().optional(),
    servicePorts: JAgentDeskServicePortAllocationSchema.optional(),
  })
  .passthrough();

export const JAgentDeskMetadataGenerationEntrySchema = z.object({ instructions: z.string().optional() }).passthrough().catch({});

export const JAgentDeskMetadataGenerationSchema = z
  .object({
    title: JAgentDeskMetadataGenerationEntrySchema.optional(),
    branchName: JAgentDeskMetadataGenerationEntrySchema.optional(),
    commitMessage: JAgentDeskMetadataGenerationEntrySchema.optional(),
    pullRequest: JAgentDeskMetadataGenerationEntrySchema.optional(),
  })
  .passthrough()
  .catch({});

export const JAgentDeskConfigRawSchema = z
  .object({
    worktree: JAgentDeskWorktreeConfigRawSchema.optional(),
    scripts: z.record(z.string(), JAgentDeskScriptEntryRawSchema).optional(),
    metadataGeneration: JAgentDeskMetadataGenerationSchema.optional(),
  })
  .passthrough();

export const JAgentDeskWorktreeConfigSchema = JAgentDeskWorktreeConfigRawSchema.extend({
  setup: z.unknown().optional().transform(normalizeLifecycleCommands),
  teardown: z.unknown().optional().transform(normalizeLifecycleCommands),
})
  .passthrough()
  .catch({ setup: [], teardown: [] });

export const JAgentDeskScriptEntrySchema = JAgentDeskScriptEntryRawSchema.catch({});

export const JAgentDeskConfigSchema = JAgentDeskConfigRawSchema.extend({
  worktree: JAgentDeskWorktreeConfigSchema.optional(),
  scripts: z.record(z.string(), JAgentDeskScriptEntrySchema).optional().catch({}),
  metadataGeneration: JAgentDeskMetadataGenerationSchema.optional(),
})
  .passthrough()
  .catch({});

export const JAgentDeskConfigRevisionSchema = z.object({ mtimeMs: z.number(), size: z.number() });

export const ProjectConfigRpcErrorSchema = z.discriminatedUnion("code", [
  z.object({ code: z.literal("project_not_found") }),
  z.object({ code: z.literal("invalid_project_config") }),
  z.object({ code: z.literal("stale_project_config"), currentRevision: JAgentDeskConfigRevisionSchema.nullable() }),
  z.object({ code: z.literal("write_failed") }),
]);

export type JAgentDeskScriptEntryRaw = z.infer<typeof JAgentDeskScriptEntryRawSchema>;
export type JAgentDeskMetadataGenerationEntry = z.infer<typeof JAgentDeskMetadataGenerationEntrySchema>;
export type JAgentDeskMetadataGeneration = z.infer<typeof JAgentDeskMetadataGenerationSchema>;
export type JAgentDeskServicePortAllocation = z.infer<typeof JAgentDeskServicePortAllocationSchema>;
export type JAgentDeskConfigRaw = z.infer<typeof JAgentDeskConfigRawSchema>;
export type JAgentDeskConfig = z.infer<typeof JAgentDeskConfigSchema>;
export type JAgentDeskConfigRevision = z.infer<typeof JAgentDeskConfigRevisionSchema>;
export type ProjectConfigRpcError = z.infer<typeof ProjectConfigRpcErrorSchema>;
