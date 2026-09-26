import { useCallback, useEffect, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { DaemonClient } from "@jagentdesk/client/internal/daemon-client";
import type { ProxyHeader, ProxyHeldRequest } from "@jagentdesk/protocol/proxy/rpc-schemas";
import type { Theme } from "@/styles/theme";
import { bytesToUtf8, decodeBase64, utf8ToBase64 } from "./base64";
import { WbButton } from "./wb-button";
import { WB_ORANGE } from "./workbench-constants";

// Burp Proxy › Intercept: hold each request, edit it, then Forward or Drop. The "Intercept is
// on/off" toggle enables holding; turning it off releases everything queued. The held request is
// shown as raw text and is editable before forwarding.

export function InterceptPanel({
  client,
  held,
  interceptOn,
  onToggle,
  onResolved,
}: {
  client: DaemonClient | null;
  held: ProxyHeldRequest[];
  interceptOn: boolean;
  onToggle: (on: boolean) => void;
  onResolved: (heldId: string) => void;
}) {
  const current = held[0] ?? null;
  const [draft, setDraft] = useState("");

  useEffect(() => {
    setDraft(current ? rawFromHeld(current) : "");
  }, [current]);

  const toggle = useCallback(() => {
    if (!client) return;
    const next = !interceptOn;
    void client.proxyInterceptSet({ enabled: next });
    onToggle(next);
  }, [client, interceptOn, onToggle]);

  const forward = useCallback(() => {
    if (!client || !current) return;
    const parsed = parseRaw(draft);
    client.proxyInterceptDecide({
      heldId: current.heldId,
      action: "forward",
      method: parsed.method,
      path: parsed.path,
      headers: parsed.headers,
      bodyB64: utf8ToBase64(parsed.body),
    });
    onResolved(current.heldId);
  }, [client, current, draft, onResolved]);

  const drop = useCallback(() => {
    if (!client || !current) return;
    client.proxyInterceptDecide({ heldId: current.heldId, action: "drop" });
    onResolved(current.heldId);
  }, [client, current, onResolved]);

  return (
    <View style={styles.container}>
      <View style={styles.toolbar}>
        <Pressable onPress={toggle} style={interceptOn ? styles.toggleOn : styles.toggle}>
          <View style={interceptOn ? styles.dotOn : styles.dotOff} />
          <Text style={interceptOn ? styles.toggleTextOn : styles.toggleText}>
            {interceptOn ? "Intercept is on" : "Intercept is off"}
          </Text>
        </Pressable>
        <WbButton label="Forward" onPress={forward} disabled={!current} />
        <WbButton label="Drop" variant="ghost" onPress={drop} disabled={!current} />
        {held.length > 1 ? <Text style={styles.queue}>{held.length - 1} more queued</Text> : null}
      </View>
      {current ? (
        <TextInput
          style={styles.editor}
          value={draft}
          onChangeText={setDraft}
          multiline
          autoCapitalize="none"
          autoCorrect={false}
        />
      ) : (
        <View style={styles.empty}>
          <Text style={styles.emptyText}>
            {interceptOn
              ? "Intercept is on. The next request through this capture will be held here."
              : "Intercept is off. Turn it on to hold requests for editing before they are sent."}
          </Text>
        </View>
      )}
    </View>
  );
}

function rawFromHeld(h: ProxyHeldRequest): string {
  const scheme = h.secure ? "https" : "http";
  const headerLines = h.headers.map((x) => `${x.name}: ${x.value}`).join("\n");
  const body = bytesToUtf8(decodeBase64(h.bodyB64));
  return `${h.method} ${scheme}://${h.host}:${h.port}${h.path} HTTP/1.1\n${headerLines}\n\n${body}`;
}

function parseRaw(raw: string): {
  method: string;
  path: string;
  headers: ProxyHeader[];
  body: string;
} {
  const normalized = raw.replace(/\r\n/g, "\n");
  const sep = normalized.indexOf("\n\n");
  const head = sep >= 0 ? normalized.slice(0, sep) : normalized;
  const body = sep >= 0 ? normalized.slice(sep + 2) : "";
  const lines = head.split("\n");
  const requestLine = lines.shift() ?? "";
  const parts = requestLine.split(/\s+/);
  const method = parts[0] || "GET";
  let path = parts[1] || "/";
  const schemeMatch = /^[a-z]+:\/\/[^/]+(\/.*)$/i.exec(path);
  if (schemeMatch) path = schemeMatch[1] ?? "/";
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
  toolbar: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    padding: theme.spacing[2],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  toggle: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  toggleOn: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: WB_ORANGE,
    backgroundColor: WB_ORANGE + "18",
  },
  dotOn: { width: 8, height: 8, borderRadius: 4, backgroundColor: WB_ORANGE },
  dotOff: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: theme.colors.foregroundExtraMuted,
  },
  toggleText: { fontSize: theme.fontSize.sm, color: theme.colors.foregroundMuted },
  toggleTextOn: {
    fontSize: theme.fontSize.sm,
    color: WB_ORANGE,
    fontWeight: theme.fontWeight.semibold,
  },
  queue: { fontSize: theme.fontSize.xs, color: theme.colors.foregroundMuted },
  editor: {
    flex: 1,
    fontSize: theme.fontSize.xs,
    fontFamily: theme.fontFamily.mono,
    color: theme.colors.foreground,
    padding: theme.spacing[2],
    textAlignVertical: "top",
  },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", padding: theme.spacing[6] },
  emptyText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    textAlign: "center",
    maxWidth: 420,
  },
}));
