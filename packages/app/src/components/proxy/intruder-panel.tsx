import { useCallback, useEffect, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { DaemonClient } from "@jagentdesk/client/internal/daemon-client";
import type {
  ProxyIntruderResult,
  ProxyTransactionFull,
} from "@jagentdesk/protocol/proxy/rpc-schemas";
import type { Theme } from "@/styles/theme";
import { bytesToUtf8, decodeBase64 } from "./base64";
import { WbButton } from "./wb-button";
import { WB_ORANGE } from "./workbench-constants";

// Burp Intruder (Community Edition = Sniper, throttled + capped). Mark payload positions in the
// request with §…§; each payload from the list is substituted and sent. Results list status,
// length and time per payload — the classic way to spot an anomalous response. A history row can
// seed the template via "Send to Intruder".

export function IntruderPanel({
  client,
  seed,
}: {
  client: DaemonClient | null;
  seed: ProxyTransactionFull | null;
}) {
  const [secure, setSecure] = useState(true);
  const [host, setHost] = useState("");
  const [port, setPort] = useState("443");
  const [template, setTemplate] = useState("");
  const [payloadText, setPayloadText] = useState("");
  const [results, setResults] = useState<ProxyIntruderResult[]>([]);
  const [running, setRunning] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    if (!seed) return;
    setSecure(seed.secure);
    setHost(seed.host);
    setPort(String(seed.port));
    setTemplate(templateFromSeed(seed));
    setResults([]);
  }, [seed]);

  const toggleSecure = useCallback(() => setSecure((s) => !s), []);

  const handleRun = useCallback(async () => {
    if (!client || !host) return;
    const payloads = payloadText
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    if (payloads.length === 0) {
      setNote("Add at least one payload (one per line).");
      return;
    }
    if (!template.includes("§")) {
      setNote("Mark a payload position in the request with §…§.");
      return;
    }
    setNote(null);
    setRunning(true);
    setResults([]);
    try {
      const res = await client.proxyIntruderRun({
        secure,
        host,
        port: Number(port) || (secure ? 443 : 80),
        template,
        payloads,
      });
      setResults(res.results);
      if (res.truncated) setNote("Community Edition caps the payload count — list was truncated.");
      else if (res.throttled) setNote("Community Edition throttles requests, so this runs slowly.");
    } catch (err) {
      setNote(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  }, [client, host, payloadText, port, secure, template]);

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
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
        <WbButton
          label="Start attack"
          onPress={handleRun}
          loading={running}
          testID="wb-intruder-run"
        />
      </View>
      {note ? <Text style={styles.note}>{note}</Text> : null}
      <View style={styles.editors}>
        <View style={styles.editorCol}>
          <Text style={styles.label}>Request template — mark positions with §…§</Text>
          <TextInput
            style={styles.templateInput}
            value={template}
            onChangeText={setTemplate}
            multiline
            autoCapitalize="none"
            autoCorrect={false}
            placeholder={"GET /search?q=§FUZZ§ HTTP/1.1\nHost: example"}
            placeholderTextColor="#9aa"
          />
        </View>
        <View style={styles.editorCol}>
          <Text style={styles.label}>Payloads (one per line)</Text>
          <TextInput
            style={styles.templateInput}
            value={payloadText}
            onChangeText={setPayloadText}
            multiline
            autoCapitalize="none"
            autoCorrect={false}
            placeholder={"admin\nroot\ntest"}
            placeholderTextColor="#9aa"
          />
        </View>
      </View>
      <ResultsTable results={results} />
    </ScrollView>
  );
}

function ResultsTable({ results }: { results: ProxyIntruderResult[] }) {
  if (results.length === 0) {
    return (
      <Text style={styles.empty}>
        No results yet. Set positions and payloads, then Start attack.
      </Text>
    );
  }
  return (
    <View style={styles.table}>
      <View style={styles.headRow}>
        <Text style={[styles.hCell, styles.cIdx]}>#</Text>
        <Text style={[styles.hCell, styles.cPayload]}>Payload</Text>
        <Text style={[styles.hCell, styles.cStatus]}>Status</Text>
        <Text style={[styles.hCell, styles.cLen]}>Length</Text>
        <Text style={[styles.hCell, styles.cTime]}>Time</Text>
      </View>
      {results.map((r) => (
        <ResultRow key={r.index} result={r} />
      ))}
    </View>
  );
}

function ResultRow({ result }: { result: ProxyIntruderResult }) {
  return (
    <View style={styles.row}>
      <Text style={[styles.cell, styles.cIdx]}>{result.index + 1}</Text>
      <Text style={[styles.cell, styles.cPayload]} numberOfLines={1}>
        {result.payload}
      </Text>
      <Text style={[styles.cell, styles.cStatus]}>{result.status ?? "—"}</Text>
      <Text style={[styles.cell, styles.cLen]}>{result.length}</Text>
      <Text style={[styles.cell, styles.cTime]}>{result.durationMs}ms</Text>
    </View>
  );
}

function templateFromSeed(tx: ProxyTransactionFull): string {
  const headerLines = tx.requestHeaders.map((h) => `${h.name}: ${h.value}`).join("\n");
  const body = tx.requestBodyIsText ? bytesToUtf8(decodeBase64(tx.requestBodyB64)) : "";
  return `${tx.requestLine}\n${headerLines}\n\n${body}`;
}

const styles = StyleSheet.create((theme: Theme) => ({
  container: { flex: 1, backgroundColor: theme.colors.surface0 },
  content: { padding: theme.spacing[3], gap: theme.spacing[2] },
  targetRow: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
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
    outlineWidth: 0,
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
    outlineWidth: 0,
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
  note: { fontSize: theme.fontSize.xs, color: theme.colors.foregroundMuted },
  editors: { flexDirection: "row", gap: theme.spacing[2], minHeight: 160 },
  editorCol: { flex: 1, minWidth: 0, gap: theme.spacing[1] },
  label: { fontSize: theme.fontSize.xs, color: theme.colors.foregroundMuted },
  templateInput: {
    outlineWidth: 0,
    minHeight: 140,
    fontSize: theme.fontSize.xs,
    fontFamily: theme.fontFamily.mono,
    color: theme.colors.foreground,
    padding: theme.spacing[2],
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.sm,
    textAlignVertical: "top",
  },
  empty: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    marginTop: theme.spacing[2],
  },
  table: {
    marginTop: theme.spacing[2],
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.sm,
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
  cIdx: { width: 44 },
  cPayload: { flex: 1, minWidth: 0 },
  cStatus: { width: 64 },
  cLen: { width: 72 },
  cTime: { width: 72 },
}));
