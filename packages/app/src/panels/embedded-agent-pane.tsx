import { useMemo, type ReactNode } from "react";
import {
  createPaneFocusContextValue,
  PaneFocusProvider,
  PaneProvider,
  type PaneContextValue,
} from "@/panels/pane-context";
import { SheetPaneHostProvider } from "@/screens/workspace/sheet-pane";

const noop = () => {};

export interface EmbeddedAgentPaneProps {
  serverId: string;
  /** The agent's workspace, or null when the host screen has none to name. */
  workspaceId: string | null;
  agentId: string;
  /** Unique per embedding, e.g. `sim-chat-<agentId>`. Keys the pane's attention and drafts. */
  tabId: string;
  onClose: () => void;
  children: ReactNode;
}

/**
 * Everything a pane component such as `AgentConversationPanel` reads from a workspace, for a
 * screen that shows one agent outside any workspace: the plugin chat docks and assistant panels.
 *
 * There is no workspace layout to open tabs or sheets in, so tab actions are no-ops and the sheet
 * host is explicitly absent. Setting it to null also hides the host of a workspace this embedding
 * may sit inside, whose sheets belong to a different pane.
 */
export function EmbeddedAgentPaneProvider({
  serverId,
  workspaceId,
  agentId,
  tabId,
  onClose,
  children,
}: EmbeddedAgentPaneProps) {
  const pane = useMemo<PaneContextValue>(
    () => ({
      serverId,
      workspaceId: workspaceId ?? "",
      tabId,
      target: { kind: "agent", agentId },
      openTab: noop,
      closeCurrentTab: onClose,
      retargetCurrentTab: noop,
      openFileInWorkspace: noop,
      openImportSheet: noop,
    }),
    [serverId, workspaceId, tabId, agentId, onClose],
  );
  const focus = useMemo(
    () => createPaneFocusContextValue({ isWorkspaceFocused: true, isPaneFocused: true }),
    [],
  );
  return (
    <SheetPaneHostProvider value={null}>
      <PaneProvider value={pane}>
        <PaneFocusProvider value={focus}>{children}</PaneFocusProvider>
      </PaneProvider>
    </SheetPaneHostProvider>
  );
}
