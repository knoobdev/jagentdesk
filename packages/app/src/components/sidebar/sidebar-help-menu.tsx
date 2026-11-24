import { useIsGumloopTheme } from "@/components/gumloop-shell/use-gumloop-chrome";
import { SidebarFooterIconHighlight } from "./sidebar-footer-icon-highlight";
import { openChangelog } from "@/changelog";
import { useCallback, useState } from "react";
import { Text, View, type PressableStateCallbackType } from "react-native";
import { Activity, CircleHelp, Keyboard, MoreVertical } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuHint,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isNative } from "@/constants/platform";
import { useAppDiagnosticStore } from "@/diagnostics/store";
import { useHostRuntimeIsConnected, useHosts } from "@/runtime/host-runtime";
import { useKeyboardShortcutsStore } from "@/stores/keyboard-shortcuts-store";
import { useSessionStore } from "@/stores/session-store";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import type { HostProfile } from "@/types/host-connection";
import { formatVersionWithPrefix } from "@/desktop/runtime";
import { resolveAppVersion } from "@/utils/app-version";

const ThemedActivity = withUnistyles(Activity);
const ThemedCircleHelp = withUnistyles(CircleHelp);
const ThemedMoreVertical = withUnistyles(MoreVertical);
const ThemedKeyboard = withUnistyles(Keyboard);
const foregroundColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const foregroundMutedColorMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});
const diagnosticLeadingIcon = (
  <ThemedActivity size={ICON_SIZE.sm} uniProps={foregroundMutedColorMapping} />
);
const shortcutsLeadingIcon = (
  <ThemedKeyboard size={ICON_SIZE.sm} uniProps={foregroundMutedColorMapping} />
);

function HostVersionHint({ host }: { host: HostProfile }) {
  const { t } = useTranslation();
  const isConnected = useHostRuntimeIsConnected(host.serverId);
  const daemonVersion = useSessionStore(
    (state) => state.sessions[host.serverId]?.serverInfo?.version ?? null,
  );
  const version = isConnected
    ? formatVersionWithPrefix(daemonVersion)
    : t("common.connectionStatus.offline");

  return (
    <DropdownMenuHint
      style={styles.versionHint}
      testID={`sidebar-help-host-version-${host.serverId}`}
    >
      {host.label} {version}
    </DropdownMenuHint>
  );
}

export function SidebarHelpMenu() {
  const { t } = useTranslation();
  const isCompactLayout = useIsCompactFormFactor();
  const gumloop = useIsGumloopTheme();
  const MenuIcon = gumloop ? ThemedMoreVertical : ThemedCircleHelp;
  const openAppDiagnostic = useAppDiagnosticStore((state) => state.open);
  const setShortcutsDialogOpen = useKeyboardShortcutsStore((state) => state.setShortcutsDialogOpen);
  const [open, setOpen] = useState(false);
  const showKeyboardShortcuts = !isNative && !isCompactLayout;
  const version = formatVersionWithPrefix(resolveAppVersion());
  const hosts = useHosts();

  const openKeyboardShortcuts = useCallback(() => {
    setShortcutsDialogOpen(true);
  }, [setShortcutsDialogOpen]);

  const gumloopTriggerStyle = useCallback(
    ({ hovered, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.gumloopTrigger,
      (hovered || pressed || open) && styles.gumloopTriggerHovered,
    ],
    [open],
  );
  const classicTriggerStyle = isCompactLayout ? styles.triggerTouch : styles.trigger;
  const label = gumloop ? "More options" : t("sidebar.help.trigger");
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <Tooltip delayDuration={300} enabledOnDesktop={!open}>
        <TooltipTrigger asChild>
          <View>
            <DropdownMenuTrigger
              style={gumloop ? gumloopTriggerStyle : classicTriggerStyle}
              testID="sidebar-help"
              accessibilityRole="button"
              accessibilityLabel={label}
            >
              {({ hovered, pressed, open: menuOpen }) => (
                <>
                  {gumloop ? null : <SidebarFooterIconHighlight visible={pressed || menuOpen} />}
                  <MenuIcon
                    size={gumloop ? 18 : ICON_SIZE.md}
                    uniProps={
                      gumloop || !hovered ? foregroundMutedColorMapping : foregroundColorMapping
                    }
                  />
                </>
              )}
            </DropdownMenuTrigger>
          </View>
        </TooltipTrigger>
        <TooltipContent side="top" align="center" offset={8}>
          <Text style={styles.tooltipText}>{label}</Text>
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent side="top" align="end" offset={8} width={280} testID="sidebar-help-menu">
        <DropdownMenuLabel>{t("sidebar.help.sectionHelp")}</DropdownMenuLabel>
        {showKeyboardShortcuts ? (
          <DropdownMenuItem
            testID="sidebar-help-shortcuts"
            leading={shortcutsLeadingIcon}
            onSelect={openKeyboardShortcuts}
          >
            {t("sidebar.help.shortcuts")}
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem testID="sidebar-help-whats-new" onSelect={openChangelog}>
          {t("sidebar.help.whatsNew")}
        </DropdownMenuItem>
        <DropdownMenuItem
          testID="sidebar-help-diagnostics"
          leading={diagnosticLeadingIcon}
          onSelect={openAppDiagnostic}
        >
          {t("sidebar.help.diagnostics")}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <View style={styles.versionList}>
          <DropdownMenuHint style={styles.versionHint} testID="sidebar-help-version">
            {t("sidebar.help.version", { version })}
          </DropdownMenuHint>
          {hosts.map((host) => (
            <HostVersionHint key={host.serverId} host={host} />
          ))}
        </View>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const styles = StyleSheet.create((theme) => ({
  gumloopTrigger: {
    width: 32,
    height: 32,
    flexShrink: 0,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  gumloopTriggerHovered: { backgroundColor: theme.colors.surfaceSidebarHover },
  triggerTouch: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  trigger: {
    width: 28,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[1],
  },
  tooltipText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.popoverForeground,
  },
  versionList: {
    gap: theme.spacing[1],
    paddingVertical: theme.spacing[2],
  },
  versionHint: {
    paddingVertical: 0,
  },
}));
