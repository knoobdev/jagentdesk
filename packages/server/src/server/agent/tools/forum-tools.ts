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
const VERDICT = z.enum(["approve", "request_changes"]);

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
        "Post a message into a Team-mode topic's discussion thread (a proposal, decision, status update, or plain note). Use this to think out loud, propose an approach, or report progress to the team.",
      inputSchema: {
        topicId: z.string(),
        text: z.string().trim().min(1).max(8000),
        kind: MESSAGE_KIND.optional(),
        taskRefs: z.array(z.string()).optional(),
      },
    },
    async ({ topicId, text, kind, taskRefs }) => {
      const topic = await forum.appendMessage(topicId, {
        authorAgentId: callerAgentId,
        authorLabel: callerLabel,
        role: callerRole,
        kind,
        text,
        taskRefs,
      });
      return ack(topic);
    },
  );

  registerTool(
    "forum.create_task",
    {
      title: "Create a forum task",
      description:
        "Create a task on the topic's board. Optionally set an estimate and claim it for yourself. Break large work into several tasks; use forum.create_subtask for subtasks of a task.",
      inputSchema: {
        topicId: z.string(),
        title: z.string().trim().min(1).max(200),
        description: z.string().max(8000).optional(),
        estimate: ESTIMATE.optional(),
        claim: z.boolean().optional(),
      },
    },
    async ({ topicId, title, description, estimate, claim }) => {
      const topic = await forum.createTask(topicId, {
        title,
        description,
        estimate,
        createdBy: callerAgentId,
        assigneeAgentId: claim ? callerAgentId : null,
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
        claim: z.boolean().optional(),
      },
    },
    async ({ topicId, parentTaskId, title, description, estimate, claim }) => {
      const topic = await forum.createTask(topicId, {
        title,
        description,
        estimate,
        parentTaskId,
        createdBy: callerAgentId,
        assigneeAgentId: claim ? callerAgentId : null,
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
        "Record a role-based review of a coder's finished task and either approve it (→ done) or " +
        "request changes (→ back to in_progress). Use role 'ba' for requirements/acceptance, " +
        "'tester' for QA/behaviour, 'pentester' for security. Put concrete findings in `findings`.",
      inputSchema: {
        topicId: z.string(),
        taskId: z.string(),
        role: REVIEW_ROLE,
        verdict: VERDICT,
        findings: z.string().trim().min(1).max(8000),
      },
    },
    async ({ topicId, taskId, role, verdict, findings }) => {
      const reviewRoleTitle = role.charAt(0).toUpperCase() + role.slice(1);
      const topic = await forum.reviewTask(topicId, {
        taskId,
        role,
        reviewerAgentId: callerAgentId,
        reviewerLabel: `${reviewRoleTitle} ${callerAgentId.slice(0, 8)}`,
        verdict,
        findings,
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
