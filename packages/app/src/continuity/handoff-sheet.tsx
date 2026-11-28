import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { SessionLedgerHandoff } from "@jagentdesk/protocol/messages";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { MarkdownRenderer } from "@/components/markdown/renderer";
import { handoffDisplayText } from "./use-agent-ledger";

/** Shows the handoff (or resume delta) the daemon sent to a provider that took over an agent. */
export function HandoffSheet({
  visible,
  onClose,
  onDismiss,
  handoff,
  isLoading,
  error,
}: {
  visible: boolean;
  onClose: () => void;
  onDismiss?: () => void;
  handoff: SessionLedgerHandoff | null;
  isLoading: boolean;
  error: string | null;
}) {
  const { t } = useTranslation();
  const header = useMemo(
    () => ({
      title: t(handoff?.mode === "delta" ? "continuity.deltaTitle" : "continuity.handoffTitle"),
      subtitle: handoff
        ? t("continuity.handoffSubtitle", {
            from: handoff.fromProvider,
            to: handoff.toProvider,
            tokens: handoff.estimatedTokens.toLocaleString(),
            budget: handoff.budgetTokens.toLocaleString(),
          })
        : undefined,
    }),
    [handoff, t],
  );
  return (
    <AdaptiveModalSheet
      header={header}
      visible={visible}
      onClose={onClose}
      onDismiss={onDismiss}
      desktopMaxWidth={760}
      testID="handoff-sheet"
    >
      <View style={styles.body}>
        {handoff ? (
          <MarkdownRenderer text={handoffDisplayText(handoff.text)} compact selectable />
        ) : (
          <Text style={styles.muted}>
            {error ?? (isLoading ? t("continuity.ledger.loading") : t("continuity.handoffMissing"))}
          </Text>
        )}
      </View>
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: {
    gap: theme.spacing[3],
    paddingBottom: theme.spacing[4],
  },
  muted: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
}));
