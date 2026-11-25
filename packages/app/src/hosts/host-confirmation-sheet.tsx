import { useCallback, useMemo } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { settingsStyles } from "@/styles/settings";
import { useHostConfirmation } from "@/runtime/host-runtime";

/** Shows the host confirmation the host runtime is waiting on. Mount once at the app root. */
export function HostConfirmationSheet() {
  const { t } = useTranslation();
  const { pending, answer } = useHostConfirmation();

  const cancel = useCallback(() => answer(false), [answer]);
  const connect = useCallback(() => answer(true), [answer]);
  const header = useMemo<SheetHeader>(() => ({ title: t("pairing.hostConfirmation.title") }), [t]);

  if (!pending) return null;

  return (
    <AdaptiveModalSheet header={header} visible onClose={cancel} testID="host-confirmation">
      <Text style={styles.confirmText}>
        {pending.kind === "changedConnection"
          ? t("pairing.hostConfirmation.descriptionChanged")
          : t("pairing.hostConfirmation.description")}
      </Text>
      {pending.keyChanged ? (
        <Text style={styles.warning}>{t("pairing.hostConfirmation.keyChanged")}</Text>
      ) : null}
      <View style={settingsStyles.card}>
        <DetailRow
          label={t("pairing.hostConfirmation.hostLabel")}
          value={pending.serverId}
          testID="host-confirmation-server-id"
        />
        <DetailRow
          label={t("pairing.hostConfirmation.fingerprintLabel")}
          value={pending.keyFingerprint}
          testID="host-confirmation-fingerprint"
          showBorder
        />
        <DetailRow
          label={t("pairing.hostConfirmation.routesLabel")}
          value={pending.routes}
          testID="host-confirmation-relay"
          showBorder
        />
        {pending.previousRoutes !== null ? (
          <DetailRow
            label={t("pairing.hostConfirmation.previousRoutesLabel")}
            value={pending.previousRoutes}
            showBorder
          />
        ) : null}
        {pending.previousKeyFingerprint ? (
          <DetailRow
            label={t("pairing.hostConfirmation.previousFingerprintLabel")}
            value={pending.previousKeyFingerprint}
            showBorder
          />
        ) : null}
      </View>
      <View style={styles.confirmActions}>
        <Button
          variant="secondary"
          size="sm"
          style={FLEX_1_STYLE}
          onPress={cancel}
          testID="host-confirmation-cancel"
        >
          {t("common.actions.cancel")}
        </Button>
        <Button
          variant="default"
          size="sm"
          style={FLEX_1_STYLE}
          onPress={connect}
          testID="host-confirmation-connect"
        >
          {t("pairing.hostConfirmation.connect")}
        </Button>
      </View>
    </AdaptiveModalSheet>
  );
}

function DetailRow({
  label,
  value,
  showBorder = false,
  testID,
}: {
  label: string;
  value: string;
  showBorder?: boolean;
  testID?: string;
}) {
  return (
    <View style={[settingsStyles.row, showBorder && settingsStyles.rowBorder]}>
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle}>{label}</Text>
        <Text style={settingsStyles.rowHint} selectable testID={testID}>
          {value}
        </Text>
      </View>
    </View>
  );
}

// Same shape as the remove-host and remove-connection confirm sheets in
// screens/settings/host-page.tsx.
const styles = StyleSheet.create((theme) => ({
  warning: { color: theme.colors.destructive, fontSize: theme.fontSize.base },
  confirmText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
  confirmActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    marginTop: theme.spacing[4],
  },
}));

const FLEX_1_STYLE = { flex: 1 };
