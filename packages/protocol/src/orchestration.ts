import { z } from "zod";

/** Built-in roles that define the delegation topology. Custom roles are allowed and behave
 * as bounded peer-like workers. */
export const BUILTIN_ORCHESTRATION_ROLES = ["supervisor", "lead", "peer"] as const;
export type BuiltinOrchestrationRole = (typeof BUILTIN_ORCHESTRATION_ROLES)[number];
export const OrchestrationRoleSchema = z.string().min(1);
export type OrchestrationRole = z.infer<typeof OrchestrationRoleSchema>;
export function isBuiltinOrchestrationRole(role: string): role is BuiltinOrchestrationRole {
  return (BUILTIN_ORCHESTRATION_ROLES as readonly string[]).includes(role);
}

/** Semantic work categories used to choose a role profile and fallback chain. */
export const OrchestrationRouteCategorySchema = z.enum([
  "planning",
  "impl",
  "impl_deep",
  "search",
  "research",
  "audit",
  "ui",
]);
export type OrchestrationRouteCategory = z.infer<typeof OrchestrationRouteCategorySchema>;

export const OrchestrationProfileSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1).optional(),
  provider: z.string().min(1),
  model: z.string().min(1),
  thinkingOptionId: z.string().min(1),
  modeId: z.string().min(1).optional(),
  enabled: z.boolean().default(true),
});
export type OrchestrationProfile = z.infer<typeof OrchestrationProfileSchema>;

export const OrchestrationRoleConfigSchema = z.object({
  enabled: z.boolean().default(true),
  label: z.string().min(1).optional(),
  instructions: z.string().optional(),
  profiles: z.array(OrchestrationProfileSchema).min(1),
  defaultProfileId: z.string().min(1),
});
export type OrchestrationRoleConfig = z.infer<typeof OrchestrationRoleConfigSchema>;

export const OrchestrationRouteTargetSchema = z.object({
  role: OrchestrationRoleSchema,
  profileId: z.string().min(1),
  /** Optional per-route override, for example search uses Luna Low. */
  thinkingOptionId: z.string().min(1).optional(),
});
export type OrchestrationRouteTarget = z.infer<typeof OrchestrationRouteTargetSchema>;

export const OrchestrationRouteSchema = z.object({
  primary: OrchestrationRouteTargetSchema,
  fallbacks: z.array(OrchestrationRouteTargetSchema).default([]),
  guardProviderPrefix: z.string().min(1).optional(),
  instructions: z.string().optional(),
});
export type OrchestrationRoute = z.infer<typeof OrchestrationRouteSchema>;

export const OrchestrationConfigSchema = z.object({
  enabled: z.boolean().default(true),
  autoPrepareBrief: z.boolean().default(true),
  askWhenAmbiguous: z.boolean().default(true),
  limits: z
    .object({
      /** Safety bound for one Lead's active bounded Peer fan-out. */
      maxPeersPerLead: z.number().int().min(1).max(12).default(3),
    })
    .default({ maxPeersPerLead: 3 }),
  roles: z
    .object({
      supervisor: OrchestrationRoleConfigSchema,
      lead: OrchestrationRoleConfigSchema,
      peer: OrchestrationRoleConfigSchema,
    })
    .catchall(OrchestrationRoleConfigSchema),
  routes: z.object({
    planning: OrchestrationRouteSchema,
    impl: OrchestrationRouteSchema,
    impl_deep: OrchestrationRouteSchema,
    search: OrchestrationRouteSchema,
    research: OrchestrationRouteSchema,
    audit: OrchestrationRouteSchema,
    ui: OrchestrationRouteSchema,
  }),
});
export type OrchestrationConfig = z.infer<typeof OrchestrationConfigSchema>;

const OrchestrationRoleConfigPatchSchema = z.object({
  enabled: z.boolean().optional(),
  label: z.string().min(1).optional(),
  instructions: z.string().optional(),
  profiles: z.array(OrchestrationProfileSchema).min(1).optional(),
  defaultProfileId: z.string().min(1).optional(),
});

export const OrchestrationConfigPatchSchema = z.object({
  enabled: z.boolean().optional(),
  autoPrepareBrief: z.boolean().optional(),
  askWhenAmbiguous: z.boolean().optional(),
  limits: z.object({ maxPeersPerLead: z.number().int().min(1).max(12).optional() }).optional(),
  roles: z
    .object({
      supervisor: OrchestrationRoleConfigPatchSchema.optional(),
      lead: OrchestrationRoleConfigPatchSchema.optional(),
      peer: OrchestrationRoleConfigPatchSchema.optional(),
    })
    .catchall(OrchestrationRoleConfigPatchSchema)
    .optional(),
  removeRoleIds: z.array(z.string().min(1)).optional(),
  routes: z
    .object({
      planning: OrchestrationRouteSchema.optional(),
      impl: OrchestrationRouteSchema.optional(),
      impl_deep: OrchestrationRouteSchema.optional(),
      search: OrchestrationRouteSchema.optional(),
      research: OrchestrationRouteSchema.optional(),
      audit: OrchestrationRouteSchema.optional(),
      ui: OrchestrationRouteSchema.optional(),
    })
    .optional(),
});
export type OrchestrationConfigPatch = z.infer<typeof OrchestrationConfigPatchSchema>;

function profile(
  id: string,
  label: string,
  provider: string,
  model: string,
  thinkingOptionId: string,
  modeId?: string,
): OrchestrationProfile {
  return {
    id,
    label,
    provider,
    model,
    thinkingOptionId,
    enabled: true,
    ...(modeId ? { modeId } : {}),
  };
}

/**
 * Defaults are executable routing policy, not fake provider data. Every id maps
 * to a provider/model that the provider catalog can verify at runtime.
 */
export function createDefaultOrchestrationConfig(): OrchestrationConfig {
  const supervisorProfiles = [
    profile("supervisor-codex-luna", "Codex Luna Max", "codex", "gpt-5.6-luna", "max"),
    profile("supervisor-codex-sol", "Codex Sol Medium", "codex", "gpt-5.6-sol", "medium"),
  ];
  const leadProfiles = [
    profile("lead-codex-luna", "Codex Luna Max", "codex", "gpt-5.6-luna", "max"),
    profile("lead-codex-sol", "Codex Sol Medium", "codex", "gpt-5.6-sol", "medium"),
  ];
  const peerProfiles = [
    profile(
      "peer-deepseek-flash",
      "DeepSeek V4 Flash",
      "opencode",
      "deepseek-v4-flash[1m]",
      "max",
      "build",
    ),
    profile("peer-codex-luna", "Codex Luna Max", "codex", "gpt-5.6-luna", "max"),
    profile("peer-gemini-ui", "Gemini UI", "gemini-ui", "gemini-3.6-flash-medium", "medium"),
  ];

  return {
    enabled: true,
    autoPrepareBrief: true,
    askWhenAmbiguous: true,
    limits: { maxPeersPerLead: 3 },
    roles: {
      supervisor: {
        enabled: true,
        instructions: DEFAULT_ROLE_INSTRUCTIONS.supervisor,
        profiles: supervisorProfiles,
        defaultProfileId: "supervisor-codex-luna",
      },
      lead: {
        enabled: true,
        instructions: DEFAULT_ROLE_INSTRUCTIONS.lead,
        profiles: leadProfiles,
        defaultProfileId: "lead-codex-luna",
      },
      peer: {
        enabled: true,
        instructions: DEFAULT_ROLE_INSTRUCTIONS.peer,
        profiles: peerProfiles,
        defaultProfileId: "peer-deepseek-flash",
      },
    },
    routes: {
      planning: {
        primary: { role: "lead", profileId: "lead-codex-sol" },
        fallbacks: [],
        instructions: DEFAULT_ROUTE_INSTRUCTIONS.planning,
      },
      impl: {
        primary: { role: "peer", profileId: "peer-deepseek-flash" },
        fallbacks: [{ role: "peer", profileId: "peer-codex-luna" }],
        instructions: DEFAULT_ROUTE_INSTRUCTIONS.impl,
      },
      impl_deep: {
        primary: { role: "peer", profileId: "peer-codex-luna" },
        fallbacks: [],
        instructions: DEFAULT_ROUTE_INSTRUCTIONS.impl_deep,
      },
      search: {
        primary: { role: "peer", profileId: "peer-codex-luna", thinkingOptionId: "low" },
        fallbacks: [{ role: "peer", profileId: "peer-deepseek-flash" }],
        instructions: DEFAULT_ROUTE_INSTRUCTIONS.search,
      },
      research: {
        primary: { role: "peer", profileId: "peer-deepseek-flash" },
        fallbacks: [],
        instructions: DEFAULT_ROUTE_INSTRUCTIONS.research,
      },
      audit: {
        primary: { role: "peer", profileId: "peer-codex-luna" },
        fallbacks: [],
        instructions: DEFAULT_ROUTE_INSTRUCTIONS.audit,
      },
      ui: {
        primary: { role: "peer", profileId: "peer-gemini-ui" },
        fallbacks: [],
        instructions: DEFAULT_ROUTE_INSTRUCTIONS.ui,
      },
    },
  };
}

export const DEFAULT_ROLE_INSTRUCTIONS: Record<BuiltinOrchestrationRole, string> = {
  supervisor: [
    "You are the Supervisor: the human-facing front door and relay for this workspace.",
    "- Preserve the human objective faithfully; do not invent product decisions.",
    "- Bootstrap exactly one Lead per workspace and observe governance/lifecycle only.",
    "- Do not split tasks, pick Peers, choose architecture, or accept engineering results.",
  ].join("\n"),
  lead: [
    "You are the Lead: the single engineering owner for this workspace and orchestration run.",
    "- Decompose the work and choose the engineering approach.",
    "- Use orchestration.create_peer for bounded implementation/search/research/review assignments.",
    "- Every Peer assignment must state ownership, expected evidence, and handback fields.",
    "- Review Peer evidence and counterevidence; close dissent with exactly one allowed outcome.",
    "- Use orchestration.accept_result only after validation and technical acceptance.",
    "- Do not create a second Lead, bypass the Supervisor, or make product decisions outside the relay.",
  ].join("\n"),
  peer: [
    "You are a bounded Peer worker acting on a single assignment from the Lead.",
    "- Do not create agents, choose product architecture, or accept the whole engineering result.",
    "- Return a structured handback: What changed/inspected; Evidence; Remaining uncertainty; Counterevidence; Requested resolution.",
    "- If direction is unsafe or authority is unclear, stop before an irreversible choice and use orchestration.handback.",
  ].join("\n"),
};

export const DEFAULT_ROUTE_INSTRUCTIONS: Record<OrchestrationRouteCategory, string> = {
  planning:
    "Plan the approach and decomposition before implementation; surface risks and open questions.",
  impl: "Implement the assignment with tests/validation and return concrete evidence.",
  impl_deep: "Deep, careful implementation for high-risk or intricate work; validate thoroughly.",
  search:
    "Locate the relevant code/information quickly and return precise findings with references.",
  research: "Research the question and return evidence plus counterevidence, not just conclusions.",
  audit: "Audit/review for correctness, security, and completeness; report defects with repro.",
  ui: "Build the interface per the design system; verify it renders correctly.",
};

export function defaultRoleInstructions(role: string): string {
  return isBuiltinOrchestrationRole(role) ? DEFAULT_ROLE_INSTRUCTIONS[role] : "";
}

export function defaultRouteInstructions(category: OrchestrationRouteCategory): string {
  return DEFAULT_ROUTE_INSTRUCTIONS[category] ?? "";
}

export const OrchestrationTaskStatusSchema = z.enum(["ready", "needs_clarification"]);
export type OrchestrationTaskStatus = z.infer<typeof OrchestrationTaskStatusSchema>;

export const OrchestrationTaskBriefSchema = z.object({
  id: z.string().min(1),
  rawRequest: z.string(),
  objective: z.string().min(1),
  context: z.string().optional(),
  constraints: z.array(z.string()),
  acceptedDecisions: z.array(z.string()),
  requestedOutcome: z.string().min(1),
  acceptanceCriteria: z.array(z.string()).min(1),
  validationPlan: z.array(z.string()).min(1),
  openQuestions: z.array(z.string()),
  routeCategory: OrchestrationRouteCategorySchema,
  selectedRoute: OrchestrationRouteTargetSchema,
  normalizedPrompt: z.string().min(1),
  status: OrchestrationTaskStatusSchema,
  createdAtMs: z.number().int().nonnegative(),
});
export type OrchestrationTaskBrief = z.infer<typeof OrchestrationTaskBriefSchema>;

export const OrchestrationConfigGetRequestSchema = z.object({
  type: z.literal("orchestration.config.get.request"),
  requestId: z.string(),
});

export const OrchestrationConfigGetResponseSchema = z.object({
  type: z.literal("orchestration.config.get.response"),
  payload: z.object({ requestId: z.string(), config: OrchestrationConfigSchema }),
});

export const OrchestrationConfigUpdateRequestSchema = z.object({
  type: z.literal("orchestration.config.update.request"),
  requestId: z.string(),
  config: OrchestrationConfigPatchSchema,
});

export const OrchestrationConfigUpdateResponseSchema = z.object({
  type: z.literal("orchestration.config.update.response"),
  payload: z.object({ requestId: z.string(), config: OrchestrationConfigSchema }),
});

export const OrchestrationTaskPrepareRequestSchema = z.object({
  type: z.literal("orchestration.task.prepare.request"),
  requestId: z.string(),
  rawRequest: z.string(),
  workspaceId: z.string().optional(),
  cwd: z.string().optional(),
  routeCategory: OrchestrationRouteCategorySchema.optional(),
});

export const OrchestrationTaskPrepareResponseSchema = z.object({
  type: z.literal("orchestration.task.prepare.response"),
  payload: z.object({ requestId: z.string(), brief: OrchestrationTaskBriefSchema }),
});

export const OrchestrationDissentOutcomeSchema = z.enum([
  "RESOLVED_BY_LEAD",
  "NEEDS_MORE_EVIDENCE",
  "ESCALATED_TO_HUMAN",
]);
export type OrchestrationDissentOutcome = z.infer<typeof OrchestrationDissentOutcomeSchema>;

export const OrchestrationHandbackSchema = z.object({
  whatChangedOrInspected: z.string().trim().min(1).max(12000),
  evidence: z.string().trim().min(1).max(12000),
  remainingUncertainty: z.string().trim().min(1).max(12000),
  counterevidence: z.string().trim().min(1).max(12000),
  requestedResolution: z.string().trim().max(12000).optional(),
  currentDirection: z.string().trim().max(12000).optional(),
  claim: z.string().trim().max(12000).optional(),
  risk: z.string().trim().max(12000).optional(),
});
export type OrchestrationHandback = z.infer<typeof OrchestrationHandbackSchema>;

export const OrchestrationRoleLabelSchema = z.string().min(1);
export const ORCHESTRATION_ROLE_LABEL = "jagentdesk.orchestration.role";
export const ORCHESTRATION_WORKSPACE_LABEL = "jagentdesk.orchestration.workspace-id";
export const ORCHESTRATION_BRIEF_LABEL = "jagentdesk.orchestration.brief-id";
export const ORCHESTRATION_ROUTE_LABEL = "jagentdesk.orchestration.route";
export const ORCHESTRATION_PROFILE_LABEL = "jagentdesk.orchestration.profile-id";

export type OrchestrationConfigGetRequest = z.infer<typeof OrchestrationConfigGetRequestSchema>;
export type OrchestrationConfigUpdateRequest = z.infer<
  typeof OrchestrationConfigUpdateRequestSchema
>;
export type OrchestrationTaskPrepareRequest = z.infer<typeof OrchestrationTaskPrepareRequestSchema>;
