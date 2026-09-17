import type { Logger } from "pino";
import type {
  ForumEstimate,
  ForumMessage,
  ForumMessageKind,
  ForumParticipant,
  ForumRole,
  ForumTask,
  ForumTaskStatus,
  ForumTopicStatus,
  ForumTopicSummary,
  StoredForumTopic,
} from "@jagentdesk/protocol/agent-forum/types";
import { AgentForumStore, generateForumId } from "./store.js";

export interface AgentForumServiceOptions {
  dir: string;
  logger: Logger;
  // Broadcast a topic to all connected clients whenever it changes (forum.stream).
  onUpdate?: (topic: StoredForumTopic) => void;
}

// The active task statuses (i.e. work still to do). Used to derive the topic-level status from the
// facts of its tasks (open-code-review discipline: never store an ad-hoc rollup that can drift).
const ACTIVE_TASK_STATUSES: ReadonlySet<ForumTaskStatus> = new Set([
  "backlog",
  "todo",
  "in_progress",
  "blocked",
]);

function deriveTopicStatus(current: ForumTopicStatus, tasks: ForumTask[]): ForumTopicStatus {
  if (current === "archived") return "archived";
  // No tasks yet → the team is still discussing (unless the lead already advanced the phase).
  if (tasks.length === 0) return current === "planning" ? "planning" : "discussion";
  if (tasks.every((t) => t.status === "done")) return "done";
  const anyActive = tasks.some((t) => ACTIVE_TASK_STATUSES.has(t.status));
  const anyReview = tasks.some((t) => t.status === "review");
  if (!anyActive && anyReview) return "review";
  return "building";
}

function toSummary(topic: StoredForumTopic): ForumTopicSummary {
  const taskStatusCounts: Record<string, number> = {};
  const epicMap = new Map<string, { name: string; done: number; total: number }>();
  for (const t of topic.tasks) {
    taskStatusCounts[t.status] = (taskStatusCounts[t.status] ?? 0) + 1;
    if (t.epic) {
      const entry = epicMap.get(t.epic) ?? { name: t.epic, done: 0, total: 0 };
      entry.total += 1;
      if (t.status === "done") entry.done += 1;
      epicMap.set(t.epic, entry);
    }
  }
  return {
    id: topic.id,
    projectKey: topic.projectKey,
    title: topic.title,
    status: topic.status,
    createdAt_ms: topic.createdAt_ms,
    updatedAt_ms: topic.updatedAt_ms,
    participantCount: topic.participants.length,
    messageCount: topic.messages.length,
    taskCount: topic.tasks.length,
    doneTaskCount: topic.tasks.filter((t) => t.status === "done").length,
    taskStatusCounts,
    epics: [...epicMap.values()],
  };
}

/**
 * Data + lifecycle layer for the Agent Forum / Team mode (docs/plans/active/agent-forum.md). Owns
 * topic/message/task persistence and status derivation; the real agent work runs on the orchestration
 * runtime, which mirrors its events in here via these methods (or the forum.* agent tools).
 */
export class AgentForumService {
  private readonly store: AgentForumStore;
  private readonly logger: Logger;
  private readonly onUpdate?: (topic: StoredForumTopic) => void;

  constructor(options: AgentForumServiceOptions) {
    this.store = new AgentForumStore(options.dir);
    this.logger = options.logger.child({ module: "agent-forum" });
    this.onUpdate = options.onUpdate;
  }

  async listSummaries(): Promise<ForumTopicSummary[]> {
    const topics = await this.store.list();
    return topics.map(toSummary);
  }

  async getTopic(topicId: string): Promise<StoredForumTopic | null> {
    return this.store.get(topicId);
  }

  async createTopic(input: {
    prompt: string;
    title?: string;
    projectKey?: string;
    leadAgentId?: string | null;
    orchestrationRunId?: string | null;
    participants?: ForumParticipant[];
  }): Promise<StoredForumTopic> {
    const now = Date.now();
    const topic: StoredForumTopic = {
      id: generateForumId("topic"),
      projectKey: input.projectKey ?? "",
      title: (input.title ?? deriveTitle(input.prompt)).slice(0, 200),
      originPrompt: input.prompt,
      status: "discussion",
      createdAt_ms: now,
      updatedAt_ms: now,
      leadAgentId: input.leadAgentId ?? null,
      orchestrationRunId: input.orchestrationRunId ?? null,
      participants: input.participants ?? [],
      messages: [
        {
          id: generateForumId("msg"),
          authorAgentId: "user",
          authorLabel: "You",
          role: "user",
          kind: "message",
          text: input.prompt,
          createdAt_ms: now,
          taskRefs: [],
          replyToId: null,
          quotedMessageId: null,
          awaitingHuman: false,
          upvoters: [],
          downvoters: [],
        },
      ],
      tasks: [],
      pendingHumanQuestion: null,
    };
    const created = await this.store.create(topic);
    this.emit(created);
    this.logger.info({ topicId: created.id }, "Forum topic created");
    return created;
  }

  async appendMessage(
    topicId: string,
    message: {
      authorAgentId: string;
      authorLabel: string;
      role: ForumRole;
      kind?: ForumMessageKind;
      text: string;
      taskRefs?: string[];
      replyToId?: string | null;
      quotedMessageId?: string | null;
      awaitingHuman?: boolean;
    },
  ): Promise<StoredForumTopic | null> {
    return this.mutate(topicId, (topic) => {
      const entry: ForumMessage = {
        id: generateForumId("msg"),
        authorAgentId: message.authorAgentId,
        authorLabel: message.authorLabel,
        role: message.role,
        kind: message.kind ?? "message",
        text: message.text,
        createdAt_ms: Date.now(),
        taskRefs: message.taskRefs ?? [],
        replyToId: message.replyToId ?? null,
        quotedMessageId: message.quotedMessageId ?? null,
        awaitingHuman: message.awaitingHuman ?? false,
        upvoters: [],
        downvoters: [],
      };
      topic.messages.push(entry);
      ensureParticipant(topic, message.authorAgentId, message.authorLabel, message.role);
      return topic;
    });
  }

  // An agent blocks on a human answer/approval: post a question into the thread and mark the topic as
  // awaiting the human. The agent chat surfaces this so the human can reply; their reply clears it.
  async askHuman(
    topicId: string,
    input: { authorAgentId: string; authorLabel: string; role: ForumRole; text: string },
  ): Promise<StoredForumTopic | null> {
    return this.mutate(topicId, (topic) => {
      const messageId = generateForumId("msg");
      topic.messages.push({
        id: messageId,
        authorAgentId: input.authorAgentId,
        authorLabel: input.authorLabel,
        role: input.role,
        kind: "question",
        text: input.text,
        createdAt_ms: Date.now(),
        taskRefs: [],
        replyToId: null,
        quotedMessageId: null,
        awaitingHuman: true,
        upvoters: [],
        downvoters: [],
      });
      ensureParticipant(topic, input.authorAgentId, input.authorLabel, input.role);
      topic.pendingHumanQuestion = { messageId, text: input.text, askedByLabel: input.authorLabel };
      return topic;
    });
  }

  // The human answers a pending question: append their post (role "user") and clear the pending flag
  // (and the awaitingHuman marker on the question it answers).
  async postHumanMessage(
    topicId: string,
    input: { text: string; replyToId?: string | null },
  ): Promise<StoredForumTopic | null> {
    return this.mutate(topicId, (topic) => {
      const pendingId = topic.pendingHumanQuestion?.messageId ?? null;
      topic.messages.push({
        id: generateForumId("msg"),
        authorAgentId: "user",
        authorLabel: "You",
        role: "user",
        kind: "message",
        text: input.text,
        createdAt_ms: Date.now(),
        taskRefs: [],
        replyToId: input.replyToId ?? pendingId,
        quotedMessageId: null,
        awaitingHuman: false,
        upvoters: [],
        downvoters: [],
      });
      const pending = topic.messages.find((m) => m.id === pendingId);
      if (pending) pending.awaitingHuman = false;
      topic.pendingHumanQuestion = null;
      return topic;
    });
  }

  async createTask(
    topicId: string,
    input: {
      title: string;
      description?: string;
      createdBy: string;
      createdByLabel?: string | null;
      parentTaskId?: string | null;
      assigneeAgentId?: string | null;
      assigneeLabel?: string | null;
      estimate?: ForumEstimate;
      epic?: string | null;
    },
  ): Promise<StoredForumTopic | null> {
    return this.mutate(topicId, (topic) => {
      const now = Date.now();
      const task: ForumTask = {
        id: generateForumId("task"),
        title: input.title,
        description: input.description ?? "",
        status: "backlog",
        assigneeAgentId: input.assigneeAgentId ?? null,
        assigneeLabel: input.assigneeLabel ?? null,
        estimate: input.estimate ?? "unknown",
        parentTaskId: input.parentTaskId ?? null,
        epic: input.epic ?? null,
        createdBy: input.createdBy,
        createdByLabel: input.createdByLabel ?? null,
        createdAt_ms: now,
        updatedAt_ms: now,
        comments: [],
        history: [{ at_ms: now, actorAgentId: input.createdBy, kind: "created", to: "backlog" }],
      };
      topic.tasks.push(task);
      topic.status = deriveTopicStatus(topic.status, topic.tasks);
      return topic;
    });
  }

  // Add a Jira-style comment onto a task (agents discuss the task in its detail view).
  async addTaskComment(
    topicId: string,
    input: {
      taskId: string;
      authorAgentId: string;
      authorLabel: string;
      role: ForumRole;
      text: string;
    },
  ): Promise<StoredForumTopic | null> {
    return this.mutate(topicId, (topic) => {
      const task = topic.tasks.find((t) => t.id === input.taskId);
      if (!task) throw new Error(`Task not found: ${input.taskId}`);
      const now = Date.now();
      task.comments.push({
        id: generateForumId("cmt"),
        authorAgentId: input.authorAgentId,
        authorLabel: input.authorLabel,
        role: input.role,
        text: input.text,
        createdAt_ms: now,
      });
      task.updatedAt_ms = now;
      ensureParticipant(topic, input.authorAgentId, input.authorLabel, input.role);
      return topic;
    });
  }

  // vBulletin-style vote on a post. direction "up"/"down" toggles that voter's reaction (voting the
  // same way again clears it, like flipping a thumbs-up off); "clear" removes any reaction.
  async voteMessage(
    topicId: string,
    messageId: string,
    voterId: string,
    direction: "up" | "down" | "clear",
  ): Promise<StoredForumTopic | null> {
    return this.mutate(topicId, (topic) => {
      const msg = topic.messages.find((m) => m.id === messageId);
      if (!msg) throw new Error(`Message not found: ${messageId}`);
      const hadUp = msg.upvoters.includes(voterId);
      const hadDown = msg.downvoters.includes(voterId);
      msg.upvoters = msg.upvoters.filter((v) => v !== voterId);
      msg.downvoters = msg.downvoters.filter((v) => v !== voterId);
      if (direction === "up" && !hadUp) msg.upvoters.push(voterId);
      if (direction === "down" && !hadDown) msg.downvoters.push(voterId);
      return topic;
    });
  }

  // Human-only: permanently delete a topic (manage/clean up old forums).
  async deleteTopic(topicId: string): Promise<boolean> {
    const existing = await this.store.get(topicId);
    if (!existing) return false;
    await this.store.delete(topicId);
    return true;
  }

  async assignTask(
    topicId: string,
    taskId: string,
    assigneeAgentId: string | null,
    actorAgentId: string,
    assigneeLabel?: string | null,
  ): Promise<StoredForumTopic | null> {
    return this.updateTask(topicId, taskId, actorAgentId, (task) => {
      if (task.assigneeAgentId === assigneeAgentId) return null;
      const from = task.assigneeAgentId ?? "";
      task.assigneeAgentId = assigneeAgentId;
      task.assigneeLabel = assigneeAgentId ? (assigneeLabel ?? task.assigneeLabel) : null;
      return { kind: "assigned", from, to: assigneeAgentId ?? "" };
    });
  }

  async estimateTask(
    topicId: string,
    taskId: string,
    estimate: ForumEstimate,
    actorAgentId: string,
  ): Promise<StoredForumTopic | null> {
    return this.updateTask(topicId, taskId, actorAgentId, (task) => {
      if (task.estimate === estimate) return null;
      const from = task.estimate;
      task.estimate = estimate;
      return { kind: "estimated", from, to: estimate };
    });
  }

  async setTaskStatus(
    topicId: string,
    taskId: string,
    status: ForumTaskStatus,
    actorAgentId: string,
  ): Promise<StoredForumTopic | null> {
    return this.updateTask(topicId, taskId, actorAgentId, (task) => {
      if (task.status === status) return null; // idempotent
      const from = task.status;
      task.status = status;
      return { kind: "status", from, to: status };
    });
  }

  async archiveTopic(topicId: string): Promise<StoredForumTopic | null> {
    return this.mutate(topicId, (topic) => {
      topic.status = "archived";
      return topic;
    });
  }

  // The lead advances the topic phase (discussion → planning → building → review → done). Never
  // overrides "archived"; task-driven derivation still applies afterwards on any task change.
  async setPhase(topicId: string, phase: ForumTopicStatus): Promise<StoredForumTopic | null> {
    return this.mutate(topicId, (topic) => {
      if (topic.status !== "archived") topic.status = phase;
      return topic;
    });
  }

  // A reviewer (BA / Tester / Pentester) records a role-based review of a task and either approves it
  // (→ done) or requests changes (→ in_progress), posting the findings into the thread (ADR-0019 /
  // open-code-review role review).
  async reviewTask(
    topicId: string,
    input: {
      taskId: string;
      role: ForumRole;
      reviewerAgentId: string;
      reviewerLabel: string;
      verdict: "approve" | "request_changes";
      findings: string;
    },
  ): Promise<StoredForumTopic | null> {
    return this.mutate(topicId, (topic) => {
      const task = topic.tasks.find((t) => t.id === input.taskId);
      if (!task) throw new Error(`Task not found: ${input.taskId}`);
      const now = Date.now();
      topic.messages.push({
        id: generateForumId("msg"),
        authorAgentId: input.reviewerAgentId,
        authorLabel: input.reviewerLabel,
        role: input.role,
        kind: "review",
        text: input.findings,
        createdAt_ms: now,
        taskRefs: [input.taskId],
        replyToId: null,
        quotedMessageId: null,
        awaitingHuman: false,
        upvoters: [],
        downvoters: [],
      });
      ensureParticipant(topic, input.reviewerAgentId, input.reviewerLabel, input.role);
      const to: ForumTaskStatus = input.verdict === "approve" ? "done" : "in_progress";
      if (task.status !== to) {
        task.updatedAt_ms = now;
        task.history.push({
          at_ms: now,
          actorAgentId: input.reviewerAgentId,
          kind: "status",
          from: task.status,
          to,
          note: `${input.role} ${input.verdict}`,
        });
        task.status = to;
      }
      topic.status = deriveTopicStatus(topic.status, topic.tasks);
      return topic;
    });
  }

  // Shared task-mutation path: applies `apply`, records a history event if it changed, bumps
  // timestamps, and re-derives the topic status. `apply` returns the event to record, or null for a
  // no-op (idempotent).
  private async updateTask(
    topicId: string,
    taskId: string,
    actorAgentId: string,
    apply: (
      task: ForumTask,
    ) => { kind: "assigned" | "estimated" | "status"; from: string; to: string } | null,
  ): Promise<StoredForumTopic | null> {
    return this.mutate(topicId, (topic) => {
      const task = topic.tasks.find((t) => t.id === taskId);
      if (!task) throw new Error(`Task not found: ${taskId}`);
      const event = apply(task);
      if (event) {
        const now = Date.now();
        task.updatedAt_ms = now;
        task.history.push({ at_ms: now, actorAgentId, ...event });
        topic.status = deriveTopicStatus(topic.status, topic.tasks);
      }
      return topic;
    });
  }

  private async mutate(
    topicId: string,
    fn: (topic: StoredForumTopic) => StoredForumTopic,
  ): Promise<StoredForumTopic | null> {
    const updated = await this.store.update(topicId, (topic) => {
      const next = fn(topic);
      next.updatedAt_ms = Date.now();
      return next;
    });
    if (updated) this.emit(updated);
    return updated;
  }

  private emit(topic: StoredForumTopic): void {
    this.onUpdate?.(topic);
  }
}

function ensureParticipant(
  topic: StoredForumTopic,
  agentId: string,
  label: string,
  role: ForumRole,
): void {
  if (topic.participants.some((p) => p.agentId === agentId)) return;
  topic.participants.push({ agentId, label, role });
}

function deriveTitle(prompt: string): string {
  const firstLine = prompt.split("\n").find((line) => line.trim().length > 0) ?? prompt;
  return firstLine.trim().slice(0, 120) || "Untitled topic";
}
