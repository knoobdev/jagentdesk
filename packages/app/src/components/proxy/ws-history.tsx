import { memo } from "react";
import { ScrollView, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { ProxyWsMessage } from "@jagentdesk/protocol/proxy/rpc-schemas";
import type { Theme } from "@/styles/theme";
import { WB_ORANGE } from "./workbench-constants";

// Burp Proxy › WebSockets history: one row per observed WS data frame, with direction, opcode,
// length and a text preview. Frames are captured live as they pass through the proxy tunnel.

export function WsHistory({ messages }: { messages: ProxyWsMessage[] }) {
  if (messages.length === 0) {
    return (
      <View style={styles.empty}>
        <Text style={styles.emptyText}>
          No WebSocket frames yet. They appear here as captured apps open WebSocket connections.
        </Text>
      </View>
    );
  }
  return (
    <ScrollView style={styles.container}>
      <View style={styles.headRow}>
        <Text style={[styles.hCell, styles.cDir]}>Dir</Text>
        <Text style={[styles.hCell, styles.cHost]}>Host</Text>
        <Text style={[styles.hCell, styles.cType]}>Type</Text>
        <Text style={[styles.hCell, styles.cLen]}>Length</Text>
        <Text style={[styles.hCell, styles.cData]}>Data</Text>
      </View>
      {messages.map((m) => (
        <WsRow key={m.id} message={m} />
      ))}
    </ScrollView>
  );
}

const WsRow = memo(function WsRow({ message }: { message: ProxyWsMessage }) {
  const toServer = message.direction === "to-server";
  return (
    <View style={styles.row}>
      <Text style={[styles.cell, styles.cDir, toServer ? styles.dirOut : styles.dirIn]}>
        {toServer ? "→" : "←"}
      </Text>
      <Text style={[styles.cell, styles.cHost]} numberOfLines={1}>
        {message.host}
      </Text>
      <Text style={[styles.cell, styles.cType]}>{message.opcode === 1 ? "text" : "binary"}</Text>
      <Text style={[styles.cell, styles.cLen]}>{message.length}</Text>
      <Text style={[styles.cell, styles.cData]} numberOfLines={1}>
        {message.preview}
      </Text>
    </View>
  );
});

const styles = StyleSheet.create((theme: Theme) => ({
  container: { flex: 1, backgroundColor: theme.colors.surface0 },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", padding: theme.spacing[6] },
  emptyText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    textAlign: "center",
    maxWidth: 440,
  },
  headRow: {
    flexDirection: "row",
    backgroundColor: theme.colors.surface2,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  hCell: {
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foregroundMuted,
  },
  row: { flexDirection: "row", borderBottomWidth: 1, borderBottomColor: theme.colors.border },
  cell: {
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    fontSize: theme.fontSize.xs,
    fontFamily: theme.fontFamily.mono,
    color: theme.colors.foreground,
  },
  cDir: { width: 40, textAlign: "center" },
  dirOut: { color: WB_ORANGE, fontWeight: theme.fontWeight.bold },
  dirIn: { color: theme.colors.success, fontWeight: theme.fontWeight.bold },
  cHost: { width: 180 },
  cType: { width: 60 },
  cLen: { width: 70 },
  cData: { flex: 1, minWidth: 0 },
}));
