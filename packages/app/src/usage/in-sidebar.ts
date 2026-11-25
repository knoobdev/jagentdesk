import { useCallback } from "react";
import { useAppSettings } from "@/hooks/use-settings";
export function useUsageInSidebar() {
  const { settings, updateSettings } = useAppSettings();
  const setInSidebar = useCallback(
    (visible: boolean) => {
      void updateSettings({ usageInSidebar: visible });
    },
    [updateSettings],
  );
  return { inSidebar: settings.usageInSidebar, setInSidebar };
}
