import type { Agent } from "@/stores/session-store";

export type CloseAgentTabPolicy = { kind: "archive-on-close" } | { kind: "layout-only" };

/** The daemon labels a bot's own agent with its bot id (bots/daemon-runtime.ts). */
const BOT_ID_LABEL = "jagentdesk.bot.id";

export function resolveCloseAgentTabPolicy(
  agent: (Pick<Agent, "parentAgentId"> & { labels?: Agent["labels"] }) | null | undefined,
): CloseAgentTabPolicy {
  if (agent?.parentAgentId) {
    return { kind: "layout-only" };
  }
  // Closing a bot's tab only hides it: archiving there would stop the bot itself.
  if (agent?.labels?.[BOT_ID_LABEL]) {
    return { kind: "layout-only" };
  }

  return { kind: "archive-on-close" };
}
