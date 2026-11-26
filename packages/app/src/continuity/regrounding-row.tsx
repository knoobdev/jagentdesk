import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { RegroundingNotice } from "@jagentdesk/protocol/agent-types";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { MarkdownRenderer } from "@/components/markdown/renderer";
import { ActivityLog } from "@/components/message";
import { Button } from "@/components/ui/button";
import { useAgentLedger } from "./use-agent-ledger";

/** The daemon wraps the block in a tag for the model; the viewer shows the body only. */
function regroundingDisplayText(text: string): string {
  return text
    .replace(/^<jagentdesk-where-we-are>\n?/, "")
    .replace(/\n?<\/jagentdesk-where-we-are>$/, "");
}

/**
 * "Re-grounded after compaction" (spec 42 §2): the first turn after a compaction carried the
 * "Where we are" block; the button shows exactly the block that was sent.
 */
export function RegroundingRow({
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
  notice: RegroundingNotice;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const ledger = useAgentLedger({ serverId, agentId, enabled: open });
  const block = ledger.data?.regroundings?.find((entry) => entry.id === notice.id) ?? null;
  const show = useCallback(() => setOpen(true), []);
  const hide = useCallback(() => setOpen(false), []);
  const header = useMemo(
    () => ({
      title: t("continuity.durable.regroundedTitle"),
      subtitle: t("continuity.durable.regroundedSubtitle", {
        tokens: notice.estimatedTokens.toLocaleString(),
      }),
    }),
    [notice.estimatedTokens, t],
  );
  let fallback = t("continuity.durable.blockMissing");
  if (ledger.error) fallback = ledger.error.message;
  else if (ledger.isLoading) fallback = t("continuity.ledger.loading");
  return (
    <View testID="regrounding-row">
      <ActivityLog type="info" message={message} timestamp={timestamp} />
      <View style={styles.actions}>
        <Button size="sm" variant="ghost" onPress={show} testID="regrounding-view-block">
          {t("continuity.durable.viewBlock")}
        </Button>
      </View>
      {open ? (
        <AdaptiveModalSheet
          header={header}
          visible={open}
          onClose={hide}
          desktopMaxWidth={760}
          testID="regrounding-sheet"
        >
          <View style={styles.body}>
            {block ? (
              <MarkdownRenderer text={regroundingDisplayText(block.text)} compact selectable />
            ) : (
              <Text style={styles.muted}>{fallback}</Text>
            )}
          </View>
        </AdaptiveModalSheet>
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
  body: {
    gap: theme.spacing[3],
    paddingBottom: theme.spacing[4],
  },
  muted: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
}));
