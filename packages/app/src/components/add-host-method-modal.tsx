import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Link2 } from "lucide-react-native";
import { AdaptiveModalSheet, type SheetHeader } from "./adaptive-modal-sheet";
import { ConnectWorkstationOptions } from "./connect-workstation";
import { getIsElectron, isNative } from "@/constants/platform";
import type { Theme } from "@/styles/theme";

const ThemedLink2 = withUnistyles(Link2);
const iconProps = (theme: Theme) => ({ color: theme.colors.foreground });

const styles = StyleSheet.create((theme) => ({
  option: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    minHeight: 64,
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    borderRadius: 10,
    backgroundColor: theme.colors.surface1,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  iconCircle: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  optionText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  optionSubtext: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    marginTop: 2,
  },
  optionBody: {
    flex: 1,
  },
  footer: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
  },
}));

export interface AddHostMethodModalProps {
  visible: boolean;
  onClose: () => void;
  onDirectConnection: () => void;
  onScanQr: () => void;
  onPasteLink: () => void;
  onTailscale: () => void;
}

/**
 * Add a host (ADR-0056): the same three ways as onboarding's "Connect your
 * workstation". The plain browser build cannot scan or join a tailnet, so it
 * keeps the direct address form next to the pairing link.
 */
export function AddHostMethodModal({
  visible,
  onClose,
  onDirectConnection,
  onScanQr,
  onPasteLink,
  onTailscale,
}: AddHostMethodModalProps) {
  const { t } = useTranslation();
  const header = useMemo<SheetHeader>(() => ({ title: t("pairing.connectionMethods.title") }), [t]);
  const isBrowser = !isNative && !getIsElectron();

  return (
    <AdaptiveModalSheet
      header={header}
      visible={visible}
      onClose={onClose}
      testID="add-host-method-modal"
    >
      <ConnectWorkstationOptions
        onScanQr={onScanQr}
        onPasteLink={onPasteLink}
        onSignInTailscale={onTailscale}
      />

      {isBrowser ? (
        <Pressable
          style={styles.option}
          onPress={onDirectConnection}
          accessibilityRole="button"
          accessibilityLabel={t("pairing.connectionMethods.direct.title")}
          testID="add-host-method-direct"
        >
          <View style={styles.iconCircle}>
            <ThemedLink2 size={18} uniProps={iconProps} />
          </View>
          <View style={styles.optionBody}>
            <Text style={styles.optionText}>{t("pairing.connectionMethods.direct.title")}</Text>
            <Text style={styles.optionSubtext}>
              {t("pairing.connectionMethods.direct.description")}
            </Text>
          </View>
        </Pressable>
      ) : null}

      <Text style={styles.footer}>{t("onboarding.connectFooter")}</Text>
    </AdaptiveModalSheet>
  );
}
