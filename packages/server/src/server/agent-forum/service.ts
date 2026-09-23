import type { Logger } from "pino";
import type {
  ForumChatMessage,
  ForumChatMessageKind,
  ForumChatRoom,
  ForumEstimate,
  ForumMessage,
  ForumDiagram,
  ForumMessageKind,
  ForumParticipant,
  ForumReviewFinding,
  ForumRole,
  ForumTask,
  ForumTaskReview,
  ForumTaskStatus,
  ForumTopicStatus,
  ForumTopicSummary,
  StoredForumTopic,
} from "@jagentdesk/protocol/agent-forum/types";
import { AgentForumStore, generateForumId } from "./store.js";

// Which review categories each role is the owner of (open-code-review dimension split). A medium
// finding in your own dimension blocks; criticals/highs from anyone always block.
const REVIEW_ROLE_DIMENSIONS: Partial<Record<ForumRole, ReadonlySet<string>>> = {
  ba: new Set(["maintainability", "documentation", "other"]),
  tester: new Set(["test", "bug"]),
  pentester: new Set(["security"]),
};
const REQUIRED_REVIEW_ROLES: readonly ForumRole[] = ["ba", "tester", "pentester"];

// The daemon (not the agent) decides the verdict from the findings: any critical/high blocks, and a
// medium in the role's own dimension blocks; otherwise it's an approval.
function deriveReviewVerdict(
  role: ForumRole,
  findings: ForumReviewFinding[],
): "approve" | "request_changes" {
  const core = REVIEW_ROLE_DIMENSIONS[role];
  const blocking = findings.some(
    (f) =>
      f.severity === "critical" ||
      f.severity === "high" ||
      (f.severity === "medium" && (core?.has(f.category) ?? false)),
  );
  return blocking ? "request_changes" : "approve";
}

// A task under review is done only once every required role's latest review approves; a single
// request_changes sends it back to in_progress; otherwise it stays in review awaiting the rest.
function deriveTaskStatusFromReviews(task: ForumTask): ForumTaskStatus {
  const latestByRole = new Map<ForumRole, ForumTaskReview>();
  for (const r of task.reviews) latestByRole.set(r.role, r);
  const latest = [...latestByRole.values()];
  if (latest.some((r) => r.verdict === "request_changes")) return "in_progress";
  const allApproved = REQUIRED_REVIEW_ROLES.every(
    (role) => latestByRole.get(role)?.verdict === "approve",
  );
  return allApproved ? "done" : "review";
}

const SEVERITY_ICON: Record<string, string> = {
  critical: "🟥",
  high: "🟧",
  medium: "🟨",
  low: "⬜",
};

// Render structured findings as a Markdown summary for the task comment + thread timeline.
function renderReviewMarkdown(
  verdict: "approve" | "request_changes",
  findings: ForumReviewFinding[],
  coverage: string,
): string {
  const head = verdict === "approve" ? "✅ **Approved**" : "🔴 **Changes requested**";
  const cov = coverage ? ` · _${coverage}_` : "";
  if (findings.length === 0) return `${head}${cov} — no blocking findings.`;
  const lines = findings.map((f) => {
    const where = f.startLine ? `\`${f.path}:${f.startLine}\`` : `\`${f.path}\``;
    const icon = SEVERITY_ICON[f.severity] ?? "⬜";
    const sug = f.suggestion ? `\n  ↳ ${f.suggestion}` : "";
    return `- ${icon} **${f.severity}/${f.category}** ${where} — ${f.content}${sug}`;
  });
  return `${head}${cov}\n${lines.join("\n")}`;
}

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
  // Idempotency for team bootstrap: one origin/lead agent should own exactly one bootstrapped topic
  // per create burst. A double-fired forum/create (Enter + keyboard "send", a draft handoff replay, a
  // double-tap) would otherwise mint N topics and re-dispatch the team-lead prompt N times, spawning
  // phantom peers. We reserve the lead synchronously (in-flight promise) and remember the last topic it
  // created for a short window so near-duplicate calls reuse it instead of creating another team.
  private readonly leadBootstrapInFlight = new Map<string, Promise<StoredForumTopic>>();
  private readonly recentLeadTopic = new Map<string, { topicId: string; at_ms: number }>();
  private static readonly LEAD_DEDUPE_WINDOW_MS = 30_000;

  constructor(options: AgentForumServiceOptions) {
    this.store = new AgentForumStore(options.dir);
    this.logger = options.logger.child({ module: "agent-forum" });
    this.onUpdate = options.onUpdate;
  }

  // Create a topic for a team bootstrap, deduping by the lead/origin agent so a repeated forum/create
  // for the same lead returns the already-created topic instead of a duplicate. `created` is false when
  // an existing topic was reused, so the caller can skip re-dispatching the (expensive) lead bootstrap.
  async createBootstrapTopic(input: {
    prompt: string;
    title?: string;
    projectKey?: string;
    leadAgentId?: string | null;
    orchestrationRunId?: string | null;
    participants?: ForumParticipant[];
  }): Promise<{ topic: StoredForumTopic; created: boolean }> {
    const lead = input.leadAgentId ?? null;
    if (!lead) {
      return { topic: await this.createTopic(input), created: true };
    }
    // A concurrent forum/create for the same lead is already resolving this burst — join it. Checked
    // and reserved with NO await in between so two simultaneous calls cannot both pass the guard.
    const inFlight = this.leadBootstrapInFlight.get(lead);
    if (inFlight) {
      return { topic: await inFlight, created: false };
    }
    let created = true;
    const work = (async (): Promise<StoredForumTopic> => {
      const reused = await this.findRecentTopicForLead(lead);
      if (reused) {
        created = false;
        this.logger.info(
          { leadAgentId: lead, topicId: reused.id },
          "Forum bootstrap deduped: reusing recent topic for lead",
        );
        return reused;
      }
      const topic = await this.createTopic(input);
      this.recentLeadTopic.set(lead, { topicId: topic.id, at_ms: Date.now() });
      return topic;
    })();
    this.leadBootstrapInFlight.set(lead, work);
    try {
      const topic = await work;
      return { topic, created };
    } finally {
      this.leadBootstrapInFlight.delete(lead);
    }
  }

  // The most recent still-existing topic this lead created inside the dedupe window, or null.
  private async findRecentTopicForLead(lead: string): Promise<StoredForumTopic | null> {
    const recent = this.recentLeadTopic.get(lead);
    if (!recent) return null;
    if (Date.now() - recent.at_ms > AgentForumService.LEAD_DEDUPE_WINDOW_MS) {
      this.recentLeadTopic.delete(lead);
      return null;
    }
    const topic = await this.store.get(recent.topicId);
    if (!topic) {
      this.recentLeadTopic.delete(lead);
      return null;
    }
    return topic;
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
          images: [],
        },
      ],
      tasks: [],
      pendingHumanQuestion: null,
      // Seed a default "general" banter room so the team always has somewhere to chat while they work.
      chatRooms: [
        {
          id: generateForumId("room"),
          name: "general",
          topic: "team banter while we build",
          createdByLabel: "You",
          createdAt_ms: now,
        },
      ],
      chatMessages: [],
      diagrams: [],
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
      images?: string[];
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
        images: message.images ?? [],
      };
      topic.messages.push(entry);
      ensureParticipant(topic, message.authorAgentId, message.authorLabel, message.role);
      // Recording a decision resolves any outstanding "waiting on the boss" state (the lead posts the
      // boss's answer as a decision after AskUserQuestion), so the thread banner clears.
      if (entry.kind === "decision" && topic.pendingHumanQuestion) {
        const pending = topic.messages.find((m) => m.id === topic.pendingHumanQuestion?.messageId);
        if (pending) pending.awaitingHuman = false;
        topic.pendingHumanQuestion = null;
      }
      return topic;
    });
  }

  // --- Banter side-channel (see ForumChatRoom/ForumChatMessage) ---------------------------------------

  // Open a new casual chat room in a topic. Returns the room's id so the caller can post into it.
  async createChatRoom(
    topicId: string,
    input: { name: string; topic?: string; byAgentId: string; byLabel: string; role: ForumRole },
  ): Promise<{ topic: StoredForumTopic; roomId: string } | null> {
    const roomId = generateForumId("room");
    const updated = await this.mutate(topicId, (topic) => {
      const room: ForumChatRoom = {
        id: roomId,
        name: input.name.trim().slice(0, 60) || "room",
        topic: (input.topic ?? "").slice(0, 200),
        createdByLabel: input.byLabel,
        createdAt_ms: Date.now(),
      };
      topic.chatRooms.push(room);
      ensureParticipant(topic, input.byAgentId, input.byLabel, input.role);
      return topic;
    });
    return updated ? { topic: updated, roomId } : null;
  }

  // Publish a new version of the topic's architecture diagram (Mermaid). Each call appends a
  // version so the human can step through how the design evolved (early ones can be wrong).
  async setDiagram(
    topicId: string,
    input: {
      title?: string;
      source: string;
      note?: string;
      byAgentId: string;
      byLabel: string;
      role: ForumRole;
    },
  ): Promise<{ topic: StoredForumTopic; diagramId: string; version: number } | null> {
    const diagramId = generateForumId("diagram");
    let version = 1;
    const updated = await this.mutate(topicId, (topic) => {
      version = (topic.diagrams.at(-1)?.version ?? 0) + 1;
      const diagram: ForumDiagram = {
        id: diagramId,
        version,
        title: (input.title ?? "Architecture").trim().slice(0, 120) || "Architecture",
        format: "mermaid",
        source: input.source,
        authorAgentId: input.byAgentId,
        authorLabel: input.byLabel,
        note: (input.note ?? "").slice(0, 500),
        createdAt_ms: Date.now(),
      };
      topic.diagrams.push(diagram);
      ensureParticipant(topic, input.byAgentId, input.byLabel, input.role);
      return topic;
    });
    return updated ? { topic: updated, diagramId, version } : null;
  }

  // Post a banter message (text or a built-in sticker) into a room. Falls back to the "general" room
  // when the caller doesn't name a valid one, so a quick chat never fails on a stale room id.
  async postChatMessage(
    topicId: string,
    input: {
      roomId?: string | null;
      authorAgentId: string;
      authorLabel: string;
      role: ForumRole;
      kind?: ForumChatMessageKind;
      text?: string;
      stickerId?: string | null;
      replyToId?: string | null;
      images?: string[];
    },
  ): Promise<StoredForumTopic | null> {
    return this.mutate(topicId, (topic) => {
      const room = resolveChatRoom(topic, input.roomId);
      const entry: ForumChatMessage = {
        id: generateForumId("chat"),
        roomId: room.id,
        authorAgentId: input.authorAgentId,
        authorLabel: input.authorLabel,
        role: input.role,
        kind: input.kind ?? "text",
        text: (input.text ?? "").slice(0, 2000),
        stickerId: input.stickerId ?? null,
        replyToId: input.replyToId ?? null,
        reactions: [],
        images: input.images ?? [],
        createdAt_ms: Date.now(),
      };
      topic.chatMessages.push(entry);
      ensureParticipant(topic, input.authorAgentId, input.authorLabel, input.role);
      return topic;
    });
  }

  // Toggle an emoji reaction on a banter message (like tapping a reaction in Telegram).
  async reactChatMessage(
    topicId: string,
    input: { messageId: string; emoji: string; by: string },
  ): Promise<StoredForumTopic | null> {
    return this.mutate(topicId, (topic) => {
      const message = topic.chatMessages.find((m) => m.id === input.messageId);
      if (!message) return topic;
      const emoji = input.emoji.slice(0, 8);
      const existing = message.reactions.find((r) => r.emoji === emoji);
      if (!existing) {
        message.reactions.push({ emoji, by: [input.by] });
        return topic;
      }
      if (existing.by.includes(input.by)) {
        existing.by = existing.by.filter((b) => b !== input.by);
        message.reactions = message.reactions.filter((r) => r.by.length > 0);
      } else {
        existing.by.push(input.by);
      }
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
        images: [],
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
        images: [],
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
        reviews: [],
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

  // A reviewer (BA / Tester / Pentester) records a role review of a task as STRUCTURED findings
  // (open-code-review). The daemon — not the agent — derives the verdict from finding severities, keeps
  // one latest review per role, and re-derives the task's status (done only when all required roles
  // approve; a single request_changes sends it back to in_progress).
  async reviewTask(
    topicId: string,
    input: {
      taskId: string;
      role: ForumRole;
      reviewerAgentId: string;
      reviewerLabel: string;
      findings: ForumReviewFinding[];
      coverage?: string;
    },
  ): Promise<StoredForumTopic | null> {
    return this.mutate(topicId, (topic) => {
      const task = topic.tasks.find((t) => t.id === input.taskId);
      if (!task) throw new Error(`Task not found: ${input.taskId}`);
      const now = Date.now();
      const verdict = deriveReviewVerdict(input.role, input.findings);
      const coverage = input.coverage ?? "";
      // Keep one review per role (the latest supersedes the previous round).
      task.reviews = task.reviews.filter((r) => r.role !== input.role);
      task.reviews.push({
        id: generateForumId("rev"),
        role: input.role,
        reviewerAgentId: input.reviewerAgentId,
        reviewerLabel: input.reviewerLabel,
        verdict,
        findings: input.findings,
        coverage,
        createdAt_ms: now,
      });
      const markdown = renderReviewMarkdown(verdict, input.findings, coverage);
      topic.messages.push({
        id: generateForumId("msg"),
        authorAgentId: input.reviewerAgentId,
        authorLabel: input.reviewerLabel,
        role: input.role,
        kind: "review",
        text: markdown,
        createdAt_ms: now,
        taskRefs: [input.taskId],
        replyToId: null,
        quotedMessageId: null,
        awaitingHuman: false,
        upvoters: [],
        downvoters: [],
        images: [],
      });
      ensureParticipant(topic, input.reviewerAgentId, input.reviewerLabel, input.role);
      task.comments.push({
        id: generateForumId("cmt"),
        authorAgentId: input.reviewerAgentId,
        authorLabel: input.reviewerLabel,
        role: input.role,
        text: markdown,
        createdAt_ms: now,
      });
      const to = deriveTaskStatusFromReviews(task);
      if (task.status !== to) {
        task.updatedAt_ms = now;
        task.history.push({
          at_ms: now,
          actorAgentId: input.reviewerAgentId,
          kind: "status",
          from: task.status,
          to,
          note: `${input.role} ${verdict}`,
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

// Resolve the target banter room: the named room, else the first (usually "general"), else mint a
// "general" room in place (covers topics persisted before the banter channel existed).
function resolveChatRoom(topic: StoredForumTopic, roomId?: string | null): ForumChatRoom {
  if (roomId) {
    const match = topic.chatRooms.find((r) => r.id === roomId);
    if (match) return match;
  }
  const first = topic.chatRooms[0];
  if (first) return first;
  const general: ForumChatRoom = {
    id: generateForumId("room"),
    name: "general",
    topic: "team banter while we build",
    createdByLabel: "",
    createdAt_ms: Date.now(),
  };
  topic.chatRooms.push(general);
  return general;
}

function deriveTitle(prompt: string): string {
  const firstLine = prompt.split("\n").find((line) => line.trim().length > 0) ?? prompt;
  return firstLine.trim().slice(0, 120) || "Untitled topic";
}
