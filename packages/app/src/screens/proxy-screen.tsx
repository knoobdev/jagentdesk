import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { Radar, X } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type {
  ProxyCaptureSession,
  ProxyHeldRequest,
  ProxyWsMessage,
  ProxyTransactionFull,
  ProxyTransactionRow,
} from "@jagentdesk/protocol/proxy/rpc-schemas";
import { PageHeader } from "@/components/headers/page-header";
import { useHostRuntimeClient, useHosts } from "@/runtime/host-runtime";
import type { Theme } from "@/styles/theme";
import * as Clipboard from "expo-clipboard";
import { CapturesPanel } from "@/components/proxy/captures-panel";
import { HttpHistory, type HistoryRowActions } from "@/components/proxy/http-history";
import { MessageEditor } from "@/components/proxy/message-editor";
import { RepeaterPanel } from "@/components/proxy/repeater-panel";
import { InterceptPanel } from "@/components/proxy/intercept-panel";
import { WsHistory } from "@/components/proxy/ws-history";
import { DecoderPanel } from "@/components/proxy/decoder-panel";
import { ComparerPanel } from "@/components/proxy/comparer-panel";
import { TargetPanel } from "@/components/proxy/target-panel";
import { IntruderPanel } from "@/components/proxy/intruder-panel";
import { SequencerPanel } from "@/components/proxy/sequencer-panel";
import { absoluteUrl, buildCurl } from "@/components/proxy/curl";
import {
  WB_ORANGE,
  WORKBENCH_TABS,
  type WorkbenchTab,
  type WorkbenchTabDef,
} from "@/components/proxy/workbench-constants";

const ThemedClose = withUnistyles(X);
const mutedIcon = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

// Tabs that render their own working panel (everything else falls through to the phase placeholder).
type ProxySubValue = "intercept" | "history" | "ws";

const READY_INLINE = new Set<WorkbenchTab>([
  "captures",
  "proxy",
  "repeater",
  "decoder",
  "comparer",
  "target",
  "logger",
  "intruder",
  "sequencer",
]);

const DESCRIPTION =
  "An intercepting-proxy security workbench for the simulators on this host: capture, inspect and replay app traffic.";
const MAX_ROWS = 5000;

// The Workbench shell: Burp's top-level tool tabs across the top, the active tool below. P1 ships
// Captures + Proxy (HTTP history + message editor) live over the daemon MITM engine; the remaining
// Burp tools are present in the tab row and land phase by phase.
export function ProxyScreen() {
  const hosts = useHosts();
  const serverId = hosts[0]?.serverId ?? "";
  const client = useHostRuntimeClient(serverId);

  const [tab, setTab] = useState<WorkbenchTab>("captures");
  const [sessions, setSessions] = useState<ProxyCaptureSession[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [allRows, setAllRows] = useState<ProxyTransactionRow[]>([]);
  const [selectedTx, setSelectedTx] = useState<ProxyTransactionFull | null>(null);
  const [repeaterSeed, setRepeaterSeed] = useState<ProxyTransactionFull | null>(null);
  const [intruderSeed, setIntruderSeed] = useState<ProxyTransactionFull | null>(null);
  const [proxySub, setProxySub] = useState<ProxySubValue>("history");
  const [wsMessages, setWsMessages] = useState<ProxyWsMessage[]>([]);
  const [held, setHeld] = useState<ProxyHeldRequest[]>([]);
  const [interceptOn, setInterceptOn] = useState(false);

  // Live subscription: every transaction streams into one list; the Proxy tab filters it by the
  // active session while Logger shows them all. Session-state changes refresh the session list;
  // held requests (Intercept) queue up for the Intercept sub-tab.
  useEffect(() => {
    if (!client) return;
    const subscriptionId = `wb_${Math.random().toString(36).slice(2)}`;
    const offTx = client.onProxyTransaction(subscriptionId, ({ row }) => {
      setAllRows((prev) => [row, ...prev].slice(0, MAX_ROWS));
    });
    const offSession = client.onProxySession(subscriptionId, () => {
      void client.proxySessionsList().then((res) => setSessions(res.sessions));
    });
    const offHeld = client.onProxyInterceptHeld(subscriptionId, ({ held: h }) => {
      setHeld((prev) => [...prev, h]);
    });
    const offWs = client.onProxyWsMessage(subscriptionId, ({ message }) => {
      setWsMessages((prev) => [...prev, message].slice(-MAX_ROWS));
    });
    void client.proxySubscribe({ subscriptionId });
    void client.proxySessionsList().then((res) => setSessions(res.sessions));
    void client
      .proxyHistoryQuery({ sessionId: null, limit: MAX_ROWS })
      .then((res) => setAllRows(res.rows));
    return () => {
      offTx();
      offSession();
      offHeld();
      offWs();
      client.proxyUnsubscribe({ subscriptionId });
    };
  }, [client]);

  const handleResolveHeld = useCallback((heldId: string) => {
    setHeld((prev) => prev.filter((h) => h.heldId !== heldId));
  }, []);

  const rows = useMemo(
    () => (selectedSessionId ? allRows.filter((r) => r.sessionId === selectedSessionId) : allRows),
    [allRows, selectedSessionId],
  );

  const handleSelectRow = useCallback(
    (id: string) => {
      if (!client) return;
      void client.proxyTransactionGet({ id }).then((res) => setSelectedTx(res.transaction));
    },
    [client],
  );

  const rowActions = useMemo<HistoryRowActions>(
    () => ({
      onCopyUrl: (row) => void Clipboard.setStringAsync(absoluteUrl(row)),
      onCopyCurl: (row) => {
        if (!client) return;
        void client.proxyTransactionGet({ id: row.id }).then((res) => {
          if (res.transaction) void Clipboard.setStringAsync(buildCurl(res.transaction));
          return undefined;
        });
      },
      onSendToRepeater: (row) => {
        if (!client) return;
        void client.proxyTransactionGet({ id: row.id }).then((res) => {
          if (res.transaction) {
            setRepeaterSeed(res.transaction);
            setTab("repeater");
          }
          return undefined;
        });
      },
      onSendToIntruder: (row) => {
        if (!client) return;
        void client.proxyTransactionGet({ id: row.id }).then((res) => {
          if (res.transaction) {
            setIntruderSeed(res.transaction);
            setTab("intruder");
          }
          return undefined;
        });
      },
    }),
    [client],
  );

  const handleCloseEditor = useCallback(() => setSelectedTx(null), []);

  return (
    <View style={styles.screen}>
      <PageHeader icon={Radar} title="Workbench" description={DESCRIPTION} />
      <TabBar tab={tab} onSelect={setTab} />
      <View style={styles.body}>
        {tab === "captures" ? (
          <CapturesPanel
            client={client}
            sessions={sessions}
            selectedSessionId={selectedSessionId}
            onSelectSession={setSelectedSessionId}
          />
        ) : null}
        {tab === "proxy" ? (
          <View style={styles.proxyPane}>
            <View style={styles.subTabs}>
              <ProxySubTab
                label="Intercept"
                active={proxySub === "intercept"}
                value="intercept"
                onSelect={setProxySub}
                badge={held.length}
              />
              <ProxySubTab
                label="HTTP history"
                active={proxySub === "history"}
                value="history"
                onSelect={setProxySub}
                badge={0}
              />
              <ProxySubTab
                label="WebSockets"
                active={proxySub === "ws"}
                value="ws"
                onSelect={setProxySub}
                badge={0}
              />
            </View>
            {proxySub === "intercept" ? (
              <InterceptPanel
                client={client}
                held={held}
                interceptOn={interceptOn}
                onToggle={setInterceptOn}
                onResolved={handleResolveHeld}
              />
            ) : null}
            {proxySub === "ws" ? <WsHistory messages={wsMessages} /> : null}
            {proxySub === "history" ? (
              <HistoryEditorPane
                rows={rows}
                selectedTx={selectedTx}
                onSelect={handleSelectRow}
                onClose={handleCloseEditor}
                actions={rowActions}
              />
            ) : null}
          </View>
        ) : null}
        {tab === "repeater" ? <RepeaterPanel client={client} seed={repeaterSeed} /> : null}
        {tab === "target" ? (
          <TargetPanel client={client} rows={allRows} actions={rowActions} />
        ) : null}
        {tab === "logger" ? (
          <HistoryEditorPane
            rows={allRows}
            selectedTx={selectedTx}
            onSelect={handleSelectRow}
            onClose={handleCloseEditor}
            actions={rowActions}
          />
        ) : null}
        {tab === "decoder" ? <DecoderPanel /> : null}
        {tab === "comparer" ? <ComparerPanel /> : null}
        {tab === "intruder" ? <IntruderPanel client={client} seed={intruderSeed} /> : null}
        {tab === "sequencer" ? <SequencerPanel /> : null}
        {READY_INLINE.has(tab) ? null : <PhasePlaceholder tab={tab} />}
      </View>
    </View>
  );
}

// HTTP-history table over a request/response editor that closes — shared by the Proxy › HTTP history
// sub-tab and the Logger tab.
function HistoryEditorPane({
  rows,
  selectedTx,
  onSelect,
  onClose,
  actions,
}: {
  rows: ProxyTransactionRow[];
  selectedTx: ProxyTransactionFull | null;
  onSelect: (id: string) => void;
  onClose: () => void;
  actions: HistoryRowActions;
}) {
  return (
    <View style={styles.proxyPane}>
      <View style={styles.historyPane}>
        <HttpHistory
          rows={rows}
          selectedId={selectedTx?.id ?? null}
          onSelect={onSelect}
          actions={actions}
        />
      </View>
      {selectedTx ? (
        <View style={styles.editorPane}>
          <View style={styles.editorBar}>
            <Text style={styles.editorBarTitle} numberOfLines={1}>
              {selectedTx.method} {selectedTx.host}
              {selectedTx.url}
            </Text>
            <Pressable onPress={onClose} style={styles.editorClose} testID="wb-editor-close">
              <ThemedClose size={16} uniProps={mutedIcon} />
            </Pressable>
          </View>
          <MessageEditor transaction={selectedTx} />
        </View>
      ) : null}
    </View>
  );
}

function ProxySubTab({
  label,
  value,
  active,
  badge,
  onSelect,
}: {
  label: string;
  value: ProxySubValue;
  active: boolean;
  badge: number;
  onSelect: (v: ProxySubValue) => void;
}) {
  const handlePress = useCallback(() => onSelect(value), [onSelect, value]);
  return (
    <Pressable onPress={handlePress} style={active ? styles.subTabOn : styles.subTab}>
      <Text style={active ? styles.subTabTextOn : styles.subTabText}>{label}</Text>
      {badge > 0 ? (
        <View style={styles.subBadge}>
          <Text style={styles.subBadgeText}>{badge}</Text>
        </View>
      ) : null}
    </Pressable>
  );
}

function TabBar({ tab, onSelect }: { tab: WorkbenchTab; onSelect: (t: WorkbenchTab) => void }) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={styles.tabBar}
      contentContainerStyle={styles.tabBarContent}
    >
      {WORKBENCH_TABS.map((def) => (
        <WorkbenchTabButton key={def.key} def={def} active={def.key === tab} onSelect={onSelect} />
      ))}
    </ScrollView>
  );
}

function WorkbenchTabButton({
  def,
  active,
  onSelect,
}: {
  def: WorkbenchTabDef;
  active: boolean;
  onSelect: (t: WorkbenchTab) => void;
}) {
  const handlePress = useCallback(() => onSelect(def.key), [def.key, onSelect]);
  return (
    <Pressable onPress={handlePress} style={active ? styles.tabActive : styles.tab}>
      <Text style={active ? styles.tabTextActive : styles.tabText}>{def.label}</Text>
      {def.ready ? null : <View style={styles.soonDot} />}
    </Pressable>
  );
}

function PhasePlaceholder({ tab }: { tab: WorkbenchTab }) {
  const label = WORKBENCH_TABS.find((t) => t.key === tab)?.label ?? tab;
  return (
    <View style={styles.placeholder}>
      <Text style={styles.placeholderTitle}>{label}</Text>
      <Text style={styles.placeholderText}>
        This Burp tool is being built in a later phase of the Workbench. Proxy capture and HTTP
        history are live now.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  screen: { flex: 1, backgroundColor: theme.colors.surface0 },
  tabBar: {
    flexGrow: 0,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  tabBarContent: { paddingHorizontal: theme.spacing[2] },
  tab: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderBottomWidth: 2,
    borderBottomColor: "transparent",
  },
  tabActive: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderBottomWidth: 2,
    borderBottomColor: WB_ORANGE,
  },
  tabText: { fontSize: theme.fontSize.sm, color: theme.colors.foregroundMuted },
  tabTextActive: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
    fontWeight: theme.fontWeight.semibold,
  },
  soonDot: {
    width: 5,
    height: 5,
    borderRadius: 3,
    backgroundColor: theme.colors.foregroundExtraMuted,
  },
  body: { flex: 1, minHeight: 0 },
  subTabs: {
    flexDirection: "row",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  subTab: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.sm,
  },
  subTabOn: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
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
  subBadge: {
    minWidth: 16,
    height: 16,
    paddingHorizontal: 4,
    borderRadius: 8,
    backgroundColor: WB_ORANGE,
    alignItems: "center",
    justifyContent: "center",
  },
  subBadgeText: { fontSize: 10, color: "#fff", fontWeight: "700" },
  proxyPane: { flex: 1 },
  historyPane: { flex: 1, minHeight: 0 },
  editorPane: {
    flex: 1,
    minHeight: 0,
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  editorBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingLeft: theme.spacing[3],
    paddingRight: theme.spacing[1],
    paddingVertical: theme.spacing[1],
    backgroundColor: theme.colors.surface2,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  editorBarTitle: {
    flex: 1,
    minWidth: 0,
    fontSize: theme.fontSize.xs,
    fontFamily: theme.fontFamily.mono,
    color: theme.colors.foregroundMuted,
  },
  editorClose: {
    width: 28,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.sm,
  },
  placeholder: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: theme.spacing[6],
    gap: theme.spacing[2],
  },
  placeholderTitle: {
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.bold,
    color: theme.colors.foreground,
  },
  placeholderText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    textAlign: "center",
    maxWidth: 420,
  },
}));
