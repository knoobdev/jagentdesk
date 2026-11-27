import type { AgentAddress } from "@jagentdesk/protocol/addresses";
import { useHosts } from "@/runtime/host-runtime";
import { useCallback, useMemo, type ReactElement } from "react";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import { useTranslation } from "react-i18next";
import { Archive, Unlink } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { getProviderIcon } from "@/components/provider-icons";
import { ComposerTrackActions, ComposerTrackPill, ComposerTrackRow } from "@/composer/tracks";
import { iconButtonChromeStyle } from "@/components/ui/icon-button-chrome";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isNative } from "@/constants/platform";
import { useAgentFactsLine } from "@/panels/agent-facts-line";
import { useSheetPanePage } from "@/screens/workspace/sheet-pane";
import {
  WorkspaceTabIcon,
  type WorkspaceTabPresentation,
} from "@/screens/workspace/workspace-tab-presentation";
import type { SheetTab } from "@/stores/workspace-layout-store";
import type { Theme } from "@/styles/theme";
import type { SubagentRow } from "./select";
import {
  buildSubagentPillPresentation,
  buildSubagentRowPresentationData,
  countFinishedSubagents,
} from "./track-presentation";

const ThemedArchive = withUnistyles(Archive);
const ThemedUnlink = withUnistyles(Unlink);

const foregroundColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const foregroundMutedColorMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});

export interface SubagentsTrackProps {
  serverId: string;
  rows: SubagentRow[];
  onOpenSubagent: (address: AgentAddress) => void;
  onOpenProviderSubagent: (parentAgentId: string, subagentId: string) => void;
  /**
   * The sheet a row opens, or null when it opens as a tab. A sheet replaces the list in place and
   * Back returns to it; a tab replaces the list's pane, so choosing it ends the list.
   */
  sheetTabFor: (row: SubagentRow) => SheetTab | null;
  onArchiveSubagent: (address: AgentAddress) => void;
  onArchiveFinished?: () => void;
  onDetachSubagent?: (address: AgentAddress) => void;
}

const ROW_ICON_SIZE = 14;

function buildRowPresentation(row: SubagentRow): WorkspaceTabPresentation {
  const data = buildSubagentRowPresentationData(row);
  return {
    ...data,
    tooltip: data.label,
    modified: false,
    icon: getProviderIcon(row.provider),
  };
}

/**
 * The agent's children as one pill in the composer's track rail: a mark and a count per state,
 * and a panel listing every child (Paseo 0.17.5 `subagents/track.tsx`).
 */
export function SubagentsTrack({
  serverId,
  rows,
  onOpenSubagent,
  onOpenProviderSubagent,
  sheetTabFor,
  onArchiveSubagent,
  onArchiveFinished,
  onDetachSubagent,
}: SubagentsTrackProps): ReactElement | null {
  const { t } = useTranslation();
  const sheetPanePage = useSheetPanePage();
  // A child on another host has no tab in this workspace, so it never opens as a sheet here; a
  // pane outside any workspace (a plugin chat dock) has no sheets at all.
  const sheets = useMemo(
    () =>
      rows.map((row) =>
        !sheetPanePage || (row.kind === "jagentdesk" && row.address.serverId !== serverId)
          ? null
          : sheetTabFor(row),
      ),
    [rows, serverId, sheetTabFor, sheetPanePage],
  );
  const pages = useMemo(
    () => (sheetPanePage ? sheets.flatMap((sheet) => (sheet ? [sheetPanePage(sheet)] : [])) : []),
    [sheetPanePage, sheets],
  );

  if (rows.length === 0) {
    return null;
  }

  const pill = buildSubagentPillPresentation(t, rows);
  const showArchiveFinished = countFinishedSubagents(rows) > 0 && onArchiveFinished;

  return (
    <ComposerTrackPill
      pages={pages}
      testID="subagents-track-header"
      segments={pill.segments}
      accessibilityLabel={pill.accessibilityLabel}
      panelTitle={t("subagents.title")}
    >
      {showArchiveFinished ? (
        <ComposerTrackActions>
          <ArchiveFinishedRow onPress={onArchiveFinished} />
        </ComposerTrackActions>
      ) : null}
      {rows.map((row, index) => (
        <SubagentsTrackRow
          key={row.kind === "jagentdesk" ? `${row.address.serverId}:${row.id}` : row.id}
          serverId={serverId}
          row={row}
          sheetTabId={sheets[index]?.tab.tabId ?? null}
          onOpenSubagent={onOpenSubagent}
          onOpenProviderSubagent={onOpenProviderSubagent}
          onArchiveSubagent={onArchiveSubagent}
          onDetachSubagent={onDetachSubagent}
        />
      ))}
    </ComposerTrackPill>
  );
}

/**
 * Bulk archive, as a row above the list rather than an icon next to the count. The pill has no
 * header to hang an icon off, and a destructive-ish action reads better with its name attached.
 */
function ArchiveFinishedRow({ onPress }: { onPress: () => void }): ReactElement {
  const { t } = useTranslation();
  const renderRow = useCallback(
    ({ active }: { active: boolean }) => (
      <>
        <ThemedArchive
          size={ROW_ICON_SIZE}
          uniProps={active ? foregroundColorMapping : foregroundMutedColorMapping}
        />
        <Text style={styles.rowLabel} numberOfLines={1}>
          {t("subagents.archiveFinishedAction")}
        </Text>
      </>
    ),
    [t],
  );
  return (
    <ComposerTrackRow
      accessibilityLabel={t("subagents.archiveFinishedAction")}
      testID="subagents-track-archive-finished"
      onPress={onPress}
    >
      {renderRow}
    </ComposerTrackRow>
  );
}

interface SubagentsTrackRowProps {
  serverId: string;
  row: SubagentRow;
  /** The sheet page the row opens in place of the list, when it opens in a sheet. */
  sheetTabId: string | null;
  onOpenSubagent: (address: AgentAddress) => void;
  onOpenProviderSubagent: (parentAgentId: string, subagentId: string) => void;
  onArchiveSubagent: (address: AgentAddress) => void;
  onDetachSubagent?: (address: AgentAddress) => void;
}

function SubagentsTrackRow({
  serverId,
  row,
  sheetTabId,
  onOpenSubagent,
  onOpenProviderSubagent,
  onArchiveSubagent,
  onDetachSubagent,
}: SubagentsTrackRowProps): ReactElement {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const rowServerId = row.kind === "jagentdesk" ? row.address.serverId : serverId;
  const hostLabel = useHosts().find((host) => host.serverId === rowServerId)?.label ?? rowServerId;
  const presentation = useMemo(() => buildRowPresentation(row), [row]);
  const displayLabel =
    presentation.titleState === "loading" ? t("common.states.loading") : presentation.label;
  const handlePress = useCallback(() => {
    if (row.kind === "provider") {
      onOpenProviderSubagent(row.parentAgentId, row.id);
    } else {
      onOpenSubagent(row.address);
    }
  }, [onOpenProviderSubagent, onOpenSubagent, row]);
  const handleArchivePress = useCallback(() => {
    if (row.kind === "jagentdesk") onArchiveSubagent(row.address);
  }, [onArchiveSubagent, row]);
  const handleDetachPress = useCallback(() => {
    if (row.kind === "jagentdesk") onDetachSubagent?.(row.address);
  }, [onDetachSubagent, row]);
  const actionsAlwaysVisible = isNative || isCompact;

  const renderRow = useCallback(
    ({ active }: { active: boolean }) => (
      <>
        <WorkspaceTabIcon presentation={presentation} />
        <View style={styles.rowText}>
          <Text style={styles.rowTitle} numberOfLines={1}>
            {displayLabel}
          </Text>
          {row.kind === "jagentdesk" ? (
            <>
              <SubagentFacts rowId={row.id} text={rowServerId !== serverId ? hostLabel : ""} />
              <JAgentDeskSubagentFacts serverId={rowServerId} agentId={row.id} />
            </>
          ) : (
            <SubagentFacts rowId={row.id} text={presentation.subtitle} />
          )}
        </View>
        {row.kind === "jagentdesk" ? (
          <SubagentRowActions
            rowId={row.id}
            displayLabel={displayLabel}
            visible={actionsAlwaysVisible || active}
            onDetachPress={onDetachSubagent ? handleDetachPress : undefined}
            onArchivePress={handleArchivePress}
          />
        ) : null}
      </>
    ),
    [
      actionsAlwaysVisible,
      displayLabel,
      handleArchivePress,
      handleDetachPress,
      hostLabel,
      onDetachSubagent,
      presentation,
      row.id,
      row.kind,
      rowServerId,
      serverId,
    ],
  );

  return (
    <ComposerTrackRow
      accessibilityLabel={displayLabel}
      testID={`subagents-track-row-${row.id}`}
      opensPage={sheetTabId ?? undefined}
      onPress={handlePress}
    >
      {renderRow}
    </ComposerTrackRow>
  );
}

function JAgentDeskSubagentFacts({ serverId, agentId }: { serverId: string; agentId: string }) {
  const text = useAgentFactsLine(serverId, agentId);
  return <SubagentFacts rowId={agentId} text={text} />;
}
function SubagentFacts({ rowId, text }: { rowId: string; text: string | null }) {
  return text ? (
    <Text style={styles.rowFacts} numberOfLines={1} testID={`subagents-track-row-facts-${rowId}`}>
      {text}
    </Text>
  ) : null;
}

function SubagentRowActions({
  rowId,
  displayLabel,
  visible,
  onDetachPress,
  onArchivePress,
}: {
  rowId: string;
  displayLabel: string;
  visible: boolean;
  onDetachPress?: () => void;
  onArchivePress: () => void;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <View
      style={visible ? styles.actionClusterVisible : styles.actionClusterHidden}
      pointerEvents={visible ? "auto" : "none"}
    >
      {onDetachPress ? (
        <SubagentActionButton
          accessibilityLabel={t("subagents.detachAction", { label: displayLabel })}
          testID={`subagents-track-detach-${rowId}`}
          tooltipLabel={t("subagents.detachTooltip")}
          icon="detach"
          visible={visible}
          onPress={onDetachPress}
        />
      ) : null}
      <SubagentActionButton
        accessibilityLabel={t("subagents.archiveAction", { label: displayLabel })}
        testID={`subagents-track-archive-${rowId}`}
        tooltipLabel={t("subagents.archiveTooltip")}
        icon="archive"
        visible={visible}
        onPress={onArchivePress}
      />
    </View>
  );
}

type SubagentActionIcon = "archive" | "detach";

function renderSubagentActionIcon(icon: SubagentActionIcon, isActive: boolean): ReactElement {
  const uniProps = isActive ? foregroundColorMapping : foregroundMutedColorMapping;
  if (icon === "detach") {
    return <ThemedUnlink size={14} uniProps={uniProps} />;
  }
  return <ThemedArchive size={14} uniProps={uniProps} />;
}

function SubagentActionButton({
  accessibilityLabel,
  testID,
  tooltipLabel,
  icon,
  visible,
  onPress,
}: {
  accessibilityLabel: string;
  testID: string;
  tooltipLabel: string;
  icon: SubagentActionIcon;
  visible: boolean;
  onPress: () => void;
}): ReactElement {
  const compact = useIsCompactFormFactor();
  const actionStyle = useCallback(
    (state: PressableStateCallbackType) => iconButtonChromeStyle({ size: "small", compact, state }),
    [compact],
  );
  return (
    <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile={false}>
      <TooltipTrigger asChild disabled={!visible}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={accessibilityLabel}
          testID={testID}
          onPress={onPress}
          style={actionStyle}
          hitSlop={8}
        >
          {({ hovered, pressed }) => renderSubagentActionIcon(icon, hovered || pressed)}
        </Pressable>
      </TooltipTrigger>
      <TooltipContent side="top" align="center" offset={8}>
        <Text style={styles.tooltipText}>{tooltipLabel}</Text>
      </TooltipContent>
    </Tooltip>
  );
}

const styles = StyleSheet.create((theme) => ({
  // `flexBasis: "auto"` rather than `flex: 1`: a zero-basis label contributes nothing to the row's
  // intrinsic width, so the panel measures itself at its floor and truncates every label at once.
  rowLabel: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: "auto",
    minWidth: 0,
    fontSize: theme.fontSize.base,
    color: theme.colors.foreground,
  },
  // Title over facts. The facts sit under the title rather than beside it, so a long task name
  // keeps the row's full width and neither line truncates the other.
  rowText: { flexGrow: 1, flexShrink: 1, flexBasis: "auto", minWidth: 0 },
  rowTitle: { fontSize: theme.fontSize.base, color: theme.colors.foreground },
  rowFacts: { fontSize: theme.fontSize.sm, color: theme.colors.foregroundMuted },
  actionClusterVisible: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    opacity: 1,
  },
  actionClusterHidden: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    opacity: 0,
  },
  tooltipText: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foreground,
  },
}));
