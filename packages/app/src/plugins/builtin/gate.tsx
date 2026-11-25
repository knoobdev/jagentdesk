import type { ReactNode } from "react";
import type { BuiltinPluginId } from "@jagentdesk/protocol/builtin-plugins";
import { useBuiltinPluginEnabled } from "./hooks";

export function BuiltinPluginGate({
  serverId,
  id,
  children,
}: {
  serverId: string | null | undefined;
  id: BuiltinPluginId;
  children: ReactNode;
}) {
  return useBuiltinPluginEnabled(serverId, id) ? children : null;
}
