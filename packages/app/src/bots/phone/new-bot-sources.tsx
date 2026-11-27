// The top of the New bot sheet on a phone (spec 37.6, 37.13.3): "Use template" and "From a link" ("Paste a
// link someone shared.") as rows, where the desktop has a Template button and a `+` submenu. "From a
// link" shows only once the sharing receive flow is in the build (bt5 registers it in `share-slot.ts`);
// "Import from another app" is deferred (spec 37.2.2) and not shown.
// Ported from Orca dfdb4fda (MIT) mobile/src/bots/MobileNewBotSheet.tsx:331-381.
import { useCallback } from "react";
import { Pressable, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ChevronRight } from "lucide-react-native";
import type { Theme } from "@/styles/theme";
import { openBotsDialog } from "@/bots/dialogs-store";
import { useBotShareSlot } from "@/bots/share-slot";

const ThemedChevron = withUnistyles(ChevronRight);
const muted = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

export function PhoneNewBotSources({
  serverId,
  onTemplates,
}: {
  serverId: string;
  onTemplates: () => void;
}) {
  const { t } = useTranslation();
  const canReceive = useBotShareSlot((state) => state.Receive !== null);
  const openLink = useCallback(() => openBotsDialog({ kind: "shareLink", serverId }), [serverId]);
  return (
    <View style={styles.group} testID="phone-new-bot-sources">
      <SourceRow
        title={t("bots.phone.bots.new.fromTemplate")}
        onPress={onTemplates}
        testID="new-bot-template"
      />
      {canReceive ? (
        <SourceRow
          title={t("bots.phone.bots.share.receive.fromLink")}
          subtitle={t("bots.phone.bots.share.receive.pasteDescription")}
          onPress={openLink}
          divider
          testID="new-bot-from-link"
        />
      ) : null}
    </View>
  );
}

function SourceRow({
  title,
  subtitle,
  divider = false,
  onPress,
  testID,
}: {
  title: string;
  subtitle?: string;
  divider?: boolean;
  onPress: () => void;
  testID: string;
}) {
  const style = useCallback(
    ({ pressed }: { pressed: boolean }) => [
      styles.row,
      divider && styles.divider,
      pressed && styles.pressed,
    ],
    [divider],
  );
  return (
    <Pressable onPress={onPress} style={style} accessibilityRole="button" testID={testID}>
      <View style={styles.text}>
        <Text style={styles.title}>{title}</Text>
        {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
      </View>
      <ThemedChevron size={16} uniProps={muted} />
    </Pressable>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  group: {
    borderRadius: 14,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    overflow: "hidden",
  },
  row: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  divider: { borderTopWidth: 1, borderTopColor: theme.colors.border },
  pressed: { backgroundColor: theme.colors.surface2 },
  text: { flex: 1, minWidth: 0 },
  title: { fontSize: 15, color: theme.colors.foreground },
  subtitle: { fontSize: 13, color: theme.colors.foregroundMuted },
}));
