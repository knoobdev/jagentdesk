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

/**
 * Prefix of the note the daemon appends to a phase argument when another Spec mode agent works
 * in the same checkout (spec 28.3 step 5). Not something the user wrote, so the chat hides it.
 */
export const SPEC_MODE_SHARED_CHECKOUT_NOTE_PREFIX =
  "Spec mode: another agent works in this checkout.";

export function specModeSharedCheckoutNote(featureDirectory: string): string {
  return `${SPEC_MODE_SHARED_CHECKOUT_NOTE_PREFIX} Use the feature directory \`${featureDirectory}\` (SPECIFY_FEATURE_DIRECTORY is set for you) and do not write .specify/feature.json.`;
}

/** The "## User Input" block every spec-kit command template carries around `$ARGUMENTS`. */
const PROMPT_INPUT_OPEN = "## User Input\n\n```text\n";
const PROMPT_INPUT_CLOSE = "\n```\n\nYou **MUST** consider the user input";

export interface SpecModeMessage {
  phase: SpecModePhase;
  /**
   * Exactly what the user wrote: the request, or the note on Revise. Empty when the daemon sent
   * the phase without an argument (Approve & continue). Null when the command has an unexpected
   * shape and the user's part cannot be told apart from the template.
   */
  userText: string | null;
}

function withoutSharedCheckoutNote(argument: string): string {
  const index = argument.lastIndexOf(SPEC_MODE_SHARED_CHECKOUT_NOTE_PREFIX);
  if (index === 0) return "";
  if (index > 0 && argument.slice(index - 2, index) === "\n\n") return argument.slice(0, index - 2);
  return argument;
}

function promptCommandArgument(body: string): string | null {
  const open = body.indexOf(PROMPT_INPUT_OPEN);
  if (open < 0) return null;
  const start = open + PROMPT_INPUT_OPEN.length;
  const close = body.indexOf(PROMPT_INPUT_CLOSE, start);
  return close < 0 ? null : body.slice(start, close);
}

/**
 * Splits a user message that carries a Spec mode phase command into the phase and the part the
 * user wrote, for the compact chat bubble (spec 28.4 step 2). Two shapes come from the daemon:
 * `/speckit-plan <argument>` (also `$speckit-plan`, `/speckit.plan`) for providers with a
 * command directory, and the whole rendered template under a `Spec Kit command speckit.plan`
 * header for prompt providers, where the argument sits in the "## User Input" text block.
 */
export function parseSpecModeMessage(text: string): SpecModeMessage | null {
  const trimmed = text.trimStart();
  const invocation = /^[/$]speckit[-.]([a-z]+)(?=\s|$)/.exec(trimmed);
  if (invocation) {
    const parsed = SpecModePhaseSchema.safeParse(invocation[1]);
    if (!parsed.success) return null;
    const argument = trimmed.slice(invocation[0].length).trim();
    return { phase: parsed.data, userText: withoutSharedCheckoutNote(argument).trim() };
  }
  const header = /^Spec Kit command speckit\.([a-z]+)\r?\n/.exec(trimmed);
  if (!header) return null;
  const parsed = SpecModePhaseSchema.safeParse(header[1]);
  if (!parsed.success) return null;
  const argument = promptCommandArgument(trimmed.slice(header[0].length).replaceAll("\r\n", "\n"));
  return {
    phase: parsed.data,
    userText: argument === null ? null : withoutSharedCheckoutNote(argument).trim(),
  };
}

/**
 * The bubble line for a phase the daemon sent from Approve & continue (no argument): the message
 * already carries the next phase, so this reads "Approved — continue to Plan".
 */
export function specModeApprovalLine(phase: SpecModePhase): string {
  return `Approved — continue to ${specModePhaseLabel(phase)}`;
}
