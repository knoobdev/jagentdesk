import { memo, useMemo, type ReactElement } from "react";
import { Globe } from "lucide-react-native";
import { withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { ComposerTrackPill } from "@/composer/tracks";
import { getIsElectron } from "@/constants/platform";
import type { Theme } from "@/styles/theme";
import {
  buildBrowserTabsPillSegments,
  filterBrowserTabRowsForAgent,
  summarizeBrowserTabRows,
} from "./model";
import {
  BROWSER_TABS_POPOVER_MAX_HEIGHT,
  BROWSER_TABS_POPOVER_WIDTH,
  BrowserTabsPopoverBody,
  browserTabsPopoverStyles,
} from "./popover";
import { useBrowserTabRows } from "./rows";

const ThemedGlobe = withUnistyles(Globe);
const muted = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const GLOBE_ICON = <ThemedGlobe size={14} uniProps={muted} />;

/**
 * The browser tabs one agent opened, as a pill in its composer track rail (spec 04 §27d.1,
 * spec 38 §4.4b). Desktop only; absent until the agent has a live tab. Opens the same list as the
 * host-row button, filtered to this agent, whose Close all closes only this agent's tabs.
 */
export const AgentBrowserTabsPill = memo(function AgentBrowserTabsPill({
  serverId,
  agentId,
}: {
  serverId: string;
  agentId: string;
}): ReactElement | null {
  if (!getIsElectron()) return null;
  return <AgentBrowserTabsPillContent serverId={serverId} agentId={agentId} />;
});

function AgentBrowserTabsPillContent({
  serverId,
  agentId,
}: {
  serverId: string;
  agentId: string;
}): ReactElement | null {
  const { t } = useTranslation();
  const allRows = useBrowserTabRows();
  const rows = useMemo(
    () => filterBrowserTabRowsForAgent(allRows, serverId, agentId),
    [agentId, allRows, serverId],
  );
  const summary = useMemo(() => summarizeBrowserTabRows(rows), [rows]);
  const segments = useMemo(
    () =>
      buildBrowserTabsPillSegments(summary, {
        notResponding: (count) => t("browserTabs.pill.notResponding", { count }),
        crashed: (count) => t("browserTabs.pill.crashed", { count }),
      }),
    [summary, t],
  );
  if (summary.count === 0) return null;
  const tooltip = t("browserTabs.pill.tooltip");
  return (
    <ComposerTrackPill
      segments={segments}
      leading={GLOBE_ICON}
      tooltip={tooltip}
      accessibilityLabel={`${tooltip}: ${segments.map((segment) => segment.text).join(", ")}`}
      panelTitle={t("browserTabs.title")}
      panelWidth={BROWSER_TABS_POPOVER_WIDTH}
      panelMaxHeight={BROWSER_TABS_POPOVER_MAX_HEIGHT}
      panelSurfaceStyle={browserTabsPopoverStyles.surface}
      testID="composer-browser-tabs-pill"
    >
      <BrowserTabsPopoverBody rows={rows} includeAgent={false} />
    </ComposerTrackPill>
  );
}
