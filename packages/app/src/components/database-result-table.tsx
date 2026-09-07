import { useMemo } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { QueryResult } from "@jagentdesk/protocol/database/rpc-schemas";
import type { Theme } from "@/styles/theme";
import { GridScroll } from "@/components/database-grid-scroll";

const MIN_COL_WIDTH = 120;
const MAX_COL_WIDTH = 320;
const CHAR_WIDTH = 7.5;
const GUTTER_WIDTH = 56;

/**
 * A read-only tabular renderer for a QueryResult — the shared grid body used by both
 * the table data view and the SQL console. Two-axis scroll via {@link GridScroll}
 * (viewport-edge scrollbars + pinned header on web), a row-number gutter, and column
 * widths estimated from the header + a sample of cells so wide values stay legible.
 */
export function DatabaseResultTable({
  result,
  startRow = 1,
}: {
  result: QueryResult;
  /** 1-based number of the first row (for paged views); defaults to 1. */
  startRow?: number;
}) {
  const widths = useMemo(() => {
    return result.columns.map((col, i) => {
      let longest = col.name.length;
      const sample = Math.min(result.rows.length, 50);
      for (let r = 0; r < sample; r++) {
        const cell = result.rows[r][i];
        const len = cell === null ? 4 : String(cell).length;
        if (len > longest) longest = len;
      }
      return Math.max(
        MIN_COL_WIDTH,
        Math.min(MAX_COL_WIDTH, Math.round(longest * CHAR_WIDTH) + 24),
      );
    });
  }, [result]);
  const totalWidth = useMemo(() => GUTTER_WIDTH + widths.reduce((sum, w) => sum + w, 0), [widths]);

  const header = (
    <View style={[styles.headerRow, { width: totalWidth }]}>
      <View style={[styles.gutterCell, styles.headerCell]}>
        <Text style={styles.gutterHeaderText}>#</Text>
      </View>
      {result.columns.map((col, i) => (
        <View key={col.name} style={[styles.headerCell, { width: widths[i] }]}>
          <Text style={styles.headerText} numberOfLines={1}>
            {col.name}
          </Text>
          {col.dataType ? (
            <Text style={styles.headerType} numberOfLines={1}>
              {col.dataType}
            </Text>
          ) : null}
        </View>
      ))}
    </View>
  );

  return (
    <GridScroll header={header}>
      {result.rows.map((row, r) => (
        // Rows are positional (no stable PK in an arbitrary result set), so the row
        // index is the correct key here.
        // eslint-disable-next-line react/no-array-index-key
        <View
          key={r}
          style={[styles.bodyRow, { width: totalWidth }, r % 2 === 1 && styles.bodyRowAlt]}
        >
          <View style={[styles.gutterCell, styles.bodyCell]}>
            <Text style={styles.gutterText}>{startRow + r}</Text>
          </View>
          {row.map((cell, c) => (
            <View
              key={result.columns[c]?.name ?? "col"}
              style={[styles.bodyCell, { width: widths[c] }]}
            >
              <Text style={[styles.bodyText, cell === null && styles.nullText]} numberOfLines={1}>
                {cell === null ? "NULL" : String(cell)}
              </Text>
            </View>
          ))}
        </View>
      ))}
      {result.rows.length === 0 ? <Text style={styles.emptyText}>No rows.</Text> : null}
    </GridScroll>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  headerRow: {
    flexDirection: "row",
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  gutterCell: {
    width: GUTTER_WIDTH,
    alignItems: "flex-end",
    backgroundColor: theme.colors.surface1,
  },
  gutterHeaderText: {
    fontSize: 10,
    color: theme.colors.foregroundExtraMuted,
  },
  gutterText: {
    fontSize: 10,
    color: theme.colors.foregroundExtraMuted,
    fontFamily: theme.fontFamily.mono,
  },
  headerCell: {
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1.5],
    borderRightWidth: StyleSheet.hairlineWidth,
    borderRightColor: theme.colors.border,
  },
  headerText: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  headerType: {
    fontSize: 10,
    color: theme.colors.foregroundExtraMuted,
  },
  bodyRow: {
    flexDirection: "row",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.border,
  },
  bodyRowAlt: {
    backgroundColor: theme.colors.surface1,
  },
  bodyCell: {
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRightWidth: StyleSheet.hairlineWidth,
    borderRightColor: theme.colors.border,
  },
  bodyText: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foreground,
    fontFamily: theme.fontFamily.mono,
  },
  nullText: {
    color: theme.colors.foregroundExtraMuted,
    fontStyle: "italic",
  },
  emptyText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    fontStyle: "italic",
    padding: theme.spacing[3],
  },
}));
