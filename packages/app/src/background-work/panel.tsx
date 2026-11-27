import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { SquareTerminal } from "lucide-react-native";
import invariant from "tiny-invariant";
import { usePaneContext } from "@/panels/pane-context";
import type { PanelDescriptor, PanelRegistration } from "@/panels/panel-registry";
import { BackgroundWorkDetail } from "./detail";
import { useBackgroundWorkSnapshot } from "./shared";

function useBackgroundWorkPanelDescriptor(
  target: { kind: "background_work"; agentId: string; itemId: string },
  context: { serverId: string },
): PanelDescriptor {
  const { t } = useTranslation();
  const snapshot = useBackgroundWorkSnapshot(context.serverId, target.agentId, true);
  const live = snapshot.items?.find((entry) => entry.id === target.itemId);
  const item = live ?? snapshot.finished?.[target.itemId]?.item;
  const label =
    item?.command?.trim() ||
    item?.description?.trim() ||
    t("message.backgroundWork.detail.tabTitle");
  return {
    label,
    subtitle: t("message.backgroundWork.detail.tabTitle"),
    tooltip: label,
    titleState: "ready",
    icon: SquareTerminal,
    statusBucket: live ? "running" : null,
  };
}

/** "Open in tab" from the background task popover: the same detail, read-only, full pane. */
function BackgroundWorkPanel(): ReactElement {
  const { serverId, target, closeCurrentTab } = usePaneContext();
  invariant(target.kind === "background_work", "BackgroundWorkPanel requires its target");
  return (
    <BackgroundWorkDetail
      serverId={serverId}
      agentId={target.agentId}
      itemId={target.itemId}
      variant="tab"
      onDismissed={closeCurrentTab}
    />
  );
}

export const backgroundWorkPanelRegistration: PanelRegistration<"background_work"> = {
  kind: "background_work",
  component: BackgroundWorkPanel,
  useDescriptor: useBackgroundWorkPanelDescriptor,
};
