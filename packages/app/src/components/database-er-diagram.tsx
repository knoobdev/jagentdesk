import { useEffect, useMemo, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import Svg, { Line, Rect, Text as SvgText } from "react-native-svg";
import { StyleSheet } from "react-native-unistyles";
import type { DbForeignKey, DbObject } from "@jagentdesk/protocol/database/rpc-schemas";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { useDatabaseNavStore } from "@/stores/database-nav-store";
import type { Theme } from "@/styles/theme";

// Theme-token hex (matches the dark design system; SVG props take color strings).
const BOX_FILL = "#272A29";
const BOX_STROKE = "#252B2A";
const BOX_STROKE_FK = "#20744A";
const EDGE = "#7ccba0";
const TEXT = "#fafafa";

const BOX_W = 168;
const BOX_H = 40;
const GAP_X = 52;
const GAP_Y = 44;
const PAD = 24;

interface Node {
  name: string;
  cx: number;
  cy: number;
  x: number;
  y: number;
}

/**
 * A graphical entity-relationship diagram for a schema: a box per table laid out
 * on a grid, with a line per foreign-key edge (source → referenced). Auto-layout
 * (no manual positioning); scrollable both axes for large schemas. Universal
 * (react-native-svg renders on desktop + mobile).
 */
export function DatabaseErDiagram({
  serverId,
  databaseId,
}: {
  serverId: string;
  databaseId: string;
}) {
  const client = useHostRuntimeClient(serverId);
  const selectedSchema = useDatabaseNavStore((s) => s.selectedSchema);
  const [objects, setObjects] = useState<DbObject[]>([]);
  const [fks, setFks] = useState<DbForeignKey[]>([]);
  const schema = selectedSchema ?? "public";

  useEffect(() => {
    if (!client) return;
    let cancelled = false;
    void (async () => {
      const [objRes, fkRes] = await Promise.all([
        client.databaseObjects({ id: databaseId, schema }).catch(() => null),
        client.databaseForeignKeys({ id: databaseId, schema }).catch(() => null),
      ]);
      if (cancelled) return;
      if (objRes && !objRes.error) setObjects(objRes.objects);
      if (fkRes && !fkRes.error) setFks(fkRes.foreignKeys);
    })();
    return () => {
      cancelled = true;
    };
  }, [client, databaseId, schema]);

  const { nodes, edges, width, height, hasFk } = useMemo(() => {
    const tables = objects.filter((o) => o.kind === "table");
    const cols = Math.max(1, Math.ceil(Math.sqrt(tables.length)));
    const index = new Map<string, number>();
    const ns: Node[] = tables.map((t, i) => {
      index.set(t.name, i);
      const x = PAD + (i % cols) * (BOX_W + GAP_X);
      const y = PAD + Math.floor(i / cols) * (BOX_H + GAP_Y);
      return { name: t.name, x, y, cx: x + BOX_W / 2, cy: y + BOX_H / 2 };
    });
    const es: Array<{ from: Node; to: Node; key: string }> = [];
    for (const fk of fks) {
      const a = index.get(fk.table);
      const b = index.get(fk.refTable);
      if (a === undefined || b === undefined || a === b) continue;
      es.push({ from: ns[a], to: ns[b], key: `${fk.table}.${fk.column}->${fk.refTable}` });
    }
    const rows = Math.ceil(tables.length / cols);
    return {
      nodes: ns,
      edges: es,
      width: PAD * 2 + cols * (BOX_W + GAP_X) - GAP_X,
      height: PAD * 2 + rows * (BOX_H + GAP_Y) - GAP_Y,
      hasFk: new Set(fks.map((f) => f.table)),
    };
  }, [objects, fks]);

  if (nodes.length === 0) {
    return (
      <View style={styles.empty}>
        <Text style={styles.emptyText}>No tables in {schema} to diagram.</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Text style={styles.header}>
        ER diagram · {schema} · {nodes.length} tables · {edges.length} relationships
      </Text>
      <ScrollView style={styles.vscroll} contentContainerStyle={styles.vcontent}>
        <ScrollView horizontal contentContainerStyle={styles.hcontent}>
          <Svg width={Math.max(width, 1)} height={Math.max(height, 1)}>
            {edges.map((e) => (
              <Line
                key={e.key}
                x1={e.from.cx}
                y1={e.from.cy}
                x2={e.to.cx}
                y2={e.to.cy}
                stroke={EDGE}
                strokeWidth={1.5}
                opacity={0.7}
              />
            ))}
            {nodes.map((n) => (
              <Rect
                key={`box-${n.name}`}
                x={n.x}
                y={n.y}
                width={BOX_W}
                height={BOX_H}
                rx={6}
                fill={BOX_FILL}
                stroke={hasFk.has(n.name) ? BOX_STROKE_FK : BOX_STROKE}
                strokeWidth={1}
              />
            ))}
            {nodes.map((n) => (
              <SvgText
                key={`t-${n.name}`}
                x={n.cx}
                y={n.cy + 4}
                fill={TEXT}
                fontSize={12}
                textAnchor="middle"
              >
                {n.name.length > 22 ? `${n.name.slice(0, 21)}…` : n.name}
              </SvgText>
            ))}
          </Svg>
        </ScrollView>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  container: { flex: 1, minHeight: 0 },
  header: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  vscroll: { flex: 1, minHeight: 0 },
  vcontent: { padding: theme.spacing[3] },
  hcontent: { padding: theme.spacing[1] },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", padding: theme.spacing[4] },
  emptyText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    fontStyle: "italic",
  },
}));
