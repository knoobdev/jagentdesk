import { useMemo } from "react";
import { ScrollView, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { QueryResult } from "@jagentdesk/protocol/database/rpc-schemas";
import type { Theme } from "@/styles/theme";

const MIN_COL_WIDTH = 120;
const MAX_COL_WIDTH = 320;
const CHAR_WIDTH = 7.5;

/**
 * A read-only tabular renderer for a QueryResult — the shared grid body used by
 * both the table data view and the SQL console. Horizontally + vertically
 * scrollable; column widths are estimated from the header + a sample of cells so
 * wide values stay legible without a layout pass.
 */
export function DatabaseResultTable({ result }: { result: QueryResult }) {
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

  return (
    // Vertical (page) scroll on the outside, horizontal (columns) on the inside —
    // both axes scroll and nothing is clipped, regardless of pane width/height.
    <ScrollView style={styles.vScroll}>
      <ScrollView horizontal contentContainerStyle={styles.hContent}>
        <View>
          <View style={styles.headerRow}>
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
          {result.rows.map((row, r) => (
            // Rows are positional (no stable PK is guaranteed in an arbitrary
            // result set), so the row index is the correct key here.
            // eslint-disable-next-line react/no-array-index-key
            <View key={r} style={[styles.bodyRow, r % 2 === 1 && styles.bodyRowAlt]}>
              {row.map((cell, c) => (
                <View
                  key={result.columns[c]?.name ?? "col"}
                  style={[styles.bodyCell, { width: widths[c] }]}
                >
                  <Text
                    style={[styles.bodyText, cell === null && styles.nullText]}
                    numberOfLines={1}
                  >
                    {cell === null ? "NULL" : String(cell)}
                  </Text>
                </View>
              ))}
            </View>
          ))}
          {result.rows.length === 0 ? <Text style={styles.emptyText}>No rows.</Text> : null}
        </View>
      </ScrollView>
    </ScrollView>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  hContent: {
    flexGrow: 1,
  },
  headerRow: {
    flexDirection: "row",
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
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
  vScroll: {
    flex: 1,
    minHeight: 0,
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
