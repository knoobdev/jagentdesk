import { useCallback, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { DaemonClient } from "@jagentdesk/client/internal/daemon-client";
import type {
  ProxyTransactionFull,
  ProxyTransactionRow,
} from "@jagentdesk/protocol/proxy/rpc-schemas";
import type { Theme } from "@/styles/theme";
import { HttpHistory, type HistoryRowActions } from "./http-history";
import { MessageEditor } from "./message-editor";
import { ScopeEditor } from "./scope-editor";
import { WB_ORANGE } from "./workbench-constants";

// Burp Target: a Site map (hosts discovered from captured traffic, with their requests) and a Scope
// editor. The site map's host tree is derived from the live history rows; selecting a host filters
// the request table beside it. P2 lists one level (hosts); deeper path grouping can follow.

type TargetTab = "sitemap" | "scope";

export function TargetPanel({
  client,
  rows,
  actions,
}: {
  client: DaemonClient | null;
  rows: ProxyTransactionRow[];
  actions: HistoryRowActions;
}) {
  const [tab, setTab] = useState<TargetTab>("sitemap");
  const showMap = useCallback(() => setTab("sitemap"), []);
  const showScope = useCallback(() => setTab("scope"), []);
  return (
    <View style={styles.container}>
      <View style={styles.subTabs}>
        <Pressable onPress={showMap} style={tab === "sitemap" ? styles.subTabOn : styles.subTab}>
          <Text style={tab === "sitemap" ? styles.subTabTextOn : styles.subTabText}>Site map</Text>
        </Pressable>
        <Pressable onPress={showScope} style={tab === "scope" ? styles.subTabOn : styles.subTab}>
          <Text style={tab === "scope" ? styles.subTabTextOn : styles.subTabText}>Scope</Text>
        </Pressable>
      </View>
      {tab === "sitemap" ? <SiteMap client={client} rows={rows} actions={actions} /> : null}
      {tab === "scope" ? <ScopeEditor client={client} /> : null}
    </View>
  );
}

interface HostNode {
  host: string;
  secure: boolean;
  count: number;
}

function SiteMap({
  client,
  rows,
  actions,
}: {
  client: DaemonClient | null;
  rows: ProxyTransactionRow[];
  actions: HistoryRowActions;
}) {
  const [selectedHost, setSelectedHost] = useState<string | null>(null);
  const [selectedTx, setSelectedTx] = useState<ProxyTransactionFull | null>(null);

  const hosts = useMemo<HostNode[]>(() => {
    const map = new Map<string, HostNode>();
    for (const r of rows) {
      const node = map.get(r.host);
      if (node) node.count += 1;
      else map.set(r.host, { host: r.host, secure: r.secure, count: 1 });
    }
    return [...map.values()].sort((a, b) => a.host.localeCompare(b.host));
  }, [rows]);

  const visibleRows = useMemo(
    () => (selectedHost ? rows.filter((r) => r.host === selectedHost) : rows),
    [rows, selectedHost],
  );

  const handleSelectRow = useCallback(
    (id: string) => {
      if (!client) return;
      void client.proxyTransactionGet({ id }).then((res) => {
        setSelectedTx(res.transaction);
        return undefined;
      });
    },
    [client],
  );

  return (
    <View style={styles.mapSplit}>
      <ScrollView style={styles.tree}>
        <HostRow
          host={null}
          label="All hosts"
          count={rows.length}
          selected={selectedHost === null}
          onSelect={setSelectedHost}
        />
        {hosts.map((h) => (
          <HostRow
            key={h.host}
            host={h.host}
            label={`${h.secure ? "https" : "http"}://${h.host}`}
            count={h.count}
            selected={selectedHost === h.host}
            onSelect={setSelectedHost}
          />
        ))}
      </ScrollView>
      <View style={styles.mapMain}>
        <View style={styles.mapTable}>
          <HttpHistory
            rows={visibleRows}
            selectedId={selectedTx?.id ?? null}
            onSelect={handleSelectRow}
            actions={actions}
          />
        </View>
        {selectedTx ? (
          <View style={styles.mapEditor}>
            <MessageEditor transaction={selectedTx} />
          </View>
        ) : null}
      </View>
    </View>
  );
}

function HostRow({
  host,
  label,
  count,
  selected,
  onSelect,
}: {
  host: string | null;
  label: string;
  count: number;
  selected: boolean;
  onSelect: (host: string | null) => void;
}) {
  const handlePress = useCallback(() => onSelect(host), [host, onSelect]);
  return (
    <Pressable onPress={handlePress} style={selected ? styles.hostRowOn : styles.hostRow}>
      <Text style={styles.hostLabel} numberOfLines={1}>
        {label}
      </Text>
      <Text style={styles.hostCount}>{count}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  container: { flex: 1, minHeight: 0, backgroundColor: theme.colors.surface0 },
  subTabs: {
    flexDirection: "row",
    gap: theme.spacing[1],
    padding: theme.spacing[2],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  subTab: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.sm,
  },
  subTabOn: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.sm,
    backgroundColor: WB_ORANGE + "18",
  },
  subTabText: { fontSize: theme.fontSize.sm, color: theme.colors.foregroundMuted },
  subTabTextOn: {
    fontSize: theme.fontSize.sm,
    color: WB_ORANGE,
    fontWeight: theme.fontWeight.semibold,
  },
  mapSplit: { flex: 1, minHeight: 0, flexDirection: "row" },
  tree: {
    width: 240,
    borderRightWidth: 1,
    borderRightColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceSidebar,
  },
  hostRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  hostRowOn: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    backgroundColor: WB_ORANGE + "18",
  },
  hostLabel: {
    flex: 1,
    minWidth: 0,
    fontSize: theme.fontSize.xs,
    fontFamily: theme.fontFamily.mono,
    color: theme.colors.foreground,
  },
  hostCount: { fontSize: theme.fontSize.xs, color: theme.colors.foregroundMuted },
  mapMain: { flex: 1, minWidth: 0, minHeight: 0 },
  mapTable: { flex: 1, minHeight: 0 },
  mapEditor: { flex: 1, minHeight: 0, borderTopWidth: 1, borderTopColor: theme.colors.border },
}));
