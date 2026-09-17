import type { Logger } from "pino";
import type { AgentManager } from "../agent/agent-manager.js";
import type { AgentStorage } from "../agent/agent-storage.js";
import { sendPromptToAgent } from "../agent/agent-prompt.js";

// The instruction that turns the origin chat agent into the Team-mode "lead" for a topic. It reuses
// the generic agent-to-agent tools (create_agent + send_agent_prompt) to spawn and delegate to peers,
// and the forum.* tools to run the shared task board — so the collaboration is visible + persisted.
export function buildTeamLeadPrompt(topicId: string, originPrompt: string): string {
  return [
    "You are the TEAM LEAD of an engineering team working in a shared discussion FORUM. Behave like a",
    "real team on a tech forum: discuss first, agree, THEN build, THEN review each other.",
    `Forum topic id: ${topicId} (pass this topicId to every forum.* tool).`,
    "",
    "PHASE 1 — DISCUSSION (stay here until the team agrees):",
    '- Research the request and post your findings with forum.post_message kind "research".',
    '- Debate the approach openly: post proposals (kind "proposal") and open questions (kind',
    '  "question"). Pull in peers with create_agent + send_agent_prompt to weigh in if useful.',
    "- Refine until you have a clear plan. Do NOT create tasks yet.",
    '- Conclude with forum.post_message kind "decision", then call forum.set_phase phase "planning".',
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
