import { useCallback, useMemo, useState, type ReactNode } from "react";
import {
  FlatList,
  Pressable,
  ScrollView,
  Text,
  View,
  type LayoutChangeEvent,
  type ListRenderItemInfo,
} from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type {
  JiraBoardColumn,
  JiraBoardConfiguration,
  JiraIssueCard,
  JiraLane,
} from "@jagentdesk/protocol/jira/rpc-schemas";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isWeb } from "@/constants/platform";
import type { Theme } from "@/styles/theme";
import { Draggable, DropZone } from "./dnd";
import { IssueCard } from "./issue-card";

// The board grid (spec 29.3): columns from the board configuration with count and WIP limits,
// lanes as rows across them.

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

function useColumnCards(cards: JiraIssueCard[], column: JiraBoardColumn): JiraIssueCard[] {
  return useMemo(
    () => cards.filter((card) => column.statusIds.includes(card.status.id)),
    [cards, column.statusIds],
  );
}

const keyOfCard = (card: JiraIssueCard) => card.key;

/**
 * One column of a board without lanes: a windowed vertical list with its own scroll, as tall as
 * the board, so a column of hundreds of cards renders only what is on screen (spec 29.3).
 */
function ColumnList({
  column,
  columnIndex,
  laneId,
  cards,
  height,
  busyKey,
  onOpenIssue,
  onMoveIssue,
  renderColumnFooter,
}: Omit<CellProps, "laneIndex"> & { height: number }) {
  const inColumn = useColumnCards(cards, column);
  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<JiraIssueCard>) => (
      <Draggable id={item.key}>
        <IssueCard
          issue={item}
          busy={busyKey === item.key}
          onOpen={onOpenIssue}
          onMove={onMoveIssue}
        />
      </Draggable>
    ),
    [busyKey, onMoveIssue, onOpenIssue],
  );
  const footer = useMemo(
    () => <>{renderColumnFooter(columnIndex)}</>,
    [columnIndex, renderColumnFooter],
  );
  const sized = useMemo(() => ({ height }), [height]);
  const renderZone = useCallback(
    (isOver: boolean) => (
      <View
        style={[isOver ? styles.listCellOver : styles.listCell, sized]}
        testID={`jira-column-${columnIndex}`}
      >
        <FlatList
          data={inColumn}
          keyExtractor={keyOfCard}
          renderItem={renderItem}
          extraData={busyKey}
          style={styles.list}
          contentContainerStyle={styles.listContent}
          ListFooterComponent={footer}
          initialNumToRender={12}
          maxToRenderPerBatch={16}
          windowSize={5}
          nestedScrollEnabled
          removeClippedSubviews={!isWeb}
          testID={`jira-column-list-${columnIndex}`}
        />
      </View>
    ),
    [busyKey, columnIndex, footer, inColumn, renderItem, sized],
  );
  return <DropZone id={columnDropId(columnIndex, laneId)}>{renderZone}</DropZone>;
}

// Lanes stack vertically in one scroll; each cell shows this many cards more per "Show more".
const LANE_CELL_PAGE = 50;

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
  const inColumn = useColumnCards(cards, column);
  const [shown, setShown] = useState(LANE_CELL_PAGE);
  const showMore = useCallback(() => setShown((count) => count + LANE_CELL_PAGE), []);
  const hidden = inColumn.length - shown;
  const renderZone = useCallback(
    (isOver: boolean) => (
      <View
        style={isOver ? styles.cellOver : styles.cell}
        testID={laneIndex === 0 ? `jira-column-${columnIndex}` : undefined}
      >
        {inColumn.slice(0, shown).map((card) => (
          <Draggable key={card.key} id={card.key}>
            <IssueCard
              issue={card}
              busy={busyKey === card.key}
              onOpen={onOpenIssue}
              onMove={onMoveIssue}
            />
          </Draggable>
        ))}
        {hidden > 0 ? (
          <Pressable
            style={styles.more}
            onPress={showMore}
            accessibilityRole="button"
            testID={`jira-cell-more-${laneId}-${columnIndex}`}
          >
            <Text
              style={styles.moreText}
            >{`Show ${Math.min(hidden, LANE_CELL_PAGE)} more of ${hidden}`}</Text>
          </Pressable>
        ) : null}
        {laneIndex === 0 ? renderColumnFooter(columnIndex) : null}
      </View>
    ),
    [
      busyKey,
      columnIndex,
      hidden,
      inColumn,
      laneId,
      laneIndex,
      onMoveIssue,
      onOpenIssue,
      renderColumnFooter,
      showMore,
      shown,
    ],
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

const HEADER_HEIGHT = 44;
const GRID_GAP = 12;
const BOTTOM_PAD = 16;
const MIN_COLUMN_HEIGHT = 160;

function useBoardLanes(lanes: JiraLane[], issues: JiraIssueCard[]) {
  const byId = useMemo(() => new Map(issues.map((issue) => [issue.id, issue])), [issues]);
  return useMemo(() => {
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
}

/**
 * The board: column headers fixed on top; the board scrolls horizontally when its columns are
 * wider than the view (snapping per column on phones). Without lanes every column scrolls
 * vertically on its own, like Jira; with lanes the lanes scroll together. Heights are measured on
 * the outer frame and passed down explicitly: a view inside a horizontal ScrollView gets no height
 * from flex on react-native-web, so nothing inside could scroll vertically.
 */
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
  const [height, setHeight] = useState(0);
  const onLayout = useCallback(
    (event: LayoutChangeEvent) => setHeight(Math.floor(event.nativeEvent.layout.height)),
    [],
  );
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
  const visibleLanes = useBoardLanes(lanes, issues);
  const showLaneHeaders = visibleLanes.length > 1;
  const bodyHeight = Math.max(MIN_COLUMN_HEIGHT, height - HEADER_HEIGHT - GRID_GAP - BOTTOM_PAD);
  const scrollSize = useMemo(() => ({ height }), [height]);
  const bodySize = useMemo(() => ({ height: bodyHeight }), [bodyHeight]);
  const single = visibleLanes.length === 1 ? visibleLanes[0] : undefined;

  return (
    <View style={styles.frame} onLayout={onLayout}>
      {height > 0 ? (
        <ScrollView
          horizontal
          style={[styles.scroll, scrollSize]}
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
            {single && !showLaneHeaders ? (
              <View style={styles.row}>
                {columns.map((column, columnIndex) => (
                  <ColumnList
                    key={column.name}
                    column={column}
                    columnIndex={columnIndex}
                    laneId={single.lane.id}
                    cards={single.cards}
                    height={bodyHeight}
                    busyKey={busyKey}
                    onOpenIssue={onOpenIssue}
                    onMoveIssue={onMoveIssue}
                    renderColumnFooter={renderColumnFooter}
                  />
                ))}
              </View>
            ) : (
              <ScrollView
                style={bodySize}
                contentContainerStyle={styles.lanes}
                nestedScrollEnabled
                testID="jira-board-lanes"
              >
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
              </ScrollView>
            )}
          </View>
        </ScrollView>
      ) : null}
    </View>
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
    height: HEADER_HEIGHT,
    justifyContent: "center",
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

const listCell = (theme: Theme) =>
  ({
    width: COLUMN_WIDTH,
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface1,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.surface1,
    overflow: "hidden",
  }) as const;

const styles = StyleSheet.create((theme: Theme) => ({
  frame: { flex: 1, minHeight: 0, minWidth: 0 },
  scroll: { flexGrow: 0 },
  content: { paddingHorizontal: theme.spacing[4], paddingBottom: BOTTOM_PAD },
  grid: { gap: GRID_GAP },
  lanes: { gap: theme.spacing[3] },
  listCell: listCell(theme),
  listCellOver: { ...listCell(theme), borderColor: theme.colors.accent },
  list: { flex: 1 },
  listContent: { gap: theme.spacing[2], padding: theme.spacing[2] },
  more: {
    alignItems: "center",
    paddingVertical: theme.spacing[1.5],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface2,
  },
  moreText: { fontSize: theme.fontSize.xs, color: theme.colors.foregroundMuted },
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
