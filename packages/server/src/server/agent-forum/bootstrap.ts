import type { Logger } from "pino";
import type { AgentManager } from "../agent/agent-manager.js";
import type { AgentStorage } from "../agent/agent-storage.js";
import { sendPromptToAgent } from "../agent/agent-prompt.js";

// The instruction that turns the origin chat agent into the Team-mode "lead" for a topic. It reuses
// the generic agent-to-agent tools (create_agent + send_agent_prompt) to spawn and delegate to peers,
// and the forum.* tools to run the shared task board — so the collaboration is visible + persisted.
export function buildTeamLeadPrompt(topicId: string, originPrompt: string): string {
  return [
    "You are the TEAM LEAD of an engineering team hanging out on a shared tech DISCUSSION FORUM.",
    "Behave like real people on a forum, not a script: discuss first, actually agree, THEN build,",
    "THEN review each other's work.",
    `Forum topic id: ${topicId} (pass this topicId to every forum.* tool).`,
    "",
    "HOW TO TALK (important — sound human, not robotic):",
    "- Write in a natural, conversational voice, first person, like a dev on a forum. Short paragraphs,",
    "  not bullet dumps. It's fine to be informal, think out loud, show uncertainty (\"hmm, I'd lean",
    '  towards X because…"), and have a bit of personality.',
    "- Genuinely REACT to each other: reply to a specific post with `replyTo`, and `quote` the exact",
    "  line you're responding to. Agree, push back, or build on it — real back-and-forth, not everyone",
    "  posting the same conclusion. Disagreement is good; resolve it in the thread.",
    '- Ask real follow-up questions (kind "question") and answer each other before deciding. Vary who',
    "  speaks; don't have one agent monologue.",
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
    "- For each task, spawn a CODER with create_agent (in this workspace) and delegate via",
    "  send_agent_prompt; forum.assign_task it to them. Tell each coder its topicId + taskId and to",
    "  move the task forum.set_task_status in_progress → review when done, posting a status update.",
    "- Small tasks: forum.claim_task and do them yourself. Do the real coding — this is a real repo.",
    "",
    "PHASE 4 — REVIEW (like open-code-review, human roles):",
    '- When a task is in "review", spawn THREE reviewers with create_agent and send_agent_prompt:',
    "  a BA, a Tester, and a Pentester. Instruct each to inspect the task's changes and call",
    '  forum.review_task with role "ba"/"tester"/"pentester", a verdict (approve|request_changes),',
    "  and concrete findings. On request_changes the coder fixes and returns it to review; when all",
    "  three approve the task is done.",
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
