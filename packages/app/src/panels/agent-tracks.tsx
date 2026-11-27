import type { AgentAddress } from "@jagentdesk/protocol/addresses";
import { memo, useCallback, type ReactElement } from "react";
import { BackgroundWorkTrack } from "@/background-work";
import { WorkspaceDiffStatPill } from "@/composer/diff-stat-pill";
import { ComposerTrackBar } from "@/composer/tracks";
import { AgentBrowserTabsPill } from "@/desktop/browser/live-tabs/composer-pill";
import { useIsCompactFormFactor } from "@/constants/layout";
import { usePaneContext } from "@/panels/pane-context";
import { PluginComposerPills } from "@/plugins";
import { usePanelStore } from "@/stores/panel-store";
import { useSessionStore } from "@/stores/session-store";
import {
  useArchiveSubagent,
  useDetachSubagent,
  useHideFinishedProviderSubagents,
  useSubagentsForParent,
} from "@/subagents";
import { ParentAgentPill } from "@/subagents/parent";
import { useSubagentSheetTab } from "@/subagents/sheet-tab";
import { SubagentsTrack } from "@/subagents/track";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";

/**
 * The pane's ambient context — background work, the parent agent, subagents, the browser tabs the
 * agent opened, plugin pills and workspace changes — as one row of pills above the composer (spec 38 §4.4b, Paseo 0.17.5
 * `panels/agent-tracks.tsx`).
 *
 * The row shares the composer's keyboard transform and owns the space between itself and the
 * transcript. Each pill owns its action while tab placement stays behind the workspace boundary.
 */
export const AgentTracks = memo(function AgentTracks({
  serverId,
  agentId,
  parentAgentId,
}: {
  serverId: string;
  agentId: string;
  parentAgentId: string | null;
}): ReactElement {
  const { workspaceId, tabId, openTab } = usePaneContext();
  const isCompact = useIsCompactFormFactor();
  const subagentRows = useSubagentsForParent({ serverId, parentAgentId: agentId });
  const backgroundWorkCount = useSessionStore((state) => {
    const session = state.sessions[serverId];
    const agent = session?.agents.get(agentId) ?? session?.agentDetails.get(agentId);
    return agent?.backgroundWork?.count ?? 0;
  });
  const canDetachSubagents = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.agentDetach === true,
  );
  const archiveSubagent = useArchiveSubagent();
  const detachSubagent = useDetachSubagent();
  const hideFinishedProviderSubagents = useHideFinishedProviderSubagents({
    serverId,
    parentAgentId: agentId,
  });
  const sheetTabFor = useSubagentSheetTab(
    buildWorkspaceTabPersistenceKey({ serverId, workspaceId }),
    tabId,
  );
  const handleOpenSubagent = useCallback((address: AgentAddress) => {
    navigateToAgent(address);
  }, []);
  const handleOpenProviderSubagent = useCallback(
    (ownerAgentId: string, subagentId: string) => {
      openTab({ kind: "provider_subagent", parentAgentId: ownerAgentId, subagentId });
    },
    [openTab],
  );
  const handleOpenBackgroundWork = useCallback(
    (itemId: string) => openTab({ kind: "background_work", agentId, itemId }),
    [agentId, openTab],
  );
  const openFileExplorerForCheckout = usePanelStore((state) => state.openFileExplorerForCheckout);
  const setExplorerTabForCheckout = usePanelStore((state) => state.setExplorerTabForCheckout);
  const handleOpenChanges = useCallback(
    (workspaceDirectory: string) => {
      const checkout = { serverId, cwd: workspaceDirectory, isGit: true };
      openFileExplorerForCheckout({ checkout, isCompact });
      setExplorerTabForCheckout({ ...checkout, tab: "changes" });
    },
    [isCompact, openFileExplorerForCheckout, serverId, setExplorerTabForCheckout],
  );

  return (
    <ComposerTrackBar>
      <BackgroundWorkTrack
        serverId={serverId}
        agentId={agentId}
        count={backgroundWorkCount}
        onOpenInTab={handleOpenBackgroundWork}
      />
      {parentAgentId ? <ParentAgentPill serverId={serverId} parentAgentId={parentAgentId} /> : null}
      <SubagentsTrack
        serverId={serverId}
        rows={subagentRows}
        onOpenSubagent={handleOpenSubagent}
        onOpenProviderSubagent={handleOpenProviderSubagent}
        sheetTabFor={sheetTabFor}
        onArchiveSubagent={archiveSubagent}
        onArchiveFinished={hideFinishedProviderSubagents}
        onDetachSubagent={canDetachSubagents ? detachSubagent : undefined}
      />
      <AgentBrowserTabsPill serverId={serverId} agentId={agentId} />
      <PluginComposerPills
        serverId={serverId}
        workspaceId={workspaceId}
        agentId={agentId}
        compact={isCompact}
      />
      <WorkspaceDiffStatPill
        serverId={serverId}
        workspaceId={workspaceId}
        onPress={handleOpenChanges}
      />
    </ComposerTrackBar>
  );
});
