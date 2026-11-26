import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ClipboardPaste, Globe, QrCode } from "lucide-react-native";
import { isFdroidBuild } from "@/constants/build-profile";
import { getIsElectron, isNative } from "@/constants/platform";
import type { Theme } from "@/styles/theme";

export type ConnectWorkstationOptionKey = "scan-qr" | "paste-pairing-link" | "sign-in-tailscale";

export interface ConnectWorkstationOption {
  key: ConnectWorkstationOptionKey;
  primary: boolean;
}

/**
 * ADR-0056 / spec `05.2.2` màn 4: the ways to reach a workstation, in order.
 * Scanning needs a camera, so only native builds that ship the scanner get it
 * (and then it is the primary action). Pairing links carry relay, so neither
 * of the first two needs a Tailscale account. A plain browser cannot own a
 * tailnet node, so it has no Tailscale sign-in.
 */
export function resolveConnectWorkstationOptions(input: {
  canScanQr: boolean;
  canSignInTailscale: boolean;
}): ConnectWorkstationOption[] {
  const options: ConnectWorkstationOption[] = [];
  if (input.canScanQr) options.push({ key: "scan-qr", primary: true });
  options.push({ key: "paste-pairing-link", primary: !input.canScanQr });
  if (input.canSignInTailscale) options.push({ key: "sign-in-tailscale", primary: false });
  return options;
}

export const canScanPairingQr = isNative && !isFdroidBuild;

/** Native embeds tsnet and the desktop signs in its bundled daemon; a browser can do neither. */
export function canSignInTailscaleHere(): boolean {
  return isNative || getIsElectron();
}

const OPTION_ICONS = {
  "scan-qr": withUnistyles(QrCode),
  "paste-pairing-link": withUnistyles(ClipboardPaste),
  "sign-in-tailscale": withUnistyles(Globe),
} as const;

type IconTheme = Theme;
const primaryIconProps = (theme: IconTheme) => ({ color: theme.colors.primaryForeground });
const iconProps = (theme: IconTheme) => ({ color: theme.colors.foreground });

const OPTION_TEXT_KEYS = {
  "scan-qr": "pairing.connectionMethods.scanQr",
  "paste-pairing-link": "pairing.connectionMethods.pasteLink",
  "sign-in-tailscale": "pairing.connectionMethods.tailscale",
} as const;

const OPTION_TEST_IDS = {
  "scan-qr": "connect-workstation-scan-qr",
  "paste-pairing-link": "connect-workstation-paste-link",
  "sign-in-tailscale": "connect-workstation-tailscale",
} as const;

export interface ConnectWorkstationOptionsProps {
  onScanQr: () => void;
  onPasteLink: () => void;
  onSignInTailscale: () => void;
  canScanQr?: boolean;
  canSignInTailscale?: boolean;
}

/** The three connect actions as Gumloop option rows (spec 38 §4.6). */
export function ConnectWorkstationOptions({
  onScanQr,
  onPasteLink,
  onSignInTailscale,
  canScanQr = canScanPairingQr,
  canSignInTailscale = canSignInTailscaleHere(),
}: ConnectWorkstationOptionsProps) {
  const options = useMemo(
    () => resolveConnectWorkstationOptions({ canScanQr, canSignInTailscale }),
    [canScanQr, canSignInTailscale],
  );
  const handlers: Record<ConnectWorkstationOptionKey, () => void> = {
    "scan-qr": onScanQr,
    "paste-pairing-link": onPasteLink,
    "sign-in-tailscale": onSignInTailscale,
  };
  return (
    <View style={styles.options} testID="connect-workstation-options">
      {options.map((option) => (
        <ConnectWorkstationOptionRow
          key={option.key}
          option={option}
          onPress={handlers[option.key]}
        />
      ))}
    </View>
  );
}

function ConnectWorkstationOptionRow({
  option,
  onPress,
}: {
  option: ConnectWorkstationOption;
  onPress: () => void;
}) {
  const { t } = useTranslation();
  const Icon = OPTION_ICONS[option.key];
  const textKey = OPTION_TEXT_KEYS[option.key];
  const title = t(`${textKey}.title`);
  const description = t(`${textKey}.description`);
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityHint={description}
      testID={OPTION_TEST_IDS[option.key]}
      style={[styles.option, option.primary ? styles.optionPrimary : null]}
    >
      <View style={[styles.iconCircle, option.primary ? styles.iconCirclePrimary : null]}>
        <Icon size={18} uniProps={option.primary ? primaryIconProps : iconProps} />
      </View>
      <View style={styles.optionBody}>
        <Text style={[styles.optionTitle, option.primary ? styles.optionTitlePrimary : null]}>
          {title}
        </Text>
        <Text
          style={[
            styles.optionDescription,
            option.primary ? styles.optionDescriptionPrimary : null,
          ]}
        >
          {description}
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  options: {
    width: "100%",
    gap: theme.spacing[3],
  },
  option: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    minHeight: 64,
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    borderRadius: 10,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  optionPrimary: {
    backgroundColor: theme.colors.primary,
    borderColor: theme.colors.primary,
  },
  iconCircle: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  iconCirclePrimary: {
    borderColor: "rgba(255, 255, 255, 0.24)",
    backgroundColor: "transparent",
  },
  optionBody: {
    flex: 1,
    gap: 2,
  },
  optionTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  optionTitlePrimary: {
    color: theme.colors.primaryForeground,
  },
  optionDescription: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  optionDescriptionPrimary: {
    color: theme.colors.primaryForeground,
    opacity: 0.72,
  },
}));
