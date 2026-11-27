// A bot's own agents (its Home Chat, its runs, its workers and their workers, and agents handed to
// it) live under the bot in the Bots section, never in the regular agent lists: Home's Recent
// activity, History and a workspace's Recents (Orca dfdb4fda (MIT) src/shared/bots/bot-homes.ts and
// sidebar-list/selection/visible-worktrees.ts keep them out the same way). The daemon labels a bot's
// own agents with `jagentdesk.bot.id`; workers carry their parent's id.
import { PARENT_AGENT_ID_LABEL } from "@jagentdesk/protocol/agent-labels";
import { BOT_ID_LABEL } from "./envelope";

// Worker chains are short; the cap only guards against a label cycle.
const MAX_PARENT_DEPTH = 16;

interface LabeledAgent {
  labels?: Record<string, string> | null;
}

/** True when the agent or an agent above it belongs to a bot. `lookup` finds an agent by id. */
export function isBotAgent(
  agent: LabeledAgent,
  lookup: (agentId: string) => LabeledAgent | undefined,
): boolean {
  let current: LabeledAgent | undefined = agent;
  for (let depth = 0; current && depth < MAX_PARENT_DEPTH; depth += 1) {
    const labels = current.labels;
    if (!labels) return false;
    if (labels[BOT_ID_LABEL]) return true;
    const parent = labels[PARENT_AGENT_ID_LABEL];
    if (!parent) return false;
    current = lookup(parent);
  }
  return false;
}
