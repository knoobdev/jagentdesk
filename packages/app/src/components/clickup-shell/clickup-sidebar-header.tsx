import { useCallback } from "react";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import { Plus } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useNewWorkspaceNavigate } from "@/components/sidebar/use-app-nav";
import type { Theme } from "@/styles/theme";

const ThemedPlus = withUnistyles(Plus);
const createForegroundMapping = (theme: Theme) => ({ color: theme.chrome.createForeground });

function createButtonStyle({
  hovered,
  pressed,
}: PressableStateCallbackType & { hovered?: boolean }) {
  return hovered || pressed ? styles.createHovered : styles.create;
}

/**
 * ClickUp's sidebar header ("Home" + violet "Create" in ClickUp): the section title and the
 * primary create action, here a new workspace. The nav list itself lives on the rail.
 */
export function ClickUpSidebarHeader({ onBeforeNavigate }: { onBeforeNavigate?: () => void }) {
  const { t } = useTranslation();
  const handleNewWorkspace = useNewWorkspaceNavigate(onBeforeNavigate);
  const renderCreate = useCallback(
    () => (
      <>
        <ThemedPlus size={14} strokeWidth={2.4} uniProps={createForegroundMapping} />
        <Text style={styles.createText}>{t("clickupShell.newWorkspace")}</Text>
      </>
    ),
    [t],
  );
  return (
    <View style={styles.header}>
      <Text style={styles.title} numberOfLines={1}>
        {t("clickupShell.workspaces")}
      </Text>
      <Pressable
        onPress={handleNewWorkspace}
        style={createButtonStyle}
        accessibilityRole="button"
        accessibilityLabel={t("sidebar.actions.newWorkspace")}
        testID="sidebar-global-new-workspace"
      >
        {renderCreate}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
    paddingLeft: theme.spacing[4],
    paddingRight: theme.spacing[3],
    paddingTop: theme.spacing[3],
    paddingBottom: theme.spacing[2],
  },
  title: {
    flexShrink: 1,
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  create: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    height: 28,
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.chrome.createBackground,
  },
  createHovered: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    height: 28,
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.chrome.createBackground,
    opacity: 0.88,
  },
  createText: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
    color: theme.chrome.createForeground,
  },
}));
