import { z } from "zod";

/**
 * Spec mode (spec 28, ADR-0030): a composer toggle that walks an agent through GitHub Spec
 * Kit's phases, one user-approved phase at a time. The daemon sends a phase command only when
 * the user sends a message or presses Approve/Revise; it never starts a turn on its own.
 */

export const SPEC_MODE_PHASES = [
  "constitution",
  "specify",
  "clarify",
  "plan",
  "checklist",
  "tasks",
  "analyze",
  "implement",
  "converge",
] as const;
export const SpecModePhaseSchema = z.enum(SPEC_MODE_PHASES);
export type SpecModePhase = z.infer<typeof SpecModePhaseSchema>;

export const SPEC_MODE_OPTIONAL_PHASES = ["clarify", "checklist", "analyze"] as const;
export const SpecModeOptionalPhaseSchema = z.enum(SPEC_MODE_OPTIONAL_PHASES);
export type SpecModeOptionalPhase = z.infer<typeof SpecModeOptionalPhaseSchema>;

export const SpecModePhaseStatusSchema = z.enum([
  "pending",
  "running",
  "awaiting_review",
  "done",
  "skipped",
]);
export type SpecModePhaseStatus = z.infer<typeof SpecModePhaseStatusSchema>;

export const SpecModePhaseStatusMapSchema = z.object({
  constitution: SpecModePhaseStatusSchema,
  specify: SpecModePhaseStatusSchema,
  clarify: SpecModePhaseStatusSchema,
  plan: SpecModePhaseStatusSchema,
  checklist: SpecModePhaseStatusSchema,
  tasks: SpecModePhaseStatusSchema,
  analyze: SpecModePhaseStatusSchema,
  implement: SpecModePhaseStatusSchema,
  converge: SpecModePhaseStatusSchema,
});
export type SpecModePhaseStatusMap = z.infer<typeof SpecModePhaseStatusMapSchema>;

export const SpecModeStateSchema = z.object({
  agentId: z.string(),
  enabled: z.boolean(),
  optionalPhases: z.array(SpecModeOptionalPhaseSchema),
  /** Project-relative feature directory (`specs/001-todo-cli`), null before Specify. */
  featureDirectory: z.string().nullable(),
  /** First phase that is not done or skipped; null once the feature converged. */
  phase: SpecModePhaseSchema.nullable(),
  phaseStatus: SpecModePhaseStatusMapSchema,
  /** Converge left tasks.md byte-identical: the feature is finished. */
  converged: z.boolean(),
  /** Project-relative files the phase awaiting review created or changed. */
  reviewFiles: z.array(z.string()),
  /** Another Spec mode agent shares this checkout: feature.json is not written (spec 28.3 step 5). */
  sharedCheckout: z.boolean(),
  updatedAt_ms: z.number().int(),
});
export type SpecModeState = z.infer<typeof SpecModeStateSchema>;

export const SpecModeErrorCodeSchema = z.enum([
  "missing_tools",
  "setup_required",
  "autorun_active",
  "unsupported_client",
  "not_awaiting_review",
  "agent_not_found",
  "agent_busy",
  "setup_conflict",
]);
export type SpecModeErrorCode = z.infer<typeof SpecModeErrorCodeSchema>;

export const SpecModeErrorSchema = z.object({
  code: SpecModeErrorCodeSchema,
  message: z.string(),
});
export type SpecModeError = z.infer<typeof SpecModeErrorSchema>;

export const SpecModeGetRequestSchema = z.object({
  type: z.literal("agent.spec_mode.get.request"),
  agentId: z.string(),
  requestId: z.string(),
});

export const SpecModeSetupPreviewRequestSchema = z.object({
  type: z.literal("agent.spec_mode.setup.preview.request"),
  agentId: z.string(),
  requestId: z.string(),
});

export const SpecModeSetRequestSchema = z.object({
  type: z.literal("agent.spec_mode.set.request"),
  agentId: z.string(),
  enabled: z.boolean(),
  optionalPhases: z.array(SpecModeOptionalPhaseSchema).optional(),
  /** The user pressed Set up on the listed files (spec 28.3 step 4). */
  confirmSetup: z.boolean().optional(),
  requestId: z.string(),
});

export const SpecModeReviewRequestSchema = z.object({
  type: z.literal("agent.spec_mode.review.request"),
  agentId: z.string(),
  decision: z.enum(["approve", "revise"]),
  note: z.string().optional(),
  requestId: z.string(),
});

const SpecModeStatePayloadSchema = z.object({
  requestId: z.string(),
  state: SpecModeStateSchema.nullable(),
  error: SpecModeErrorSchema.nullable(),
});

export const SpecModeGetResponseSchema = z.object({
  type: z.literal("agent.spec_mode.get.response"),
  payload: SpecModeStatePayloadSchema,
});

export const SpecModeSetupPreviewResponseSchema = z.object({
  type: z.literal("agent.spec_mode.setup.preview.response"),
  payload: z.object({
    requestId: z.string(),
    /** Project-relative paths Set up would create; empty when nothing is missing. */
    files: z.array(z.string()),
    /** Host requirements that are not met, as shown to the user ("Requires jq or python3"). */
    missingTools: z.array(z.string()),
    error: SpecModeErrorSchema.nullable(),
  }),
});

export const SpecModeSetResponseSchema = z.object({
  type: z.literal("agent.spec_mode.set.response"),
  payload: SpecModeStatePayloadSchema,
});

export const SpecModeReviewResponseSchema = z.object({
  type: z.literal("agent.spec_mode.review.response"),
  payload: SpecModeStatePayloadSchema,
});

/** Pushed to every client whenever an agent's Spec mode state changes. */
export const SpecModeStateMessageSchema = z.object({
  type: z.literal("agent.spec_mode.state"),
  payload: z.object({ agentId: z.string(), state: SpecModeStateSchema }),
});

export const SpecModeRequestSchemas = [
  SpecModeGetRequestSchema,
  SpecModeSetupPreviewRequestSchema,
  SpecModeSetRequestSchema,
  SpecModeReviewRequestSchema,
] as const;

export const SpecModeResponseSchemas = [
  SpecModeGetResponseSchema,
  SpecModeSetupPreviewResponseSchema,
  SpecModeSetResponseSchema,
  SpecModeReviewResponseSchema,
  SpecModeStateMessageSchema,
] as const;

export type SpecModeGetRequest = z.infer<typeof SpecModeGetRequestSchema>;
export type SpecModeSetupPreviewRequest = z.infer<typeof SpecModeSetupPreviewRequestSchema>;
export type SpecModeSetRequest = z.infer<typeof SpecModeSetRequestSchema>;
export type SpecModeReviewRequest = z.infer<typeof SpecModeReviewRequestSchema>;
export type SpecModeSetupPreview = z.infer<typeof SpecModeSetupPreviewResponseSchema>["payload"];

const PHASE_LABELS: Record<SpecModePhase, string> = {
  constitution: "Constitution",
  specify: "Specify",
  clarify: "Clarify",
  plan: "Plan",
  checklist: "Checklist",
  tasks: "Tasks",
  analyze: "Analyze",
  implement: "Implement",
  converge: "Converge",
};

export function specModePhaseLabel(phase: SpecModePhase): string {
  return PHASE_LABELS[phase];
}

/**
 * The phase a user message in the chat invokes, when it starts with a spec-kit command the
 * daemon sent (`/speckit-plan`, `$speckit-plan`, `/speckit.plan`) or with the header of a
 * rendered command for providers without a command directory. Used for the
 * "Spec mode · Plan" chat label (spec 28.4 step 2).
 */
export function specModePhaseOfMessage(text: string): SpecModePhase | null {
  const match = /^(?:[/$]speckit[-.]|Spec Kit command speckit\.)([a-z]+)\b/.exec(text.trimStart());
  const parsed = SpecModePhaseSchema.safeParse(match?.[1]);
  return parsed.success ? parsed.data : null;
}
