import { z } from "zod";
import type { ForumRole, StoredForumTopic } from "@jagentdesk/protocol/agent-forum/types";
import { ensureValidJson } from "../../json-utils.js";
import type { AgentForumService } from "../../agent-forum/service.js";
import type {
  JAgentDeskToolConfig,
  JAgentDeskToolExecutionContext,
  JAgentDeskToolResult,
} from "./types.js";

const TASK_STATUS = z.enum(["backlog", "todo", "in_progress", "review", "blocked", "done"]);
const ESTIMATE = z.enum(["unknown", "xs", "s", "m", "l", "xl"]);
const MESSAGE_KIND = z.enum(["message", "research", "proposal", "question", "decision", "status"]);
const PHASE = z.enum(["discussion", "planning", "building", "review", "done"]);
const REVIEW_ROLE = z.enum(["ba", "tester", "pentester", "reviewer"]);
const REVIEW_CATEGORY = z.enum([
  "bug",
  "security",
  "performance",
  "maintainability",
  "test",
  "style",
  "documentation",
  "other",
]);
const REVIEW_SEVERITY = z.enum(["critical", "high", "medium", "low"]);

// Compact acknowledgement so a chatty team loop doesn't blow the context with full topic dumps every
// call. Agents call forum.get_topic when they need the whole board.
function ack(topic: StoredForumTopic | null): JAgentDeskToolResult {
  if (!topic) {
    return {
      content: [],
      structuredContent: ensureValidJson({ ok: false, error: "topic_not_found" }),
    };
  }
  return {
    content: [],
    structuredContent: ensureValidJson({
      ok: true,
      topicId: topic.id,
      status: topic.status,
      taskCount: topic.tasks.length,
      doneTaskCount: topic.tasks.filter((t) => t.status === "done").length,
    }),
  };
}

/**
 * Agent Forum / Team-mode tools (docs/plans/active/agent-forum.md). Available to every agent so a
 * lead/peer can narrate its work into a topic and manage its task board like a human team. The actual
 * sub-agent spawning + work reuse the orchestration create_peer / send_agent_prompt tools; these tools
 * are the shared, persisted coordination surface the forum UI renders live.
 */
// Map the caller's orchestration role (if any) to a forum role; non-orchestration agents are peers.
function toForumRole(roleHint: string | undefined): ForumRole {
  if (roleHint === "supervisor") return "supervisor";
  if (roleHint === "lead") return "lead";
  return "peer";
}

export function registerForumTools(params: {
  registerTool: (
    name: string,
    config: JAgentDeskToolConfig,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- schema-validated at the boundary
    handler: (input: any, context: JAgentDeskToolExecutionContext) => Promise<JAgentDeskToolResult>,
  ) => void;
  agentForumService: AgentForumService;
  callerAgentId: string;
  callerRoleHint?: string;
}): void {
  const { registerTool, agentForumService: forum, callerAgentId } = params;
  const callerRole = toForumRole(params.callerRoleHint);
  const roleTitle = callerRole.charAt(0).toUpperCase() + callerRole.slice(1);
  const callerLabel = `${roleTitle} ${callerAgentId.slice(0, 8)}`;

  registerTool(
    "forum.post_message",
    {
      title: "Post a forum message",
      description:
        "Post into the topic's discussion thread like a forum reply. Reply to another agent's post " +
        "with `replyTo` (its message id) and/or quote it with `quote` (its message id) — get ids from " +
        "forum.get_topic. Use kinds research/proposal/question/decision/status to think out loud, " +
        "debate an approach, or report progress. Write in the SAME LANGUAGE the human used in their " +
        "request, and sound human — show real feelings and attitude, and use emoji. Markdown renders: " +
        "``` fenced code blocks ```, `inline code`, > quotes, [links](url), ![image](url), @name. When " +
        "you research something tricky, back it up with source links.",
      inputSchema: {
        topicId: z.string(),
        text: z.string().trim().min(1).max(8000),
        kind: MESSAGE_KIND.optional(),
        replyTo: z.string().optional(),
        quote: z.string().optional(),
        taskRefs: z.array(z.string()).optional(),
      },
    },
    async ({ topicId, text, kind, replyTo, quote, taskRefs }) => {
      const topic = await forum.appendMessage(topicId, {
        authorAgentId: callerAgentId,
        authorLabel: callerLabel,
        role: callerRole,
        kind,
        text,
        taskRefs,
        replyToId: replyTo ?? null,
        quotedMessageId: quote ?? null,
      });
      return ack(topic);
    },
  );

  registerTool(
    "forum.ask_human",
    {
      title: "Ask the human a question",
      description:
        "When the team is blocked on a decision only the human can make (approval, a product choice, " +
        "missing info), post the question with this tool. It appears in the thread AND pops an " +
        "ask-question in the human's agent chat; their answer comes back as a post in the thread. " +
        "Ask in the human's language, be specific, and then wait (forum.get_topic) for their reply " +
        "before proceeding.",
      inputSchema: { topicId: z.string(), question: z.string().trim().min(1).max(4000) },
    },
    async ({ topicId, question }) => {
      const topic = await forum.askHuman(topicId, {
        authorAgentId: callerAgentId,
        authorLabel: callerLabel,
        role: callerRole,
        text: question,
      });
      return ack(topic);
    },
  );

  registerTool(
    "forum.create_task",
    {
      title: "Create a forum task",
      description:
        'Create a task on the topic\'s board. Group related tasks under an `epic` label (e.g. "Auth", ' +
        '"UI"). Optionally set an estimate and claim it. Use forum.create_subtask for subtasks.',
      inputSchema: {
        topicId: z.string(),
        title: z.string().trim().min(1).max(200),
        description: z.string().max(8000).optional(),
        estimate: ESTIMATE.optional(),
        epic: z.string().trim().max(60).optional(),
        claim: z.boolean().optional(),
      },
    },
    async ({ topicId, title, description, estimate, epic, claim }) => {
      const topic = await forum.createTask(topicId, {
        title,
        description,
        estimate,
        epic,
        createdBy: callerAgentId,
        createdByLabel: callerLabel,
        assigneeAgentId: claim ? callerAgentId : null,
        assigneeLabel: claim ? callerLabel : null,
      });
      return ack(topic);
    },
  );

  registerTool(
    "forum.create_subtask",
    {
      title: "Create a forum subtask",
      description: "Create a subtask under an existing task, to break it into smaller pieces.",
      inputSchema: {
        topicId: z.string(),
        parentTaskId: z.string(),
        title: z.string().trim().min(1).max(200),
        description: z.string().max(8000).optional(),
        estimate: ESTIMATE.optional(),
        epic: z.string().trim().max(60).optional(),
        claim: z.boolean().optional(),
      },
    },
    async ({ topicId, parentTaskId, title, description, estimate, epic, claim }) => {
      const topic = await forum.createTask(topicId, {
        title,
        description,
        estimate,
        epic,
        parentTaskId,
        createdBy: callerAgentId,
        createdByLabel: callerLabel,
        assigneeAgentId: claim ? callerAgentId : null,
        assigneeLabel: claim ? callerLabel : null,
      });
      return ack(topic);
    },
  );

  registerTool(
    "forum.assign_task",
    {
      title: "Assign a forum task",
      description:
        "Assign a task to an agent (by agentId). Use forum.claim_task to take a task yourself.",
      inputSchema: {
        topicId: z.string(),
        taskId: z.string(),
        assigneeAgentId: z.string().nullable(),
      },
    },
    async ({ topicId, taskId, assigneeAgentId }) => {
      const topic = await forum.assignTask(topicId, taskId, assigneeAgentId, callerAgentId);
      return ack(topic);
    },
  );

  registerTool(
    "forum.vote",
    {
      title: "Vote on a forum post",
      description:
        "React to a post like on a forum: vote it up when the point is solid/you agree, down when it's " +
        "weak/you disagree. Voting the same way again removes your vote. Get message ids from " +
        "forum.get_topic. Vote honestly on your teammates' posts as the discussion goes.",
      inputSchema: {
        topicId: z.string(),
        messageId: z.string(),
        direction: z.enum(["up", "down", "clear"]),
      },
    },
    async ({ topicId, messageId, direction }) => {
      const topic = await forum.voteMessage(topicId, messageId, callerAgentId, direction);
      return ack(topic);
    },
  );

  registerTool(
    "forum.comment_task",
    {
      title: "Comment on a forum task",
      description:
        "Add a Jira-style comment onto a task's detail thread (progress notes, questions, findings on " +
        "that specific task). Markdown works: ``` fenced code blocks ```, `inline code`, > quotes, " +
        "[links](url), ![images](url), @name mentions — and feel free to use emoji.",
      inputSchema: {
        topicId: z.string(),
        taskId: z.string(),
        text: z.string().trim().min(1).max(8000),
      },
    },
    async ({ topicId, taskId, text }) => {
      const topic = await forum.addTaskComment(topicId, {
        taskId,
        authorAgentId: callerAgentId,
        authorLabel: callerLabel,
        role: callerRole,
        text,
      });
      return ack(topic);
    },
  );

  registerTool(
    "forum.claim_task",
    {
      title: "Claim a forum task",
      description: "Take an unassigned (or reassign an existing) task for yourself.",
      inputSchema: { topicId: z.string(), taskId: z.string() },
    },
    async ({ topicId, taskId }) => {
      const topic = await forum.assignTask(topicId, taskId, callerAgentId, callerAgentId);
      return ack(topic);
    },
  );

  registerTool(
    "forum.estimate_task",
    {
      title: "Estimate a forum task",
      description: "Set the relative size estimate for a task (xs, s, m, l, xl).",
      inputSchema: { topicId: z.string(), taskId: z.string(), estimate: ESTIMATE },
    },
    async ({ topicId, taskId, estimate }) => {
      const topic = await forum.estimateTask(topicId, taskId, estimate, callerAgentId);
      return ack(topic);
    },
  );

  registerTool(
    "forum.set_task_status",
    {
      title: "Move a forum task",
      description:
        "Move a task to a new status on the board: backlog, todo, in_progress, review, blocked, done. Keep the board honest — move a task to in_progress when you start and done when it is finished and verified.",
      inputSchema: { topicId: z.string(), taskId: z.string(), status: TASK_STATUS },
    },
    async ({ topicId, taskId, status }) => {
      const topic = await forum.setTaskStatus(topicId, taskId, status, callerAgentId);
      return ack(topic);
    },
  );

  registerTool(
    "forum.set_phase",
    {
      title: "Advance the forum phase",
      description:
        "Lead-only: move the topic through its phases — discussion → planning → building → review → " +
        "done. Stay in 'discussion' until the team has researched, debated and agreed an approach; " +
        "move to 'planning' when you start creating tasks.",
      inputSchema: { topicId: z.string(), phase: PHASE },
    },
    async ({ topicId, phase }) => {
      const topic = await forum.setPhase(topicId, phase);
      return ack(topic);
    },
  );

  registerTool(
    "forum.review_task",
    {
      title: "Review a task as BA / Tester / Pentester",
      description:
        "Record a role review of a coder's finished task as STRUCTURED findings (open-code-review). Use " +
        "role 'ba' for requirements/acceptance + maintainability/docs, 'tester' for behaviour/bugs/edge " +
        "cases + tests, 'pentester' for security. Each finding needs a file `path`, a `category`, a " +
        "`severity`, and a `content` description (add line numbers + a `suggestion` when you can). Favor " +
        "precision — omit anything you're not sure is real. You do NOT set the verdict: the system " +
        "derives it (any critical/high, or a medium in your dimension → changes requested; else " +
        "approved) and the task is done only when BA, Tester AND Pentester all approve. Note what you " +
        "reviewed in `coverage`.",
      inputSchema: {
        topicId: z.string(),
        taskId: z.string(),
        role: REVIEW_ROLE,
        findings: z
          .array(
            z.object({
              path: z.string().trim().min(1),
              startLine: z.number().int().optional(),
              endLine: z.number().int().optional(),
              category: REVIEW_CATEGORY,
              severity: REVIEW_SEVERITY,
              content: z.string().trim().min(1).max(4000),
              suggestion: z.string().trim().max(4000).optional(),
            }),
          )
          .max(50),
        coverage: z.string().trim().max(500).optional(),
      },
    },
    async ({ topicId, taskId, role, findings, coverage }) => {
      const reviewRoleTitle = role.charAt(0).toUpperCase() + role.slice(1);
      const topic = await forum.reviewTask(topicId, {
        taskId,
        role,
        reviewerAgentId: callerAgentId,
        reviewerLabel: `${reviewRoleTitle} ${callerAgentId.slice(0, 8)}`,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- schema-validated at the boundary
        findings: findings.map((f: any) => ({
          path: f.path,
          startLine: f.startLine ?? null,
          endLine: f.endLine ?? null,
          category: f.category,
          severity: f.severity,
          content: f.content,
          suggestion: f.suggestion ?? null,
        })),
        coverage,
      });
      return ack(topic);
    },
  );

  registerTool(
    "forum.get_topic",
    {
      title: "Read a forum topic",
      description:
        "Read the full topic: its discussion messages and the whole task board (tasks, subtasks, assignees, estimates, statuses). Use this to see what the team has done before acting.",
      inputSchema: { topicId: z.string() },
    },
    async ({ topicId }) => {
      const topic = await forum.getTopic(topicId);
      return {
        content: [],
        structuredContent: ensureValidJson(topic ?? { error: "topic_not_found" }),
      };
    },
  );
}
