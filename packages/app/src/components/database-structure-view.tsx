import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type {
  DatabaseEngine,
  DbColumn,
  DbForeignKey,
} from "@jagentdesk/protocol/database/rpc-schemas";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { buildCreateTableDdl } from "@/utils/sql-ddl";
import type { Theme } from "@/styles/theme";

type Tab = "columns" | "ddl" | "relationships";

/**
 * The structure view for a table — Columns (type / PK / FK / nullable / default),
 * DDL (reconstructed CREATE TABLE), and Relationships (outgoing + incoming
 * foreign keys — the list-form ER for a table). Works on desktop + mobile.
 */
export function DatabaseStructureView({
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
  const [columns, setColumns] = useState<DbColumn[]>([]);
  const [fks, setFks] = useState<DbForeignKey[]>([]);
  const [tab, setTab] = useState<Tab>("columns");

  useEffect(() => {
    if (!client) return;
    let cancelled = false;
    void (async () => {
      const [cols, fkRes] = await Promise.all([
        client.databaseColumns({ id: databaseId, schema, table }).catch(() => null),
        client.databaseForeignKeys({ id: databaseId, schema }).catch(() => null),
      ]);
      if (cancelled) return;
      if (cols && !cols.error) setColumns(cols.columns);
      if (fkRes && !fkRes.error) setFks(fkRes.foreignKeys);
    })();
    return () => {
      cancelled = true;
    };
  }, [client, databaseId, schema, table]);

  const outgoing = useMemo(() => fks.filter((f) => f.table === table), [fks, table]);
  const incoming = useMemo(() => fks.filter((f) => f.refTable === table), [fks, table]);
  const ddl = useMemo(
    () => buildCreateTableDdl(engine, schema, table, columns, outgoing),
    [engine, schema, table, columns, outgoing],
  );

  const showColumns = useCallback(() => setTab("columns"), []);
  const showDdl = useCallback(() => setTab("ddl"), []);
  const showRel = useCallback(() => setTab("relationships"), []);

  let body;
  if (tab === "columns") {
    body = (
      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
        {columns.map((c) => (
          <View key={c.name} style={styles.colRow}>
            <Text style={styles.colName} numberOfLines={1}>
              {c.name}
            </Text>
            <Text style={styles.colType} numberOfLines={1}>
              {c.dataType}
              {c.nullable ? "" : " · NOT NULL"}
              {c.isPrimaryKey ? " · PK" : ""}
              {c.isForeignKey ? " · FK" : ""}
              {c.defaultValue ? ` · default ${c.defaultValue}` : ""}
            </Text>
          </View>
        ))}
      </ScrollView>
    );
  } else if (tab === "ddl") {
    body = (
      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
        <Text style={styles.ddl} selectable>
          {ddl}
        </Text>
      </ScrollView>
    );
  } else {
    body = (
      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
        <Text style={styles.relHeader}>References (outgoing)</Text>
        {outgoing.length === 0 ? (
          <Text style={styles.relEmpty}>None.</Text>
        ) : (
          outgoing.map((f) => (
            <Text key={`o-${f.column}-${f.refTable}`} style={styles.relRow}>
              {f.column} → {f.refSchema}.{f.refTable}.{f.refColumn}
            </Text>
          ))
        )}
        <Text style={styles.relHeader}>Referenced by (incoming)</Text>
        {incoming.length === 0 ? (
          <Text style={styles.relEmpty}>None.</Text>
        ) : (
          incoming.map((f) => (
            <Text key={`i-${f.table}-${f.column}`} style={styles.relRow}>
              {f.refSchema}.{f.refTable}.{f.refColumn} ← {f.table}.{f.column}
            </Text>
          ))
        )}
      </ScrollView>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.tabs}>
        <Pressable
          style={[styles.tab, tab === "columns" && styles.tabActive]}
          onPress={showColumns}
        >
          <Text style={[styles.tabText, tab === "columns" && styles.tabTextActive]}>Columns</Text>
        </Pressable>
        <Pressable style={[styles.tab, tab === "ddl" && styles.tabActive]} onPress={showDdl}>
          <Text style={[styles.tabText, tab === "ddl" && styles.tabTextActive]}>DDL</Text>
        </Pressable>
        <Pressable
          style={[styles.tab, tab === "relationships" && styles.tabActive]}
          onPress={showRel}
        >
          <Text style={[styles.tabText, tab === "relationships" && styles.tabTextActive]}>
            Relationships
          </Text>
        </Pressable>
      </View>
      {body}
    </View>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  container: { flex: 1, minHeight: 0 },
  tabs: {
    flexDirection: "row",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  tab: {
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
  },
  tabActive: { backgroundColor: theme.colors.surface2 },
  tabText: { fontSize: theme.fontSize.xs, color: theme.colors.foregroundMuted },
  tabTextActive: { color: theme.colors.foreground },
  scroll: { flex: 1, minHeight: 0 },
  scrollContent: { padding: theme.spacing[3], gap: theme.spacing[1] },
  colRow: {
    paddingVertical: theme.spacing[1.5],
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.border,
  },
  colName: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  colType: { fontSize: theme.fontSize.xs, color: theme.colors.foregroundMuted },
  ddl: {
    fontSize: theme.fontSize.xs,
    fontFamily: theme.fontFamily.mono,
    color: theme.colors.foreground,
  },
  relHeader: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foregroundMuted,
    textTransform: "uppercase" as const,
    letterSpacing: 0.5,
    marginTop: theme.spacing[2],
  },
  relRow: {
    fontSize: theme.fontSize.sm,
    fontFamily: theme.fontFamily.mono,
    color: theme.colors.foreground,
  },
  relEmpty: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    fontStyle: "italic",
  },
}));
