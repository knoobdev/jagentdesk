import { useWindowDimensions } from "react-native";
import { useCloseAgentListGesture } from "@/mobile-panels/gestures";
import { MobilePanelOverlay } from "@/mobile-panels/presentation";
import { RetainedPanelActivity } from "@/components/retained-panel";
import { GumloopSidebar } from "./sidebar";

export function GumloopDrawer({ active }: { active: boolean }) {
  const { width } = useWindowDimensions();
  const { gesture } = useCloseAgentListGesture();
  return (
    <RetainedPanelActivity active={active}>
      <MobilePanelOverlay
        panel="agent-list"
        closeGesture={gesture}
        panelWidth={Math.min(324, width * 0.85)}
        scrimColor="rgba(0,0,0,0.32)"
      >
        <GumloopSidebar active={active} />
      </MobilePanelOverlay>
    </RetainedPanelActivity>
  );
}
