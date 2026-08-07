import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { SidebarCalloutDescriptionText } from "@/components/sidebar-callout";
import { getIsElectronMac } from "@/constants/platform";
import { useSidebarCallouts } from "@/contexts/sidebar-callout-context";
import { getDesktopRuntimeInfo, type DesktopRuntimeInfo } from "@/desktop/runtime";

function RosettaCalloutDescription({ t }: { t: ReturnType<typeof useTranslation>["t"] }) {
  return (
    <>
      <SidebarCalloutDescriptionText>
        {t("desktop.rosetta.runningIntel")}
      </SidebarCalloutDescriptionText>
      <SidebarCalloutDescriptionText>{t("desktop.rosetta.highCpu")}</SidebarCalloutDescriptionText>
    </>
  );
}

export function RosettaCalloutSource() {
  const { t } = useTranslation();
  const callouts = useSidebarCallouts();
  const [runtimeInfo, setRuntimeInfo] = useState<DesktopRuntimeInfo | null>(null);
  const isElectronMac = getIsElectronMac();

  useEffect(() => {
    if (!isElectronMac) {
      return;
    }

    let cancelled = false;
    void getDesktopRuntimeInfo()
      .then((nextRuntimeInfo) => {
        if (!cancelled) {
          setRuntimeInfo(nextRuntimeInfo);
        }
        return nextRuntimeInfo;
      })
      .catch((error) => {
        console.warn("[RosettaCallout] Failed to load desktop runtime info", error);
      });

    return () => {
      cancelled = true;
    };
  }, [isElectronMac]);

  useEffect(() => {
    if (!isElectronMac || runtimeInfo?.runningUnderARM64Translation !== true) {
      return;
    }

    return callouts.show({
      id: "desktop-rosetta-warning",
      priority: 300,
      title: t("desktop.rosetta.title"),
      description: <RosettaCalloutDescription t={t} />,
      variant: "error",
      dismissible: false,
      testID: "rosetta-callout",
    });
  }, [callouts, isElectronMac, runtimeInfo, t]);

  return null;
}
