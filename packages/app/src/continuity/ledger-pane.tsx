import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ScrollView, Share, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { SessionLedger, SessionLedgerHandoff } from "@jagentdesk/protocol/messages";
import { isWeb } from "@/constants/platform";
import { MarkdownRenderer } from "@/components/markdown/renderer";
import { Button } from "@/components/ui/button";
import { useHostFeature } from "@/runtime/host-features";
import { useSessionStore } from "@/stores/session-store";
import { formatTimeAgo } from "@/utils/time";
import { HandoffSheet } from "./handoff-sheet";
import { providerDisplayLabel, useAgentLedger } from "./use-agent-ledger";

function exportLedgerMarkdown(markdown: string, agentId: string): void {
  if (isWeb) {
    const url = URL.createObjectURL(new Blob([markdown], { type: "text/markdown" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `session-ledger-${agentId}.md`;
    link.click();
    URL.revokeObjectURL(url);
    return;
  }
  void Share.share({ message: markdown });
}

function ProviderSessions({ ledger }: { ledger: SessionLedger }) {
  const { t } = useTranslation();
  return (
    <View style={styles.section} testID="ledger-provider-sessions">
      <Text style={styles.heading}>{t("continuity.ledger.providers")}</Text>
      {ledger.providerSessions.map((entry) => (
        <View key={entry.provider} style={styles.row}>
          <Text style={styles.rowTitle}>
            {providerDisplayLabel(entry.provider)} ·{" "}
            {entry.model ?? t("continuity.ledger.defaultModel")}
            {entry.current ? ` · ${t("continuity.ledger.current")}` : ""}
          </Text>
          <Text style={styles.rowMeta}>
            {t("continuity.ledger.turns", { count: entry.turns })} ·{" "}
            {t("continuity.ledger.lastUsed", { time: formatTimeAgo(new Date(entry.lastUsedAt)) })}
          </Text>
        </View>
      ))}
    </View>
  );
}

function HandoffRow({
  handoff,
  onView,
}: {
  handoff: SessionLedgerHandoff;
  onView: (handoff: SessionLedgerHandoff) => void;
}) {
  const { t } = useTranslation();
  const handlePress = useCallback(() => onView(handoff), [handoff, onView]);
  return (
    <View style={styles.handoffRow}>
      <Text style={styles.rowTitle} numberOfLines={1}>
        {handoff.fromProvider} → {handoff.toProvider}
        {handoff.model ? ` · ${handoff.model}` : ""}
      </Text>
      <Button size="sm" variant="ghost" onPress={handlePress}>
        {t("continuity.ledger.view")}
      </Button>
    </View>
  );
}

function Handoffs({
  handoffs,
  onView,
}: {
  handoffs: SessionLedgerHandoff[];
  onView: (handoff: SessionLedgerHandoff) => void;
}) {
  const { t } = useTranslation();
  if (handoffs.length === 0) return null;
  return (
    <View style={styles.section}>
      <Text style={styles.heading}>{t("continuity.ledger.handoffs")}</Text>
      {Array.from({ length: handoffs.length }, (_, index) => handoffs[handoffs.length - 1 - index])
        .filter((handoff): handoff is SessionLedgerHandoff => Boolean(handoff))
        .map((handoff) => (
          <HandoffRow key={handoff.id} handoff={handoff} onView={onView} />
        ))}
    </View>
  );
}

/** Inspector tab: the focused agent's session ledger, read-only, exportable as Markdown. */
export function LedgerPane({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const supported = useHostFeature(serverId, "crossProviderContinuity");
  const agentId = useSessionStore((state) => state.sessions[serverId]?.focusedAgentId ?? null);
  const ledger = useAgentLedger({ serverId, agentId, enabled: supported });
  const [viewing, setViewing] = useState<SessionLedgerHandoff | null>(null);
  const closeHandoff = useCallback(() => setViewing(null), []);
  const handleExport = useCallback(() => {
    if (ledger.data && agentId) exportLedgerMarkdown(ledger.data.markdown, agentId);
  }, [agentId, ledger.data]);
  const message = useMemo(() => {
    if (!supported) return t("continuity.ledger.updateHost");
    if (!agentId) return t("continuity.ledger.noAgent");
    if (ledger.error) return ledger.error.message;
    if (!ledger.data) return t("continuity.ledger.loading");
    return null;
  }, [agentId, ledger.data, ledger.error, supported, t]);

  if (message || !ledger.data) {
    return (
      <View style={styles.empty} testID="ledger-pane">
        <Text style={styles.muted}>{message}</Text>
      </View>
    );
  }
  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.content} testID="ledger-pane">
      <View style={styles.toolbar}>
        <Button size="sm" variant="secondary" onPress={handleExport} testID="ledger-export">
          {t("continuity.ledger.export")}
        </Button>
      </View>
      <ProviderSessions ledger={ledger.data} />
      <Handoffs handoffs={ledger.data.handoffs} onView={setViewing} />
      <View style={styles.section} testID="ledger-markdown">
        <MarkdownRenderer text={ledger.data.markdown} compact selectable />
      </View>
      {viewing ? (
        <HandoffSheet
          visible
          onClose={closeHandoff}
          handoff={viewing}
          isLoading={false}
          error={null}
        />
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create((theme) => ({
  scroll: { flex: 1 },
  content: {
    gap: theme.spacing[4],
    padding: theme.spacing[3],
  },
  empty: {
    flex: 1,
    padding: theme.spacing[4],
  },
  toolbar: {
    flexDirection: "row",
    justifyContent: "flex-end",
  },
  section: {
    gap: theme.spacing[2],
  },
  heading: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    fontWeight: "600",
    textTransform: "uppercase",
  },
  row: {
    gap: theme.spacing[1],
  },
  handoffRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  rowTitle: {
    flexShrink: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  rowMeta: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  muted: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
}));
