import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { DbDatabaseName, DbObject, DbSchema } from "@jagentdesk/protocol/database/rpc-schemas";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import type { DaemonClient } from "@jagentdesk/client/internal/daemon-client";
import { diffObjects, type ObjectDiff } from "@/utils/sql-schema-diff";
import { diffRows, type RowDiff } from "@/utils/sql-data-diff";
import type { Theme } from "@/styles/theme";

const DATA_DIFF_CAP = 1000;

function Chip({
  name,
  active,
  onSelect,
  testID,
}: {
  name: string;
  active: boolean;
  onSelect: (name: string) => void;
  testID?: string;
}) {
  const handlePress = useCallback(() => onSelect(name), [name, onSelect]);
  return (
    <Pressable
      style={[styles.chip, active && styles.chipActive]}
      onPress={handlePress}
      testID={testID}
    >
      <Text style={[styles.chipText, active && styles.chipTextActive]}>{name}</Text>
    </Pressable>
  );
}

const STATUS_LABEL: Record<ObjectDiff["status"], string> = {
  added: "+ added",
  removed: "− removed",
  changed: "~ changed",
  unchanged: "= unchanged",
};

function statusStyle(status: ObjectDiff["status"]) {
  if (status === "added") return styles.status_added;
  if (status === "removed") return styles.status_removed;
  if (status === "changed") return styles.status_changed;
  return styles.status_unchanged;
}

/** Resolve a side's databaseId: the connection itself, or a child database opened
 *  on it (`${parentId}::${dbName}`) so two databases of one server can be compared. */
async function resolveSideId(
  client: DaemonClient,
  parentId: string,
  dbName: string | null,
): Promise<string> {
  if (!dbName) return parentId;
  const res = await client
    .databaseOpenDatabase({ id: parentId, database: dbName })
    .catch(() => null);
  return res && !res.error && res.database ? res.database.id : `${parentId}::${dbName}`;
}

async function loadObjects(
  client: DaemonClient,
  id: string,
  schema: string | null,
): Promise<DbObject[]> {
  if (!schema) return [];
  const res = await client.databaseObjects({ id, schema }).catch(() => null);
  return res && !res.error ? res.objects : [];
}

function pickDefaultSchema(schemas: DbSchema[]): string | null {
  return (
    (schemas.find((s) => s.name === "public" || s.name === "main") ?? schemas[0])?.name ?? null
  );
}

/**
 * Compare two databases (or two schemas) of one connection — structure AND data.
 * With multiple databases on the server the From/To pickers choose databases (each
 * opened as a child client); otherwise they choose schemas of the one database.
 * Structure diff is the object-name diff; data diff matches rows by primary key for
 * a chosen common table. Universal (desktop + mobile).
 */
// eslint-disable-next-line complexity
export function DatabaseSchemaDiff({
  serverId,
  databaseId,
}: {
  serverId: string;
  databaseId: string;
}) {
  const client = useHostRuntimeClient(serverId);
  const [databases, setDatabases] = useState<DbDatabaseName[]>([]);
  const [leftDb, setLeftDb] = useState<string | null>(null);
  const [rightDb, setRightDb] = useState<string | null>(null);
  const [leftId, setLeftId] = useState<string>(databaseId);
  const [rightId, setRightId] = useState<string>(databaseId);
  const [leftSchemas, setLeftSchemas] = useState<DbSchema[]>([]);
  const [rightSchemas, setRightSchemas] = useState<DbSchema[]>([]);
  const [leftSchema, setLeftSchema] = useState<string | null>(null);
  const [rightSchema, setRightSchema] = useState<string | null>(null);
  const [objectsLeft, setObjectsLeft] = useState<DbObject[]>([]);
  const [objectsRight, setObjectsRight] = useState<DbObject[]>([]);
  const [table, setTable] = useState<string | null>(null);
  const [rowDiff, setRowDiff] = useState<RowDiff | null>(null);
  const [dataError, setDataError] = useState<string | null>(null);

  // Databases on the server (drives cross-database compare); empty for single-db.
  useEffect(() => {
    if (!client) return;
    void client
      .databaseDatabases({ id: databaseId })
      .then((res) => {
        if (!res.error) {
          setDatabases(res.databases);
          if (res.databases.length > 1) {
            setLeftDb((v) => v ?? res.databases[0].name);
            setRightDb((v) => v ?? res.databases[1].name);
          }
        }
        return undefined;
      })
      .catch(() => {});
  }, [client, databaseId]);
  const multiDb = databases.length > 1;

  // Resolve each side's databaseId + its schemas whenever the chosen database changes.
  useEffect(() => {
    if (!client) return;
    let cancelled = false;
    void (async () => {
      const id = multiDb ? await resolveSideId(client, databaseId, leftDb) : databaseId;
      if (cancelled) return;
      setLeftId(id);
      const res = await client.databaseSchemas({ id }).catch(() => null);
      if (cancelled || !res || res.error) return;
      setLeftSchemas(res.schemas);
      setLeftSchema(
        (v) => v ?? (multiDb ? pickDefaultSchema(res.schemas) : (res.schemas[0]?.name ?? null)),
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [client, databaseId, multiDb, leftDb]);

  useEffect(() => {
    if (!client) return;
    let cancelled = false;
    void (async () => {
      const id = multiDb ? await resolveSideId(client, databaseId, rightDb) : databaseId;
      if (cancelled) return;
      setRightId(id);
      const res = await client.databaseSchemas({ id }).catch(() => null);
      if (cancelled || !res || res.error) return;
      setRightSchemas(res.schemas);
      setRightSchema(
        (v) =>
          v ??
          (multiDb
            ? pickDefaultSchema(res.schemas)
            : (res.schemas[1]?.name ?? res.schemas[0]?.name ?? null)),
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [client, databaseId, multiDb, rightDb]);

  useEffect(() => {
    if (!client) return;
    void loadObjects(client, leftId, leftSchema).then(setObjectsLeft);
  }, [client, leftId, leftSchema]);
  useEffect(() => {
    if (!client) return;
    void loadObjects(client, rightId, rightSchema).then(setObjectsRight);
  }, [client, rightId, rightSchema]);

  const diff = useMemo(() => diffObjects(objectsLeft, objectsRight), [objectsLeft, objectsRight]);
  const changed = diff.filter((d) => d.status !== "unchanged");
  const commonTables = useMemo(() => {
    const rightNames = new Set(objectsRight.filter((o) => o.kind === "table").map((o) => o.name));
    return objectsLeft
      .filter((o) => o.kind === "table" && rightNames.has(o.name))
      .map((o) => o.name);
  }, [objectsLeft, objectsRight]);

  const runDataDiff = useCallback(
    async (tableName: string) => {
      if (!client || !leftSchema || !rightSchema) return;
      setTable(tableName);
      setRowDiff(null);
      setDataError(null);
      try {
        const cols = await client.databaseColumns({
          id: leftId,
          schema: leftSchema,
          table: tableName,
        });
        if (cols.error) throw new Error(cols.error);
        const pk = cols.columns.filter((c) => c.isPrimaryKey).map((c) => c.name);
        const [l, r] = await Promise.all([
          client.databaseQuery({
            id: leftId,
            sql: `select * from ${leftSchema}.${tableName}`,
            limit: DATA_DIFF_CAP,
          }),
          client.databaseQuery({
            id: rightId,
            sql: `select * from ${rightSchema}.${tableName}`,
            limit: DATA_DIFF_CAP,
          }),
        ]);
        if (l.error || !l.result) throw new Error(l.error ?? "left query failed");
        if (r.error || !r.result) throw new Error(r.error ?? "right query failed");
        const columns = l.result.columns.map((c) => c.name);
        setRowDiff(diffRows(pk, columns, l.result.rows, r.result.rows));
      } catch (e) {
        setDataError(e instanceof Error ? e.message : String(e));
      }
    },
    [client, leftId, rightId, leftSchema, rightSchema],
  );

  const leftChoices = multiDb ? databases.map((d) => d.name) : leftSchemas.map((s) => s.name);
  const rightChoices = multiDb ? databases.map((d) => d.name) : rightSchemas.map((s) => s.name);
  const leftValue = multiDb ? leftDb : leftSchema;
  const rightValue = multiDb ? rightDb : rightSchema;
  const onLeft = multiDb ? setLeftDb : setLeftSchema;
  const onRight = multiDb ? setRightDb : setRightSchema;

  return (
    <View style={styles.container}>
      <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
        <Text style={styles.title}>{multiDb ? "Compare databases" : "Compare schemas"}</Text>
        <Text style={styles.label}>From</Text>
        <View style={styles.chipRow}>
          {leftChoices.map((n) => (
            <Chip
              key={`l-${n}`}
              name={n}
              active={leftValue === n}
              onSelect={onLeft}
              testID={`compare-from-${n}`}
            />
          ))}
        </View>
        <Text style={styles.label}>To</Text>
        <View style={styles.chipRow}>
          {rightChoices.map((n) => (
            <Chip
              key={`r-${n}`}
              name={n}
              active={rightValue === n}
              onSelect={onRight}
              testID={`compare-to-${n}`}
            />
          ))}
        </View>

        <Text style={styles.summary}>
          {changed.length === 0
            ? "No structure differences."
            : `${changed.filter((d) => d.status === "added").length} added · ${changed.filter((d) => d.status === "removed").length} removed`}
        </Text>
        {diff.map((d) => (
          <View key={d.name} style={styles.row}>
            <Text style={[styles.status, statusStyle(d.status)]}>{STATUS_LABEL[d.status]}</Text>
            <Text style={styles.objName} numberOfLines={1}>
              {d.name}
            </Text>
          </View>
        ))}

        {commonTables.length > 0 ? (
          <>
            <Text style={styles.label}>Compare data (pick a table)</Text>
            <View style={styles.chipRow}>
              {commonTables.map((t) => (
                <Chip
                  key={`t-${t}`}
                  name={t}
                  active={table === t}
                  onSelect={runDataDiff}
                  testID={`compare-table-${t}`}
                />
              ))}
            </View>
            {dataError ? <Text style={styles.dataError}>{dataError}</Text> : null}
            {rowDiff ? (
              <Text style={styles.summary}>
                {`${table}: `}
                <Text style={styles.status_added}>{rowDiff.added} added</Text>
                {" · "}
                <Text style={styles.status_removed}>{rowDiff.removed} removed</Text>
                {" · "}
                <Text style={styles.status_changed}>{rowDiff.changed} changed</Text>
                {" · "}
                {`${rowDiff.unchanged} same`}
                {rowDiff.byFullRow ? " (matched by full row — no PK)" : ""}
              </Text>
            ) : null}
          </>
        ) : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  container: { flex: 1, minHeight: 0 },
  scroll: { flex: 1, minHeight: 0 },
  content: { padding: theme.spacing[4], gap: theme.spacing[2] },
  title: {
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.bold,
    color: theme.colors.foreground,
  },
  label: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
    marginTop: theme.spacing[2],
  },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[1.5] },
  chip: {
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
  },
  chipActive: { borderColor: theme.colors.accent, backgroundColor: theme.colors.surface2 },
  chipText: { fontSize: theme.fontSize.xs, color: theme.colors.foregroundMuted },
  chipTextActive: { color: theme.colors.foreground },
  summary: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    marginTop: theme.spacing[3],
    marginBottom: theme.spacing[1],
  },
  dataError: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.palette.red[500],
    marginTop: theme.spacing[1],
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.border,
  },
  status: { fontSize: theme.fontSize.xs, fontFamily: theme.fontFamily.mono, width: 96 },
  status_added: { color: theme.colors.palette.green[400] },
  status_removed: { color: theme.colors.palette.red[500] },
  status_changed: { color: theme.colors.palette.amber[500] },
  status_unchanged: { color: theme.colors.foregroundExtraMuted },
  objName: { flex: 1, minWidth: 0, fontSize: theme.fontSize.sm, color: theme.colors.foreground },
}));
