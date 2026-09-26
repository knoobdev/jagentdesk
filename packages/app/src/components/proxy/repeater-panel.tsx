import { useCallback, useEffect, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { ProxyTransactionFull } from "@jagentdesk/protocol/proxy/rpc-schemas";
import type { DaemonClient } from "@jagentdesk/client/internal/daemon-client";
import type { Theme } from "@/styles/theme";
import { bytesToUtf8, decodeBase64, utf8ToBase64 } from "./base64";
import { HeaderEditor, makeHeaderRows, rowsToHeaders, type HeaderRowValue } from "./header-editor";
import { MessagePane } from "./message-editor";
import { WbButton } from "./wb-button";
import { WB_ORANGE } from "./workbench-constants";

// Burp Repeater with a structured request editor: method + path, editable key/value header rows,
// and a body box with one-click JSON formatting. The response shows on the right (headers as a
// key/value table, JSON pretty-printed). A history row can seed all fields via "Send to Repeater".

export function RepeaterPanel({
  client,
  seed,
}: {
  client: DaemonClient | null;
  seed: ProxyTransactionFull | null;
}) {
  const [secure, setSecure] = useState(true);
  const [host, setHost] = useState("");
  const [port, setPort] = useState("443");
  const [method, setMethod] = useState("GET");
  const [path, setPath] = useState("/");
  const [rows, setRows] = useState<HeaderRowValue[]>([]);
  const [body, setBody] = useState("");
  const [response, setResponse] = useState<ProxyTransactionFull | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!seed) return;
    setSecure(seed.secure);
    setHost(seed.host);
    setPort(String(seed.port));
    const parts = seed.requestLine.split(/\s+/);
    setMethod(parts[0] || "GET");
    setPath(parts[1] || seed.url || "/");
    setRows(makeHeaderRows(seed.requestHeaders));
    setBody(seed.requestBodyIsText ? bytesToUtf8(decodeBase64(seed.requestBodyB64)) : "");
    setResponse(null);
    setError(null);
  }, [seed]);

  const toggleSecure = useCallback(() => setSecure((s) => !s), []);

  const formatJson = useCallback(() => {
    try {
      setBody(JSON.stringify(JSON.parse(body), null, 2));
      setError(null);
    } catch {
      setError("Body is not valid JSON.");
    }
  }, [body]);

  const handleSend = useCallback(async () => {
    if (!client || !host) return;
    setSending(true);
    setError(null);
    try {
      const res = await client.proxyRepeaterSend({
        secure,
        host,
        port: Number(port) || (secure ? 443 : 80),
        method: method.trim() || "GET",
        path: path.trim() || "/",
        headers: rowsToHeaders(rows),
        bodyB64: utf8ToBase64(body),
      });
      if (res.error) setError(res.error);
      setResponse(res.transaction);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  }, [body, client, host, method, path, port, rows, secure]);

  return (
    <View style={styles.container}>
      <View style={styles.targetRow}>
        <Pressable onPress={toggleSecure} style={secure ? styles.schemeOn : styles.scheme}>
          <Text style={secure ? styles.schemeTextOn : styles.schemeText}>
            {secure ? "HTTPS" : "HTTP"}
          </Text>
        </Pressable>
        <TextInput
          style={styles.hostInput}
          value={host}
          onChangeText={setHost}
          placeholder="host"
          autoCapitalize="none"
          autoCorrect={false}
        />
        <Text style={styles.colon}>:</Text>
        <TextInput
          style={styles.portInput}
          value={port}
          onChangeText={setPort}
          keyboardType="number-pad"
        />
        <WbButton label="Send" onPress={handleSend} loading={sending} testID="wb-repeater-send" />
      </View>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <View style={styles.split}>
        <ScrollView style={styles.pane} contentContainerStyle={styles.paneContent}>
          <Text style={styles.paneTitle}>REQUEST</Text>
          <View style={styles.methodRow}>
            <TextInput
              style={styles.methodInput}
              value={method}
              onChangeText={setMethod}
              placeholder="GET"
              autoCapitalize="characters"
              autoCorrect={false}
            />
            <TextInput
              style={styles.pathInput}
              value={path}
              onChangeText={setPath}
              placeholder="/path?query"
              autoCapitalize="none"
              autoCorrect={false}
            />
          </View>
          <Text style={styles.label}>Headers</Text>
          <HeaderEditor rows={rows} onChange={setRows} />
          <View style={styles.bodyHead}>
            <Text style={styles.label}>Body</Text>
            <Pressable onPress={formatJson} hitSlop={6}>
              <Text style={styles.formatBtn}>Format JSON</Text>
            </Pressable>
          </View>
          <TextInput
            style={styles.bodyInput}
            value={body}
            onChangeText={setBody}
            multiline
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="{ }"
            placeholderTextColor="#9aa"
          />
        </ScrollView>
        <View style={styles.pane}>
          {response ? (
            <MessagePane
              title="Response"
              startLine={response.statusLine}
              headers={response.responseHeaders}
              bodyB64={response.responseBodyB64}
              isText={response.responseBodyIsText}
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

const styles = StyleSheet.create((theme: Theme) => ({
  container: { flex: 1, minHeight: 0, backgroundColor: theme.colors.surface0 },
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
  paneContent: { padding: theme.spacing[2], gap: theme.spacing[2] },
  paneTitle: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.bold,
    color: theme.colors.foreground,
    textTransform: "uppercase",
  },
  methodRow: { flexDirection: "row", gap: theme.spacing[1] },
  methodInput: {
    width: 84,
    fontSize: theme.fontSize.xs,
    fontFamily: theme.fontFamily.mono,
    color: WB_ORANGE,
    fontWeight: theme.fontWeight.bold,
    paddingVertical: 4,
    paddingHorizontal: theme.spacing[2],
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.sm,
    outlineWidth: 0,
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
}));
