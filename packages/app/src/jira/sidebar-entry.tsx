import { useCallback } from "react";
import { router, usePathname } from "expo-router";
import { KanbanSquare } from "lucide-react-native";
import { SidebarHeaderRow } from "@/components/sidebar/sidebar-header-row";
import { useAppNavTargets } from "@/components/sidebar/use-app-nav";
import { usePanelStore } from "@/stores/panel-store";

/** The Jira row of the sidebar (desktop + phone drawer); absent when the host has no Jira (spec 29.3). */
export function JiraSidebarEntry({ closesDrawer }: { closesDrawer: boolean }) {
  const { jiraRoute } = useAppNavTargets();
  const pathname = usePathname();
  const showMobileAgent = usePanelStore((state) => state.showMobileAgent);
  const open = useCallback(() => {
    if (!jiraRoute) return;
    if (closesDrawer) showMobileAgent();
    router.push(jiraRoute);
  }, [closesDrawer, jiraRoute, showMobileAgent]);
  if (!jiraRoute) return null;
  return (
    <SidebarHeaderRow
      icon={KanbanSquare}
      label="Jira"
      onPress={open}
      isActive={pathname.includes("/jira")}
      testID="sidebar-jira-nav"
      variant="compact"
    />
  );
}
