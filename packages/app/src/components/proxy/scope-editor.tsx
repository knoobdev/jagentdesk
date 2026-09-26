import { useCallback, useEffect, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { DaemonClient } from "@jagentdesk/client/internal/daemon-client";
import type { ProxyScopeRule } from "@jagentdesk/protocol/proxy/rpc-schemas";
import type { Theme } from "@/styles/theme";
import { WbButton } from "./wb-button";
import { WB_ORANGE } from "./workbench-constants";

// Burp Target › Scope: include / exclude rules that bound what the tester treats as in-scope.
// Rules persist on the daemon (proxy/scope get+set). P2 covers host + port + include/exclude +
// enable toggle; advanced regex is exposed via the per-rule "regex" toggle.

const NEW_RULE: ProxyScopeRule = {
  enabled: true,
  include: true,
  protocol: "any",
  host: "",
  port: "",
  useRegex: false,
};

export function ScopeEditor({ client }: { client: DaemonClient | null }) {
  const [rules, setRules] = useState<ProxyScopeRule[]>([]);
  const [draftHost, setDraftHost] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!client) return;
    void client.proxyScopeGet().then((res) => setRules(res.rules));
  }, [client]);

  const persist = useCallback(
    (next: ProxyScopeRule[]) => {
      setRules(next);
      setSaved(false);
      if (client) void client.proxyScopeSet({ rules: next }).then(() => setSaved(true));
    },
    [client],
  );

  const addRule = useCallback(() => {
    if (!draftHost.trim()) return;
    persist([...rules, { ...NEW_RULE, host: draftHost.trim() }]);
    setDraftHost("");
  }, [draftHost, persist, rules]);

  const updateRule = useCallback(
    (index: number, patch: Partial<ProxyScopeRule>) => {
      persist(rules.map((r, i) => (i === index ? { ...r, ...patch } : r)));
    },
    [persist, rules],
  );

  const removeRule = useCallback(
    (index: number) => persist(rules.filter((_, i) => i !== index)),
    [persist, rules],
  );

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <View style={styles.addRow}>
        <TextInput
          style={styles.hostInput}
          value={draftHost}
          onChangeText={setDraftHost}
          placeholder="host to include (e.g. api.internal)"
          autoCapitalize="none"
          autoCorrect={false}
        />
        <WbButton label="Add" onPress={addRule} />
      </View>
      {saved ? <Text style={styles.saved}>Saved to host.</Text> : null}
      <Text style={styles.sectionTitle}>Scope rules</Text>
      {rules.length === 0 ? (
        <Text style={styles.empty}>No rules — every host is in scope.</Text>
      ) : (
        rules.map((rule, index) => (
          <ScopeRow
            key={`${rule.host}|${rule.port}|${rule.protocol}|${rule.include ? "i" : "e"}`}
            rule={rule}
            index={index}
            onUpdate={updateRule}
            onRemove={removeRule}
          />
        ))
      )}
    </ScrollView>
  );
}

function ScopeRow({
  rule,
  index,
  onUpdate,
  onRemove,
}: {
  rule: ProxyScopeRule;
  index: number;
  onUpdate: (index: number, patch: Partial<ProxyScopeRule>) => void;
  onRemove: (index: number) => void;
}) {
  const toggleEnabled = useCallback(
    () => onUpdate(index, { enabled: !rule.enabled }),
    [index, onUpdate, rule.enabled],
  );
  const toggleInclude = useCallback(
    () => onUpdate(index, { include: !rule.include }),
    [index, onUpdate, rule.include],
  );
  const toggleRegex = useCallback(
    () => onUpdate(index, { useRegex: !rule.useRegex }),
    [index, onUpdate, rule.useRegex],
  );
  const remove = useCallback(() => onRemove(index), [index, onRemove]);
  return (
    <View style={styles.rule}>
      <Pressable onPress={toggleEnabled} style={rule.enabled ? styles.checkOn : styles.checkOff}>
        <Text style={styles.checkMark}>{rule.enabled ? "✓" : ""}</Text>
      </Pressable>
      <Pressable
        onPress={toggleInclude}
        style={rule.include ? styles.includeTag : styles.excludeTag}
      >
        <Text style={rule.include ? styles.includeText : styles.excludeText}>
          {rule.include ? "Include" : "Exclude"}
        </Text>
      </Pressable>
      <Text style={styles.ruleHost} numberOfLines={1}>
        {rule.host}
      </Text>
      <Pressable onPress={toggleRegex} style={rule.useRegex ? styles.regexOn : styles.regex}>
        <Text style={rule.useRegex ? styles.regexTextOn : styles.regexText}>.*</Text>
      </Pressable>
      <Pressable onPress={remove} style={styles.removeBtn}>
        <Text style={styles.removeText}>✕</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  container: { flex: 1, backgroundColor: theme.colors.surface0 },
  content: { padding: theme.spacing[3], gap: theme.spacing[2] },
  addRow: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
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
  saved: { fontSize: theme.fontSize.xs, color: theme.colors.success },
  sectionTitle: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.bold,
    color: theme.colors.foreground,
    marginTop: theme.spacing[1],
  },
  empty: { fontSize: theme.fontSize.sm, color: theme.colors.foregroundMuted },
  rule: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  checkOn: {
    width: 20,
    height: 20,
    borderRadius: theme.borderRadius.sm,
    backgroundColor: WB_ORANGE,
    alignItems: "center",
    justifyContent: "center",
  },
  checkOff: {
    width: 20,
    height: 20,
    borderRadius: theme.borderRadius.sm,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  checkMark: { color: "#fff", fontSize: 12, fontWeight: "700" },
  includeTag: {
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 2,
    borderRadius: theme.borderRadius.sm,
    backgroundColor: theme.colors.success + "22",
  },
  excludeTag: {
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 2,
    borderRadius: theme.borderRadius.sm,
    backgroundColor: theme.colors.destructive + "22",
  },
  includeText: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.success,
    fontWeight: theme.fontWeight.semibold,
  },
  excludeText: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.destructive,
    fontWeight: theme.fontWeight.semibold,
  },
  ruleHost: {
    flex: 1,
    minWidth: 0,
    fontSize: theme.fontSize.sm,
    fontFamily: theme.fontFamily.mono,
    color: theme.colors.foreground,
  },
  regex: {
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 2,
    borderRadius: theme.borderRadius.sm,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  regexOn: {
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 2,
    borderRadius: theme.borderRadius.sm,
    borderWidth: 1,
    borderColor: WB_ORANGE,
    backgroundColor: WB_ORANGE + "18",
  },
  regexText: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
    fontFamily: theme.fontFamily.mono,
  },
  regexTextOn: { fontSize: theme.fontSize.xs, color: WB_ORANGE, fontFamily: theme.fontFamily.mono },
  removeBtn: { width: 24, height: 24, alignItems: "center", justifyContent: "center" },
  removeText: { color: theme.colors.foregroundMuted, fontSize: 14 },
}));
