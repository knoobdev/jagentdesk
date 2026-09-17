import type { Logger } from "pino";
import type { AgentManager } from "../agent/agent-manager.js";
import type { AgentStorage } from "../agent/agent-storage.js";
import { sendPromptToAgent } from "../agent/agent-prompt.js";

// The instruction that turns the origin chat agent into the Team-mode "lead" for a topic. It reuses
// the generic agent-to-agent tools (create_agent + send_agent_prompt) to spawn and delegate to peers,
// and the forum.* tools to run the shared task board — so the collaboration is visible + persisted.
export function buildTeamLeadPrompt(topicId: string, originPrompt: string): string {
  return [
    "You are the TEAM LEAD for a collaborative Team-mode session.",
    `Forum topic id: ${topicId}`,
    "",
    "Work like a human engineering team, and keep everything visible on the shared board:",
    `1. Post your proposed approach with forum.post_message (topicId "${topicId}", kind "proposal").`,
    "2. Break the work into tasks with forum.create_task, and into subtasks with forum.create_subtask.",
    "3. Estimate each task with forum.estimate_task (xs/s/m/l/xl).",
    "4. For work that can run in parallel, spawn peer agents with create_agent (in this workspace) and",
    "   delegate with send_agent_prompt; assign the task to that peer with forum.assign_task. Tell each",
    "   peer its topicId and taskId and instruct it to move its task with forum.set_task_status",
    "   (in_progress → review/done) and post updates with forum.post_message.",
    "5. Claim small tasks yourself with forum.claim_task and do them.",
    "6. Move tasks to in_progress when started and done ONLY when finished and verified.",
    '7. When all tasks are done, post a final summary with forum.post_message (kind "decision").',
    "",
    "Use forum.get_topic to read the current board before acting. Do the actual coding work — this is a",
    "real workspace. Here is the user's request:",
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
