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
  if (tasks.length === 0) return "planning";
  if (tasks.every((t) => t.status === "done")) return "done";
  const anyActive = tasks.some((t) => ACTIVE_TASK_STATUSES.has(t.status));
  const anyReview = tasks.some((t) => t.status === "review");
  if (!anyActive && anyReview) return "review";
  return "in_progress";
}

function toSummary(topic: StoredForumTopic): ForumTopicSummary {
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
      status: "planning",
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
        },
      ],
      tasks: [],
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
      };
      topic.messages.push(entry);
      ensureParticipant(topic, message.authorAgentId, message.authorLabel, message.role);
      return topic;
    });
  }

  async createTask(
    topicId: string,
    input: {
      title: string;
      description?: string;
      createdBy: string;
      parentTaskId?: string | null;
      assigneeAgentId?: string | null;
      estimate?: ForumEstimate;
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
        estimate: input.estimate ?? "unknown",
        parentTaskId: input.parentTaskId ?? null,
        createdBy: input.createdBy,
        createdAt_ms: now,
        updatedAt_ms: now,
        history: [{ at_ms: now, actorAgentId: input.createdBy, kind: "created", to: "backlog" }],
      };
      topic.tasks.push(task);
      topic.status = deriveTopicStatus(topic.status, topic.tasks);
      return topic;
    });
  }

  async assignTask(
    topicId: string,
    taskId: string,
    assigneeAgentId: string | null,
    actorAgentId: string,
  ): Promise<StoredForumTopic | null> {
    return this.updateTask(topicId, taskId, actorAgentId, (task) => {
      if (task.assigneeAgentId === assigneeAgentId) return null;
      const from = task.assigneeAgentId ?? "";
      task.assigneeAgentId = assigneeAgentId;
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
