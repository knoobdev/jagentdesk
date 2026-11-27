import { useCallback } from "react";
import { Text } from "react-native";
import { Maximize2 } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";

const ThemedMaximize = withUnistyles(Maximize2, (theme) => ({
  color: theme.colors.foregroundMuted,
}));

/**
 * Spec 38 §4.5: a browser tab in the inspector moves to the workspace's main pane. The tab keeps
 * its browser id, so the pane there adopts the same webview without reloading the page.
 */
export function InspectorOpenInMainPaneButton({
  workspaceKey,
  tabId,
}: {
  workspaceKey: string;
  tabId: string;
}) {
  const { t } = useTranslation();
  const label = t("workspace.tabs.explorer.openInMainPane");
  const handlePress = useCallback(() => {
    useWorkspaceLayoutStore.getState().moveTabToMainPane(workspaceKey, tabId);
  }, [tabId, workspaceKey]);
  return (
    <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile={false}>
      <TooltipTrigger
        testID="inspector-open-in-main-pane"
        accessibilityRole="button"
        accessibilityLabel={label}
        onPress={handlePress}
        style={buttonStyle}
      >
        <ThemedMaximize size={16} />
      </TooltipTrigger>
      <TooltipContent side="bottom" align="center" offset={8}>
        <Text style={styles.tooltipText}>{label}</Text>
      </TooltipContent>
    </Tooltip>
  );
}

function buttonStyle({ hovered, pressed }: { hovered?: boolean; pressed?: boolean }) {
  return [styles.button, (hovered || pressed) && styles.buttonHovered];
}

const styles = StyleSheet.create((theme) => ({
  button: {
    width: 28,
    height: 28,
    borderRadius: 6,
    alignItems: "center",
    justifyContent: "center",
  },
  buttonHovered: {
    backgroundColor: theme.colors.surface2,
  },
  tooltipText: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.popoverForeground,
  },
}));
