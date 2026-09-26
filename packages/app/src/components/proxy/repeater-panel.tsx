import { useCallback, useEffect, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { ProxyHeader, ProxyTransactionFull } from "@jagentdesk/protocol/proxy/rpc-schemas";
import type { DaemonClient } from "@jagentdesk/client/internal/daemon-client";
import type { Theme } from "@/styles/theme";
import { WbButton } from "./wb-button";
import { bytesToUtf8, decodeBase64, utf8ToBase64 } from "./base64";
import { MessagePane } from "./message-editor";
import { WB_ORANGE } from "./workbench-constants";

// Burp Repeater: edit a request and send it over and over, viewing each response. The request is
// edited as raw text (request line + headers + blank line + body), with a target (scheme/host/port)
// alongside. A history row can seed this via "Send to Repeater". P2 ships a single request tab;
// multiple named tabs come later.

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
  const [raw, setRaw] = useState("");
  const [response, setResponse] = useState<ProxyTransactionFull | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Seed from a captured request when one is sent here.
  useEffect(() => {
    if (!seed) return;
    setSecure(seed.secure);
    setHost(seed.host);
    setPort(String(seed.port));
    setRaw(rawFromTransaction(seed));
    setResponse(null);
    setError(null);
  }, [seed]);

  const toggleSecure = useCallback(() => setSecure((s) => !s), []);

  const handleSend = useCallback(async () => {
    if (!client || !host) return;
    setSending(true);
    setError(null);
    try {
      const parsed = parseRawRequest(raw);
      const res = await client.proxyRepeaterSend({
        secure,
        host,
        port: Number(port) || (secure ? 443 : 80),
        method: parsed.method,
        path: parsed.path,
        headers: parsed.headers,
        bodyB64: utf8ToBase64(parsed.body),
      });
      if (res.error) setError(res.error);
      setResponse(res.transaction);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  }, [client, host, port, raw, secure]);

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
        <View style={styles.pane}>
          <Text style={styles.paneTitle}>REQUEST</Text>
          <TextInput
            style={styles.rawInput}
            value={raw}
            onChangeText={setRaw}
            multiline
            autoCapitalize="none"
            autoCorrect={false}
            placeholder={"GET / HTTP/1.1\nHost: example"}
            placeholderTextColor="#9aa"
          />
        </View>
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

function rawFromTransaction(tx: ProxyTransactionFull): string {
  const headerLines = tx.requestHeaders.map((h) => `${h.name}: ${h.value}`).join("\n");
  const body = tx.requestBodyIsText ? bytesToUtf8(decodeBase64(tx.requestBodyB64)) : "";
  return `${tx.requestLine}\n${headerLines}\n\n${body}`;
}

interface ParsedRequest {
  method: string;
  path: string;
  headers: ProxyHeader[];
  body: string;
}

function parseRawRequest(raw: string): ParsedRequest {
  const normalized = raw.replace(/\r\n/g, "\n");
  const sep = normalized.indexOf("\n\n");
  const head = sep >= 0 ? normalized.slice(0, sep) : normalized;
  const body = sep >= 0 ? normalized.slice(sep + 2) : "";
  const lines = head.split("\n");
  const requestLine = lines.shift() ?? "";
  const parts = requestLine.split(/\s+/);
  const method = parts[0] || "GET";
  const path = parts[1] || "/";
  const headers: ProxyHeader[] = [];
  for (const line of lines) {
    const idx = line.indexOf(":");
    if (idx > 0)
      headers.push({ name: line.slice(0, idx).trim(), value: line.slice(idx + 1).trim() });
  }
  return { method, path, headers, body };
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
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.sm,
  },
  colon: { color: theme.colors.foregroundMuted },
  portInput: {
    width: 64,
    fontSize: theme.fontSize.sm,
    fontFamily: theme.fontFamily.mono,
    color: theme.colors.foreground,
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.sm,
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
  paneTitle: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.bold,
    color: theme.colors.foreground,
    textTransform: "uppercase",
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    backgroundColor: theme.colors.surface1,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  rawInput: {
    flex: 1,
    fontSize: theme.fontSize.xs,
    fontFamily: theme.fontFamily.mono,
    color: theme.colors.foreground,
    padding: theme.spacing[2],
    textAlignVertical: "top",
  },
  respEmpty: { flex: 1, alignItems: "center", justifyContent: "center" },
  respEmptyText: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
}));
