import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { DbObject, DbSchema } from "@jagentdesk/protocol/database/rpc-schemas";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { diffObjects, type ObjectDiff } from "@/utils/sql-schema-diff";
import type { Theme } from "@/styles/theme";

function SchemaChip({
  name,
  active,
  onSelect,
}: {
  name: string;
  active: boolean;
  onSelect: (name: string) => void;
}) {
  const handlePress = useCallback(() => onSelect(name), [name, onSelect]);
  return (
    <Pressable style={[styles.chip, active && styles.chipActive]} onPress={handlePress}>
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

/**
 * Compare two schemas of the same connection — which objects were added / removed
 * / in common. The object-name diff is computed in the app from two `objects`
 * introspections (`sql-schema-diff`). Universal (desktop + mobile).
 */
export function DatabaseSchemaDiff({
  serverId,
  databaseId,
}: {
  serverId: string;
  databaseId: string;
}) {
  const client = useHostRuntimeClient(serverId);
  const [schemas, setSchemas] = useState<DbSchema[]>([]);
  const [left, setLeft] = useState<string | null>(null);
  const [right, setRight] = useState<string | null>(null);
  const [objectsLeft, setObjectsLeft] = useState<DbObject[]>([]);
  const [objectsRight, setObjectsRight] = useState<DbObject[]>([]);

  useEffect(() => {
    if (!client) return;
    void client
      .databaseSchemas({ id: databaseId })
      .then((res) => {
        if (!res.error) {
          setSchemas(res.schemas);
          if (res.schemas[0]) setLeft((v) => v ?? res.schemas[0].name);
          if (res.schemas[1]) setRight((v) => v ?? res.schemas[1].name);
        }
        return undefined;
      })
      .catch(() => {});
  }, [client, databaseId]);

  useEffect(() => {
    if (!client || !left) return;
    void client
      .databaseObjects({ id: databaseId, schema: left })
      .then((res) => (res.error ? undefined : setObjectsLeft(res.objects)))
      .catch(() => {});
  }, [client, databaseId, left]);

  useEffect(() => {
    if (!client || !right) return;
    void client
      .databaseObjects({ id: databaseId, schema: right })
      .then((res) => (res.error ? undefined : setObjectsRight(res.objects)))
      .catch(() => {});
  }, [client, databaseId, right]);

  const diff = useMemo(() => diffObjects(objectsLeft, objectsRight), [objectsLeft, objectsRight]);
  const changed = diff.filter((d) => d.status !== "unchanged");

  return (
    <View style={styles.container}>
      <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
        <Text style={styles.title}>Compare schemas</Text>
        <Text style={styles.label}>From</Text>
        <View style={styles.chipRow}>
          {schemas.map((s) => (
            <SchemaChip
              key={`l-${s.name}`}
              name={s.name}
              active={left === s.name}
              onSelect={setLeft}
            />
          ))}
        </View>
        <Text style={styles.label}>To</Text>
        <View style={styles.chipRow}>
          {schemas.map((s) => (
            <SchemaChip
              key={`r-${s.name}`}
              name={s.name}
              active={right === s.name}
              onSelect={setRight}
            />
          ))}
        </View>

        <Text style={styles.summary}>
          {changed.length === 0
            ? "No object differences."
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
