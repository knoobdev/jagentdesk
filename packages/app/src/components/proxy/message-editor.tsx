import { useCallback, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { ProxyHeader, ProxyTransactionFull } from "@jagentdesk/protocol/proxy/rpc-schemas";
import type { Theme } from "@/styles/theme";
import { WB_ORANGE } from "./workbench-constants";
import { bytesToUtf8, decodeBase64 } from "./base64";

// The Burp message editor: request on the left, response on the right (stacked on phones), each
// with Pretty / Raw / Hex sub-tabs. Pretty pretty-prints JSON; Raw shows the exact bytes as text;
// Hex is a classic offset / hex / ASCII dump. Read-only in P1 (editing + resend arrives with
// Repeater in a later phase).

type ViewMode = "pretty" | "raw" | "hex";
const MODES: ViewMode[] = ["pretty", "raw", "hex"];
const MODE_LABELS: Record<ViewMode, string> = { pretty: "Pretty", raw: "Raw", hex: "Hex" };

export function MessageEditor({ transaction }: { transaction: ProxyTransactionFull | null }) {
  if (!transaction) {
    return (
      <View style={styles.empty}>
        <Text style={styles.emptyText}>Select a request to view its message.</Text>
      </View>
    );
  }
  return (
    <View style={styles.split}>
      <MessagePane
        title="Request"
        startLine={transaction.requestLine}
        headers={transaction.requestHeaders}
        bodyB64={transaction.requestBodyB64}
        isText={transaction.requestBodyIsText}
      />
      <MessagePane
        title="Response"
        startLine={transaction.statusLine}
        headers={transaction.responseHeaders}
        bodyB64={transaction.responseBodyB64}
        isText={transaction.responseBodyIsText}
      />
    </View>
  );
}

function ModeButton({
  mode,
  active,
  onSelect,
}: {
  mode: ViewMode;
  active: boolean;
  onSelect: (m: ViewMode) => void;
}) {
  const handlePress = useCallback(() => onSelect(mode), [mode, onSelect]);
  const label = MODE_LABELS[mode];
  return (
    <Pressable onPress={handlePress} style={active ? styles.modeActive : styles.mode}>
      <Text style={active ? styles.modeTextActive : styles.modeText}>{label}</Text>
    </Pressable>
  );
}

export function MessagePane({
  title,
  startLine,
  headers,
  bodyB64,
  isText,
}: {
  title: string;
  startLine: string;
  headers: ProxyHeader[];
  bodyB64: string;
  isText: boolean;
}) {
  const [mode, setMode] = useState<ViewMode>("pretty");
  const bytes = useMemo(() => decodeBase64(bodyB64), [bodyB64]);
  const headerText = useMemo(
    () => headers.map((h) => `${h.name}: ${h.value}`).join("\n"),
    [headers],
  );
  const body = useMemo(
    () => renderBody(mode, bytes, isText, headers),
    [mode, bytes, isText, headers],
  );

  return (
    <View style={styles.pane}>
      <View style={styles.paneTabs}>
        <Text style={styles.paneTitle}>{title}</Text>
        <View style={styles.modeRow}>
          {MODES.map((m) => (
            <ModeButton key={m} mode={m} active={mode === m} onSelect={setMode} />
          ))}
        </View>
      </View>
      <ScrollView style={styles.body} contentContainerStyle={styles.bodyContent}>
        <Text style={styles.startLine} selectable>
          {startLine}
        </Text>
        {headerText ? (
          <Text style={styles.headers} selectable>
            {headerText}
          </Text>
        ) : null}
        {body ? (
          <Text style={styles.bodyText} selectable>
            {body}
          </Text>
        ) : null}
      </ScrollView>
    </View>
  );
}

function renderBody(
  mode: ViewMode,
  bytes: Uint8Array,
  isText: boolean,
  headers: ProxyHeader[],
): string {
  if (bytes.length === 0) return "";
  if (mode === "hex") return hexDump(bytes);
  if (!isText) return `[${bytes.length} bytes of binary body — switch to Hex]`;
  const text = bytesToUtf8(bytes);
  if (mode === "pretty" && looksJson(headers)) {
    try {
      return JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      return text;
    }
  }
  return text;
}

function looksJson(headers: ProxyHeader[]): boolean {
  for (const h of headers) {
    if (h.name.toLowerCase() === "content-type" && h.value.toLowerCase().includes("json")) {
      return true;
    }
  }
  return false;
}

function hexDump(bytes: Uint8Array): string {
  const lines: string[] = [];
  const cap = Math.min(bytes.length, 64 * 1024);
  for (let i = 0; i < cap; i += 16) {
    const slice = bytes.subarray(i, i + 16);
    const hex = [...slice].map((b) => b.toString(16).padStart(2, "0")).join(" ");
    const ascii = [...slice]
      .map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : "."))
      .join("");
    lines.push(`${i.toString(16).padStart(8, "0")}  ${hex.padEnd(47, " ")}  ${ascii}`);
  }
  if (bytes.length > cap) lines.push(`… ${bytes.length - cap} more bytes`);
  return lines.join("\n");
}

const styles = StyleSheet.create((theme: Theme) => ({
  empty: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: theme.spacing[4],
  },
  emptyText: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  split: {
    flex: 1,
    minHeight: 0,
    flexDirection: "row",
    gap: 1,
    backgroundColor: theme.colors.border,
  },
  pane: { flex: 1, minWidth: 0, minHeight: 0, backgroundColor: theme.colors.surface0 },
  paneTabs: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  paneTitle: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.bold,
    color: theme.colors.foreground,
    textTransform: "uppercase",
  },
  modeRow: { flexDirection: "row", gap: theme.spacing[1] },
  mode: {
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 2,
    borderRadius: theme.borderRadius.sm,
  },
  modeActive: {
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 2,
    borderRadius: theme.borderRadius.sm,
    borderBottomWidth: 2,
    borderBottomColor: WB_ORANGE,
  },
  modeText: { fontSize: theme.fontSize.xs, color: theme.colors.foregroundMuted },
  modeTextActive: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foreground,
    fontWeight: theme.fontWeight.semibold,
  },
  body: { flex: 1 },
  bodyContent: { padding: theme.spacing[2], gap: theme.spacing[2] },
  startLine: {
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.xs,
    color: WB_ORANGE,
  },
  headers: {
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  bodyText: {
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foreground,
  },
}));
