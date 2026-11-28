import { useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { ProviderSwitchNotice } from "@jagentdesk/protocol/agent-types";
import { ActivityLog } from "@/components/message";
import { useTimelineRowSheet, type TimelineRowSheetProps } from "@/components/timeline-row-sheet";
import { Button } from "@/components/ui/button";
import { useToast } from "@/contexts/toast-context";
import { HandoffSheet } from "./handoff-sheet";
import { useAgentLedger } from "./use-agent-ledger";

/** Failover rows already announced in this app session. */
const announcedFailovers = new Set<string>();
const FRESH_FAILOVER_MS = 30_000;

/** The timeline row a provider switch appends, with a button that shows what was handed over. */
export function ProviderSwitchRow({
  serverId,
  agentId,
  message,
  timestamp,
  notice,
}: {
  serverId: string;
  agentId: string;
  message: string;
  timestamp: number;
  notice: ProviderSwitchNotice;
}) {
  const { t } = useTranslation();
  const { openRowSheet } = useTimelineRowSheet();
  const toast = useToast();
  // Spec 40 §4: a failover is announced once, when its row arrives live.
  useEffect(() => {
    const key = `${agentId}:${timestamp}`;
    if (notice.reason !== "failover" || announcedFailovers.has(key)) return;
    if (Date.now() - timestamp > FRESH_FAILOVER_MS) return;
    announcedFailovers.add(key);
    toast.show(message);
  }, [agentId, message, notice.reason, timestamp, toast]);
  const show = useCallback(
    () =>
      openRowSheet(`handoff:${agentId}:${notice.handoffId}`, (sheet) => (
        <ProviderSwitchHandoffSheet
          serverId={serverId}
          agentId={agentId}
          handoffId={notice.handoffId}
          {...sheet}
        />
      )),
    [agentId, notice.handoffId, openRowSheet, serverId],
  );
  return (
    <View testID="provider-switch-row">
      <ActivityLog type="info" message={message} timestamp={timestamp} />
      {notice.handoffId ? (
        <View style={styles.actions}>
          <Button size="sm" variant="ghost" onPress={show} testID="provider-switch-view-handoff">
            {t(notice.mode === "resume" ? "continuity.viewDelta" : "continuity.viewHandoff")}
          </Button>
        </View>
      ) : null}
    </View>
  );
}

/** Hosted by the stream's `TimelineRowSheetProvider`, so it outlives the row (see there). */
function ProviderSwitchHandoffSheet({
  serverId,
  agentId,
  handoffId,
  visible,
  onClose,
  onDismiss,
}: TimelineRowSheetProps & {
  serverId: string;
  agentId: string;
  handoffId: ProviderSwitchNotice["handoffId"];
}) {
  // A handoff is recorded before its row is appended and never changes: one fetch per open.
  const ledger = useAgentLedger({ serverId, agentId, enabled: true, follow: false });
  const handoff = ledger.data?.handoffs.find((entry) => entry.id === handoffId) ?? null;
  return (
    <HandoffSheet
      visible={visible}
      onClose={onClose}
      onDismiss={onDismiss}
      handoff={handoff}
      isLoading={ledger.isLoading}
      error={ledger.error ? ledger.error.message : null}
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  actions: {
    flexDirection: "row",
    paddingLeft: theme.spacing[6],
    marginTop: -theme.spacing[1],
  },
}));
