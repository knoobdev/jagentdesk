import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { ProviderSwitchNotice } from "@jagentdesk/protocol/agent-types";
import { ActivityLog } from "@/components/message";
import { Button } from "@/components/ui/button";
import { HandoffSheet } from "./handoff-sheet";
import { useAgentLedger } from "./use-agent-ledger";

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
  const [open, setOpen] = useState(false);
  const ledger = useAgentLedger({ serverId, agentId, enabled: open });
  const handoff = ledger.data?.handoffs.find((entry) => entry.id === notice.handoffId) ?? null;
  const show = useCallback(() => setOpen(true), []);
  const hide = useCallback(() => setOpen(false), []);
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
      {open ? (
        <HandoffSheet
          visible={open}
          onClose={hide}
          handoff={handoff}
          isLoading={ledger.isLoading}
          error={ledger.error ? ledger.error.message : null}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  actions: {
    flexDirection: "row",
    paddingLeft: theme.spacing[6],
    marginTop: -theme.spacing[1],
  },
}));
