import { useCallback, type ComponentProps } from "react";
import { ToolCall } from "@/components/message";
import { usePaneContext } from "@/panels/pane-context";
import { providerSubagentKey, useProviderSubagentStore } from "./provider-store";

/** Provider launch markers open the same child panel as the Subagents track. */
export function SubagentLaunchMarker({
  serverId,
  parentAgentId,
  callId,
  ...props
}: ComponentProps<typeof ToolCall> & {
  serverId: string;
  parentAgentId: string;
  callId: string;
}) {
  const { openTab, target } = usePaneContext();
  const ownerAgentId = target.kind === "provider_subagent" ? target.parentAgentId : parentAgentId;
  const child = useProviderSubagentStore((state) => {
    for (const [key, descriptor] of state.descriptors) {
      if (
        descriptor.parentAgentId === ownerAgentId &&
        descriptor.toolCallId === callId &&
        key === providerSubagentKey(serverId, ownerAgentId, descriptor.id)
      )
        return descriptor;
    }
    return null;
  });
  const openChild = useCallback(() => {
    if (child)
      openTab({ kind: "provider_subagent", parentAgentId: ownerAgentId, subagentId: child.id });
  }, [child, openTab, ownerAgentId]);
  return <ToolCall {...props} onOpenSubagent={child ? openChild : undefined} />;
}
