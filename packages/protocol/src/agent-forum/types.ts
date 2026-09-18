import { z } from "zod";

// Agent Forum / Team mode (docs/plans/active/agent-forum.md). A "topic" is one collaborative run
// started from a user's coding prompt: agents discuss, create tasks, break them into subtasks,
// assign, estimate, and move status — all persisted and streamed to a forum/task-board UI. The real
// agent work runs on the existing Supervisor/Lead/Peer orchestration runtime; this is the data layer.

// Timestamps are milliseconds Unix UTC (suffix _ms), matching the rest of the protocol.

// Topic phases, in order. A topic starts in "discussion" — the agents research, refine, and debate
// like a real forum thread — then move to "planning" (turning the conclusion into tasks), "building",
// "review" (role-based BA/Tester/Pentester review), and "done". "archived" is terminal.
export const ForumTopicStatusSchema = z.enum([
  "discussion",
  "planning",
  "building",
  "review",
  "done",
  "archived",
]);
export type ForumTopicStatus = z.infer<typeof ForumTopicStatusSchema>;

// Task lifecycle. Kept as an explicit ordered set so the board renders columns in this order and the
// daemon can validate transitions. `blocked` is a side state reachable from any active state.
export const ForumTaskStatusSchema = z.enum([
  "backlog",
  "todo",
  "in_progress",
  "review",
  "blocked",
  "done",
]);
export type ForumTaskStatus = z.infer<typeof ForumTaskStatusSchema>;

// Roles a forum participant can act as. Beyond the orchestration roles, reviewers act as a Business
// Analyst, Tester/QA, or Pentester (security) — the human-team roles that review a coder's work
// (open-code-review methodology).
export const ForumRoleSchema = z.enum([
  "supervisor",
  "lead",
  "peer",
  "ba",
  "tester",
  "pentester",
  "reviewer",
  "user",
  "system",
]);
export type ForumRole = z.infer<typeof ForumRoleSchema>;

// A relative size estimate. Free-form points would invite drift; a small ordinal set keeps the board
// legible and lets the daemon aggregate. `unknown` = not yet estimated.
export const ForumEstimateSchema = z.enum(["unknown", "xs", "s", "m", "l", "xl"]);
export type ForumEstimate = z.infer<typeof ForumEstimateSchema>;

export const ForumParticipantSchema = z.object({
  // "user"/"system" for non-agent authors; otherwise the daemon agentId.
  agentId: z.string(),
  label: z.string(),
  role: ForumRoleSchema,
});
export type ForumParticipant = z.infer<typeof ForumParticipantSchema>;

// One entry in a task's audit trail (who moved it, from/to, when) — mirrors open-code-review's
// derive-status-from-facts discipline so the board is always explainable.
export const ForumTaskEventSchema = z.object({
  at_ms: z.number().int(),
  actorAgentId: z.string(),
  kind: z.enum(["created", "assigned", "estimated", "status", "note"]),
  from: z.string().optional(),
  to: z.string().optional(),
  note: z.string().optional(),
});
export type ForumTaskEvent = z.infer<typeof ForumTaskEventSchema>;

// Code-review model (alibaba/open-code-review methodology, integrated into the daemon core rather than
// left to the reviewer's prose). A review is a set of evidence-carrying findings; the daemon — not the
// agent — derives the verdict from finding severities, and a task is only "done" once every required
// role has approved. Categories/severities mirror open-code-review's taxonomy.
export const ForumReviewCategorySchema = z.enum([
  "bug",
  "security",
  "performance",
  "maintainability",
  "test",
  "style",
  "documentation",
  "other",
]);
export type ForumReviewCategory = z.infer<typeof ForumReviewCategorySchema>;

export const ForumReviewSeveritySchema = z.enum(["critical", "high", "medium", "low"]);
export type ForumReviewSeverity = z.infer<typeof ForumReviewSeveritySchema>;

// One evidence-carrying finding: where (file + line range), what kind, how bad, the issue, and an
// optional suggested fix. Line anchors + description are the evidence contract (a finding without a
// path is rejected upstream).
export const ForumReviewFindingSchema = z.object({
  path: z.string(),
  startLine: z.number().int().nullable().default(null),
  endLine: z.number().int().nullable().default(null),
  category: ForumReviewCategorySchema,
  severity: ForumReviewSeveritySchema,
  content: z.string(),
  suggestion: z.string().nullable().default(null),
});
export type ForumReviewFinding = z.infer<typeof ForumReviewFindingSchema>;

// A completed role review of a task: the findings + the daemon-derived verdict + a coverage note.
export const ForumTaskReviewSchema = z.object({
  id: z.string(),
  role: ForumRoleSchema,
  reviewerAgentId: z.string(),
  reviewerLabel: z.string(),
  verdict: z.enum(["approve", "request_changes"]),
  findings: z.array(ForumReviewFindingSchema).default([]),
  // Free-text coverage note (e.g. "reviewed 3/3 changed files"), open-code-review's coverage accounting.
  coverage: z.string().default(""),
  createdAt_ms: z.number().int(),
});
export type ForumTaskReview = z.infer<typeof ForumTaskReviewSchema>;

// A comment on a task (Jira-style): agents discuss the task itself in its detail view. Body is
// Markdown (code blocks, quotes, links, images, @mentions all render in the UI).
export const ForumTaskCommentSchema = z.object({
  id: z.string(),
  authorAgentId: z.string(),
  authorLabel: z.string(),
  role: ForumRoleSchema,
  text: z.string(),
  createdAt_ms: z.number().int(),
});
export type ForumTaskComment = z.infer<typeof ForumTaskCommentSchema>;

export const ForumTaskSchema = z.object({
  id: z.string(),
  title: z.string(),
  // Markdown description of the task (rendered in the Jira-style detail view).
  description: z.string().default(""),
  status: ForumTaskStatusSchema,
  assigneeAgentId: z.string().nullable().default(null),
  // Human-readable assignee label (agent name/role) so the board needn't resolve agent ids.
  assigneeLabel: z.string().nullable().default(null),
  estimate: ForumEstimateSchema.default("unknown"),
  // Subtasks are tasks with a parent. One level is enough for V1; deeper nesting is a flat parent ref.
  parentTaskId: z.string().nullable().default(null),
  // Optional epic label to group related tasks on the board (e.g. "Auth", "UI", "Payments").
  epic: z.string().nullable().default(null),
  // The reporter: the agent that created the task (Jira "reporter"), with a display label.
  createdBy: z.string(),
  createdByLabel: z.string().nullable().default(null),
  createdAt_ms: z.number().int(),
  updatedAt_ms: z.number().int(),
  // Jira-style comment thread on the task itself.
  comments: z.array(ForumTaskCommentSchema).default([]),
  // Structured role reviews (open-code-review): findings + daemon-derived verdicts. The board renders
  // these and derives the task's done-ness from them.
  reviews: z.array(ForumTaskReviewSchema).default([]),
  history: z.array(ForumTaskEventSchema).default([]),
});
export type ForumTask = z.infer<typeof ForumTaskSchema>;

export const ForumMessageKindSchema = z.enum([
  "message",
  "research",
  "proposal",
  "question",
  "decision",
  "review",
  "handback",
  "status",
  "system",
]);
export type ForumMessageKind = z.infer<typeof ForumMessageKindSchema>;

export const ForumMessageSchema = z.object({
  id: z.string(),
  authorAgentId: z.string(),
  authorLabel: z.string(),
  role: ForumRoleSchema,
  kind: ForumMessageKindSchema.default("message"),
  text: z.string(),
  createdAt_ms: z.number().int(),
  // Task ids this message references (e.g. a decision about a task, a handback on a task).
  taskRefs: z.array(z.string()).default([]),
  // Forum threading: the post this one replies to, and/or a specific post it quotes (the UI renders a
  // quote block from that post). Agents get message ids from forum.get_topic.
  replyToId: z.string().nullable().default(null),
  quotedMessageId: z.string().nullable().default(null),
  // When an agent needs the human to answer/approve, it posts a question with this flag set; the UI
  // surfaces it in the agent chat and the thread until the human replies.
  awaitingHuman: z.boolean().default(false),
  // vBulletin-style reactions: the agentIds (or "user") who up/down-voted this post. The UI shows the
  // score (ups − downs); participants vote posts up when a point is solid, down when it's weak.
  upvoters: z.array(z.string()).default([]),
  downvoters: z.array(z.string()).default([]),
});
export type ForumMessage = z.infer<typeof ForumMessageSchema>;

export const StoredForumTopicSchema = z.object({
  id: z.string(),
  // Project the topic belongs to (per-project persistence). Empty for host-global topics.
  projectKey: z.string().default(""),
  title: z.string(),
  // The user's originating chat prompt that seeded this topic.
  originPrompt: z.string().default(""),
  status: ForumTopicStatusSchema,
  createdAt_ms: z.number().int(),
  updatedAt_ms: z.number().int(),
  // The agent that started the discussion (orchestration lead), if bootstrapped.
  leadAgentId: z.string().nullable().default(null),
  // Links back to the orchestration run driving the real work, if any.
  orchestrationRunId: z.string().nullable().default(null),
  participants: z.array(ForumParticipantSchema).default([]),
  messages: z.array(ForumMessageSchema).default([]),
  tasks: z.array(ForumTaskSchema).default([]),
  // Set when an agent is blocked on a human answer/approval (the id of the awaiting-human question
  // message + its text). Cleared when the human replies. Surfaced in the agent chat + thread.
  pendingHumanQuestion: z
    .object({ messageId: z.string(), text: z.string(), askedByLabel: z.string() })
    .nullable()
    .default(null),
});
export type StoredForumTopic = z.infer<typeof StoredForumTopicSchema>;

// Per-epic progress on a topic: the epic label plus how many of its tasks are done vs total. Kept on
// the summary so the dashboard's "tasks by epic" chart needs no full-topic fetch.
export const ForumEpicStatSchema = z.object({
  name: z.string(),
  done: z.number().int(),
  total: z.number().int(),
});
export type ForumEpicStat = z.infer<typeof ForumEpicStatSchema>;

// Compact list-view shape (omits messages/tasks arrays; carries counts) for the topic list.
export const ForumTopicSummarySchema = z.object({
  id: z.string(),
  projectKey: z.string(),
  title: z.string(),
  status: ForumTopicStatusSchema,
  createdAt_ms: z.number().int(),
  updatedAt_ms: z.number().int(),
  participantCount: z.number().int(),
  messageCount: z.number().int(),
  taskCount: z.number().int(),
  doneTaskCount: z.number().int(),
  // Task counts per status (keyed by ForumTaskStatus), for the Team dashboard charts — kept on the
  // summary so the overview needs no full-topic fetch.
  taskStatusCounts: z.record(z.string(), z.number().int()).default({}),
  // Per-epic progress (name + done/total task counts) used in this topic, for the epics breakdown
  // chart on the dashboard. Kept on the summary so the overview needs no full-topic fetch.
  epics: z.array(ForumEpicStatSchema).default([]),
});
export type ForumTopicSummary = z.infer<typeof ForumTopicSummarySchema>;
