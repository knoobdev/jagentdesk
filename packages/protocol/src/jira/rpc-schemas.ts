import { z } from "zod";

// Wire schemas for Jira (spec 29, ADR-0034). Requests are `{ type, requestId, ...params }`;
// responses are `{ type, payload: { requestId, error, ...data } }` (docs/rpc-namespacing.md).
//
// Secrets (API tokens, PATs, OAuth access/refresh tokens, OAuth client secrets) travel at most
// once, client→daemon, on `jira.connections.add` / `jira.oauth.begin|delegate`, and then live only
// in the daemon's FileSecretStore under $JAGENTDESK_HOME/jira. No response or push carries one,
// and no DTO carries a Jira URL that needs credentials: attachments come back as bytes
// (`jira.issue.attachments.download`), users and icons as names. Every timestamp is Unix ms UTC.

export const JiraErrorSchema = z.object({
  // auth_failed | needs_reauth | forbidden | not_found | invalid_input | rate_limited | network |
  // unsupported | too_large | jira_error
  code: z.string(),
  message: z.string(),
  // Jira's per-field validation messages (`errors` on a 400), keyed by field id.
  fieldErrors: z.record(z.string(), z.string()).optional(),
});
export type JiraError = z.infer<typeof JiraErrorSchema>;

export const JiraDeploymentSchema = z.enum(["cloud", "datacenter"]);
export type JiraDeployment = z.infer<typeof JiraDeploymentSchema>;

export const JiraAuthMethodSchema = z.enum(["api_token", "oauth", "pat"]);
export type JiraAuthMethod = z.infer<typeof JiraAuthMethodSchema>;

export const JiraAuthStateSchema = z.enum(["connected", "needs_reauth", "error"]);
export type JiraAuthState = z.infer<typeof JiraAuthStateSchema>;

// `ref` is the accountId on Cloud and the username on Data Center; clients treat it as opaque.
export const JiraUserSchema = z.object({
  ref: z.string(),
  displayName: z.string(),
});
export type JiraUser = z.infer<typeof JiraUserSchema>;

export const JiraConnectionSchema = z.object({
  id: z.string(), // `jir_…`
  label: z.string(),
  deployment: JiraDeploymentSchema,
  siteUrl: z.string(),
  cloudId: z.string().optional(),
  method: JiraAuthMethodSchema,
  account: JiraUserSchema,
  authState: JiraAuthStateSchema,
  lastError: z.string().optional(),
  tokenExpiresAt_ms: z.number().optional(),
  createdAt_ms: z.number(),
});
export type JiraConnection = z.infer<typeof JiraConnectionSchema>;

export const JiraProjectSchema = z.object({
  id: z.string(),
  key: z.string(),
  name: z.string(),
  projectTypeKey: z.string(),
  lead: JiraUserSchema.nullable(),
});
export type JiraProject = z.infer<typeof JiraProjectSchema>;

export const JiraBoardTypeSchema = z.enum(["scrum", "kanban", "simple"]);
export type JiraBoardType = z.infer<typeof JiraBoardTypeSchema>;

export const JiraBoardSchema = z.object({
  id: z.number(),
  name: z.string(),
  type: JiraBoardTypeSchema,
  projectKey: z.string().nullable(),
  projectName: z.string().nullable(),
});
export type JiraBoard = z.infer<typeof JiraBoardSchema>;

export const JiraStatusCategorySchema = z.enum(["new", "indeterminate", "done", "undefined"]);
export type JiraStatusCategory = z.infer<typeof JiraStatusCategorySchema>;

export const JiraStatusSchema = z.object({
  id: z.string(),
  name: z.string(),
  category: JiraStatusCategorySchema,
});
export type JiraStatus = z.infer<typeof JiraStatusSchema>;

export const JiraBoardColumnSchema = z.object({
  name: z.string(),
  statusIds: z.array(z.string()),
  min: z.number().nullable(),
  max: z.number().nullable(),
});
export type JiraBoardColumn = z.infer<typeof JiraBoardColumnSchema>;

export const JiraQuickFilterSchema = z.object({
  id: z.number(),
  name: z.string(),
  jql: z.string(),
});
export type JiraQuickFilter = z.infer<typeof JiraQuickFilterSchema>;

export const JiraBoardConfigurationSchema = z.object({
  boardId: z.number(),
  name: z.string(),
  type: JiraBoardTypeSchema,
  columns: z.array(JiraBoardColumnSchema),
  // "issueCount" | "issueCountExclSubs" | "none": what the WIP limits count.
  constraintType: z.string(),
  estimation: z.object({ fieldId: z.string(), displayName: z.string() }).nullable(),
  rankFieldId: z.number().nullable(),
  // Empty on Data Center, which has no quick filter API.
  quickFilters: z.array(JiraQuickFilterSchema),
  backlogEnabled: z.boolean(),
  sprintsEnabled: z.boolean(),
  statuses: z.array(JiraStatusSchema),
});
export type JiraBoardConfiguration = z.infer<typeof JiraBoardConfigurationSchema>;

export const JiraIssueTypeSchema = z.object({
  id: z.string(),
  name: z.string(),
  subtask: z.boolean(),
});
export type JiraIssueType = z.infer<typeof JiraIssueTypeSchema>;

export const JiraPrioritySchema = z.object({ id: z.string(), name: z.string() });
export type JiraPriority = z.infer<typeof JiraPrioritySchema>;

export const JiraIssueRefSchema = z.object({
  id: z.string(),
  key: z.string(),
  summary: z.string(),
  typeName: z.string(),
});
export type JiraIssueRef = z.infer<typeof JiraIssueRefSchema>;

// What a board card, a backlog row and a search result show.
export const JiraIssueCardSchema = z.object({
  id: z.string(),
  key: z.string(),
  summary: z.string(),
  type: JiraIssueTypeSchema,
  status: JiraStatusSchema,
  priority: JiraPrioritySchema.nullable(),
  assignee: JiraUserSchema.nullable(),
  // The board's estimation field (story points, original estimate in seconds, …).
  estimate: z.number().nullable(),
  parent: JiraIssueRefSchema.nullable(),
  labels: z.array(z.string()),
  flagged: z.boolean(),
  sprintId: z.number().nullable(),
  updated_ms: z.number(),
});
export type JiraIssueCard = z.infer<typeof JiraIssueCardSchema>;

export const JiraSprintStateSchema = z.enum(["future", "active", "closed"]);
export type JiraSprintState = z.infer<typeof JiraSprintStateSchema>;

export const JiraSprintSchema = z.object({
  id: z.number(),
  name: z.string(),
  state: JiraSprintStateSchema,
  goal: z.string().nullable(),
  startDate_ms: z.number().nullable(),
  endDate_ms: z.number().nullable(),
  completeDate_ms: z.number().nullable(),
  boardId: z.number().nullable(),
});
export type JiraSprint = z.infer<typeof JiraSprintSchema>;

export const JiraSwimlaneModeSchema = z.enum(["none", "assignee", "epic", "queries"]);
export type JiraSwimlaneMode = z.infer<typeof JiraSwimlaneModeSchema>;

export const JiraSwimlaneQuerySchema = z.object({
  id: z.string(),
  name: z.string(),
  jql: z.string(),
});
export type JiraSwimlaneQuery = z.infer<typeof JiraSwimlaneQuerySchema>;

// Jira has no swimlane API (spec 29.3): the daemon keeps this per board in swimlanes.json.
export const JiraSwimlaneConfigSchema = z.object({
  mode: JiraSwimlaneModeSchema,
  queries: z.array(JiraSwimlaneQuerySchema),
});
export type JiraSwimlaneConfig = z.infer<typeof JiraSwimlaneConfigSchema>;

export const JiraLaneSchema = z.object({
  id: z.string(),
  title: z.string(),
  issueIds: z.array(z.string()),
});
export type JiraLane = z.infer<typeof JiraLaneSchema>;

export const JiraBoardFilterSchema = z.object({
  quickFilterIds: z.array(z.number()).optional(),
  text: z.string().optional(),
  assigneeRefs: z.array(z.string()).optional(),
  parentKeys: z.array(z.string()).optional(),
  labels: z.array(z.string()).optional(),
  typeIds: z.array(z.string()).optional(),
});
export type JiraBoardFilter = z.infer<typeof JiraBoardFilterSchema>;

// Description, comment and worklog text: Markdown converted from ADF (Cloud) or wiki markup
// (Data Center). `editable` is false when the source holds content Markdown cannot round-trip
// (panels, macros, merged table cells, media, colors); `unsupported` names what was found.
export const JiraRichTextSchema = z.object({
  markdown: z.string(),
  editable: z.boolean(),
  unsupported: z.array(z.string()),
});
export type JiraRichText = z.infer<typeof JiraRichTextSchema>;

export const JiraOptionSchema = z.object({ id: z.string(), name: z.string() });
export type JiraOption = z.infer<typeof JiraOptionSchema>;

export const JiraFieldKindSchema = z.enum([
  "text",
  "textarea",
  "number",
  "date",
  "user",
  "labels",
  "option",
  "options",
  "readonly",
]);
export type JiraFieldKind = z.infer<typeof JiraFieldKindSchema>;

export const JiraFieldValueSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), text: z.string().nullable() }),
  z.object({ kind: z.literal("number"), number: z.number().nullable() }),
  z.object({ kind: z.literal("date"), date: z.string().nullable() }), // YYYY-MM-DD
  z.object({ kind: z.literal("user"), user: JiraUserSchema.nullable() }),
  z.object({ kind: z.literal("labels"), labels: z.array(z.string()) }),
  z.object({ kind: z.literal("option"), option: JiraOptionSchema.nullable() }),
  z.object({ kind: z.literal("options"), options: z.array(JiraOptionSchema) }),
]);
export type JiraFieldValue = z.infer<typeof JiraFieldValueSchema>;

// A field on the issue sidebar or a transition screen, shaped by `editmeta` / transition fields.
export const JiraFieldViewSchema = z.object({
  fieldId: z.string(),
  name: z.string(),
  kind: JiraFieldKindSchema,
  required: z.boolean(),
  editable: z.boolean(),
  value: JiraFieldValueSchema,
  allowedValues: z.array(JiraOptionSchema).nullable(),
});
export type JiraFieldView = z.infer<typeof JiraFieldViewSchema>;

// What a client sends to set a field. The daemon shapes the Jira payload from the field's schema.
export const JiraFieldInputSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), text: z.string().nullable() }),
  z.object({ kind: z.literal("markdown"), markdown: z.string() }),
  z.object({ kind: z.literal("number"), number: z.number().nullable() }),
  z.object({ kind: z.literal("date"), date: z.string().nullable() }),
  z.object({ kind: z.literal("user"), ref: z.string().nullable() }),
  z.object({ kind: z.literal("labels"), labels: z.array(z.string()) }),
  z.object({ kind: z.literal("option"), id: z.string().nullable() }),
  z.object({ kind: z.literal("options"), ids: z.array(z.string()) }),
]);
export type JiraFieldInput = z.infer<typeof JiraFieldInputSchema>;

export const JiraAttachmentSchema = z.object({
  id: z.string(),
  filename: z.string(),
  mimeType: z.string(),
  size: z.number(),
  created_ms: z.number(),
  author: JiraUserSchema.nullable(),
  hasThumbnail: z.boolean(),
});
export type JiraAttachment = z.infer<typeof JiraAttachmentSchema>;

export const JiraIssueLinkSchema = z.object({
  id: z.string(),
  // The phrase as Jira shows it from this issue's side ("blocks", "is blocked by", …).
  relation: z.string(),
  issue: z.object({
    id: z.string(),
    key: z.string(),
    summary: z.string(),
    status: JiraStatusSchema,
    typeName: z.string(),
  }),
});
export type JiraIssueLink = z.infer<typeof JiraIssueLinkSchema>;

export const JiraRemoteLinkSchema = z.object({
  id: z.string(),
  title: z.string(),
  url: z.string(),
});
export type JiraRemoteLink = z.infer<typeof JiraRemoteLinkSchema>;

export const JiraLinkTypeSchema = z.object({
  id: z.string(),
  name: z.string(),
  inward: z.string(),
  outward: z.string(),
});
export type JiraLinkType = z.infer<typeof JiraLinkTypeSchema>;

export const JiraTimeTrackingSchema = z.object({
  originalEstimate: z.string().nullable(),
  remainingEstimate: z.string().nullable(),
  timeSpent: z.string().nullable(),
});
export type JiraTimeTracking = z.infer<typeof JiraTimeTrackingSchema>;

export const JiraIssueDetailSchema = z.object({
  id: z.string(),
  key: z.string(),
  // `<siteUrl>/browse/<key>` — the "Open in Jira" link; carries no credentials.
  webUrl: z.string(),
  projectKey: z.string(),
  summary: z.string(),
  type: JiraIssueTypeSchema,
  status: JiraStatusSchema,
  priority: JiraPrioritySchema.nullable(),
  assignee: JiraUserSchema.nullable(),
  reporter: JiraUserSchema.nullable(),
  parent: JiraIssueRefSchema.nullable(),
  labels: z.array(z.string()),
  created_ms: z.number(),
  updated_ms: z.number(),
  description: JiraRichTextSchema,
  subtasks: z.array(JiraIssueCardSchema),
  links: z.array(JiraIssueLinkSchema),
  remoteLinks: z.array(JiraRemoteLinkSchema),
  attachments: z.array(JiraAttachmentSchema),
  watching: z.boolean(),
  watchCount: z.number(),
  timeTracking: JiraTimeTrackingSchema.nullable(),
  // Sidebar fields in the order Jira's editmeta lists them, plus read-only fields with a value.
  fields: z.array(JiraFieldViewSchema),
  canEdit: z.boolean(),
  linkTypes: z.array(JiraLinkTypeSchema),
});
export type JiraIssueDetail = z.infer<typeof JiraIssueDetailSchema>;

export const JiraTransitionSchema = z.object({
  id: z.string(),
  name: z.string(),
  to: JiraStatusSchema,
  hasScreen: z.boolean(),
  // Fields on the transition screen; `required` ones must be filled before it can run.
  fields: z.array(JiraFieldViewSchema),
});
export type JiraTransition = z.infer<typeof JiraTransitionSchema>;

export const JiraCommentSchema = z.object({
  id: z.string(),
  author: JiraUserSchema.nullable(),
  body: JiraRichTextSchema,
  created_ms: z.number(),
  updated_ms: z.number(),
  editable: z.boolean(),
});
export type JiraComment = z.infer<typeof JiraCommentSchema>;

export const JiraWorklogSchema = z.object({
  id: z.string(),
  author: JiraUserSchema.nullable(),
  timeSpent: z.string(),
  timeSpentSeconds: z.number(),
  started_ms: z.number(),
  comment: z.string(),
});
export type JiraWorklog = z.infer<typeof JiraWorklogSchema>;

export const JiraChangelogEntrySchema = z.object({
  id: z.string(),
  author: JiraUserSchema.nullable(),
  created_ms: z.number(),
  items: z.array(
    z.object({ field: z.string(), from: z.string().nullable(), to: z.string().nullable() }),
  ),
});
export type JiraChangelogEntry = z.infer<typeof JiraChangelogEntrySchema>;

export const JiraFilterSchema = z.object({
  id: z.string(),
  name: z.string(),
  jql: z.string(),
  favourite: z.boolean(),
  owner: z.string().nullable(),
  mine: z.boolean(),
});
export type JiraFilter = z.infer<typeof JiraFilterSchema>;

export const JiraEpicSchema = z.object({
  id: z.string(),
  key: z.string(),
  name: z.string(),
  done: z.boolean(),
});
export type JiraEpic = z.infer<typeof JiraEpicSchema>;

export const JiraVersionSchema = z.object({
  id: z.string(),
  name: z.string(),
  released: z.boolean(),
  releaseDate: z.string().nullable(),
});
export type JiraVersion = z.infer<typeof JiraVersionSchema>;

export const JiraOAuthSiteSchema = z.object({
  cloudId: z.string(),
  name: z.string(),
  url: z.string(),
});
export type JiraOAuthSite = z.infer<typeof JiraOAuthSiteSchema>;

export const JiraCreateMetaFieldSchema = z.object({
  fieldId: z.string(),
  name: z.string(),
  kind: JiraFieldKindSchema,
  required: z.boolean(),
  allowedValues: z.array(JiraOptionSchema).nullable(),
});
export type JiraCreateMetaField = z.infer<typeof JiraCreateMetaFieldSchema>;

export const JiraSuggestionSchema = z.object({ value: z.string(), label: z.string() });
export type JiraSuggestion = z.infer<typeof JiraSuggestionSchema>;

// ── RPC helpers ─────────────────────────────────────────────────────────

function req<T extends string, S extends z.ZodRawShape>(type: T, shape: S) {
  return z.object({ type: z.literal(type), requestId: z.string(), ...shape });
}

function res<T extends string, S extends z.ZodRawShape>(type: T, shape: S) {
  return z.object({
    type: z.literal(type),
    payload: z.object({ requestId: z.string(), error: JiraErrorSchema.nullable(), ...shape }),
  });
}

const connectionId = z.string();
const issueKey = z.string();

// ── Connections + OAuth ─────────────────────────────────────────────────

export const JiraConnectionsListRequestSchema = req("jira.connections.list.request", {});
export const JiraConnectionsListResponseSchema = res("jira.connections.list.response", {
  connections: z.array(JiraConnectionSchema),
});

export const JiraConnectionsAddRequestSchema = req("jira.connections.add.request", {
  label: z.string().optional(),
  deployment: JiraDeploymentSchema,
  siteUrl: z.string(),
  // Token methods only; OAuth connections come from jira.oauth.complete.
  method: z.enum(["api_token", "pat"]),
  email: z.string().optional(), // Cloud API token: the Atlassian account email
  token: z.string(),
});
export const JiraConnectionsAddResponseSchema = res("jira.connections.add.response", {
  connection: JiraConnectionSchema.nullable(),
});

export const JiraConnectionsRemoveRequestSchema = req("jira.connections.remove.request", {
  connectionId,
});
export const JiraConnectionsRemoveResponseSchema = res("jira.connections.remove.response", {});

export const JiraConnectionsTestRequestSchema = req("jira.connections.test.request", {
  connectionId,
});
export const JiraConnectionsTestResponseSchema = res("jira.connections.test.response", {
  connection: JiraConnectionSchema.nullable(),
});

export const JIRA_OAUTH_LOOPBACK_REDIRECT_URI = "http://127.0.0.1:8765/jira/callback";

export const JiraOAuthBeginRequestSchema = req("jira.oauth.begin.request", {
  clientId: z.string(),
  clientSecret: z.string(),
  // The callback URL registered in the developer console; defaults to the desktop loopback.
  redirectUri: z.string().optional(),
  label: z.string().optional(),
});
export const JiraOAuthBeginResponseSchema = res("jira.oauth.begin.response", {
  state: z.string(),
  authorizeUrl: z.string(),
  redirectUri: z.string(),
  expiresAt_ms: z.number(),
});

export const JiraOAuthCompleteRequestSchema = req("jira.oauth.complete.request", {
  state: z.string(),
  // Either the code from the loopback listener, or the whole URL the browser landed on.
  code: z.string().optional(),
  callbackUrl: z.string().optional(),
  // Second call when the grant covers several sites.
  cloudId: z.string().optional(),
});
export const JiraOAuthCompleteResponseSchema = res("jira.oauth.complete.response", {
  connection: JiraConnectionSchema.nullable(),
  // Set (and connection null) when the user must pick one of several sites.
  sites: z.array(JiraOAuthSiteSchema).nullable(),
});

// Mobile "Sign in on a desktop": the daemon starts the flow and asks paired desktops to run it.
export const JiraOAuthDelegateRequestSchema = req("jira.oauth.delegate.request", {
  clientId: z.string(),
  clientSecret: z.string(),
  redirectUri: z.string().optional(),
  label: z.string().optional(),
});
export const JiraOAuthDelegateResponseSchema = res("jira.oauth.delegate.response", {
  state: z.string(),
  authorizeUrl: z.string(),
  redirectUri: z.string(),
  expiresAt_ms: z.number(),
});

// Broadcast to every session: a desktop app runs the loopback flow for this state.
export const JiraOAuthDelegationSchema = z.object({
  type: z.literal("jira.oauth.delegation"),
  state: z.string(),
  authorizeUrl: z.string(),
  redirectUri: z.string(),
  expiresAt_ms: z.number(),
});
export type JiraOAuthDelegation = z.infer<typeof JiraOAuthDelegationSchema>;

export const JiraOAuthProgressSchema = z.object({
  type: z.literal("jira.oauth.progress"),
  state: z.string(),
  phase: z.enum(["exchanging", "choose_site", "done", "failed"]),
  connectionId: z.string().optional(),
  error: z.string().optional(),
});
export type JiraOAuthProgress = z.infer<typeof JiraOAuthProgressSchema>;

// ── Projects, boards ────────────────────────────────────────────────────

export const JiraProjectsListRequestSchema = req("jira.projects.list.request", {
  connectionId,
  query: z.string().optional(),
});
export const JiraProjectsListResponseSchema = res("jira.projects.list.response", {
  projects: z.array(JiraProjectSchema),
});

export const JiraBoardsListRequestSchema = req("jira.boards.list.request", {
  connectionId,
  projectKey: z.string().optional(),
  query: z.string().optional(),
});
export const JiraBoardsListResponseSchema = res("jira.boards.list.response", {
  boards: z.array(JiraBoardSchema),
});

export const JiraBoardsGetRequestSchema = req("jira.boards.get.request", {
  connectionId,
  boardId: z.number(),
});
export const JiraBoardsGetResponseSchema = res("jira.boards.get.response", {
  board: JiraBoardSchema.nullable(),
});

export const JiraBoardsConfigurationRequestSchema = req("jira.boards.configuration.request", {
  connectionId,
  boardId: z.number(),
});
export const JiraBoardsConfigurationResponseSchema = res("jira.boards.configuration.response", {
  configuration: JiraBoardConfigurationSchema.nullable(),
});

export const JiraBoardIssuesRequestSchema = req("jira.board.issues.request", {
  connectionId,
  boardId: z.number(),
  filter: JiraBoardFilterSchema.optional(),
});
export const JiraBoardIssuesResponseSchema = res("jira.board.issues.response", {
  issues: z.array(JiraIssueCardSchema),
  // Lanes computed by the daemon from swimlanes.json (spec 29.3); one lane when mode is none.
  lanes: z.array(JiraLaneSchema),
  swimlanes: JiraSwimlaneConfigSchema,
  // Scrum: the active sprint the board shows; null on Kanban or when no sprint is active.
  sprint: JiraSprintSchema.nullable(),
  // The board has more than JIRA_BOARD_MAX_ISSUES issues; only that many came back.
  truncated: z.boolean(),
});

// Polling while a board view is open (spec 29.3): one watch per open view.
export const JiraBoardWatchRequestSchema = req("jira.board.watch.request", {
  watchId: z.string(),
  connectionId,
  boardId: z.number(),
});
export const JiraBoardWatchResponseSchema = res("jira.board.watch.response", {});

export const JiraBoardUnwatchRequestSchema = req("jira.board.unwatch.request", {
  watchId: z.string(),
});
export const JiraBoardUnwatchResponseSchema = res("jira.board.unwatch.response", {});

export const JiraBoardChangedSchema = z.object({
  type: z.literal("jira.board.changed"),
  watchId: z.string(),
  connectionId,
  boardId: z.number(),
  issueKeys: z.array(z.string()),
});
export type JiraBoardChanged = z.infer<typeof JiraBoardChangedSchema>;

export const JiraBacklogGetRequestSchema = req("jira.backlog.get.request", {
  connectionId,
  boardId: z.number(),
});
export const JiraBacklogSprintSchema = z.object({
  sprint: JiraSprintSchema,
  issues: z.array(JiraIssueCardSchema),
});
export const JiraBacklogGetResponseSchema = res("jira.backlog.get.response", {
  sprints: z.array(JiraBacklogSprintSchema),
  backlog: z.array(JiraIssueCardSchema),
  epics: z.array(JiraEpicSchema),
  versions: z.array(JiraVersionSchema),
});

// ── Sprints ─────────────────────────────────────────────────────────────

export const JiraSprintsListRequestSchema = req("jira.sprints.list.request", {
  connectionId,
  boardId: z.number(),
  states: z.array(JiraSprintStateSchema).optional(),
});
export const JiraSprintsListResponseSchema = res("jira.sprints.list.response", {
  sprints: z.array(JiraSprintSchema),
});

export const JiraSprintsCreateRequestSchema = req("jira.sprints.create.request", {
  connectionId,
  boardId: z.number(),
  name: z.string(),
  goal: z.string().optional(),
  startDate_ms: z.number().optional(),
  endDate_ms: z.number().optional(),
});
export const JiraSprintsCreateResponseSchema = res("jira.sprints.create.response", {
  sprint: JiraSprintSchema.nullable(),
});

export const JiraSprintsStartRequestSchema = req("jira.sprints.start.request", {
  connectionId,
  sprintId: z.number(),
  name: z.string().optional(),
  goal: z.string().optional(),
  startDate_ms: z.number(),
  endDate_ms: z.number(),
});
export const JiraSprintsStartResponseSchema = res("jira.sprints.start.response", {
  sprint: JiraSprintSchema.nullable(),
});

export const JiraSprintDestinationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("backlog") }),
  z.object({ kind: z.literal("sprint"), sprintId: z.number() }),
  z.object({ kind: z.literal("new_sprint"), name: z.string() }),
]);
export type JiraSprintDestination = z.infer<typeof JiraSprintDestinationSchema>;

export const JiraSprintsCompleteRequestSchema = req("jira.sprints.complete.request", {
  connectionId,
  boardId: z.number(),
  sprintId: z.number(),
  // Where open issues go; Jira's REST complete has no such option, so the daemon moves them first.
  incompleteDestination: JiraSprintDestinationSchema,
});
export const JiraSprintsCompleteResponseSchema = res("jira.sprints.complete.response", {
  sprint: JiraSprintSchema.nullable(),
  movedIssueKeys: z.array(z.string()),
});

export const JiraSprintsMoveIssuesRequestSchema = req("jira.sprints.move_issues.request", {
  connectionId,
  issueKeys: z.array(z.string()),
  target: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("sprint"), sprintId: z.number() }),
    z.object({ kind: z.literal("backlog"), boardId: z.number() }),
  ]),
});
export const JiraSprintsMoveIssuesResponseSchema = res("jira.sprints.move_issues.response", {});

// ── Issues ──────────────────────────────────────────────────────────────

export const JiraIssueGetRequestSchema = req("jira.issue.get.request", { connectionId, issueKey });
export const JiraIssueGetResponseSchema = res("jira.issue.get.response", {
  issue: JiraIssueDetailSchema.nullable(),
});

export const JiraIssueCreateRequestSchema = req("jira.issue.create.request", {
  connectionId,
  projectKey: z.string(),
  issueTypeId: z.string(),
  summary: z.string(),
  descriptionMarkdown: z.string().optional(),
  parentKey: z.string().optional(),
  sprintId: z.number().optional(),
  fields: z.record(z.string(), JiraFieldInputSchema).optional(),
});
export const JiraIssueCreateResponseSchema = res("jira.issue.create.response", {
  issue: JiraIssueCardSchema.nullable(),
});

export const JiraIssueCreateMetaRequestSchema = req("jira.issue.create_meta.request", {
  connectionId,
  projectKey: z.string(),
  issueTypeId: z.string().optional(),
});
export const JiraIssueCreateMetaResponseSchema = res("jira.issue.create_meta.response", {
  issueTypes: z.array(JiraIssueTypeSchema),
  // Fields for `issueTypeId` (empty when it was not given).
  fields: z.array(JiraCreateMetaFieldSchema),
});

export const JiraIssueUpdateRequestSchema = req("jira.issue.update.request", {
  connectionId,
  issueKey,
  summary: z.string().optional(),
  descriptionMarkdown: z.string().optional(),
  fields: z.record(z.string(), JiraFieldInputSchema).optional(),
});
export const JiraIssueUpdateResponseSchema = res("jira.issue.update.response", {
  issue: JiraIssueDetailSchema.nullable(),
});

export const JiraIssueTransitionsRequestSchema = req("jira.issue.transitions.request", {
  connectionId,
  issueKey,
});
export const JiraIssueTransitionsResponseSchema = res("jira.issue.transitions.response", {
  transitions: z.array(JiraTransitionSchema),
});

export const JiraIssueTransitionRequestSchema = req("jira.issue.transition.request", {
  connectionId,
  issueKey,
  transitionId: z.string(),
  fields: z.record(z.string(), JiraFieldInputSchema).optional(),
  commentMarkdown: z.string().optional(),
});
export const JiraIssueTransitionResponseSchema = res("jira.issue.transition.response", {
  issue: JiraIssueCardSchema.nullable(),
});

export const JiraAssigneeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("me") }),
  z.object({ kind: z.literal("user"), ref: z.string() }),
  z.object({ kind: z.literal("none") }),
]);
export type JiraAssignee = z.infer<typeof JiraAssigneeSchema>;

export const JiraIssueAssignRequestSchema = req("jira.issue.assign.request", {
  connectionId,
  issueKey,
  assignee: JiraAssigneeSchema,
});
export const JiraIssueAssignResponseSchema = res("jira.issue.assign.response", {
  assignee: JiraUserSchema.nullable(),
});

export const JiraIssueRankRequestSchema = req("jira.issue.rank.request", {
  connectionId,
  issueKeys: z.array(z.string()),
  rankBeforeKey: z.string().optional(),
  rankAfterKey: z.string().optional(),
  rankFieldId: z.number().optional(),
});
export const JiraIssueRankResponseSchema = res("jira.issue.rank.response", {});

export const JiraIssueWatchRequestSchema = req("jira.issue.watch.request", {
  watchId: z.string(),
  connectionId,
  issueKey,
});
export const JiraIssueWatchResponseSchema = res("jira.issue.watch.response", {});

export const JiraIssueUnwatchRequestSchema = req("jira.issue.unwatch.request", {
  watchId: z.string(),
});
export const JiraIssueUnwatchResponseSchema = res("jira.issue.unwatch.response", {});

export const JiraIssueChangedSchema = z.object({
  type: z.literal("jira.issue.changed"),
  watchId: z.string(),
  connectionId,
  issueKey,
  updated_ms: z.number(),
});
export type JiraIssueChanged = z.infer<typeof JiraIssueChangedSchema>;

// The header "Watch" toggle (Jira watchers), distinct from the view polling above.
export const JiraIssueWatchersSetRequestSchema = req("jira.issue.watchers.set.request", {
  connectionId,
  issueKey,
  watching: z.boolean(),
});
export const JiraIssueWatchersSetResponseSchema = res("jira.issue.watchers.set.response", {
  watching: z.boolean(),
  watchCount: z.number(),
});

export const JiraIssueChangelogListRequestSchema = req("jira.issue.changelog.list.request", {
  connectionId,
  issueKey,
  startAt: z.number().optional(),
});
export const JiraIssueChangelogListResponseSchema = res("jira.issue.changelog.list.response", {
  entries: z.array(JiraChangelogEntrySchema),
  total: z.number(),
  startAt: z.number(),
});

export const JiraIssueCommentsListRequestSchema = req("jira.issue.comments.list.request", {
  connectionId,
  issueKey,
  startAt: z.number().optional(),
});
export const JiraIssueCommentsListResponseSchema = res("jira.issue.comments.list.response", {
  comments: z.array(JiraCommentSchema),
  total: z.number(),
  startAt: z.number(),
});

export const JiraIssueCommentsAddRequestSchema = req("jira.issue.comments.add.request", {
  connectionId,
  issueKey,
  bodyMarkdown: z.string(),
});
export const JiraIssueCommentsAddResponseSchema = res("jira.issue.comments.add.response", {
  comment: JiraCommentSchema.nullable(),
});

export const JiraIssueCommentsUpdateRequestSchema = req("jira.issue.comments.update.request", {
  connectionId,
  issueKey,
  commentId: z.string(),
  bodyMarkdown: z.string(),
});
export const JiraIssueCommentsUpdateResponseSchema = res("jira.issue.comments.update.response", {
  comment: JiraCommentSchema.nullable(),
});

export const JiraIssueWorklogListRequestSchema = req("jira.issue.worklog.list.request", {
  connectionId,
  issueKey,
  startAt: z.number().optional(),
});
export const JiraIssueWorklogListResponseSchema = res("jira.issue.worklog.list.response", {
  worklogs: z.array(JiraWorklogSchema),
  total: z.number(),
  startAt: z.number(),
});

export const JiraRemainingEstimateSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("auto") }),
  z.object({ kind: z.literal("leave") }),
  z.object({ kind: z.literal("new"), value: z.string() }),
]);
export type JiraRemainingEstimate = z.infer<typeof JiraRemainingEstimateSchema>;

export const JiraIssueWorklogAddRequestSchema = req("jira.issue.worklog.add.request", {
  connectionId,
  issueKey,
  timeSpent: z.string(), // Jira duration: "1h 30m", "2d"
  started_ms: z.number(),
  commentMarkdown: z.string().optional(),
  remainingEstimate: JiraRemainingEstimateSchema.optional(),
});
export const JiraIssueWorklogAddResponseSchema = res("jira.issue.worklog.add.response", {
  worklog: JiraWorklogSchema.nullable(),
});

export const JIRA_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;

// Safety ceiling of the board view (spec 29.3): the daemon pages through every issue of a board up
// to this many, far above real boards; past it the response says `truncated` and the app says so.
export const JIRA_BOARD_MAX_ISSUES = 5000;

// Attachments referenced from rich text (description, comments): the daemon maps ADF media nodes
// and wiki `!file!` / `[^file]` to `![name](jira-attachment:<attachmentId>)` (images) or
// `[name](jira-attachment:<attachmentId>)`; the app loads the bytes through
// jira.issue.attachments.download, never through a Jira URL.
export const JIRA_ATTACHMENT_SCHEME = "jira-attachment:";

export const JiraIssueAttachmentsUploadRequestSchema = req(
  "jira.issue.attachments.upload.request",
  {
    connectionId,
    issueKey,
    fileName: z.string(),
    mimeType: z.string(),
    dataBase64: z.string(),
  },
);
export const JiraIssueAttachmentsUploadResponseSchema = res(
  "jira.issue.attachments.upload.response",
  { attachments: z.array(JiraAttachmentSchema) },
);

export const JiraIssueAttachmentsDownloadRequestSchema = req(
  "jira.issue.attachments.download.request",
  {
    connectionId,
    attachmentId: z.string(),
    variant: z.enum(["content", "thumbnail"]),
  },
);
export const JiraIssueAttachmentsDownloadResponseSchema = res(
  "jira.issue.attachments.download.response",
  {
    fileName: z.string(),
    mimeType: z.string(),
    size: z.number(),
    dataBase64: z.string(),
  },
);

export const JiraIssueAttachmentsDeleteRequestSchema = req(
  "jira.issue.attachments.delete.request",
  { connectionId, attachmentId: z.string() },
);
export const JiraIssueAttachmentsDeleteResponseSchema = res(
  "jira.issue.attachments.delete.response",
  {},
);

export const JiraLinkInputSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("issue"),
    linkTypeName: z.string(),
    // outward: "<this issue> <outward phrase> <target>"; inward: the reverse.
    direction: z.enum(["outward", "inward"]),
    targetKey: z.string(),
  }),
  z.object({ kind: z.literal("web"), url: z.string(), title: z.string() }),
]);
export type JiraLinkInput = z.infer<typeof JiraLinkInputSchema>;

export const JiraIssueLinksAddRequestSchema = req("jira.issue.links.add.request", {
  connectionId,
  issueKey,
  link: JiraLinkInputSchema,
});
export const JiraIssueLinksAddResponseSchema = res("jira.issue.links.add.response", {});

// ── Search, filters, users, swimlanes ───────────────────────────────────

export const JiraSearchRequestSchema = req("jira.search.request", {
  connectionId,
  jql: z.string(),
  nextPageToken: z.string().optional(),
  maxResults: z.number().optional(),
});
export const JiraSearchResponseSchema = res("jira.search.response", {
  issues: z.array(JiraIssueCardSchema),
  nextPageToken: z.string().nullable(),
  // Data Center reports a total; Cloud's search/jql does not.
  total: z.number().nullable(),
});

// JQL suggestions: field names when `fieldName` is absent, otherwise values for that field.
export const JiraJqlSuggestRequestSchema = req("jira.jql.suggest.request", {
  connectionId,
  fieldName: z.string().optional(),
  value: z.string().optional(),
});
export const JiraJqlSuggestResponseSchema = res("jira.jql.suggest.response", {
  suggestions: z.array(JiraSuggestionSchema),
});

export const JiraFiltersListRequestSchema = req("jira.filters.list.request", { connectionId });
export const JiraFiltersListResponseSchema = res("jira.filters.list.response", {
  filters: z.array(JiraFilterSchema),
});

export const JiraFiltersSaveRequestSchema = req("jira.filters.save.request", {
  connectionId,
  name: z.string(),
  jql: z.string(),
  description: z.string().optional(),
  favourite: z.boolean().optional(),
});
export const JiraFiltersSaveResponseSchema = res("jira.filters.save.response", {
  filter: JiraFilterSchema.nullable(),
});

export const JiraUsersFindRequestSchema = req("jira.users.find.request", {
  connectionId,
  query: z.string(),
  // Restrict to people assignable to this issue or project.
  issueKey: z.string().optional(),
  projectKey: z.string().optional(),
});
export const JiraUsersFindResponseSchema = res("jira.users.find.response", {
  users: z.array(JiraUserSchema),
});

export const JiraSwimlanesGetRequestSchema = req("jira.swimlanes.get.request", {
  connectionId,
  boardId: z.number(),
});
export const JiraSwimlanesGetResponseSchema = res("jira.swimlanes.get.response", {
  swimlanes: JiraSwimlaneConfigSchema,
});

export const JiraSwimlanesSetRequestSchema = req("jira.swimlanes.set.request", {
  connectionId,
  boardId: z.number(),
  swimlanes: JiraSwimlaneConfigSchema,
});
export const JiraSwimlanesSetResponseSchema = res("jira.swimlanes.set.response", {
  swimlanes: JiraSwimlaneConfigSchema,
});

// ── Unions ──────────────────────────────────────────────────────────────

export const JiraRequestSchemas = [
  JiraConnectionsListRequestSchema,
  JiraConnectionsAddRequestSchema,
  JiraConnectionsRemoveRequestSchema,
  JiraConnectionsTestRequestSchema,
  JiraOAuthBeginRequestSchema,
  JiraOAuthCompleteRequestSchema,
  JiraOAuthDelegateRequestSchema,
  JiraProjectsListRequestSchema,
  JiraBoardsListRequestSchema,
  JiraBoardsGetRequestSchema,
  JiraBoardsConfigurationRequestSchema,
  JiraBoardIssuesRequestSchema,
  JiraBoardWatchRequestSchema,
  JiraBoardUnwatchRequestSchema,
  JiraBacklogGetRequestSchema,
  JiraSprintsListRequestSchema,
  JiraSprintsCreateRequestSchema,
  JiraSprintsStartRequestSchema,
  JiraSprintsCompleteRequestSchema,
  JiraSprintsMoveIssuesRequestSchema,
  JiraIssueGetRequestSchema,
  JiraIssueCreateRequestSchema,
  JiraIssueCreateMetaRequestSchema,
  JiraIssueUpdateRequestSchema,
  JiraIssueTransitionsRequestSchema,
  JiraIssueTransitionRequestSchema,
  JiraIssueAssignRequestSchema,
  JiraIssueRankRequestSchema,
  JiraIssueWatchRequestSchema,
  JiraIssueUnwatchRequestSchema,
  JiraIssueWatchersSetRequestSchema,
  JiraIssueChangelogListRequestSchema,
  JiraIssueCommentsListRequestSchema,
  JiraIssueCommentsAddRequestSchema,
  JiraIssueCommentsUpdateRequestSchema,
  JiraIssueWorklogListRequestSchema,
  JiraIssueWorklogAddRequestSchema,
  JiraIssueAttachmentsUploadRequestSchema,
  JiraIssueAttachmentsDownloadRequestSchema,
  JiraIssueAttachmentsDeleteRequestSchema,
  JiraIssueLinksAddRequestSchema,
  JiraSearchRequestSchema,
  JiraJqlSuggestRequestSchema,
  JiraFiltersListRequestSchema,
  JiraFiltersSaveRequestSchema,
  JiraUsersFindRequestSchema,
  JiraSwimlanesGetRequestSchema,
  JiraSwimlanesSetRequestSchema,
] as const;

export const JiraResponseSchemas = [
  JiraConnectionsListResponseSchema,
  JiraConnectionsAddResponseSchema,
  JiraConnectionsRemoveResponseSchema,
  JiraConnectionsTestResponseSchema,
  JiraOAuthBeginResponseSchema,
  JiraOAuthCompleteResponseSchema,
  JiraOAuthDelegateResponseSchema,
  JiraProjectsListResponseSchema,
  JiraBoardsListResponseSchema,
  JiraBoardsGetResponseSchema,
  JiraBoardsConfigurationResponseSchema,
  JiraBoardIssuesResponseSchema,
  JiraBoardWatchResponseSchema,
  JiraBoardUnwatchResponseSchema,
  JiraBacklogGetResponseSchema,
  JiraSprintsListResponseSchema,
  JiraSprintsCreateResponseSchema,
  JiraSprintsStartResponseSchema,
  JiraSprintsCompleteResponseSchema,
  JiraSprintsMoveIssuesResponseSchema,
  JiraIssueGetResponseSchema,
  JiraIssueCreateResponseSchema,
  JiraIssueCreateMetaResponseSchema,
  JiraIssueUpdateResponseSchema,
  JiraIssueTransitionsResponseSchema,
  JiraIssueTransitionResponseSchema,
  JiraIssueAssignResponseSchema,
  JiraIssueRankResponseSchema,
  JiraIssueWatchResponseSchema,
  JiraIssueUnwatchResponseSchema,
  JiraIssueWatchersSetResponseSchema,
  JiraIssueChangelogListResponseSchema,
  JiraIssueCommentsListResponseSchema,
  JiraIssueCommentsAddResponseSchema,
  JiraIssueCommentsUpdateResponseSchema,
  JiraIssueWorklogListResponseSchema,
  JiraIssueWorklogAddResponseSchema,
  JiraIssueAttachmentsUploadResponseSchema,
  JiraIssueAttachmentsDownloadResponseSchema,
  JiraIssueAttachmentsDeleteResponseSchema,
  JiraIssueLinksAddResponseSchema,
  JiraSearchResponseSchema,
  JiraJqlSuggestResponseSchema,
  JiraFiltersListResponseSchema,
  JiraFiltersSaveResponseSchema,
  JiraUsersFindResponseSchema,
  JiraSwimlanesGetResponseSchema,
  JiraSwimlanesSetResponseSchema,
] as const;

export const JiraPushSchemas = [
  JiraBoardChangedSchema,
  JiraIssueChangedSchema,
  JiraOAuthDelegationSchema,
  JiraOAuthProgressSchema,
] as const;

export type JiraRequest = z.infer<(typeof JiraRequestSchemas)[number]>;
export type JiraRequestType = JiraRequest["type"];
export type JiraResponse = z.infer<(typeof JiraResponseSchemas)[number]>;
export type JiraPush = z.infer<(typeof JiraPushSchemas)[number]>;

/** The response type paired with a request type (`….request` → `….response`). */
export type JiraResponseTypeFor<T extends JiraRequestType> = T extends `${infer Prefix}.request`
  ? `${Prefix}.response`
  : never;

export type JiraResponseFor<T extends JiraRequestType> = Extract<
  JiraResponse,
  { type: JiraResponseTypeFor<T> }
>;

/** Request params as a client passes them: everything but `type` and `requestId`. */
export type JiraRequestParams<T extends JiraRequestType> = Omit<
  Extract<JiraRequest, { type: T }>,
  "type" | "requestId"
>;

/** The success payload of a response, without the envelope fields. */
export type JiraResponseData<T extends JiraRequestType> = Omit<
  JiraResponseFor<T>["payload"],
  "requestId" | "error"
>;

export const JIRA_REQUEST_TYPES: readonly JiraRequestType[] = JiraRequestSchemas.map(
  (schema) => schema.shape.type.value,
);
