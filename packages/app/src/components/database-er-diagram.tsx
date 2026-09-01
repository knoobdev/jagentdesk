import { Fragment, useEffect, useMemo, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import Svg, { Line, Rect, Text as SvgText } from "react-native-svg";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { DbColumn, DbForeignKey, DbObject } from "@jagentdesk/protocol/database/rpc-schemas";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { useDatabaseNavStore } from "@/stores/database-nav-store";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import type { Theme } from "@/styles/theme";

// Theme-token hex — SVG props take color strings (matches the dark design system).
const BOX_FILL = "#1E2120";
const HEADER_FILL = "#20744A";
const BOX_STROKE = "#252B2A";
const ROW_SEP = "#252B2A";
const EDGE = "#7ccba0";
const TEXT = "#fafafa";
const TEXT_MUTED = "#A1A5A4";
const PK_COLOR = "#e3b341";
const FK_COLOR = "#7ccba0";

const BOX_W = 240;
const HEADER_H = 30;
const ROW_H = 20;
const PAD = 28;
const GAP_X = 72;
const GAP_Y = 40;
const MAX_ROWS = 16;
const MAX_COLS = 5;

const ThemedSpinner = withUnistyles(LoadingSpinner);
const mutedColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

type DbClientLike = NonNullable<ReturnType<typeof useHostRuntimeClient>>;

/** Fetch one table's columns (kept out of the effect to bound callback nesting). */
async function loadColumns(
  client: DbClientLike,
  databaseId: string,
  schema: string,
  table: string,
): Promise<readonly [string, DbColumn[]]> {
  const res = await client.databaseColumns({ id: databaseId, schema, table }).catch(() => null);
  return [table, res && !res.error ? res.columns : []] as const;
}

function keyMarker(c: DbColumn): { text: string; color: string } {
  if (c.isPrimaryKey) return { text: "PK", color: PK_COLOR };
  if (c.isForeignKey) return { text: "FK", color: FK_COLOR };
  return { text: "", color: FK_COLOR };
}

interface TableBox {
  name: string;
  columns: DbColumn[];
  shown: DbColumn[];
  x: number;
  y: number;
  h: number;
  rowIndex: Map<string, number>;
}

/**
 * A DataGrip-style entity-relationship diagram: each table is a card that lists
 * its columns (with PK/FK markers + type), foreign keys are drawn as edges from
 * the FK column's row to the referenced table's header. Auto bin-packed layout;
 * scrollable both axes. Universal (react-native-svg → desktop + mobile).
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
  const [columnsByTable, setColumnsByTable] = useState<Record<string, DbColumn[]>>({});
  const [loading, setLoading] = useState(true);
  const schema = selectedSchema ?? "public";

  useEffect(() => {
    if (!client) return;
    let cancelled = false;
    setLoading(true);
    void (async () => {
      const [objRes, fkRes] = await Promise.all([
        client.databaseObjects({ id: databaseId, schema }).catch(() => null),
        client.databaseForeignKeys({ id: databaseId, schema }).catch(() => null),
      ]);
      if (cancelled) return;
      const tables =
        objRes && !objRes.error ? objRes.objects.filter((o) => o.kind === "table") : [];
      setObjects(tables);
      if (fkRes && !fkRes.error) setFks(fkRes.foreignKeys);
      // Fetch each table's columns in parallel so boxes can list their fields.
      const entries = await Promise.all(
        tables.map((t) => loadColumns(client, databaseId, schema, t.name)),
      );
      if (cancelled) return;
      setColumnsByTable(Object.fromEntries(entries));
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [client, databaseId, schema]);

  const layout = useMemo(() => {
    const tables = objects;
    if (tables.length === 0) return { boxes: [], byName: new Map(), width: 0, height: 0 };
    const cols = Math.max(1, Math.min(MAX_COLS, Math.ceil(Math.sqrt(tables.length))));
    const colHeights = Array.from({ length: cols }, () => PAD);
    const boxes: TableBox[] = [];
    const byName = new Map<string, TableBox>();
    for (const t of tables) {
      const columns = columnsByTable[t.name] ?? [];
      const shown = columns.slice(0, MAX_ROWS);
      const rowIndex = new Map<string, number>();
      shown.forEach((c, i) => rowIndex.set(c.name, i));
      const h =
        HEADER_H + Math.max(shown.length, 1) * ROW_H + (columns.length > MAX_ROWS ? ROW_H : 0);
      // Bin-pack into the shortest column for a compact diagram.
      let col = 0;
      for (let i = 1; i < cols; i++) if (colHeights[i] < colHeights[col]) col = i;
      const x = PAD + col * (BOX_W + GAP_X);
      const y = colHeights[col];
      colHeights[col] = y + h + GAP_Y;
      const box: TableBox = { name: t.name, columns, shown, x, y, h, rowIndex };
      boxes.push(box);
      byName.set(t.name, box);
    }
    return {
      boxes,
      byName,
      width: PAD + cols * (BOX_W + GAP_X) - GAP_X + PAD,
      height: Math.max(...colHeights) + PAD,
    };
  }, [objects, columnsByTable]);

  const edges = useMemo(() => {
    const out: Array<{ key: string; x1: number; y1: number; x2: number; y2: number }> = [];
    for (const fk of fks) {
      const src = layout.byName.get(fk.table);
      const dst = layout.byName.get(fk.refTable);
      if (!src || !dst || src === dst) continue;
      const ri = src.rowIndex.get(fk.column);
      const y1 =
        ri === undefined ? src.y + HEADER_H / 2 : src.y + HEADER_H + ri * ROW_H + ROW_H / 2;
      // Exit from whichever side faces the target.
      const srcRight = dst.x >= src.x;
      const x1 = srcRight ? src.x + BOX_W : src.x;
      const x2 = srcRight ? dst.x : dst.x + BOX_W;
      const y2 = dst.y + HEADER_H / 2;
      out.push({ key: `${fk.table}.${fk.column}->${fk.refTable}`, x1, y1, x2, y2 });
    }
    return out;
  }, [fks, layout]);

  if (loading) {
    return (
      <View style={styles.center}>
        <ThemedSpinner size="small" uniProps={mutedColor} />
      </View>
    );
  }
  if (layout.boxes.length === 0) {
    return (
      <View style={styles.center}>
        <Text style={styles.emptyText}>No tables in {schema} to diagram.</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Text style={styles.header}>
        ER diagram · {schema} · {layout.boxes.length} tables · {edges.length} relationships
      </Text>
      <ScrollView style={styles.vscroll} contentContainerStyle={styles.vcontent}>
        <ScrollView horizontal contentContainerStyle={styles.hcontent}>
          <Svg width={Math.max(layout.width, 1)} height={Math.max(layout.height, 1)}>
            {edges.map((e) => (
              <Line
                key={e.key}
                x1={e.x1}
                y1={e.y1}
                x2={e.x2}
                y2={e.y2}
                stroke={EDGE}
                strokeWidth={1.25}
                opacity={0.65}
              />
            ))}
            {layout.boxes.map((b) => (
              <TableCard key={b.name} box={b} />
            ))}
          </Svg>
        </ScrollView>
      </ScrollView>
    </View>
  );
}

function TableCard({ box }: { box: TableBox }) {
  const extra = box.columns.length - box.shown.length;
  return (
    <>
      <Rect
        x={box.x}
        y={box.y}
        width={BOX_W}
        height={box.h}
        rx={8}
        fill={BOX_FILL}
        stroke={BOX_STROKE}
        strokeWidth={1}
      />
      <Rect x={box.x} y={box.y} width={BOX_W} height={HEADER_H} rx={8} fill={HEADER_FILL} />
      {/* square off the header's bottom corners */}
      <Rect x={box.x} y={box.y + HEADER_H - 8} width={BOX_W} height={8} fill={HEADER_FILL} />
      <SvgText x={box.x + 12} y={box.y + 20} fill={TEXT} fontSize={13} fontWeight="600">
        {box.name.length > 28 ? `${box.name.slice(0, 27)}…` : box.name}
      </SvgText>
      {box.shown.map((c, i) => {
        const rowY = box.y + HEADER_H + i * ROW_H;
        const midY = rowY + ROW_H / 2 + 4;
        const marker = keyMarker(c);
        const nameColor = c.isPrimaryKey ? PK_COLOR : TEXT;
        return (
          <Fragment key={c.name}>
            {i > 0 ? (
              <Line
                x1={box.x}
                y1={rowY}
                x2={box.x + BOX_W}
                y2={rowY}
                stroke={ROW_SEP}
                strokeWidth={0.5}
              />
            ) : null}
            {marker.text ? (
              <SvgText x={box.x + 10} y={midY} fill={marker.color} fontSize={9} fontWeight="700">
                {marker.text}
              </SvgText>
            ) : null}
            <SvgText x={box.x + 34} y={midY} fill={nameColor} fontSize={11}>
              {c.name.length > 20 ? `${c.name.slice(0, 19)}…` : c.name}
            </SvgText>
            <SvgText
              x={box.x + BOX_W - 10}
              y={midY}
              fill={TEXT_MUTED}
              fontSize={10}
              textAnchor="end"
            >
              {c.dataType.length > 14 ? `${c.dataType.slice(0, 13)}…` : c.dataType}
            </SvgText>
          </Fragment>
        );
      })}
      {extra > 0 ? (
        <SvgText
          x={box.x + 12}
          y={box.y + HEADER_H + box.shown.length * ROW_H + 14}
          fill={TEXT_MUTED}
          fontSize={10}
          fontStyle="italic"
        >
          +{extra} more columns
        </SvgText>
      ) : null}
    </>
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
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: theme.spacing[4] },
  emptyText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    fontStyle: "italic",
  },
}));
