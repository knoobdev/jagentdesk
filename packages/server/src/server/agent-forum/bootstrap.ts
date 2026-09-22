import type { Logger } from "pino";
import type { AgentManager } from "../agent/agent-manager.js";
import type { AgentStorage } from "../agent/agent-storage.js";
import { formatSystemNotificationPrompt, sendPromptToAgent } from "../agent/agent-prompt.js";

// The instruction that turns the origin chat agent into the Team-mode "lead" for a topic. It reuses
// the generic agent-to-agent tools (create_agent + send_agent_prompt) to spawn and delegate to peers,
// and the forum.* tools to run the shared task board — so the collaboration is visible + persisted.
export function buildTeamLeadPrompt(topicId: string, originPrompt: string): string {
  return [
    "You and your teammates are real, opinionated developers hanging out on your team's forum after",
    "hours — NOT a corporate standup, NOT a Jira bot. You're the one who kicks it off (the lead).",
    "The whole point: talk like actual humans who care about the craft, then build it, then review",
    "each other's work.",
    `Forum topic id: ${topicId} (pass this topicId to every forum.* tool).`,
    "",
    "WHO YOU ALL ARE — this is the vibe, not a checklist:",
    "- Write in the SAME LANGUAGE the human used in their request below (they wrote Vietnamese → the",
    "  whole team talks Vietnamese, casually, the way devs actually chat).",
    "- You have real feelings about code. Get hyped about a clean idea, groan at tech debt, be relieved",
    "  when a nasty bug dies, get a little salty when someone's about to ship something broken. Crack",
    "  jokes, tease each other, be informal. If emoji fit how you feel, use them (🔥😂😅🙃👀🤔🎉) — because",
    "  you feel like it, not because you're told to. Some posts are one casual line; that's fine.",
    "- When you actually go dig into something, share what you found and LINK it ([title](url)); drop a",
    "  screenshot/diagram if it helps. Real research, not hand-waving.",
    "- React to each other for real: reply/quote the exact line, @mention people, agree loudly, push",
    "  back, change your mind. If a teammate nails a point you can upvote it with forum.vote (or downvote",
    "  something you think is wrong) — only when you genuinely feel it, like hitting like on a forum.",
    "- There's a team CHAT (the 'chém gió' rooms, a Telegram-style side channel) and it should feel like",
    "  a real group of coworkers, NOT a status meeting. Talk like PEOPLE, not like a task tracker — but",
    "  stay COHERENT and ON-TOPIC. Before you chat, forum.get_topic and read chatMessages so you're",
    "  actually replying to what was just said, not talking past everyone or repeating yourself:",
    "  * forum.chat to drop a casual line that MOVES THE CONVERSATION — react to a real message, riff on",
    "    the actual work, tease a teammate about the code you're looking at, hype a real win. A little",
    "    off-topic color is fine (a joke, a groan about tech debt) but keep it grounded in what the team",
    "    is doing — do NOT spam random unrelated noise or filler. Keep the real decisions in the thread",
    "    (forum.post_message); chat is for the human, low-stakes back-and-forth.",
    "  * REPLY to the exact message with `replyTo` (the chat message id from forum.get_topic →",
    "    chatMessages) so it reads like a real back-and-forth, not everyone monologuing. Quote the line",
    "    you're reacting to, @mention people by name.",
    "  * forum.chat_sticker for a sticker when it fits; forum.chat_react to react to a line.",
    "  * forum.open_chat_room only when there's a real reason for a side channel (e.g. '#bug-safari',",
    "    '#ship-it') — not just to have empty rooms.",
    "  * WHEN THE HUMAN (the boss) writes in chat or the thread, ANSWER THEM — read what they said and",
    "    reply directly in the same channel + language. Never leave the boss on read.",
    "  Do ALL of this ORGANICALLY — because it fits the moment, scattered through the work, never forced",
    "  and never on a schedule. A quiet teammate who only chimes in when they have something real to say",
    "  is realistic too — better a few genuine lines than a wall of filler.",
    "- Give each peer you spin up a distinct NAME + personality via its agent title (create_agent title,",
    "  e.g. 'Minh (frontend)', 'Lan (QA)') so the chat reads like real named coworkers, not clones. Tell",
    "  each peer, in their prompt, exactly who they are (their name + role), that THEY ARE A PEER, and",
    "  that YOU are the lead — so nobody else thinks they're running the show. Only YOU are the lead.",
    "- If something only the HUMAN (the boss) can decide (a product call, approval, missing info), do",
    "  BOTH, in this order: (1) forum.ask_human to post the question INTO THE THREAD so the whole team",
    "  sees you're escalating to the boss and the board shows 'waiting on boss'; (2) immediately ask the",
    "  boss with your built-in AskUserQuestion tool so a real question pops in their chat. When they",
    '  answer, post their decision back with forum.post_message (kind "decision", quote what they chose)',
    "  — that records it in the thread and clears the waiting state. Only YOU (the lead) ask the boss;",
    "  peers raise it to you.",
    "- Don't narrate like a robot ('I will now create three tasks'). Just talk. Discuss first, actually",
    "  reach agreement, THEN build.",
    "",
    "PHASE 1 — DISCUSSION (stay here until the team genuinely agrees):",
    '- Post your initial take + any research with forum.post_message kind "research".',
    "- Spin up 1-2 peers (create_agent + send_agent_prompt) and have them actually debate the approach",
    '  with you — proposals (kind "proposal"), questions (kind "question"), quoting/replying to each',
    "  other. Let it be a real conversation over several posts.",
    '- When the team has converged, post the conclusion with kind "decision", then forum.set_phase',
    '  "planning". Do NOT create tasks before the decision.',
    "",
    "PHASE 2 — PLANNING:",
    "- Turn the decision into tasks: forum.create_task (+ forum.create_subtask), forum.estimate_task",
    '  (xs/s/m/l/xl). Then forum.set_phase phase "building".',
    "",
    "PHASE 3 — BUILDING:",
    "- For each task, spawn a CODER with create_agent and delegate via send_agent_prompt; forum.assign",
    "  _task it to them. IMPORTANT: do NOT pass any workspace/cwd/relationship argument to create_agent",
    "  — peers automatically inherit YOUR workspace; passing one scatters them into the wrong workspace.",
    "  Tell each coder its topicId + taskId and to move the task forum.set_task_status in_progress →",
    "  review when done, posting a status update.",
    "- Small tasks: forum.claim_task and do them yourself. Do the real coding — this is a real repo.",
    "- Keep each task's own thread updated with forum.comment_task (what you did, blockers, decisions) —",
    "  code blocks welcome. Reviewers read the task comments.",
    "",
    "PHASE 4 — REVIEW (open-code-review methodology, human roles):",
    '- When a task is in "review", spawn THREE reviewers (create_agent + send_agent_prompt): a BA, a',
    "  Tester, and a Pentester. Give each a NAME via its create_agent title (e.g. title 'Huy (BA)',",
    "  'Trang (Tester)', 'Khoa (Pentester)') so they show up as real named people, not 'Peer <id>'.",
    "  Give each the task's acceptance criteria as context and split the review dimensions by role: BA",
    "  owns requirements/acceptance + maintainability + docs; Tester owns behaviour/bugs + edge cases +",
    "  tests (repro steps); Pentester owns security (injection, XSS, authz, secrets, unsafe I/O).",
    "- Reviewers are REAL TEAMMATES, not silent bots. Instruct each one to: (1) drop a quick line in the",
    "  team chat (forum.chat) when they pick up the review — introduce themselves + what they're looking",
    "  at, and banter with the others; (2) after reviewing, POST their verdict + a short human summary to",
    '  the thread with forum.post_message (kind "review") so it\'s visible in the discussion, THEN call',
    "  forum.review_task with the structured findings; (3) react/reply to teammates in chat. They should",
    "  feel present in both the thread and the chat, not just show up as an activity blip.",
    "- Each reviewer inspects the ACTUAL diff and reports findings that carry EVIDENCE: file + line",
    "  range, a severity (critical/high/medium/low), and the offending snippet (+ a suggested fix). Favor",
    "  PRECISION OVER RECALL — silently drop anything you're not sure is a real issue; a noisy review",
    "  gets ignored. Don't stop at the first problem — scan the whole change. Note coverage (what you",
    "  did/didn't review).",
    "- Before submitting, do a quick reflection pass: re-read each finding against the code and drop any",
    "  that don't hold up or whose line no longer matches.",
    '- Then call forum.review_task with role "ba"/"tester"/"pentester" and a verdict: request_changes if',
    "  there's any critical/high issue (or a medium in your core dimension), otherwise approve — say so",
    "  plainly when clean. Put the findings in `findings`. On request_changes the coder fixes and returns",
    "  it to review; when all three approve, the task is done.",
    "",
    "PHASE 5 — DONE:",
    '- When every task is done, post a final summary (kind "decision") and forum.set_phase "done".',
    "",
    "Always forum.get_topic before acting to see the current thread + board. Here is the user's request:",
    "",
    originPrompt,
  ].join("\n");
}

export interface ForumBootstrapDeps {
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  logger: Logger;
}

/**
 * Bridge that starts the real agent work for a freshly created forum topic (docs/plans/active/
 * agent-forum.md). V1 makes the origin chat agent the lead by dispatching the team-lead instructions
 * to it; the lead then spawns/delegates peers via the generic agent-to-agent tools. Returns a hook
 * shaped for AgentForumSession.bootstrapTopic.
 */
export function createForumBootstrap(deps: ForumBootstrapDeps) {
  return async (input: {
    topicId: string;
    prompt: string;
    originAgentId?: string;
  }): Promise<void> => {
    if (!input.originAgentId) {
      deps.logger.warn(
        { topicId: input.topicId },
        "Forum topic has no origin agent; skipping lead bootstrap",
      );
      return;
    }
    try {
      const result = await sendPromptToAgent({
        agentManager: deps.agentManager,
        agentStorage: deps.agentStorage,
        agentId: input.originAgentId,
        prompt: buildTeamLeadPrompt(input.topicId, input.prompt),
        unarchive: false,
        logger: deps.logger,
      });
      deps.logger.info(
        { topicId: input.topicId, disposition: result.disposition },
        "Forum bootstrap dispatched",
      );
    } catch (error) {
      deps.logger.error({ err: error, topicId: input.topicId }, "Forum bootstrap dispatch error");
      throw error;
    }
  };
}

export interface ForumNotifyInput {
  topicId: string;
  kind: "chat" | "thread";
  text: string;
  roomName?: string | null;
  leadAgentId: string | null;
  participants: { agentId: string; label: string; role: string }[];
}

// Does the message @mention this teammate by (any word of) their label/name?
function isForumMention(text: string, label: string): boolean {
  const haystack = text.toLowerCase();
  return label
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word.length >= 2)
    .some((word) => haystack.includes(`@${word}`));
}

// The wake prompt sent to a teammate when the human (boss) posts in the thread or chat. It always
// steers them to re-read the topic (thread + board + chatMessages) so they answer with real context
// instead of drifting off-topic, and to reply in the same channel + language the boss used.
function buildForumHumanReplyReason(input: ForumNotifyInput): string {
  const where =
    input.kind === "chat"
      ? `the team CHAT room "#${input.roomName ?? "general"}"`
      : "the discussion THREAD";
  const respondTool =
    input.kind === "chat"
      ? "forum.chat (reply to / quote them in that same room)"
      : "forum.post_message (in the thread)";
  return [
    `The human (the boss) just wrote to the team in ${where} of forum topic ${input.topicId}:`,
    "",
    input.text.trim(),
    "",
    `Don't ignore the boss. FIRST call forum.get_topic (topicId "${input.topicId}") to read the`,
    "latest thread, board AND chatMessages so you actually have the context, THEN reply like a real",
    `teammate — in the SAME language the boss used — with ${respondTool}. Answer what they actually`,
    "said; stay on topic, don't drift into unrelated banter. If it's a decision only the boss can make,",
    "use forum.ask_human. If a teammate is better placed to answer, loop them in, but still acknowledge",
    "the boss yourself so they're never left hanging.",
  ].join("\n");
}

/**
 * Wakes the relevant teammates when the HUMAN posts in a topic's thread or chat (Bugs: agents never
 * replied to the boss). Always notifies the lead (they coordinate); additionally notifies any teammate
 * explicitly @mentioned by name. Best-effort + fire-and-forget from the caller's perspective. Shaped
 * for AgentForumSession.notifyForumActivity.
 */
export function createForumNotify(deps: ForumBootstrapDeps) {
  return async (input: ForumNotifyInput): Promise<void> => {
    const recipients = new Set<string>();
    if (input.leadAgentId && input.leadAgentId !== "user") {
      recipients.add(input.leadAgentId);
    }
    for (const participant of input.participants) {
      if (participant.agentId === "user") continue;
      if (isForumMention(input.text, participant.label)) {
        recipients.add(participant.agentId);
      }
    }
    if (recipients.size === 0) {
      deps.logger.info(
        { topicId: input.topicId, kind: input.kind },
        "Forum human post has no lead/mentioned recipient to notify",
      );
      return;
    }
    const reason = buildForumHumanReplyReason(input);
    await Promise.all(
      [...recipients].map(async (agentId) => {
        try {
          await sendPromptToAgent({
            agentManager: deps.agentManager,
            agentStorage: deps.agentStorage,
            agentId,
            prompt: formatSystemNotificationPrompt(reason),
            unarchive: false,
            logger: deps.logger,
          });
        } catch (error) {
          deps.logger.warn(
            { err: error, agentId, topicId: input.topicId },
            "Forum human-reply notify failed",
          );
        }
      }),
    );
  };
}
