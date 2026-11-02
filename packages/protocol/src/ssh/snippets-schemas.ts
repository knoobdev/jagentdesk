import { z } from "zod";

// Wire schemas for SSH milestone S5 (spec 25.4, 25.7): snippet library, multi-server
// snippet runs, per-server command history, workspace templates and per-server/group
// terminal appearance. Same envelope as ssh/rpc-schemas.ts: requests carry `type` +
// `requestId`; responses are `{ type, payload: { requestId, error, ...data } }`.

function req<T extends string, S extends z.ZodRawShape>(type: T, extra: S) {
  return z.object({ type: z.literal(type), requestId: z.string(), ...extra });
}
function resp<T extends string, S extends z.ZodRawShape>(type: T, extra: S) {
  return z.object({
    type: z.literal(type),
    payload: z.object({ requestId: z.string(), error: z.string().nullable(), ...extra }),
  });
}

// ── snippet library ──

export const SshSnippetPackageSchema = z.object({
  id: z.string(), // `spk_…`
  label: z.string(),
});
export type SshSnippetPackage = z.infer<typeof SshSnippetPackageSchema>;

// Spec 25.7: a snippet is a labelled script with no variables (Termius parity).
export const SshSnippetSchema = z.object({
  id: z.string(), // `snp_…`
  label: z.string(),
  script: z.string(),
  packageId: z.string().optional(),
  defaultTargets: z.array(z.string()), // server ids saved with "Save targets"
  createdAtMs: z.number(),
  updatedAtMs: z.number(),
});
export type SshSnippet = z.infer<typeof SshSnippetSchema>;

// Create when `id` is absent; the daemon assigns the id and timestamps.
export const SshSnippetInputSchema = z.object({
  id: z.string().optional(),
  label: z.string(),
  script: z.string(),
  packageId: z.string().optional(),
  defaultTargets: z.array(z.string()),
});
export type SshSnippetInput = z.infer<typeof SshSnippetInputSchema>;

export const SshSnippetPackageInputSchema = z.object({
  id: z.string().optional(),
  label: z.string(),
});
export type SshSnippetPackageInput = z.infer<typeof SshSnippetPackageInputSchema>;

export const SshSnippetsListRequestSchema = req("ssh.snippets.list.request", {});
export const SshSnippetsListResponseSchema = resp("ssh.snippets.list.response", {
  packages: z.array(SshSnippetPackageSchema),
  snippets: z.array(SshSnippetSchema),
});
export const SshSnippetsSaveRequestSchema = req("ssh.snippets.save.request", {
  snippet: SshSnippetInputSchema,
});
export const SshSnippetsSaveResponseSchema = resp("ssh.snippets.save.response", {
  snippet: SshSnippetSchema.nullable(),
});
export const SshSnippetsDeleteRequestSchema = req("ssh.snippets.delete.request", {
  id: z.string(),
});
export const SshSnippetsDeleteResponseSchema = resp("ssh.snippets.delete.response", {});
export const SshSnippetsSavePackageRequestSchema = req("ssh.snippets.save_package.request", {
  package: SshSnippetPackageInputSchema,
});
export const SshSnippetsSavePackageResponseSchema = resp("ssh.snippets.save_package.response", {
  package: SshSnippetPackageSchema.nullable(),
});
// Deleting a package keeps its snippets; they move out of the package.
export const SshSnippetsDeletePackageRequestSchema = req("ssh.snippets.delete_package.request", {
  id: z.string(),
});
export const SshSnippetsDeletePackageResponseSchema = resp(
  "ssh.snippets.delete_package.response",
  {},
);

// ── multi-server run (spec 25.7) ──
// Each target runs the script on its own `exec` channel; output streams per server
// through ssh.snippet.output and state changes through ssh.snippet.state, to every
// subscribed client.

export const SshSnippetRunSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("snippet"), snippetId: z.string() }),
  z.object({ kind: z.literal("script"), script: z.string() }),
]);
export type SshSnippetRunSource = z.infer<typeof SshSnippetRunSourceSchema>;

export const SshSnippetTargetStateSchema = z.enum([
  "connecting",
  "running",
  "exited",
  "failed",
  "cancelled",
]);
export type SshSnippetTargetState = z.infer<typeof SshSnippetTargetStateSchema>;

export const SshSnippetOutputStreamSchema = z.enum(["stdout", "stderr"]);
export type SshSnippetOutputStream = z.infer<typeof SshSnippetOutputStreamSchema>;

export const SshSnippetOutputChunkSchema = z.object({
  stream: SshSnippetOutputStreamSchema,
  text: z.string(),
});
export type SshSnippetOutputChunk = z.infer<typeof SshSnippetOutputChunkSchema>;

export const SshSnippetRunErrorSchema = z.object({
  code: z.string(), // e.g. `connect_failed`, `exec_failed`, `timeout`
  message: z.string(),
});
export type SshSnippetRunError = z.infer<typeof SshSnippetRunErrorSchema>;

export const SshSnippetTargetStatusSchema = z.object({
  serverId: z.string(),
  state: SshSnippetTargetStateSchema,
  exitCode: z.number().int().nullable(),
  signal: z.string().nullable(),
  error: SshSnippetRunErrorSchema.nullable(),
  startedAtMs: z.number(),
  finishedAtMs: z.number().nullable(),
  // True once the per-server output cap (1 MiB) dropped later output.
  truncated: z.boolean(),
});
export type SshSnippetTargetStatus = z.infer<typeof SshSnippetTargetStatusSchema>;

export const SshSnippetRunTargetSchema = SshSnippetTargetStatusSchema.extend({
  output: z.array(SshSnippetOutputChunkSchema),
});
export type SshSnippetRunTarget = z.infer<typeof SshSnippetRunTargetSchema>;

export const SshSnippetRunSchema = z.object({
  runId: z.string(), // `run_…`
  snippetId: z.string().nullable(),
  label: z.string(),
  script: z.string(),
  startedAtMs: z.number(),
  finishedAtMs: z.number().nullable(),
  targets: z.array(SshSnippetRunTargetSchema),
});
export type SshSnippetRun = z.infer<typeof SshSnippetRunSchema>;

export const SshSnippetRunSummarySchema = SshSnippetRunSchema.omit({ targets: true }).extend({
  targets: z.array(SshSnippetTargetStatusSchema),
});
export type SshSnippetRunSummary = z.infer<typeof SshSnippetRunSummarySchema>;

export const SshSnippetRunRequestSchema = req("ssh.snippet.run.request", {
  source: SshSnippetRunSourceSchema,
  serverIds: z.array(z.string()).min(1),
  timeoutMs: z.number().int().positive().optional(),
});
export const SshSnippetRunResponseSchema = resp("ssh.snippet.run.response", {
  run: SshSnippetRunSchema.nullable(),
});
export const SshSnippetCancelRequestSchema = req("ssh.snippet.cancel.request", {
  runId: z.string(),
  serverId: z.string().optional(), // absent → cancel every target still running
});
export const SshSnippetCancelResponseSchema = resp("ssh.snippet.cancel.response", {});
export const SshSnippetGetRunRequestSchema = req("ssh.snippet.get_run.request", {
  runId: z.string(),
});
export const SshSnippetGetRunResponseSchema = resp("ssh.snippet.get_run.response", {
  run: SshSnippetRunSchema.nullable(),
});
export const SshSnippetListRunsRequestSchema = req("ssh.snippet.list_runs.request", {});
export const SshSnippetListRunsResponseSchema = resp("ssh.snippet.list_runs.response", {
  runs: z.array(SshSnippetRunSummarySchema),
});

export const SshSnippetOutputEventSchema = z.object({
  type: z.literal("ssh.snippet.output"),
  runId: z.string(),
  serverId: z.string(),
  stream: SshSnippetOutputStreamSchema,
  text: z.string(),
});
export type SshSnippetOutputEvent = z.infer<typeof SshSnippetOutputEventSchema>;

export const SshSnippetStateEventSchema = z.object({
  type: z.literal("ssh.snippet.state"),
  runId: z.string(),
  target: SshSnippetTargetStatusSchema,
});
export type SshSnippetStateEvent = z.infer<typeof SshSnippetStateEventSchema>;

// ── command history (spec 25.7) ──
// Commands sent from a terminal's input or a snippet, per server. The daemon never
// reads the server's own shell history file.

export const SshCommandSourceSchema = z.enum(["input", "snippet"]);
export type SshCommandSource = z.infer<typeof SshCommandSourceSchema>;

export const SshCommandHistoryEntrySchema = z.object({
  command: z.string(),
  source: SshCommandSourceSchema,
  atMs: z.number(),
});
export type SshCommandHistoryEntry = z.infer<typeof SshCommandHistoryEntrySchema>;

export const SshHistoryListRequestSchema = req("ssh.history.list.request", {
  serverId: z.string(),
});
export const SshHistoryListResponseSchema = resp("ssh.history.list.response", {
  entries: z.array(SshCommandHistoryEntrySchema), // newest first
});
export const SshHistoryClearRequestSchema = req("ssh.history.clear.request", {
  serverId: z.string(),
});
export const SshHistoryClearResponseSchema = resp("ssh.history.clear.response", {});

// ── workspace templates (spec 25.4) ──
// The split tree is stored flat (no recursive schema): `rootId` names a node; a split
// node lists child ids with matching `sizes` (fractions summing to 1).

export const SshPaneTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("server"), serverId: z.string() }),
  z.object({ kind: z.literal("local") }),
]);
export type SshPaneTarget = z.infer<typeof SshPaneTargetSchema>;

export const SshSplitDirectionSchema = z.enum(["row", "column"]);
export type SshSplitDirection = z.infer<typeof SshSplitDirectionSchema>;

export const SshLayoutNodeSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("split"),
    id: z.string(),
    direction: SshSplitDirectionSchema,
    children: z.array(z.string()).min(2),
    sizes: z.array(z.number().positive()).min(2),
  }),
  z.object({
    kind: z.literal("pane"),
    id: z.string(),
    target: SshPaneTargetSchema,
    tabTitle: z.string().optional(),
  }),
]);
export type SshLayoutNode = z.infer<typeof SshLayoutNodeSchema>;

export const SSH_WORKSPACE_MAX_PANES = 16;

export const SshWorkspaceLayoutSchema = z.object({
  rootId: z.string(),
  nodes: z.array(SshLayoutNodeSchema).min(1),
});
export type SshWorkspaceLayout = z.infer<typeof SshWorkspaceLayoutSchema>;

export const SshWorkspaceTemplateSchema = z.object({
  id: z.string(), // `wst_…`
  label: z.string(),
  layout: SshWorkspaceLayoutSchema,
  createdAtMs: z.number(),
  updatedAtMs: z.number(),
});
export type SshWorkspaceTemplate = z.infer<typeof SshWorkspaceTemplateSchema>;

export const SshWorkspaceTemplateInputSchema = z.object({
  id: z.string().optional(),
  label: z.string(),
  layout: SshWorkspaceLayoutSchema,
});
export type SshWorkspaceTemplateInput = z.infer<typeof SshWorkspaceTemplateInputSchema>;

export const SshWorkspacesListRequestSchema = req("ssh.workspaces.list.request", {});
export const SshWorkspacesListResponseSchema = resp("ssh.workspaces.list.response", {
  templates: z.array(SshWorkspaceTemplateSchema),
});
export const SshWorkspacesSaveRequestSchema = req("ssh.workspaces.save.request", {
  template: SshWorkspaceTemplateInputSchema,
});
export const SshWorkspacesSaveResponseSchema = resp("ssh.workspaces.save.response", {
  template: SshWorkspaceTemplateSchema.nullable(),
});
export const SshWorkspacesDeleteRequestSchema = req("ssh.workspaces.delete.request", {
  id: z.string(),
});
export const SshWorkspacesDeleteResponseSchema = resp("ssh.workspaces.delete.response", {});

// ── terminal appearance (spec 25.2 `theme?`, `fontSize?`; 25.4) ──
// Fields the owner adds to SshServerSchema and SshGroupSchema. `theme` is an app theme
// name (its terminal palette is used); the effective value inherits up the group chain.

export const SSH_TERMINAL_FONT_SIZE_MIN = 8;
export const SSH_TERMINAL_FONT_SIZE_MAX = 32;

export const SshTerminalAppearanceShape = {
  theme: z.string().optional(),
  fontSize: z
    .number()
    .int()
    .min(SSH_TERMINAL_FONT_SIZE_MIN)
    .max(SSH_TERMINAL_FONT_SIZE_MAX)
    .optional(),
};
export const SshTerminalAppearanceSchema = z.object(SshTerminalAppearanceShape);
export type SshTerminalAppearance = z.infer<typeof SshTerminalAppearanceSchema>;

export const SnippetsInboundSchemas = [
  SshSnippetsListRequestSchema,
  SshSnippetsSaveRequestSchema,
  SshSnippetsDeleteRequestSchema,
  SshSnippetsSavePackageRequestSchema,
  SshSnippetsDeletePackageRequestSchema,
  SshSnippetRunRequestSchema,
  SshSnippetCancelRequestSchema,
  SshSnippetGetRunRequestSchema,
  SshSnippetListRunsRequestSchema,
  SshHistoryListRequestSchema,
  SshHistoryClearRequestSchema,
  SshWorkspacesListRequestSchema,
  SshWorkspacesSaveRequestSchema,
  SshWorkspacesDeleteRequestSchema,
] as const;

export const SnippetsOutboundSchemas = [
  SshSnippetsListResponseSchema,
  SshSnippetsSaveResponseSchema,
  SshSnippetsDeleteResponseSchema,
  SshSnippetsSavePackageResponseSchema,
  SshSnippetsDeletePackageResponseSchema,
  SshSnippetRunResponseSchema,
  SshSnippetCancelResponseSchema,
  SshSnippetGetRunResponseSchema,
  SshSnippetListRunsResponseSchema,
  SshHistoryListResponseSchema,
  SshHistoryClearResponseSchema,
  SshWorkspacesListResponseSchema,
  SshWorkspacesSaveResponseSchema,
  SshWorkspacesDeleteResponseSchema,
  SshSnippetOutputEventSchema,
  SshSnippetStateEventSchema,
] as const;

export const SnippetsInboundMessageSchema = z.discriminatedUnion("type", [
  ...SnippetsInboundSchemas,
]);
export type SnippetsInboundMessage = z.infer<typeof SnippetsInboundMessageSchema>;

export const SnippetsOutboundMessageSchema = z.discriminatedUnion("type", [
  ...SnippetsOutboundSchemas,
]);
export type SnippetsOutboundMessage = z.infer<typeof SnippetsOutboundMessageSchema>;
