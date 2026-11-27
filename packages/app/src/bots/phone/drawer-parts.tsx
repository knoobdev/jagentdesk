// The Bots section in the phone's drawer (spec 37.6, 38.5): the same rows as the desktop sidebar at
// 44 px, but `+` opens the New bot sheet straight away (its Template and From a link rows replace the
// desktop's submenu) and an empty host says "No bots yet." under the heading.
// Orca dfdb4fda (MIT) mobile/src/bots/MobileBotsSectionHeader.tsx:39-120 (`+` = "New bot") and
// mobile/src/home/tabs/MobileHomeBotsTab.tsx:116-121 ("No bots yet.").
import { useCallback } from "react";
import { Pressable, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Plus } from "lucide-react-native";
import type { Theme } from "@/styles/theme";
import { Button } from "@/components/ui/button";
import { openBotsDialog } from "@/bots/dialogs-store";

const ThemedPlus = withUnistyles(Plus);
const foreground = (theme: Theme) => ({ color: theme.colors.foreground });

export function PhoneBotsNewButton({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const open = useCallback(() => openBotsDialog({ kind: "newBot", serverId }), [serverId]);
  return (
    <Pressable
      onPress={open}
      style={styles.button}
      accessibilityRole="button"
      accessibilityLabel={t("bots.phone.bots.new.title")}
      testID="sidebar-bots-new"
    >
      <ThemedPlus size={18} uniProps={foreground} />
    </Pressable>
  );
}

export function PhoneBotsEmpty({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const open = useCallback(() => openBotsDialog({ kind: "newBot", serverId }), [serverId]);
  return (
    <View style={styles.empty} testID="bots-empty">
      <Text style={styles.emptyText}>{t("bots.phone.bots.list.noBotsYet")}</Text>
      <Button size="sm" variant="outline" onPress={open} testID="bots-empty-new">
        {t("bots.phone.bots.new.title")}
      </Button>
    </View>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  button: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  empty: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    paddingHorizontal: 12,
  },
  emptyText: { fontSize: 14, color: theme.colors.foregroundMuted },
}));
