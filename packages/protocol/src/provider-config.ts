import { z } from "zod";
import type { AgentProvider } from "./agent-types.js";
import { AgentProviderSchema } from "./provider-manifest.js";

const ProviderCommandDefaultSchema = z.object({
  mode: z.literal("default"),
});

const ProviderCommandAppendSchema = z.object({
  mode: z.literal("append"),
  args: z.array(z.string()).optional(),
});

const ProviderCommandReplaceSchema = z.object({
  mode: z.literal("replace"),
  argv: z.array(z.string().min(1)).min(1),
});

export const ProviderCommandSchema = z.discriminatedUnion("mode", [
  ProviderCommandDefaultSchema,
  ProviderCommandAppendSchema,
  ProviderCommandReplaceSchema,
]);

export const ProviderRuntimeSettingsSchema = z.object({
  command: ProviderCommandSchema.optional(),
  env: z.record(z.string(), z.string()).optional(),
  disallowedTools: z.array(z.string()).optional(),
});

const ProviderProfileThinkingOptionSchema = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string().optional(),
  isDefault: z.boolean().optional(),
});

export const ProviderProfileModelSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string().optional(),
  isDefault: z.boolean().optional(),
  contextWindow: z.number().int().positive().optional(),
  thinkingOptions: z.array(ProviderProfileThinkingOptionSchema).optional(),
});

// Daemon-managed custom API provider block (spec 34.2 / ADR-0047). The `extends`
// value is derived from `protocol` (openai → opencode, anthropic → claude).
export const ProviderApiConfigSchema = z.object({
  protocol: z.enum(["openai", "anthropic"]),
  baseUrl: z.string().min(1),
  via: z.enum(["direct", "tailnet", "ssh"]).optional(),
  /** Required when via is "ssh": the SSH server (spec 25) to tunnel through. */
  sshServerId: z.string().min(1).optional(),
});

export const ProviderOverrideSchema = z.object({
  extends: z.string().optional(),
  label: z.string().optional(),
  description: z.string().optional(),
  command: z.array(z.string().min(1)).min(1).optional(),
  env: z.record(z.string(), z.string()).optional(),
  options: z.record(z.string(), z.unknown()).optional(),
  // COMPAT(providerParams): added in v0.10.0, remove after 2027-03-30 once configs use options.
  params: z.record(z.string(), z.unknown()).optional(),
  models: z.array(ProviderProfileModelSchema).optional(),
  additionalModels: z.array(ProviderProfileModelSchema).optional(),
  disallowedTools: z.array(z.string()).optional(),
  enabled: z.boolean().optional(),
  order: z.number().optional(),
  api: ProviderApiConfigSchema.optional(),
});

const BUILTIN_PROVIDER_IDS = ["claude", "codex", "copilot", "opencode", "pi", "omp"] as const;
const PROVIDER_ID_PATTERN = /^[a-z][a-z0-9-]*$/;

export const ProviderOverridesSchema = z
  .record(z.string(), ProviderOverrideSchema)
  .superRefine((providers, ctx) => {
    const builtinProviderIdSet = new Set<string>(BUILTIN_PROVIDER_IDS);
    const validExtendsValues = new Set<string>([...BUILTIN_PROVIDER_IDS, "acp"]);

    for (const [providerId, provider] of Object.entries(providers)) {
      if (!PROVIDER_ID_PATTERN.test(providerId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [providerId],
          message: `Provider ID "${providerId}" must match ${PROVIDER_ID_PATTERN}.`,
        });
      }

      const isBuiltinProvider = builtinProviderIdSet.has(providerId);
      const isApiProvider = provider.api !== undefined;
      if (!isBuiltinProvider && !provider.extends && !isApiProvider) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [providerId, "extends"],
          message: `Custom provider "${providerId}" must declare extends.`,
        });
      }

      if (!isBuiltinProvider && !provider.label && !isApiProvider) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [providerId, "label"],
          message: `Custom provider "${providerId}" must declare label.`,
        });
      }

      if (isApiProvider && provider.api?.via === "ssh" && !provider.api.sshServerId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [providerId, "api", "sshServerId"],
          message: `API provider "${providerId}" with via "ssh" must declare sshServerId.`,
        });
      }

      if (provider.extends && !validExtendsValues.has(provider.extends)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [providerId, "extends"],
          message: `Provider "${providerId}" extends unknown provider "${provider.extends}".`,
        });
      }

      if (provider.extends === "acp" && !provider.command) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [providerId, "command"],
          message: `Provider "${providerId}" extending "acp" must declare command.`,
        });
      }
    }
  });

export const AgentProviderRuntimeSettingsMapSchema = z
  .record(z.string(), ProviderRuntimeSettingsSchema)
  .superRefine((providers, ctx) => {
    for (const providerId of Object.keys(providers)) {
      const parsedProviderId = AgentProviderSchema.safeParse(providerId);
      if (!parsedProviderId.success) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [providerId],
          message: `Invalid agent provider "${providerId}".`,
        });
      }
    }
  });

export type ProviderCommand = z.infer<typeof ProviderCommandSchema>;
export type ProviderRuntimeSettings = z.infer<typeof ProviderRuntimeSettingsSchema>;
export type ProviderProfileModel = z.infer<typeof ProviderProfileModelSchema>;
export type ProviderOverride = z.infer<typeof ProviderOverrideSchema>;
export type ProviderOverrides = z.infer<typeof ProviderOverridesSchema>;
export type AgentProviderRuntimeSettingsMap = Partial<
  Record<AgentProvider, ProviderRuntimeSettings>
>;
