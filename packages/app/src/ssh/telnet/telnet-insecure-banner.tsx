import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";

/** Telnet has no TLS layer; the protocol default port is 23. */
export const TELNET_DEFAULT_PORT = 23;

interface TelnetInsecureBannerProps {
  address: string;
  /** Remote port; defaults to the telnet standard port 23. */
  port?: number;
}

/**
 * Warning strip for telnet terminal tabs: states plainly that the connection
 * is not encrypted and names the telnet endpoint. Presentational only — no
 * hooks, store access, or network calls.
 */
export function TelnetInsecureBanner({
  address,
  port = TELNET_DEFAULT_PORT,
}: TelnetInsecureBannerProps) {
  const { t } = useTranslation();
  return (
    <View style={styles.row} testID="telnet-insecure-banner">
      <Text style={styles.label} numberOfLines={1}>
        {t("ssh.telnet.unencrypted")}
      </Text>
      <Text style={styles.hint} numberOfLines={1}>
        {t("ssh.telnet.endpoint", { address, port })}
      </Text>
    </View>
  );
}

// Shape mirrors the streamError strip in components/terminal-pane.tsx so the
// banner reads as an existing chrome row: thin full-width strip, top border,
// surface1 background, xs text.
const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1],
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  label: {
    color: theme.colors.statusWarning,
    fontSize: theme.fontSize.xs,
  },
  hint: {
    flexShrink: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
}));
