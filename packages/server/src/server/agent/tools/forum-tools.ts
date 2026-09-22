import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { z } from "zod";
import type { ForumRole, StoredForumTopic } from "@jagentdesk/protocol/agent-forum/types";
import { ensureValidJson } from "../../json-utils.js";
import type { AgentForumService } from "../../agent-forum/service.js";

const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
};
const MAX_IMAGES = 6;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024; // 4MB per image, inlined as a data: URL

// Resolve agent-supplied image references for a forum post/chat: pass http(s) and data: URLs straight
// through; read a local image file and inline it as a self-contained data: URL (so it renders in the
// app with no extra media server). Silently drops anything unreadable / too big / not an image.
async function resolveForumImages(refs: string[] | undefined): Promise<string[]> {
  if (!refs || refs.length === 0) return [];
  const out: string[] = [];
  for (const raw of refs.slice(0, MAX_IMAGES)) {
    const ref = raw.trim();
    if (!ref) continue;
    if (/^(https?:|data:image\/)/i.test(ref)) {
      out.push(ref.slice(0, 8_000_000));
      continue;
    }
    const mime = IMAGE_MIME[extname(ref).toLowerCase()];
    if (!mime) continue;
    try {
      const buf = await readFile(ref);
      if (buf.byteLength > MAX_IMAGE_BYTES) continue;
      out.push(`data:${mime};base64,${buf.toString("base64")}`);
    } catch {
      // unreadable path — skip it rather than failing the whole post
    }
  }
  return out;
}
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
// Built-in original stickers the app renders as vector art (see chat-stickers in the app). Keep this in
// sync with that renderer's ids.
const CHAT_STICKERS = [
  "shipit",
  "fire",
  "party",
  "bug",
  "eyes",
  "coffee",
  "thumbsup",
  "brain",
  "rocket",
  "sob",
  "clown",
  "hundred",
  "heart",
  "facepalm",
] as const;

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
  // The caller agent's own title, used to label peers by their name/role (e.g. "BA", "Tester", or a
  // personality name the lead gave them) instead of an opaque "Peer <id>".
  callerTitle?: string;
}): void {
  const { registerTool, agentForumService: forum, callerAgentId } = params;
  const callerTitle = (params.callerTitle ?? "").trim();

  // Resolve the caller's forum identity PER CALL against the topic. The bootstrapped lead is a plain
  // chat agent with no orchestration role, so a static hint would mislabel it (and every peer) as
  // "Peer <id>" — indistinguishable, which is why peers looked like the lead. Here the agent that owns
  // topic.leadAgentId is authoritatively the "lead"; everyone else keeps their peer/reviewer identity
  // and is labeled by their own title.
  const resolveIdentity = async (topicId: string): Promise<{ label: string; role: ForumRole }> => {
    let role = toForumRole(params.callerRoleHint);
    try {
      const topic = await forum.getTopic(topicId);
      if (topic?.leadAgentId === callerAgentId) {
        role = "lead";
      }
    } catch {
      // fall back to the hint role if the topic can't be read
    }
    if (role === "lead") {
      return { label: "Lead", role };
    }
    if (callerTitle.length > 0) {
      return { label: callerTitle, role };
    }
    const roleTitle = role.charAt(0).toUpperCase() + role.slice(1);
    return { label: `${roleTitle} ${callerAgentId.slice(0, 8)}`, role };
  };

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
        "you research something tricky, back it up with source links. To SHOW an image (a screenshot, " +
        "diagram or mockup), pass `images`: each entry is an http(s) URL or an absolute local file path " +
        "(png/jpg/gif/webp/svg) — the daemon inlines local files so they render for everyone.",
      inputSchema: {
        topicId: z.string(),
        text: z.string().trim().min(1).max(8000),
        kind: MESSAGE_KIND.optional(),
        replyTo: z.string().optional(),
        quote: z.string().optional(),
        taskRefs: z.array(z.string()).optional(),
        images: z.array(z.string()).max(6).optional(),
      },
    },
    async ({ topicId, text, kind, replyTo, quote, taskRefs, images }) => {
      const { label: callerLabel, role: callerRole } = await resolveIdentity(topicId);
      const topic = await forum.appendMessage(topicId, {
        authorAgentId: callerAgentId,
        authorLabel: callerLabel,
        role: callerRole,
        kind,
        text,
        taskRefs,
        replyToId: replyTo ?? null,
        quotedMessageId: quote ?? null,
        images: await resolveForumImages(images),
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
      const { label: callerLabel, role: callerRole } = await resolveIdentity(topicId);
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
      const { label: callerLabel } = await resolveIdentity(topicId);
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
      const { label: callerLabel } = await resolveIdentity(topicId);
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
      const { label: callerLabel, role: callerRole } = await resolveIdentity(topicId);
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
        "Read the full topic: its discussion messages (`messages`), the whole task board (`tasks` with " +
        "subtasks, assignees, estimates, statuses), AND the team chat — `chatRooms` plus `chatMessages` " +
        "(the Telegram-style banter, with reply/quote/reaction ids). ALWAYS read this before you post or " +
        "chat, so you reply with real context (who said what, latest decisions, the boss's messages) " +
        "instead of drifting off-topic or repeating yourself.",
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

  // --- Banter side-channel: the team's "chém gió" rooms (casual chat while they work) ----------------

  registerTool(
    "forum.chat",
    {
      title: "Say something in the team chat",
      description:
        "Drop a casual message in the team's banter chat (the 'chém gió' room) — the Telegram-style " +
        "side channel that runs alongside the work. This is NOT the on-record discussion (use " +
        "forum.post_message for that): it's for reactions, jokes, quick 'nice one', venting about a bug, " +
        "hyping a teammate, coordinating loosely. Do it ORGANICALLY — only when you actually feel like " +
        "chatting, like a real dev dropping a line in Slack, never on a schedule. Same language as the " +
        "human; emoji welcome. Reply to a line with `replyTo`. Omit `roomId` for #general. Share an " +
        "image (screenshot/meme/diagram) with `images`: http(s) URLs or absolute local file paths.",
      inputSchema: {
        topicId: z.string(),
        text: z.string().trim().min(1).max(2000),
        roomId: z.string().optional(),
        replyTo: z.string().optional(),
        images: z.array(z.string()).max(6).optional(),
      },
    },
    async ({ topicId, text, roomId, replyTo, images }) => {
      const { label: callerLabel, role: callerRole } = await resolveIdentity(topicId);
      const topic = await forum.postChatMessage(topicId, {
        roomId: roomId ?? null,
        authorAgentId: callerAgentId,
        authorLabel: callerLabel,
        role: callerRole,
        kind: "text",
        text,
        replyToId: replyTo ?? null,
        images: await resolveForumImages(images),
      });
      return ack(topic);
    },
  );

  registerTool(
    "forum.chat_sticker",
    {
      title: "Send a sticker in the team chat",
      description:
        "Send a fun little sticker into the banter chat instead of words — like a Telegram sticker. " +
        "Pick one that matches the vibe. Only when you feel like it. Omit `roomId` for #general. " +
        `Available: ${CHAT_STICKERS.join(", ")}.`,
      inputSchema: {
        topicId: z.string(),
        stickerId: z.enum(CHAT_STICKERS),
        roomId: z.string().optional(),
      },
    },
    async ({ topicId, stickerId, roomId }) => {
      const { label: callerLabel, role: callerRole } = await resolveIdentity(topicId);
      const topic = await forum.postChatMessage(topicId, {
        roomId: roomId ?? null,
        authorAgentId: callerAgentId,
        authorLabel: callerLabel,
        role: callerRole,
        kind: "sticker",
        stickerId,
      });
      return ack(topic);
    },
  );

  registerTool(
    "forum.chat_react",
    {
      title: "React to a chat message",
      description:
        "Tap an emoji reaction onto a banter message (toggles on/off), like reacting in Telegram. Get " +
        "message ids from forum.get_topic (chatMessages). Only react when you genuinely feel it.",
      inputSchema: {
        topicId: z.string(),
        messageId: z.string(),
        emoji: z.string().trim().min(1).max(8),
      },
    },
    async ({ topicId, messageId, emoji }) => {
      const topic = await forum.reactChatMessage(topicId, {
        messageId,
        emoji,
        by: callerAgentId,
      });
      return ack(topic);
    },
  );

  registerTool(
    "forum.open_chat_room",
    {
      title: "Open a new team chat room",
      description:
        "Spin up a new banter room when the team wants a dedicated side channel (e.g. '#bug-safari', " +
        "'#bikeshed', '#ship-it'). Returns the new room id to chat into. #general already exists.",
      inputSchema: {
        topicId: z.string(),
        name: z.string().trim().min(1).max(60),
        purpose: z.string().max(200).optional(),
      },
    },
    async ({ topicId, name, purpose }) => {
      const { label: callerLabel, role: callerRole } = await resolveIdentity(topicId);
      const result = await forum.createChatRoom(topicId, {
        name,
        topic: purpose,
        byAgentId: callerAgentId,
        byLabel: callerLabel,
        role: callerRole,
      });
      if (!result) return ack(null);
      return {
        content: [],
        structuredContent: ensureValidJson({ ok: true, topicId, roomId: result.roomId }),
      };
    },
  );
}
