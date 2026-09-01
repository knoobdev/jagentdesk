import { useCallback, useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { ChevronLeft, ChevronRight, RefreshCw } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { DatabaseEngine, QueryResult } from "@jagentdesk/protocol/database/rpc-schemas";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { useDatabaseViewStore } from "@/stores/database-view-store";
import { DatabaseResultTable } from "@/components/database-result-table";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { qualifyTable } from "@/utils/sql-ident";
import type { Theme } from "@/styles/theme";

const PAGE_SIZE = 100;

const ThemedChevronLeft = withUnistyles(ChevronLeft);
const ThemedChevronRight = withUnistyles(ChevronRight);
const ThemedRefresh = withUnistyles(RefreshCw);
const ThemedSpinner = withUnistyles(LoadingSpinner);
const mutedColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

/**
 * The read-only data view for a single table/view — a paginated grid backed by
 * `database/query` (LIMIT/OFFSET). Editing (P4) layers on top of this; the SELECT
 * always runs through the read-only path so a table view can never mutate data.
 */
export function DatabaseDataGrid({
  serverId,
  databaseId,
  engine,
  schema,
  table,
}: {
  serverId: string;
  databaseId: string;
  engine: DatabaseEngine;
  schema: string;
  table: string;
}) {
  const client = useHostRuntimeClient(serverId);
  const listRefreshKey = useDatabaseViewStore((s) => s.listRefreshKey);
  const [result, setResult] = useState<QueryResult | null>(null);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (nextPage: number) => {
      if (!client) return;
      setLoading(true);
      setError(null);
      try {
        const sql = `select * from ${qualifyTable(engine, schema, table)}`;
        const res = await client.databaseQuery({
          id: databaseId,
          sql,
          limit: PAGE_SIZE,
          offset: nextPage * PAGE_SIZE,
        });
        if (res.error || !res.result) {
          setError(res.error ?? "Query failed");
          setResult(null);
        } else {
          setResult(res.result);
          setPage(nextPage);
        }
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : "Query failed");
      } finally {
        setLoading(false);
      }
    },
    [client, databaseId, engine, schema, table],
  );

  // Reset to the first page whenever the table changes, and reload on commit.
  useEffect(() => {
    void load(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [databaseId, schema, table, listRefreshKey]);

  const handlePrev = useCallback(() => {
    if (page > 0) void load(page - 1);
  }, [page, load]);
  const handleNext = useCallback(() => {
    if (result?.truncated) void load(page + 1);
  }, [page, result, load]);
  const handleRefresh = useCallback(() => void load(page), [page, load]);

  const from = page * PAGE_SIZE;
  const shown = result?.rows.length ?? 0;

  let gridBody;
  if (loading && !result) {
    gridBody = (
      <View style={styles.center}>
        <ThemedSpinner size="small" uniProps={mutedColor} />
      </View>
    );
  } else if (result) {
    gridBody = <DatabaseResultTable result={result} />;
  } else {
    gridBody = null;
  }

  return (
    <View style={styles.container}>
      <View style={styles.toolbar}>
        <Text style={styles.title} numberOfLines={1}>
          {schema}.{table}
        </Text>
        <View style={styles.toolbarSpacer} />
        <Pressable style={styles.pageBtn} onPress={handlePrev} disabled={page === 0}>
          <ThemedChevronLeft size={16} uniProps={mutedColor} />
        </Pressable>
        <Text style={styles.pageText}>{shown === 0 ? "0" : `${from + 1}–${from + shown}`}</Text>
        <Pressable style={styles.pageBtn} onPress={handleNext} disabled={!result?.truncated}>
          <ThemedChevronRight size={16} uniProps={mutedColor} />
        </Pressable>
        <Pressable style={styles.pageBtn} onPress={handleRefresh}>
          <ThemedRefresh size={15} uniProps={mutedColor} />
        </Pressable>
      </View>

      {error ? (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : null}

      {gridBody}

      {result ? (
        <View style={styles.statusBar}>
          <Text style={styles.statusText}>
            {shown} row{shown === 1 ? "" : "s"}
            {result.truncated ? "+ · more pages" : ""} · {result.elapsedMs} ms
          </Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  container: {
    flex: 1,
    minHeight: 0,
  },
  toolbar: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  title: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  toolbarSpacer: {
    flex: 1,
  },
  pageBtn: {
    padding: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
  },
  pageText: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
    minWidth: 72,
    textAlign: "center",
  },
  errorBox: {
    padding: theme.spacing[3],
    backgroundColor: theme.colors.palette.red[100],
  },
  errorText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.palette.red[800],
  },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    minHeight: 120,
  },
  statusBar: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1],
    borderTopWidth: theme.borderWidth[1],
    borderTopColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  statusText: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
}));
