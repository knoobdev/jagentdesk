import { memo, useCallback, useMemo } from "react";
import { ScrollView, Text, View } from "react-native";
import { Copy, MessageSquarePlus, Send, TerminalSquare, Trash2 } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { ProxyTransactionRow } from "@jagentdesk/protocol/proxy/rpc-schemas";
import type { Theme } from "@/styles/theme";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { WB_ORANGE } from "./workbench-constants";

// Right-click / long-press context menu — the way a tester moves a request between Burp's tools.
// Copy URL and Copy as cURL work now; "Send to …" entries light up as each tool lands (P2+).
const mutedColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const ThemedCopy = withUnistyles(Copy);
const ThemedCurl = withUnistyles(TerminalSquare);
const ThemedSend = withUnistyles(Send);
const ICON_COPY = <ThemedCopy size={14} uniProps={mutedColor} />;
const ICON_CURL = <ThemedCurl size={14} uniProps={mutedColor} />;
const ThemedComment = withUnistyles(MessageSquarePlus);
const ThemedTrash = withUnistyles(Trash2);
const ICON_SEND = <ThemedSend size={14} uniProps={mutedColor} />;
const ICON_COMMENT = <ThemedComment size={14} uniProps={mutedColor} />;
const ICON_TRASH = <ThemedTrash size={14} uniProps={mutedColor} />;

export interface HistoryRowActions {
  onCopyUrl: (row: ProxyTransactionRow) => void;
  onCopyCurl: (row: ProxyTransactionRow) => void;
  onSendToRepeater: (row: ProxyTransactionRow) => void;
  onSendToIntruder: (row: ProxyTransactionRow) => void;
  onHighlight: (row: ProxyTransactionRow, color: string | null) => void;
  onComment: (row: ProxyTransactionRow) => void;
  onDelete: (row: ProxyTransactionRow) => void;
  onClearHistory: () => void;
}

// Burp's highlight palette (a subset), applied as the row background.
const HIGHLIGHTS: { name: string; color: string | null }[] = [
  { name: "Red", color: "#ffd5d5" },
  { name: "Orange", color: "#ffe6cc" },
  { name: "Yellow", color: "#fff6c2" },
  { name: "Green", color: "#d6f5d6" },
  { name: "Blue", color: "#d6e4ff" },
  { name: "None", color: null },
];

function HighlightItem({
  entry,
  row,
  onHighlight,
}: {
  entry: { name: string; color: string | null };
  row: ProxyTransactionRow;
  onHighlight: (row: ProxyTransactionRow, color: string | null) => void;
}) {
  const handleSelect = useCallback(
    () => onHighlight(row, entry.color),
    [entry.color, onHighlight, row],
  );
  const dot = useMemo(
    () => (
      <View
        style={[styles.hlDot, entry.color ? { backgroundColor: entry.color } : styles.hlDotNone]}
      />
    ),
    [entry.color],
  );
  return (
    <ContextMenuItem leading={dot} onSelect={handleSelect}>
      {`Highlight: ${entry.name}`}
    </ContextMenuItem>
  );
}

// Burp's HTTP-history table: one row per intercepted transaction, newest first, with the columns a
// tester scans (#, method, host, URL, status, length, MIME, time). Selecting a row loads it into
// the message editor below. Column widths are fixed so the header and rows align under horizontal
// scroll — the pattern the app's other data grids use on web.

interface Column {
  key: string;
  label: string;
  width: number;
  align?: "right";
  value: (r: ProxyTransactionRow) => string;
}

const COLUMNS: Column[] = [
  { key: "seq", label: "#", width: 52, align: "right", value: (r) => String(r.seq) },
  { key: "method", label: "Method", width: 72, value: (r) => r.method },
  {
    key: "host",
    label: "Host",
    width: 200,
    value: (r) => `${r.secure ? "https://" : "http://"}${r.host}`,
  },
  { key: "url", label: "URL", width: 360, value: (r) => r.url },
  {
    key: "status",
    label: "Status",
    width: 64,
    align: "right",
    value: (r) => (r.status == null ? "—" : String(r.status)),
  },
  {
    key: "len",
    label: "Length",
    width: 80,
    align: "right",
    value: (r) => (r.responseLength == null ? "—" : String(r.responseLength)),
  },
  { key: "mime", label: "MIME", width: 110, value: (r) => r.mimeType || "—" },
  { key: "time", label: "Time", width: 96, value: (r) => new Date(r.ts_ms).toLocaleTimeString() },
];

const TABLE_WIDTH = COLUMNS.reduce((sum, c) => sum + c.width, 0);
// Widths are constant, so build the per-column width styles once at module load rather than as new
// objects each render (react-perf).
const TABLE_STYLE = { width: TABLE_WIDTH };
const WIDTH_STYLES: Record<string, { width: number }> = Object.fromEntries(
  COLUMNS.map((c) => [c.key, { width: c.width }]),
);

export function HttpHistory({
  rows,
  selectedId,
  onSelect,
  actions,
}: {
  rows: ProxyTransactionRow[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  actions: HistoryRowActions;
}) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator style={styles.hScroll}>
      <View style={TABLE_STYLE}>
        <View style={styles.headerRow}>
          {COLUMNS.map((c) => (
            <Text
              key={c.key}
              style={[
                styles.headerCell,
                WIDTH_STYLES[c.key],
                c.align === "right" ? styles.right : null,
              ]}
              numberOfLines={1}
            >
              {c.label}
            </Text>
          ))}
        </View>
        <ScrollView style={styles.vScroll}>
          {rows.length === 0 ? (
            <Text style={styles.empty}>No requests captured yet.</Text>
          ) : (
            rows.map((r) => (
              <HistoryRow
                key={r.id}
                row={r}
                selected={r.id === selectedId}
                onSelect={onSelect}
                actions={actions}
              />
            ))
          )}
        </ScrollView>
      </View>
    </ScrollView>
  );
}

const HistoryRow = memo(function HistoryRow({
  row,
  selected,
  onSelect,
  actions,
}: {
  row: ProxyTransactionRow;
  selected: boolean;
  onSelect: (id: string) => void;
  actions: HistoryRowActions;
}) {
  const handlePress = useCallback(() => onSelect(row.id), [onSelect, row.id]);
  const handleCopyUrl = useCallback(() => actions.onCopyUrl(row), [actions, row]);
  const handleCopyCurl = useCallback(() => actions.onCopyCurl(row), [actions, row]);
  const handleSendToRepeater = useCallback(() => actions.onSendToRepeater(row), [actions, row]);
  const handleSendToIntruder = useCallback(() => actions.onSendToIntruder(row), [actions, row]);
  const handleComment = useCallback(() => actions.onComment(row), [actions, row]);
  const handleDelete = useCallback(() => actions.onDelete(row), [actions, row]);
  const highlightStyle = useMemo(
    () => (row.highlight ? { backgroundColor: row.highlight } : null),
    [row.highlight],
  );
  return (
    <ContextMenu>
      <ContextMenuTrigger
        enabledOnMobile
        onPress={handlePress}
        style={[styles.row, selected ? styles.rowSelected : null, highlightStyle]}
        testID={`wb-row-${row.seq}`}
      >
        {COLUMNS.map((c) => (
          <Text
            key={c.key}
            style={[styles.cell, WIDTH_STYLES[c.key], c.align === "right" ? styles.right : null]}
            numberOfLines={1}
          >
            {c.value(row)}
          </Text>
        ))}
      </ContextMenuTrigger>
      <ContextMenuContent align="start" width={230} testID={`wb-row-menu-${row.seq}`}>
        <ContextMenuLabel>{`${row.method} ${row.host}`}</ContextMenuLabel>
        <ContextMenuItem leading={ICON_COPY} onSelect={handleCopyUrl}>
          Copy URL
        </ContextMenuItem>
        <ContextMenuItem leading={ICON_CURL} onSelect={handleCopyCurl}>
          Copy as cURL
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem leading={ICON_SEND} onSelect={handleSendToRepeater}>
          Send to Repeater
        </ContextMenuItem>
        <ContextMenuItem leading={ICON_SEND} onSelect={handleSendToIntruder}>
          Send to Intruder
        </ContextMenuItem>
        <ContextMenuSeparator />
        {HIGHLIGHTS.map((h) => (
          <HighlightItem key={h.name} entry={h} row={row} onHighlight={actions.onHighlight} />
        ))}
        <ContextMenuSeparator />
        <ContextMenuItem leading={ICON_COMMENT} onSelect={handleComment}>
          Add comment…
        </ContextMenuItem>
        <ContextMenuItem destructive leading={ICON_TRASH} onSelect={handleDelete}>
          Delete item
        </ContextMenuItem>
        <ContextMenuItem destructive leading={ICON_TRASH} onSelect={actions.onClearHistory}>
          Clear history
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
});

const styles = StyleSheet.create((theme: Theme) => ({
  hScroll: { flex: 1, backgroundColor: theme.colors.surface0 },
  vScroll: { flex: 1 },
  headerRow: {
    flexDirection: "row",
    backgroundColor: theme.colors.surface2,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  headerCell: {
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foregroundMuted,
  },
  row: {
    flexDirection: "row",
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  rowSelected: { backgroundColor: WB_ORANGE + "22" },
  cell: {
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    fontSize: theme.fontSize.xs,
    fontFamily: theme.fontFamily.mono,
    color: theme.colors.foreground,
  },
  right: { textAlign: "right" },
  hlDot: { width: 12, height: 12, borderRadius: 3 },
  hlDotNone: { borderWidth: 1, borderColor: theme.colors.border },
  empty: {
    padding: theme.spacing[4],
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
}));
