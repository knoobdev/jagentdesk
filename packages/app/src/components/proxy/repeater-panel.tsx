import { useCallback, useEffect, useRef, useState } from "react";
import { Modal, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { ChevronDown, Plus, X } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { ProxyTransactionFull } from "@jagentdesk/protocol/proxy/rpc-schemas";
import type { DaemonClient } from "@jagentdesk/client/internal/daemon-client";
import type { Theme } from "@/styles/theme";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { bytesToUtf8, decodeBase64, utf8ToBase64 } from "./base64";
import { HeaderEditor, makeHeaderRows, rowsToHeaders, type HeaderRowValue } from "./header-editor";
import { MessagePane } from "./message-editor";
import { WbButton } from "./wb-button";
import { WB_ORANGE } from "./workbench-constants";

// Burp Repeater: each request is its own TAB (created by "Send to Repeater"), which can be renamed,
// duplicated or closed. Each tab has a structured request editor — method dropdown, path, editable
// key/value headers (with suggestions), and a body box with JSON formatting — plus its own response.

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
const mutedColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const ThemedChevron = withUnistyles(ChevronDown);
const ThemedPlus = withUnistyles(Plus);
const ThemedX = withUnistyles(X);

interface RepeaterTab {
  id: string;
  title: string;
  secure: boolean;
  host: string;
  port: string;
  method: string;
  path: string;
  rows: HeaderRowValue[];
  body: string;
  response: ProxyTransactionFull | null;
  sending: boolean;
  error: string | null;
}

let tabSeq = 0;
function emptyTab(): RepeaterTab {
  tabSeq += 1;
  return {
    id: `rt${tabSeq}`,
    title: `Tab ${tabSeq}`,
    secure: true,
    host: "",
    port: "443",
    method: "GET",
    path: "/",
    rows: [],
    body: "",
    response: null,
    sending: false,
    error: null,
  };
}

function tabFromSeed(seed: ProxyTransactionFull): RepeaterTab {
  tabSeq += 1;
  const parts = seed.requestLine.split(/\s+/);
  return {
    id: `rt${tabSeq}`,
    title: `${parts[0] || "GET"} ${seed.host}`.slice(0, 24),
    secure: seed.secure,
    host: seed.host,
    port: String(seed.port),
    method: parts[0] || "GET",
    path: parts[1] || seed.url || "/",
    rows: makeHeaderRows(seed.requestHeaders),
    body: seed.requestBodyIsText ? bytesToUtf8(decodeBase64(seed.requestBodyB64)) : "",
    response: null,
    sending: false,
    error: null,
  };
}

export function RepeaterPanel({
  client,
  seed,
}: {
  client: DaemonClient | null;
  seed: ProxyTransactionFull | null;
}) {
  const [tabs, setTabs] = useState<RepeaterTab[]>(() => [emptyTab()]);
  const [activeId, setActiveId] = useState<string>(tabs[0]!.id);
  const [renaming, setRenaming] = useState<RepeaterTab | null>(null);
  const seedRef = useRef<ProxyTransactionFull | null>(null);

  // A new seed (from "Send to Repeater") opens a new tab.
  useEffect(() => {
    if (!seed || seed === seedRef.current) return;
    seedRef.current = seed;
    const tab = tabFromSeed(seed);
    setTabs((prev) => [...prev, tab]);
    setActiveId(tab.id);
  }, [seed]);

  const active = tabs.find((t) => t.id === activeId) ?? tabs[0] ?? null;

  const patchActive = useCallback(
    (patch: Partial<RepeaterTab>) => {
      setTabs((prev) => prev.map((t) => (t.id === activeId ? { ...t, ...patch } : t)));
    },
    [activeId],
  );

  const addTab = useCallback(() => {
    const t = emptyTab();
    setTabs((prev) => [...prev, t]);
    setActiveId(t.id);
  }, []);

  const closeTab = useCallback((id: string) => {
    setTabs((prev) => {
      const next = prev.filter((t) => t.id !== id);
      const safe = next.length > 0 ? next : [emptyTab()];
      setActiveId((cur) => (cur === id ? safe[safe.length - 1]!.id : cur));
      return safe;
    });
  }, []);

  const duplicateTab = useCallback((id: string) => {
    setTabs((prev) => {
      const src = prev.find((t) => t.id === id);
      if (!src) return prev;
      tabSeq += 1;
      const copy: RepeaterTab = {
        ...src,
        id: `rt${tabSeq}`,
        title: `${src.title} copy`,
        rows: src.rows.map((r) => ({ id: r.id, name: r.name, value: r.value })),
        response: null,
      };
      setActiveId(copy.id);
      const idx = prev.findIndex((t) => t.id === id);
      return [...prev.slice(0, idx + 1), copy, ...prev.slice(idx + 1)];
    });
  }, []);

  const renameTab = useCallback((id: string, title: string) => {
    setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, title: title || t.title } : t)));
  }, []);

  const send = useCallback(async () => {
    if (!client || !active || !active.host) return;
    patchActive({ sending: true, error: null });
    try {
      const res = await client.proxyRepeaterSend({
        secure: active.secure,
        host: active.host,
        port: Number(active.port) || (active.secure ? 443 : 80),
        method: active.method.trim() || "GET",
        path: active.path.trim() || "/",
        headers: rowsToHeaders(active.rows),
        bodyB64: utf8ToBase64(active.body),
      });
      patchActive({ sending: false, response: res.transaction, error: res.error });
    } catch (err) {
      patchActive({ sending: false, error: err instanceof Error ? err.message : String(err) });
    }
  }, [active, client, patchActive]);

  const handleRenameSubmit = useCallback(
    (title: string) => {
      setRenaming((cur) => {
        if (cur) renameTab(cur.id, title);
        return null;
      });
    },
    [renameTab],
  );
  const handleRenameCancel = useCallback(() => setRenaming(null), []);

  if (!active) return null;

  return (
    <View style={styles.container}>
      <TabsBar
        tabs={tabs}
        activeId={activeId}
        onSelect={setActiveId}
        onAdd={addTab}
        onClose={closeTab}
        onDuplicate={duplicateTab}
        onRename={setRenaming}
      />
      <RequestResponse tab={active} onPatch={patchActive} onSend={send} />
      <RenameModal tab={renaming} onSubmit={handleRenameSubmit} onCancel={handleRenameCancel} />
    </View>
  );
}

function TabsBar({
  tabs,
  activeId,
  onSelect,
  onAdd,
  onClose,
  onDuplicate,
  onRename,
}: {
  tabs: RepeaterTab[];
  activeId: string;
  onSelect: (id: string) => void;
  onAdd: () => void;
  onClose: (id: string) => void;
  onDuplicate: (id: string) => void;
  onRename: (tab: RepeaterTab) => void;
}) {
  return (
    <View style={styles.tabsBar}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.tabsRow}
      >
        {tabs.map((t) => (
          <TabChip
            key={t.id}
            tab={t}
            active={t.id === activeId}
            onSelect={onSelect}
            onClose={onClose}
            onDuplicate={onDuplicate}
            onRename={onRename}
          />
        ))}
      </ScrollView>
      <Pressable onPress={onAdd} style={styles.addTab} testID="wb-repeater-add-tab">
        <ThemedPlus size={16} uniProps={mutedColor} />
      </Pressable>
    </View>
  );
}

function TabChip({
  tab,
  active,
  onSelect,
  onClose,
  onDuplicate,
  onRename,
}: {
  tab: RepeaterTab;
  active: boolean;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onDuplicate: (id: string) => void;
  onRename: (tab: RepeaterTab) => void;
}) {
  const select = useCallback(() => onSelect(tab.id), [onSelect, tab.id]);
  const close = useCallback(() => onClose(tab.id), [onClose, tab.id]);
  const duplicate = useCallback(() => onDuplicate(tab.id), [onDuplicate, tab.id]);
  const rename = useCallback(() => onRename(tab), [onRename, tab]);
  return (
    <ContextMenu>
      <ContextMenuTrigger
        enabledOnMobile
        onPress={select}
        style={active ? styles.tabChipOn : styles.tabChip}
        testID={`wb-repeater-tab-${tab.id}`}
      >
        <Text style={active ? styles.tabTextOn : styles.tabText} numberOfLines={1}>
          {tab.title}
        </Text>
        <Pressable
          onPress={close}
          hitSlop={6}
          style={styles.tabClose}
          testID={`wb-repeater-close-${tab.id}`}
        >
          <ThemedX size={12} uniProps={mutedColor} />
        </Pressable>
      </ContextMenuTrigger>
      <ContextMenuContent align="start" width={170}>
        <ContextMenuItem onSelect={rename}>Rename…</ContextMenuItem>
        <ContextMenuItem onSelect={duplicate}>Duplicate</ContextMenuItem>
        <ContextMenuItem destructive onSelect={close}>
          Close
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function MethodSelect({ method, onChange }: { method: string; onChange: (m: string) => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger style={styles.methodTrigger} accessibilityLabel="HTTP method">
        <Text style={styles.methodText}>{method}</Text>
        <ThemedChevron size={14} uniProps={mutedColor} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" width={140}>
        {METHODS.map((m) => (
          <MethodItem key={m} method={m} onChange={onChange} />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function MethodItem({ method, onChange }: { method: string; onChange: (m: string) => void }) {
  const handleSelect = useCallback(() => onChange(method), [method, onChange]);
  return <DropdownMenuItem onSelect={handleSelect}>{method}</DropdownMenuItem>;
}

function RequestResponse({
  tab,
  onPatch,
  onSend,
}: {
  tab: RepeaterTab;
  onPatch: (patch: Partial<RepeaterTab>) => void;
  onSend: () => void;
}) {
  const toggleSecure = useCallback(() => onPatch({ secure: !tab.secure }), [onPatch, tab.secure]);
  const setHost = useCallback((host: string) => onPatch({ host }), [onPatch]);
  const setPort = useCallback((port: string) => onPatch({ port }), [onPatch]);
  const setMethod = useCallback((method: string) => onPatch({ method }), [onPatch]);
  const setPath = useCallback((path: string) => onPatch({ path }), [onPatch]);
  const setRows = useCallback((rows: HeaderRowValue[]) => onPatch({ rows }), [onPatch]);
  const setBody = useCallback((body: string) => onPatch({ body }), [onPatch]);
  const clearTarget = useCallback(() => onPatch({ host: "", path: "/" }), [onPatch]);
  const formatJson = useCallback(() => {
    try {
      onPatch({ body: JSON.stringify(JSON.parse(tab.body), null, 2), error: null });
    } catch {
      onPatch({ error: "Body is not valid JSON." });
    }
  }, [onPatch, tab.body]);

  return (
    <View style={styles.splitWrap}>
      <View style={styles.targetRow}>
        <Pressable onPress={toggleSecure} style={tab.secure ? styles.schemeOn : styles.scheme}>
          <Text style={tab.secure ? styles.schemeTextOn : styles.schemeText}>
            {tab.secure ? "HTTPS" : "HTTP"}
          </Text>
        </Pressable>
        <TextInput
          style={styles.hostInput}
          value={tab.host}
          onChangeText={setHost}
          placeholder="host"
          autoCapitalize="none"
          autoCorrect={false}
        />
        <Text style={styles.colon}>:</Text>
        <TextInput
          style={styles.portInput}
          value={tab.port}
          onChangeText={setPort}
          keyboardType="number-pad"
        />
        <Pressable
          onPress={clearTarget}
          hitSlop={6}
          style={styles.clearTarget}
          testID="wb-repeater-clear"
        >
          <ThemedX size={14} uniProps={mutedColor} />
        </Pressable>
        <WbButton label="Send" onPress={onSend} loading={tab.sending} testID="wb-repeater-send" />
      </View>
      {tab.error ? <Text style={styles.error}>{tab.error}</Text> : null}
      <View style={styles.split}>
        <View style={styles.reqPane}>
          <View style={styles.reqHeadFixed}>
            <Text style={styles.paneTitle}>REQUEST</Text>
            <View style={styles.methodRow}>
              <MethodSelect method={tab.method} onChange={setMethod} />
              <TextInput
                style={styles.pathInput}
                value={tab.path}
                onChangeText={setPath}
                placeholder="/path?query"
                autoCapitalize="none"
                autoCorrect={false}
              />
            </View>
            <Text style={styles.label}>Headers</Text>
          </View>
          <ScrollView
            style={styles.headersScroll}
            contentContainerStyle={styles.headersScrollContent}
          >
            <HeaderEditor rows={tab.rows} onChange={setRows} />
          </ScrollView>
          <View style={styles.bodyHead}>
            <Text style={styles.label}>Body</Text>
            <Pressable onPress={formatJson} hitSlop={6}>
              <Text style={styles.formatBtn}>Format JSON</Text>
            </Pressable>
          </View>
          <TextInput
            style={styles.bodyInput}
            value={tab.body}
            onChangeText={setBody}
            multiline
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="{ }"
            placeholderTextColor="#9aa"
          />
        </View>
        <View style={styles.pane}>
          {tab.response ? (
            <MessagePane
              title="Response"
              startLine={tab.response.statusLine}
              headers={tab.response.responseHeaders}
              bodyB64={tab.response.responseBodyB64}
              isText={tab.response.responseBodyIsText}
            />
          ) : (
            <View style={styles.respEmpty}>
              <Text style={styles.respEmptyText}>Send the request to see the response.</Text>
            </View>
          )}
        </View>
      </View>
    </View>
  );
}

function RenameModal({
  tab,
  onSubmit,
  onCancel,
}: {
  tab: RepeaterTab | null;
  onSubmit: (title: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState("");
  useEffect(() => {
    setText(tab?.title ?? "");
  }, [tab]);
  const save = useCallback(() => onSubmit(text), [onSubmit, text]);
  return (
    <Modal visible={tab != null} transparent animationType="fade" onRequestClose={onCancel}>
      <Pressable style={styles.modalBackdrop} onPress={onCancel}>
        <Pressable style={styles.modalCard}>
          <Text style={styles.modalTitle}>Rename tab</Text>
          <TextInput
            style={styles.modalInput}
            value={text}
            onChangeText={setText}
            autoFocus
            autoCapitalize="none"
          />
          <View style={styles.modalActions}>
            <WbButton label="Cancel" variant="ghost" onPress={onCancel} />
            <WbButton label="Save" onPress={save} />
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  container: { flex: 1, minHeight: 0, backgroundColor: theme.colors.surface0 },
  tabsBar: {
    flexDirection: "row",
    alignItems: "center",
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  tabsRow: { alignItems: "center", paddingHorizontal: theme.spacing[1] },
  tabChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    maxWidth: 200,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[2],
    borderBottomWidth: 2,
    borderBottomColor: "transparent",
  },
  tabChipOn: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    maxWidth: 200,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[2],
    borderBottomWidth: 2,
    borderBottomColor: WB_ORANGE,
  },
  tabText: { fontSize: theme.fontSize.xs, color: theme.colors.foregroundMuted, flexShrink: 1 },
  tabTextOn: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foreground,
    fontWeight: theme.fontWeight.semibold,
    flexShrink: 1,
  },
  tabClose: { width: 16, height: 16, alignItems: "center", justifyContent: "center" },
  addTab: { paddingHorizontal: theme.spacing[2], paddingVertical: theme.spacing[2] },
  splitWrap: { flex: 1, minHeight: 0 },
  targetRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    padding: theme.spacing[2],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  scheme: {
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.sm,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  schemeOn: {
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.sm,
    borderWidth: 1,
    borderColor: WB_ORANGE,
    backgroundColor: WB_ORANGE + "18",
  },
  schemeText: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
    fontWeight: theme.fontWeight.semibold,
  },
  schemeTextOn: {
    fontSize: theme.fontSize.xs,
    color: WB_ORANGE,
    fontWeight: theme.fontWeight.bold,
  },
  hostInput: {
    flex: 1,
    minWidth: 0,
    fontSize: theme.fontSize.sm,
    fontFamily: theme.fontFamily.mono,
    color: theme.colors.foreground,
    paddingVertical: 4,
    paddingHorizontal: theme.spacing[2],
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.sm,
    outlineWidth: 0,
  },
  colon: { color: theme.colors.foregroundMuted },
  portInput: {
    width: 64,
    fontSize: theme.fontSize.sm,
    fontFamily: theme.fontFamily.mono,
    color: theme.colors.foreground,
    paddingVertical: 4,
    paddingHorizontal: theme.spacing[2],
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.sm,
    outlineWidth: 0,
  },
  error: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.xs,
    paddingHorizontal: theme.spacing[2],
    paddingBottom: theme.spacing[1],
  },
  split: {
    flex: 1,
    minHeight: 0,
    flexDirection: "row",
    gap: 1,
    backgroundColor: theme.colors.border,
  },
  pane: { flex: 1, minWidth: 0, minHeight: 0, backgroundColor: theme.colors.surface0 },
  reqPane: {
    flex: 1,
    minWidth: 0,
    minHeight: 0,
    backgroundColor: theme.colors.surface0,
    padding: theme.spacing[2],
    gap: theme.spacing[2],
  },
  reqHeadFixed: { gap: theme.spacing[2] },
  headersScroll: { maxHeight: 160 },
  headersScrollContent: { paddingBottom: theme.spacing[1] },
  clearTarget: { width: 26, height: 26, alignItems: "center", justifyContent: "center" },
  paneContent: {
    padding: theme.spacing[2],
    gap: theme.spacing[2],
    paddingBottom: theme.spacing[8],
  },
  paneTitle: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.bold,
    color: theme.colors.foreground,
    textTransform: "uppercase",
  },
  methodRow: { flexDirection: "row", gap: theme.spacing[1], alignItems: "center" },
  methodTrigger: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    width: 96,
    paddingVertical: 4,
    paddingHorizontal: theme.spacing[2],
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.sm,
  },
  methodText: {
    flex: 1,
    fontSize: theme.fontSize.xs,
    fontFamily: theme.fontFamily.mono,
    color: WB_ORANGE,
    fontWeight: theme.fontWeight.bold,
  },
  pathInput: {
    flex: 1,
    minWidth: 0,
    fontSize: theme.fontSize.xs,
    fontFamily: theme.fontFamily.mono,
    color: theme.colors.foreground,
    paddingVertical: 4,
    paddingHorizontal: theme.spacing[2],
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.sm,
    outlineWidth: 0,
  },
  label: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
    fontWeight: theme.fontWeight.semibold,
  },
  bodyHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  formatBtn: {
    fontSize: theme.fontSize.xs,
    color: WB_ORANGE,
    fontWeight: theme.fontWeight.semibold,
  },
  bodyInput: {
    flex: 1,
    minHeight: 120,
    fontSize: theme.fontSize.xs,
    fontFamily: theme.fontFamily.mono,
    color: theme.colors.foreground,
    padding: theme.spacing[2],
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.sm,
    textAlignVertical: "top",
    outlineWidth: 0,
  },
  respEmpty: { flex: 1, alignItems: "center", justifyContent: "center" },
  respEmptyText: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.4)",
    alignItems: "center",
    justifyContent: "center",
    padding: theme.spacing[4],
  },
  modalCard: {
    width: "100%",
    maxWidth: 360,
    backgroundColor: theme.colors.surface0,
    borderRadius: theme.borderRadius.lg,
    padding: theme.spacing[4],
    gap: theme.spacing[3],
  },
  modalTitle: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.bold,
    color: theme.colors.foreground,
  },
  modalInput: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    padding: theme.spacing[2],
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
    outlineWidth: 0,
  },
  modalActions: { flexDirection: "row", justifyContent: "flex-end", gap: theme.spacing[2] },
}));
