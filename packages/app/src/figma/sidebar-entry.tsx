import { default as React, useCallback } from "react";
import { router, usePathname } from "expo-router";
import { Figma as FigmaIcon } from "lucide-react-native";
import { SidebarHeaderRow } from "@/components/sidebar/sidebar-header-row";
import { useAppNavTargets } from "@/components/sidebar/use-app-nav";
import { usePanelStore } from "@/stores/panel-store";

/** The Figma row of the sidebar (desktop + phone drawer); absent when the host has no Figma (spec 32.5). */
export function FigmaSidebarEntry({ closesDrawer }: { closesDrawer: boolean }) {
  const { figmaRoute } = useAppNavTargets();
  const pathname = usePathname();
  const showMobileAgent = usePanelStore((state) => state.showMobileAgent);
  const open = useCallback(() => {
    if (!figmaRoute) return;
    if (closesDrawer) showMobileAgent();
    router.push(figmaRoute);
  }, [closesDrawer, figmaRoute, showMobileAgent]);
  if (!figmaRoute) return null;
  return (
    <SidebarHeaderRow
      icon={FigmaIcon}
      label="Figma"
      onPress={open}
      isActive={pathname.includes("/figma")}
      testID="sidebar-figma-nav"
      variant="compact"
    />
  );
}
