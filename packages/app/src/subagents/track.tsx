import { usePaneContext } from "@/panels/pane-context";
import { useSubagentSheetTab } from "./sheet-tab";
import { useSheetPanePage } from "@/screens/workspace/sheet-pane";
import { ComposerTrackPill, ComposerTrackRow } from "@/composer/tracks";
import { iconButtonChromeStyle } from "@/components/ui/icon-button-chrome";
import { useAgentFactsLine } from "@/panels/agent-facts-line";
import type { AgentAddress } from "@jagentdesk/protocol/addresses";
import { useHosts } from "@/runtime/host-runtime";
import { useCallback, useMemo, useState, type ReactElement } from "react";
import { Pressable, ScrollView, Text, View, type PressableStateCallbackType } from "react-native";
import { useTranslation } from "react-i18next";
import { Archive, ChevronDown, ChevronRight, Unlink } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { getProviderIcon } from "@/components/provider-icons";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useIsCompactFormFactor, MAX_CONTENT_WIDTH } from "@/constants/layout";
import { isNative } from "@/constants/platform";
import {
  WorkspaceTabIcon,
  type WorkspaceTabPresentation,
} from "@/screens/workspace/workspace-tab-presentation";
import type { Theme } from "@/styles/theme";
import type { SubagentRow } from "./select";
import {
  buildSubagentRowPresentationData,
  countFinishedSubagents,
  formatHeaderLabel,
} from "./track-presentation";

const ThemedArchive = withUnistyles(Archive);
const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedChevronRight = withUnistyles(ChevronRight);
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
  onArchiveSubagent: (address: AgentAddress) => void;
  onArchiveFinished?: () => void;
  onDetachSubagent?: (address: AgentAddress) => void;
}

const SUBAGENTS_LIST_MAX_HEIGHT = 200;

function buildRowPresentation(row: SubagentRow): WorkspaceTabPresentation {
  const data = buildSubagentRowPresentationData(row);
  return {
    ...data,
    tooltip: data.label,
    modified: false,
    icon: getProviderIcon(row.provider),
  };
}

export function SubagentsTrack({
  serverId,
  rows,
  onOpenSubagent,
  onOpenProviderSubagent,
  onArchiveSubagent,
  onArchiveFinished,
  onDetachSubagent,
}: SubagentsTrackProps): ReactElement | null {
  const { t } = useTranslation();
  const compact = useIsCompactFormFactor();
  const [expanded, setExpanded] = useState(false);

  const toggleExpanded = useCallback(() => {
    setExpanded((current) => !current);
  }, []);

  const surfaceStyle = useMemo(
    () => [styles.surface, expanded && styles.surfaceExpanded],
    [expanded],
  );

  const headerStyle = useCallback(
    ({ hovered, pressed }: PressableStateCallbackType) => [
      styles.headerToggle,
      (hovered || pressed) && styles.headerActive,
    ],
    [],
  );
  const headerContainerStyle = useMemo(
    () => [styles.header, expanded ? styles.headerDivider : styles.headerCollapsed],
    [expanded],
  );

  if (rows.length === 0) {
    return null;
  }

  const headerLabel = formatHeaderLabel(rows);
  const finishedCount = countFinishedSubagents(rows);

  if (compact)
    return (
      <CompactSubagentsTrack
        serverId={serverId}
        rows={rows}
        onOpenSubagent={onOpenSubagent}
        onOpenProviderSubagent={onOpenProviderSubagent}
        onArchiveSubagent={onArchiveSubagent}
        onArchiveFinished={onArchiveFinished}
        onDetachSubagent={onDetachSubagent}
      />
    );
  return (
    <View style={styles.outer} testID="subagents-track">
      <View style={styles.track}>
        <View style={surfaceStyle}>
          <View style={headerContainerStyle}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={headerLabel}
              testID="subagents-track-header"
              onPress={toggleExpanded}
              style={headerStyle}
            >
              {expanded ? (
                <ThemedChevronDown size={12} uniProps={foregroundMutedColorMapping} />
              ) : (
                <ThemedChevronRight size={12} uniProps={foregroundMutedColorMapping} />
              )}
              <Text style={styles.headerLabel} numberOfLines={1}>
                {headerLabel}
              </Text>
            </Pressable>
            {finishedCount > 0 && onArchiveFinished ? (
              <View style={styles.headerAction}>
                <SubagentActionButton
                  accessibilityLabel={t("subagents.archiveFinishedAction")}
                  testID="subagents-track-archive-finished"
                  tooltipLabel={t("subagents.archiveFinishedTooltip")}
                  icon="archive"
                  visible
                  onPress={onArchiveFinished}
                />
              </View>
            ) : null}
          </View>
          {expanded ? (
            <ScrollView
              style={styles.scroll}
              contentContainerStyle={styles.scrollContent}
              showsVerticalScrollIndicator={false}
              nestedScrollEnabled
            >
              {rows.map((row) => (
                <SubagentsTrackRow
                  serverId={serverId}
                  key={row.kind === "jagentdesk" ? `${row.address.serverId}:${row.id}` : row.id}
                  row={row}
                  onOpenSubagent={onOpenSubagent}
                  onOpenProviderSubagent={onOpenProviderSubagent}
                  onArchiveSubagent={onArchiveSubagent}
                  onDetachSubagent={onDetachSubagent}
                />
              ))}
            </ScrollView>
          ) : null}
        </View>
      </View>
    </View>
  );
}

function CompactSubagentsTrack(props: SubagentsTrackProps) {
  const { t } = useTranslation();
  const pane = usePaneContext();
  const sheetFor = useSubagentSheetTab(`${pane.serverId}:${pane.workspaceId}`, pane.tabId);
  const page = useSheetPanePage();
  const sheets = useMemo(
    () =>
      props.rows.map((row) =>
        row.kind === "jagentdesk" && row.address.serverId !== props.serverId ? null : sheetFor(row),
      ),
    [props.rows, props.serverId, sheetFor],
  );
  const pages = useMemo(
    () => sheets.flatMap((sheet) => (sheet ? [page(sheet)] : [])),
    [page, sheets],
  );
  const segments = useMemo(
    () => [{ bucket: null, text: `${props.rows.length} ${t("subagents.title")}` }],
    [props.rows.length, t],
  );
  return (
    <ComposerTrackPill
      testID="subagents-track-header"
      segments={segments}
      panelTitle={t("subagents.title")}
      pages={pages}
    >
      {props.onArchiveFinished && countFinishedSubagents(props.rows) > 0 ? (
        <CompactArchiveFinished onPress={props.onArchiveFinished} />
      ) : null}
      {props.rows.map((row, index) => (
        <CompactSubagentRow
          key={row.kind === "jagentdesk" ? `${row.address.serverId}:${row.id}` : row.id}
          row={row}
          pageId={sheets[index]?.tab.tabId}
          onOpenSubagent={props.onOpenSubagent}
          onOpenProviderSubagent={props.onOpenProviderSubagent}
        />
      ))}
    </ComposerTrackPill>
  );
}
function CompactArchiveFinished({ onPress }: { onPress: () => void }) {
  const { t } = useTranslation();
  return (
    <ComposerTrackRow onPress={onPress} accessibilityLabel={t("subagents.archiveFinishedAction")}>
      <Text style={styles.rowLabel}>{t("subagents.archiveFinishedAction")}</Text>
    </ComposerTrackRow>
  );
}
function CompactSubagentRow({
  row,
  pageId,
  onOpenSubagent,
  onOpenProviderSubagent,
}: {
  row: SubagentRow;
  pageId?: string;
  onOpenSubagent: SubagentsTrackProps["onOpenSubagent"];
  onOpenProviderSubagent: SubagentsTrackProps["onOpenProviderSubagent"];
}) {
  const presentation = useMemo(() => buildRowPresentation(row), [row]);
  const open = useCallback(() => {
    if (row.kind === "provider") onOpenProviderSubagent(row.parentAgentId, row.id);
    else onOpenSubagent(row.address);
  }, [onOpenProviderSubagent, onOpenSubagent, row]);
  return (
    <ComposerTrackRow
      onPress={open}
      opensPage={pageId}
      closeOnSelect={!pageId}
      accessibilityLabel={presentation.label}
      testID={`subagents-track-row-${row.id}`}
    >
      <WorkspaceTabIcon presentation={presentation} />
      <Text style={styles.rowLabel} numberOfLines={2}>
        {presentation.label}
      </Text>
    </ComposerTrackRow>
  );
}

interface SubagentsTrackRowProps {
  serverId: string;
  row: SubagentRow;
  onOpenSubagent: (address: AgentAddress) => void;
  onOpenProviderSubagent: (parentAgentId: string, subagentId: string) => void;
  onArchiveSubagent: (address: AgentAddress) => void;
  onDetachSubagent?: (address: AgentAddress) => void;
}

function SubagentsTrackRow({
  serverId,
  row,
  onOpenSubagent,
  onOpenProviderSubagent,
  onArchiveSubagent,
  onDetachSubagent,
}: SubagentsTrackRowProps): ReactElement {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const [hovered, setHovered] = useState(false);
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
  const handlePointerEnter = useCallback(() => setHovered(true), []);
  const handlePointerLeave = useCallback(() => setHovered(false), []);
  const hostLabel = useHosts().find(
    (host) => row.kind === "jagentdesk" && host.serverId === row.address.serverId,
  )?.label;
  const actionsAlwaysVisible = isNative || isCompact;
  const actionsVisible = actionsAlwaysVisible || hovered;

  return (
    // Wrapper View handles hover so moving the pointer between the row and
    // the archive button doesn't drop the hover state — the same pattern
    // used by sidebar workspace rows.
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={displayLabel}
        testID={`subagents-track-row-${row.id}`}
        onPress={handlePress}
        onHoverIn={handlePointerEnter}
        onHoverOut={handlePointerLeave}
      >
        {({ pressed }) => (
          <View style={hovered || pressed ? styles.rowActive : styles.row}>
            <WorkspaceTabIcon presentation={presentation} />
            <View style={styles.rowText}>
              <Text style={styles.rowTitle} numberOfLines={1}>
                {displayLabel}
              </Text>
              {row.kind === "jagentdesk" && row.address.serverId !== serverId ? (
                <Text style={styles.rowSubtitle}>{hostLabel ?? row.address.serverId}</Text>
              ) : null}
              {row.kind === "jagentdesk" ? (
                <JAgentDeskSubagentFacts serverId={row.address.serverId} agentId={row.id} />
              ) : (
                <SubagentFacts rowId={row.id} text={presentation.subtitle} />
              )}
            </View>
            {row.kind === "jagentdesk" ? (
              <SubagentRowActions
                rowId={row.id}
                displayLabel={displayLabel}
                visible={actionsVisible}
                onDetachPress={onDetachSubagent ? handleDetachPress : undefined}
                onArchivePress={handleArchivePress}
              />
            ) : null}
          </View>
        )}
      </Pressable>
    </View>
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
  rowText: { flexGrow: 1, flexShrink: 1, flexBasis: "auto", minWidth: 0 },
  rowTitle: { fontSize: theme.fontSize.base, color: theme.colors.foreground },
  rowFacts: { fontSize: theme.fontSize.sm, color: theme.colors.foregroundMuted },
  outer: {
    width: "100%",
    alignItems: "center",
    paddingHorizontal: theme.spacing[4],
  },
  track: {
    width: "100%",
    maxWidth: MAX_CONTENT_WIDTH,
    marginBottom: -theme.spacing[4],
  },
  surface: {
    alignSelf: "stretch",
    backgroundColor: theme.colors.surface1,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.borderAccent,
    borderBottomWidth: 0,
    borderTopLeftRadius: theme.borderRadius["2xl"],
    borderTopRightRadius: theme.borderRadius["2xl"],
    overflow: "hidden",
  },
  surfaceExpanded: {
    paddingBottom: theme.spacing[4],
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
  },
  headerToggle: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingLeft: theme.spacing[3],
    paddingRight: theme.spacing[1],
    paddingVertical: theme.spacing[2],
  },
  headerAction: {
    paddingRight: theme.spacing[2],
  },
  headerCollapsed: {
    paddingBottom: theme.spacing[4],
  },
  headerActive: {
    backgroundColor: theme.colors.surface2,
  },
  headerDivider: {
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  headerLabel: {
    flexShrink: 1,
    minWidth: 0,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  scroll: {
    maxHeight: SUBAGENTS_LIST_MAX_HEIGHT,
  },
  scrollContent: {
    paddingVertical: theme.spacing[1],
  },
  row: {
    minHeight: { xs: 44, md: 32 },
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  rowActive: {
    minHeight: { xs: 44, md: 32 },
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    backgroundColor: theme.colors.surface2,
  },
  rowLabel: {
    flex: 1,
    minWidth: 0,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  // Keep provider context secondary and bounded so the task remains readable on compact screens.
  rowSubtitle: {
    flexShrink: 1,
    minWidth: 0,
    maxWidth: "45%",
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
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
  actionButton: {
    padding: theme.spacing[1],
    alignItems: "center",
    justifyContent: "center",
  },
  tooltipText: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foreground,
  },
}));
