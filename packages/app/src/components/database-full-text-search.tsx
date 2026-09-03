import { useCallback, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { DatabaseEngine } from "@jagentdesk/protocol/database/rpc-schemas";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { useDatabaseNavStore, type SelectedDbObject } from "@/stores/database-nav-store";
import { useDatabaseViewStore } from "@/stores/database-view-store";
import { qualifyTable, quoteIdent } from "@/utils/sql-ident";
import type { Theme } from "@/styles/theme";

const ThemedInput = withUnistyles(TextInput);
const placeholderColor = (theme: Theme) => ({
  placeholderTextColor: theme.colors.foregroundExtraMuted,
});

// Column types worth scanning for a text match — skip binary/blob and pure numeric
// keys where an ILIKE is meaningless or expensive.
const TEXTUAL = /char|text|json|uuid|name|enum|citext|xml|inet|cidr/i;

interface TableHit {
  schema: string;
  table: string;
  matches: number;
  columns: string[];
}

/**
 * Full-text data search across the database — DataGrip's "Search everywhere in
 * data". For a term, every table's textual columns are scanned with ILIKE and the
 * per-table match counts are listed; picking a hit opens that table filtered.
 */
export function DatabaseFullTextSearch({
  serverId,
  databaseId,
  engine,
}: {
  serverId: string;
  databaseId: string;
  engine: DatabaseEngine;
}) {
  const client = useHostRuntimeClient(serverId);
  const requestFilter = useDatabaseViewStore((s) => s.requestFilter);
  const openTable = useDatabaseViewStore((s) => s.openTable);
  const selectObject = useDatabaseNavStore((s) => s.selectObject);
  const [term, setTerm] = useState("");
  const [running, setRunning] = useState(false);
  const [hits, setHits] = useState<TableHit[]>([]);
  const [scanned, setScanned] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const search = useCallback(async () => {
    if (!client) return;
    const q = term.trim();
    if (!q) return;
    setRunning(true);
    setError(null);
    setHits([]);
    setScanned(null);
    const like = `%${q}%`;
    try {
      const schemas = await client.databaseSchemas({ id: databaseId });
      if (schemas.error) {
        setError(schemas.error);
        return;
      }
      const found: TableHit[] = [];
      let tablesScanned = 0;
      for (const s of schemas.schemas) {
        const objs = await client.databaseObjects({ id: databaseId, schema: s.name });
        if (objs.error) continue;
        for (const o of objs.objects) {
          if (o.kind !== "table" && o.kind !== "view") continue;
          const cols = await client.databaseColumns({
            id: databaseId,
            schema: s.name,
            table: o.name,
          });
          if (cols.error) continue;
          const textCols = cols.columns.filter((c) => TEXTUAL.test(c.dataType));
          if (textCols.length === 0) continue;
          tablesScanned++;
          const where = textCols
            .map((c) => `${quoteIdent(engine, c.name)}::text ilike $1`)
            .join(" or ");
          const res = await client.databaseQuery({
            id: databaseId,
            sql: `select count(*) as n from ${qualifyTable(engine, s.name, o.name)} where ${where}`,
            params: [like],
            limit: 1,
          });
          const n = res.result?.rows?.[0]?.[0];
          const count = typeof n === "number" ? n : Number(n ?? 0);
          if (count > 0) {
            found.push({
              schema: s.name,
              table: o.name,
              matches: count,
              columns: textCols.map((c) => c.name),
            });
          }
        }
      }
      found.sort((a, b) => b.matches - a.matches);
      setHits(found);
      setScanned(tablesScanned);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Search failed");
    } finally {
      setRunning(false);
    }
  }, [client, term, databaseId, engine]);

  const openHit = useCallback(
    (hit: TableHit) => {
      const where = hit.columns
        .map((c) => `${quoteIdent(engine, c)}::text ilike '%${term.trim().replace(/'/g, "''")}%'`)
        .join(" or ");
      requestFilter(hit.schema, hit.table, where);
      openTable(databaseId, { schema: hit.schema, name: hit.table });
      const obj: SelectedDbObject = { databaseId, schema: hit.schema, name: hit.table };
      selectObject(databaseId, obj);
    },
    [engine, term, requestFilter, openTable, selectObject, databaseId],
  );

  return (
    <View style={styles.container}>
      <View style={styles.bar}>
        <ThemedInput
          style={styles.input}
          value={term}
          onChangeText={setTerm}
          onSubmitEditing={search}
          placeholder="Search all text columns across the database…"
          autoCapitalize="none"
          autoCorrect={false}
          uniProps={placeholderColor}
        />
        <Pressable style={styles.searchBtn} onPress={search} disabled={running}>
          <Text style={styles.searchBtnText}>{running ? "Searching…" : "Search"}</Text>
        </Pressable>
      </View>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <ScrollView style={styles.results} contentContainerStyle={styles.resultsContent}>
        {scanned !== null && !running ? (
          <Text style={styles.summary}>
            {hits.length === 0
              ? `No matches in ${scanned} table(s).`
              : `${hits.length} table(s) with matches (scanned ${scanned}).`}
          </Text>
        ) : null}
        {hits.map((hit) => (
          <HitRow key={`${hit.schema}.${hit.table}`} hit={hit} onOpen={openHit} />
        ))}
      </ScrollView>
    </View>
  );
}

function HitRow({ hit, onOpen }: { hit: TableHit; onOpen: (hit: TableHit) => void }) {
  const press = useCallback(() => onOpen(hit), [onOpen, hit]);
  return (
    <Pressable style={styles.hit} onPress={press}>
      <View style={styles.hitInfo}>
        <Text style={styles.hitTable} numberOfLines={1} ellipsizeMode="middle">
          {hit.schema}.{hit.table}
        </Text>
        <Text style={styles.hitCols} numberOfLines={1}>
          {hit.columns.join(", ")}
        </Text>
      </View>
      <Text style={styles.hitCount} numberOfLines={1}>
        {hit.matches}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  container: { flex: 1, minHeight: 0 },
  bar: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    padding: theme.spacing[3],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  input: {
    flex: 1,
    minWidth: 0,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1.5],
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface0,
    fontSize: theme.fontSize.sm,
    fontFamily: theme.fontFamily.mono,
    color: theme.colors.foreground,
  },
  searchBtn: {
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1.5],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.accent,
  },
  searchBtnText: { fontSize: theme.fontSize.xs, color: theme.colors.accentForeground },
  error: {
    padding: theme.spacing[3],
    fontSize: theme.fontSize.xs,
    color: theme.colors.statusDanger,
  },
  results: { flex: 1, minHeight: 0 },
  resultsContent: { padding: theme.spacing[3], gap: theme.spacing[1] },
  summary: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
    marginBottom: theme.spacing[1],
  },
  hit: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1.5],
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.border,
  },
  hitInfo: {
    flex: 1,
    minWidth: 0,
    gap: theme.spacing[1],
  },
  hitTable: {
    fontSize: theme.fontSize.sm,
    fontFamily: theme.fontFamily.mono,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  hitCols: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
    fontFamily: theme.fontFamily.mono,
  },
  hitCount: {
    flexShrink: 0,
    fontSize: theme.fontSize.xs,
    fontFamily: theme.fontFamily.mono,
    color: theme.colors.accent,
  },
}));
