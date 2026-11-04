import { useCallback, useMemo, type ReactNode } from "react";
import { ScrollView, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type {
  JiraBoardColumn,
  JiraBoardConfiguration,
  JiraIssueCard,
  JiraLane,
} from "@jagentdesk/protocol/jira/rpc-schemas";
import { useIsCompactFormFactor } from "@/constants/layout";
import type { Theme } from "@/styles/theme";
import { Draggable, DropZone } from "./dnd";
import { IssueCard } from "./issue-card";

// The board grid (spec 29.3): columns from the board configuration with count and WIP limits,
// lanes as rows across them. It scrolls horizontally by column (snapping per column on phones).

export const COLUMN_WIDTH = 272;
const COLUMN_GAP = 12;

export const COLUMN_DROP_PREFIX = "column:";

export function columnDropId(columnIndex: number, laneId: string): string {
  return `${COLUMN_DROP_PREFIX}${columnIndex}:${laneId}`;
}

export function parseColumnDropId(dropId: string): number | null {
  if (!dropId.startsWith(COLUMN_DROP_PREFIX)) return null;
  const index = Number(dropId.slice(COLUMN_DROP_PREFIX.length).split(":")[0]);
  return Number.isInteger(index) ? index : null;
}

export function columnIndexOf(columns: JiraBoardColumn[], statusId: string): number {
  return columns.findIndex((column) => column.statusIds.includes(statusId));
}

type WipState = "ok" | "over" | "under";

function wipState(column: JiraBoardColumn, count: number): WipState {
  if (column.max !== null && count > column.max) return "over";
  if (column.min !== null && count < column.min) return "under";
  return "ok";
}

function wipLabel(column: JiraBoardColumn): string | null {
  if (column.min !== null && column.max !== null) return `Min ${column.min} · Max ${column.max}`;
  if (column.max !== null) return `Max ${column.max}`;
  if (column.min !== null) return `Min ${column.min}`;
  return null;
}

const HEADER_STYLE = { ok: "header", over: "headerOver", under: "headerUnder" } as const;
const HEADER_TEXT = { ok: "headerText", over: "headerTextOver", under: "headerTextUnder" } as const;

function ColumnHeader({
  column,
  count,
  index,
}: {
  column: JiraBoardColumn;
  count: number;
  index: number;
}) {
  const state = wipState(column, count);
  const limit = wipLabel(column);
  return (
    <View style={styles[HEADER_STYLE[state]]} testID={`jira-column-header-${index}`}>
      <Text style={styles[HEADER_TEXT[state]]} numberOfLines={1}>
        {column.name.toUpperCase()} {count}
      </Text>
      {limit ? <Text style={styles[HEADER_TEXT[state]]}>{limit}</Text> : null}
    </View>
  );
}

interface CellProps {
  column: JiraBoardColumn;
  columnIndex: number;
  laneId: string;
  laneIndex: number;
  cards: JiraIssueCard[];
  busyKey: string | null;
  onOpenIssue: (issueKey: string) => void;
  onMoveIssue: (issue: JiraIssueCard) => void;
  renderColumnFooter: (columnIndex: number) => ReactNode;
}

function ColumnCell({
  column,
  columnIndex,
  laneId,
  laneIndex,
  cards,
  busyKey,
  onOpenIssue,
  onMoveIssue,
  renderColumnFooter,
}: CellProps) {
  const inColumn = useMemo(
    () => cards.filter((card) => column.statusIds.includes(card.status.id)),
    [cards, column.statusIds],
  );
  const renderZone = useCallback(
    (isOver: boolean) => (
      <View
        style={isOver ? styles.cellOver : styles.cell}
        testID={laneIndex === 0 ? `jira-column-${columnIndex}` : undefined}
      >
        {inColumn.map((card) => (
          <Draggable key={card.key} id={card.key}>
            <IssueCard
              issue={card}
              busy={busyKey === card.key}
              onOpen={onOpenIssue}
              onMove={onMoveIssue}
            />
          </Draggable>
        ))}
        {laneIndex === 0 ? renderColumnFooter(columnIndex) : null}
      </View>
    ),
    [busyKey, columnIndex, inColumn, laneIndex, onMoveIssue, onOpenIssue, renderColumnFooter],
  );
  return <DropZone id={columnDropId(columnIndex, laneId)}>{renderZone}</DropZone>;
}

function LaneRow({
  lane,
  cards,
  columns,
  laneIndex,
  showHeader,
  ...cell
}: {
  lane: JiraLane;
  cards: JiraIssueCard[];
  columns: JiraBoardColumn[];
  laneIndex: number;
  showHeader: boolean;
  busyKey: string | null;
  onOpenIssue: (issueKey: string) => void;
  onMoveIssue: (issue: JiraIssueCard) => void;
  renderColumnFooter: (columnIndex: number) => ReactNode;
}) {
  return (
    <View style={styles.lane}>
      {showHeader ? (
        <Text style={styles.laneTitle} numberOfLines={1} testID={`jira-lane-${lane.id}`}>
          {lane.title} · {cards.length}
        </Text>
      ) : null}
      <View style={styles.row}>
        {columns.map((column, columnIndex) => (
          <ColumnCell
            key={column.name}
            column={column}
            columnIndex={columnIndex}
            laneId={lane.id}
            laneIndex={laneIndex}
            cards={cards}
            {...cell}
          />
        ))}
      </View>
    </View>
  );
}

export interface BoardGridProps {
  configuration: JiraBoardConfiguration;
  issues: JiraIssueCard[];
  lanes: JiraLane[];
  busyKey: string | null;
  onOpenIssue: (issueKey: string) => void;
  onMoveIssue: (issue: JiraIssueCard) => void;
  /** Rendered at the bottom of each column of the first lane (quick create). */
  renderColumnFooter: (columnIndex: number) => ReactNode;
}

export function BoardGrid({
  configuration,
  issues,
  lanes,
  busyKey,
  onOpenIssue,
  onMoveIssue,
  renderColumnFooter,
}: BoardGridProps) {
  const isCompact = useIsCompactFormFactor();
  const { columns } = configuration;
  const byId = useMemo(() => new Map(issues.map((issue) => [issue.id, issue])), [issues]);
  const counts = useMemo(() => {
    const excludeSubtasks = configuration.constraintType === "issueCountExclSubs";
    return columns.map(
      (column) =>
        issues.filter(
          (issue) =>
            column.statusIds.includes(issue.status.id) && !(excludeSubtasks && issue.type.subtask),
        ).length,
    );
  }, [columns, configuration.constraintType, issues]);
  const visibleLanes = useMemo(() => {
    const withIssues = lanes
      .map((lane) => ({
        lane,
        cards: lane.issueIds.map((id) => byId.get(id)).filter((c): c is JiraIssueCard => !!c),
      }))
      .filter((entry) => entry.cards.length > 0);
    const first = lanes[0];
    if (withIssues.length === 0 && first) return [{ lane: first, cards: [] }];
    return withIssues;
  }, [byId, lanes]);
  const showLaneHeaders = visibleLanes.length > 1;

  return (
    <ScrollView
      horizontal
      style={styles.scroll}
      contentContainerStyle={styles.content}
      snapToInterval={isCompact ? COLUMN_WIDTH + COLUMN_GAP : undefined}
      decelerationRate={isCompact ? "fast" : "normal"}
      testID="jira-board"
    >
      <View style={styles.grid}>
        <View style={styles.row}>
          {columns.map((column, index) => (
            <ColumnHeader
              key={column.name}
              column={column}
              count={counts[index] ?? 0}
              index={index}
            />
          ))}
        </View>
        {visibleLanes.map(({ lane, cards }, laneIndex) => (
          <LaneRow
            key={lane.id}
            lane={lane}
            cards={cards}
            columns={columns}
            laneIndex={laneIndex}
            showHeader={showLaneHeaders}
            busyKey={busyKey}
            onOpenIssue={onOpenIssue}
            onMoveIssue={onMoveIssue}
            renderColumnFooter={renderColumnFooter}
          />
        ))}
      </View>
    </ScrollView>
  );
}

const cell = (theme: Theme) =>
  ({
    width: COLUMN_WIDTH,
    minHeight: 120,
    gap: theme.spacing[2],
    padding: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface1,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.surface1,
  }) as const;

const header = (theme: Theme) =>
  ({
    width: COLUMN_WIDTH,
    gap: 2,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1.5],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface1,
  }) as const;

const headerText = (theme: Theme) =>
  ({
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.semibold,
    letterSpacing: 0.4,
    color: theme.colors.foregroundMuted,
  }) as const;

const styles = StyleSheet.create((theme: Theme) => ({
  scroll: { flex: 1, minHeight: 0 },
  content: { paddingHorizontal: theme.spacing[4], paddingBottom: theme.spacing[4] },
  grid: { gap: theme.spacing[3] },
  row: { flexDirection: "row", gap: COLUMN_GAP, alignItems: "flex-start" },
  lane: { gap: theme.spacing[2] },
  laneTitle: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  cell: cell(theme),
  cellOver: { ...cell(theme), borderColor: theme.colors.accent },
  header: header(theme),
  headerOver: { ...header(theme), backgroundColor: theme.colors.palette.red[100] },
  headerUnder: { ...header(theme), backgroundColor: theme.colors.palette.blue[100] },
  headerText: headerText(theme),
  headerTextOver: { ...headerText(theme), color: theme.colors.palette.red[800] },
  headerTextUnder: { ...headerText(theme), color: theme.colors.palette.blue[800] },
}));
