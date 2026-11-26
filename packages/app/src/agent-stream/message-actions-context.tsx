import { createContext, useContext } from "react";
import { BuiltinMessageActions } from "@/plugins/builtin/surfaces";

/** The agent whose chat is rendered; null on read-only surfaces (subagent panes, guests). */
export const MessageActionsAgentContext = createContext<{
  serverId: string;
  agentId: string;
} | null>(null);

/** Built-in feature actions ("Remember this") for one message of the current agent. */
export function MessageFeatureActions({
  role,
  getContent,
}: {
  role: "user" | "assistant";
  getContent: () => string;
}) {
  const agent = useContext(MessageActionsAgentContext);
  if (!agent) return null;
  return (
    <BuiltinMessageActions
      serverId={agent.serverId}
      agentId={agent.agentId}
      role={role}
      getContent={getContent}
    />
  );
}
