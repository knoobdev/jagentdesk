import { useCallback, useMemo } from "react";
import { View } from "react-native";
import { router, type Href } from "expo-router";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { MenuHeader } from "@/components/headers/menu-header";
import { useIsGumloopTheme } from "@/components/gumloop-shell/use-gumloop-chrome";
import { useIsCompactFormFactor } from "@/constants/layout";
import type { Theme } from "@/styles/theme";
import { buildSettingsSectionRoute } from "@/utils/host-routes";
import { NotificationFeedActions, NotificationFeedList } from "./list";

/** The Notifications page a phone opens from the bell in the drawer's host row (spec 14 §8.5). */
export function NotificationFeedScreen({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  // Gumloop phones draw the shell's compact header (title + gear) instead of this page's header.
  const gumloop = useIsGumloopTheme();
  const compact = useIsCompactFormFactor();
  const shellHeader = gumloop && compact;
  const openSettings = useCallback(() => {
    router.push(buildSettingsSectionRoute("notifications") as Href);
  }, []);
  const actions = useMemo(
    () => <NotificationFeedActions serverId={serverId} onOpenSettings={openSettings} />,
    [serverId, openSettings],
  );
  return (
    <View style={styles.screen} testID="notification-feed-page">
      <MenuHeader title={t("notificationFeed.title")} rightContent={actions} />
      {shellHeader ? (
        <View style={styles.toolbar}>
          <NotificationFeedActions serverId={serverId} onOpenSettings={null} />
        </View>
      ) : null}
      <View style={styles.body}>
        <NotificationFeedList serverId={serverId} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  screen: { flex: 1, backgroundColor: theme.colors.surface0 },
  toolbar: {
    flexDirection: "row",
    justifyContent: "flex-end",
    paddingHorizontal: theme.spacing[4],
    paddingTop: theme.spacing[2],
  },
  body: { flex: 1, paddingHorizontal: theme.spacing[2], paddingTop: theme.spacing[2] },
}));
