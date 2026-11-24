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
  const { openTab } = usePaneContext();
  const child = useProviderSubagentStore((state) => {
    for (const [key, descriptor] of state.descriptors) {
      if (
        descriptor.parentAgentId === parentAgentId &&
        descriptor.toolCallId === callId &&
        key === providerSubagentKey(serverId, parentAgentId, descriptor.id)
      )
        return descriptor;
    }
    return null;
  });
  const openChild = useCallback(() => {
    if (child) openTab({ kind: "provider_subagent", parentAgentId, subagentId: child.id });
  }, [child, openTab, parentAgentId]);
  return <ToolCall {...props} onOpenSubagent={child ? openChild : undefined} />;
}
